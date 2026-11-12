// Regression tests for the phase 6 security / correctness reviews.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assertProjectPathAllowed, diffText, MAX_PREVIEW, prepareTool, Prepared, runShell, visible } from '../electron/project';

let root = '';
const w = (rel: string, content: string | Buffer) => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
};
const rd = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const ok = (p: Prepared) => { if ('error' in p) throw new Error(`unexpected error: ${p.error}`); return p; };
const err = (p: Prepared) => { if (!('error' in p)) throw new Error('expected an error'); return p.error; };
const approval = (p: Prepared) => { const o = ok(p); if (!o.needsApproval) throw new Error('expected an approval request'); return o; };
const node = (code: string) => `"${process.execPath}" -e "${code}"`;
const tryLink = (target: string, linkPath: string, type: 'junction' | 'file' = 'junction'): boolean => {
  try { fs.symlinkSync(target, linkPath, type); return true; } catch { return false; }
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-hard-'));
  w('notes.md', '# notes\nhello world\n');
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('names that dodge the protections are refused (Windows aliases, case, devices)', () => {
  it('trailing dots/spaces, alternate data streams and drive prefixes', () => {
    expect(err(prepareTool(root, 'read_file', { path: '.env ' }))).toMatch(/dot or space/);
    expect(err(prepareTool(root, 'read_file', { path: '.env.' }))).toMatch(/dot or space/);
    expect(err(prepareTool(root, 'read_file', { path: '.env::$DATA' }))).toMatch(/not an allowed name/);
    expect(err(prepareTool(root, 'write_file', { path: 'notes.md:hidden', content: 'x' }))).toMatch(/not an allowed name/);
  });

  it('reserved device names', () => {
    for (const n of ['nul', 'CON.txt', 'aux', 'com1', 'LPT9.log']) {
      expect(err(prepareTool(root, 'write_file', { path: n, content: 'x' })), n).toMatch(/reserved device name/);
    }
  });

  it('.git and node_modules are protected in any letter case, for reads AND writes', () => {
    w('.git/config', '[remote] url = https://user:token@example.com');
    w('node_modules/x/index.js', 'x');
    for (const p of ['.git/config', '.GIT/config', '.Git/config', 'NODE_MODULES/x/index.js', 'Node_Modules/x/index.js']) {
      expect(err(prepareTool(root, 'read_file', { path: p })), p).toMatch(/protected folder/);
    }
    expect(err(prepareTool(root, 'write_file', { path: '.Git/hooks/pre-commit', content: 'x' }))).toMatch(/protected folder/);
    expect(err(prepareTool(root, 'edit_file', { path: '.GIT/config', old_text: 'url', new_text: 'x' }))).toMatch(/protected folder/);
    expect(err(prepareTool(root, 'list_files', { path: '.git' }))).toMatch(/protected folder/);
    expect(err(prepareTool(root, 'search_files', { query: 'token', path: '.git' }))).toMatch(/protected folder/);
  });

  it('any .env* variant is secret', () => {
    for (const n of ['.env', '.env.local', '.env.production', '.envrc', '.environment']) {
      w(n, 'S=1');
      expect(err(prepareTool(root, 'read_file', { path: n })), n).toMatch(/secrets/);
    }
  });

  it('an 8.3 short name resolves to the real file and is then blocked (Windows, when short names are enabled)', () => {
    if (process.platform !== 'win32') return;
    w('.env', 'S=1');
    w('.git/config', 'x');
    const dir = spawnSync('cmd', ['/d', '/c', 'dir', '/x', '/a', root], { encoding: 'utf8' }).stdout ?? '';
    const shortOf = (name: string) => dir.split(/\r?\n/).find((l) => l.trimEnd().endsWith(` ${name}`))?.match(/\s(\S+~\d\S*)\s+\S+$/)?.[1];
    const envShort = shortOf('.env');
    if (envShort) expect(err(prepareTool(root, 'read_file', { path: envShort }))).toMatch(/secrets/);
    const gitShort = shortOf('.git');
    if (gitShort) expect(err(prepareTool(root, 'write_file', { path: `${gitShort}/hooks/x`, content: 'x' }))).toMatch(/protected folder/);
  });
});

describe('writes are re-validated at the moment they run', () => {
  it('a dangling symlink inside the project cannot be used to create a file outside it', () => {
    const outside = path.join(os.tmpdir(), `rc-dangling-${Date.now()}`);
    if (!tryLink(outside, path.join(root, 'dangling'), 'file')) return; // links not permitted in this environment
    expect(err(prepareTool(root, 'write_file', { path: 'dangling', content: 'x' }))).toMatch(/symbolic link|outside/);
    expect(fs.existsSync(outside)).toBe(false);
  });

  it('a dangling junction (target folder deleted) is refused too, so nothing is created through it', () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-gone-'));
    if (!tryLink(target, path.join(root, 'gone'))) { fs.rmSync(target, { recursive: true, force: true }); return; }
    fs.rmSync(target, { recursive: true, force: true }); // the junction now dangles
    expect('error' in prepareTool(root, 'write_file', { path: 'gone/new.txt', content: 'x' })).toBe(true);
    expect('error' in prepareTool(root, 'write_file', { path: 'gone', content: 'x' })).toBe(true);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('a folder swapped for a link to outside AFTER the preview is refused when it runs', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-swap-'));
    w('sub/keep.txt', 'k');
    const p = approval(prepareTool(root, 'write_file', { path: 'sub/new.txt', content: 'payload' }));
    fs.rmSync(path.join(root, 'sub'), { recursive: true, force: true });
    if (!tryLink(outside, path.join(root, 'sub'))) { fs.rmSync(outside, { recursive: true, force: true }); return; }
    await expect(p.run()).rejects.toThrow(/outside the project folder|resolves somewhere else/);
    expect(fs.existsSync(path.join(outside, 'new.txt'))).toBe(false);
    fs.rmSync(outside, { recursive: true, force: true });
  });
});

describe('what the user reviews is the complete change, with nothing hidden', () => {
  it('a 200-line change is shown in full; a change too big to review is refused (split it)', () => {
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `row ${i}`).join('\n');
    const p = approval(prepareTool(root, 'write_file', { path: 'mid.txt', content: lines(200) }));
    expect(p.action.preview).toContain('+row 199');
    expect(p.action.preview).not.toContain('more lines');
    expect(p.action.preview).toContain(`Project: ${fs.realpathSync.native(root)}`);
    expect(err(prepareTool(root, 'write_file', { path: 'huge.txt', content: lines(8000) }))).toMatch(/too large to review in full/);
    expect(MAX_PREVIEW).toBeGreaterThan(10_000);
  });

  it('bidi / zero-width / control characters are made visible in diffs and commands', () => {
    const p = approval(prepareTool(root, 'write_file', { path: 'spoof.txt', content: 'safe‮evil​x' }));
    expect(p.action.preview).toContain('⟦U+202E⟧');
    expect(p.action.preview).toContain('⟦U+200B⟧');
    expect(p.action.preview).not.toMatch(/[‮​]/);
    const c = approval(prepareTool(root, 'run_command', { command: 'echo ‮done' }));
    expect(c.action.preview).toContain('⟦U+202E⟧');
    expect(c.action.preview).toContain('non-ASCII');
    expect(visible('a\tb\nc')).toBe('a\tb\nc'); // tabs and newlines are fine
  });

  it('multi-line and control-character commands are refused outright', () => {
    expect(err(prepareTool(root, 'run_command', { command: 'echo a\necho b' }))).toMatch(/single line/);
    expect(err(prepareTool(root, 'run_command', { command: 'echo a\r\necho b' }))).toMatch(/single line/);
    expect(err(prepareTool(root, 'run_command', { command: 'echo \u0007' }))).toMatch(/single line/);
  });
});

describe('line endings, encodings and exact matching', () => {
  it('edit_file matches and writes CRLF files correctly even though the model sends \\n', async () => {
    w('crlf.txt', 'a\r\nb\r\nc\r\n');
    const p = approval(prepareTool(root, 'edit_file', { path: 'crlf.txt', old_text: 'a\nb', new_text: 'X\nY' }));
    await p.run();
    expect(rd('crlf.txt')).toBe('X\r\nY\r\nc\r\n');
  });

  it('write_file over a CRLF file keeps CRLF, and the preview shows only the real change', async () => {
    w('crlf2.txt', 'a\r\nb\r\nc\r\n');
    const p = approval(prepareTool(root, 'write_file', { path: 'crlf2.txt', content: 'a\nB\nc\n' }));
    expect(p.action.preview).toContain('-b');
    expect(p.action.preview).toContain('+B');
    expect(p.action.preview).not.toContain('-a');
    await p.run();
    expect(rd('crlf2.txt')).toBe('a\r\nB\r\nc\r\n');
  });

  it('a change that only alters line endings says so', () => {
    expect(diffText('a\r\nb', 'a\nb')).toBe('(only the line endings differ)');
  });

  it('refuses to rewrite files that are not valid UTF-8 (would destroy their bytes), but can read them', () => {
    w('latin1.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    expect(err(prepareTool(root, 'edit_file', { path: 'latin1.txt', old_text: 'caf', new_text: 'x' }))).toMatch(/not valid UTF-8/);
    expect(err(prepareTool(root, 'write_file', { path: 'latin1.txt', content: 'x' }))).toMatch(/not valid UTF-8/);
    expect('error' in prepareTool(root, 'read_file', { path: 'latin1.txt' })).toBe(false);
  });

  it('counts overlapping matches, so an ambiguous edit is not treated as unique', () => {
    w('aaa.txt', 'aaa');
    expect(err(prepareTool(root, 'edit_file', { path: 'aaa.txt', old_text: 'aa', new_text: 'b' }))).toMatch(/found 2/);
  });
});

describe('read_file windows and command output', () => {
  const big = () => Array.from({ length: 2000 }, (_, i) => `line ${i} ${'x'.repeat(20)}`).join('\n');

  it('a long file is returned as a window with a hint to continue', async () => {
    w('long.txt', big());
    const r = await ok(prepareTool(root, 'read_file', { path: 'long.txt' })).run();
    expect(r.text.length).toBeLessThan(20_500);
    expect(r.text).toMatch(/\[Lines 1-\d+ of 2000\. Call read_file with start_line\/end_line to read more\.\]$/);
  });

  it('start_line / end_line read exactly that range', async () => {
    w('long.txt', big());
    const r = await ok(prepareTool(root, 'read_file', { path: 'long.txt', start_line: 5, end_line: 6 })).run();
    expect(r.text).toBe(`line 4 ${'x'.repeat(20)}\nline 5 ${'x'.repeat(20)}\n[Lines 5-6 of 2000. Call read_file with start_line/end_line to read more.]`);
    expect(err(prepareTool(root, 'read_file', { path: 'long.txt', start_line: 99999 }))).toMatch(/only 2000 lines/);
    expect(err(prepareTool(root, 'read_file', { path: 'long.txt', start_line: 0 }))).toMatch(/number 1 or higher/);
  });

  it('command output keeps the beginning AND the end (build errors are at the end)', async () => {
    const r = await runShell(root, node("console.log('START-MARK'); console.log('x'.repeat(60000)); console.log('END-MARK')"), 30_000);
    expect(r.text).toContain('START-MARK');
    expect(r.text).toContain('END-MARK');
    expect(r.text).toContain('bytes omitted');
  });

  it('search_files says what it skipped instead of claiming "no matches"', async () => {
    w('blob.bin', Buffer.from([0, 1, 2, 3]));
    const r = await ok(prepareTool(root, 'search_files', { query: 'zzz-none' })).run();
    expect(r.text).toMatch(/No matches\.\n\[Searched \d+ file\(s\); 1 file\(s\) skipped/);
  });
});

describe('project folder safety', () => {
  it('may not overlap the app data or system folders (equal, inside, or an ancestor)', () => {
    const data = path.join(root, 'AppData', 'Ronin Council');
    fs.mkdirSync(data, { recursive: true });
    expect(() => assertProjectPathAllowed(data, [data])).toThrow(/overlaps/);
    expect(() => assertProjectPathAllowed(data, [path.join(root, 'AppData')])).toThrow(/overlaps/); // inside a protected folder
    expect(() => assertProjectPathAllowed(root, [data])).toThrow(/overlaps/); // ancestor of a protected folder
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-else-'));
    expect(() => assertProjectPathAllowed(elsewhere, [data, undefined])).not.toThrow();
    expect(() => assertProjectPathAllowed('', [data])).not.toThrow();
    fs.rmSync(elsewhere, { recursive: true, force: true });
  });
});
