import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { diffText, prepareTool, Prepared, runShell, TOOL_DEFS, validateProjectPath } from '../electron/project';

let root = '';
const w = (rel: string, content: string | Buffer) => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
};
const rd = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-proj-'));
  w('src/a.txt', 'line1\nline2\nline3\n');
  w('notes.md', '# notes\nhello world\n');
  w('.env', 'SECRET=1\n');
  w('node_modules/x/index.js', 'hello world');
  w('.git/config', '[core]');
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const ok = (p: Prepared) => { if ('error' in p) throw new Error(`unexpected error: ${p.error}`); return p; };
const err = (p: Prepared) => { if (!('error' in p)) throw new Error('expected an error'); return p.error; };
const node = (code: string) => `"${process.execPath}" -e "${code}"`;

describe('tool definitions', () => {
  it('declares six tools with strict schemas', () => {
    expect(TOOL_DEFS.map((t) => t.name)).toEqual(['read_file', 'list_files', 'search_files', 'write_file', 'edit_file', 'run_command']);
    for (const t of TOOL_DEFS) expect(t.input_schema.additionalProperties).toBe(false);
  });
  it('rejects unknown tools and malformed input instead of throwing', () => {
    expect(err(prepareTool(root, 'format_disk', {}))).toMatch(/Unknown tool/);
    expect(err(prepareTool(root, 'read_file', { path: 42 }))).toMatch(/must be a string/);
    expect(err(prepareTool(root, 'read_file', null))).toMatch(/must be a string/);
  });
});

describe('read-only tools run without approval', () => {
  it('read_file returns the content', async () => {
    const p = ok(prepareTool(root, 'read_file', { path: 'src/a.txt' }));
    expect(p.needsApproval).toBe(false);
    expect((await p.run()).text).toBe('line1\nline2\nline3\n');
  });

  it('stays inside the project: relative escapes, absolute paths outside, and symlinks are refused', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-out-'));
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret');
    expect(err(prepareTool(root, 'read_file', { path: '../' + path.basename(outside) + '/secret.txt' }))).toMatch(/outside the project folder/);
    expect(err(prepareTool(root, 'read_file', { path: path.join(outside, 'secret.txt') }))).toMatch(/outside the project folder/);
    try {
      fs.symlinkSync(outside, path.join(root, 'link'), 'junction');
      expect(err(prepareTool(root, 'read_file', { path: 'link/secret.txt' }))).toMatch(/outside the project folder/);
      expect(err(prepareTool(root, 'write_file', { path: 'link/new.txt', content: 'x' }))).toMatch(/outside the project folder/);
      expect(fs.existsSync(path.join(outside, 'new.txt'))).toBe(false);
    } catch (e) {
      if ((e as Error).message.includes('unexpected') || (e as Error).message.includes('expected')) throw e; // symlinks not permitted: skip that part
    }
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('refuses secrets-style files, binaries and huge files', () => {
    expect(err(prepareTool(root, 'read_file', { path: '.env' }))).toMatch(/secrets/);
    w('keys/id_rsa', 'x');
    w('cert.pem', 'x');
    expect(err(prepareTool(root, 'read_file', { path: 'keys/id_rsa' }))).toMatch(/secrets/);
    expect(err(prepareTool(root, 'read_file', { path: 'cert.pem' }))).toMatch(/secrets/);
    w('bin.dat', Buffer.from([1, 2, 0, 3]));
    expect(err(prepareTool(root, 'read_file', { path: 'bin.dat' }))).toMatch(/binary/);
    w('big.txt', 'x'.repeat(2_500_000));
    expect(err(prepareTool(root, 'read_file', { path: 'big.txt' }))).toMatch(/too large/);
    expect(err(prepareTool(root, 'read_file', { path: 'src' }))).toMatch(/not a file/);
  });

  it('list_files skips .git, node_modules and secrets; recursive goes deeper', async () => {
    const top = await ok(prepareTool(root, 'list_files', {})).run();
    expect(top.text.split('\n').sort()).toEqual(['notes.md', 'src/']);
    const deep = await ok(prepareTool(root, 'list_files', { path: '.', recursive: true })).run();
    expect(deep.text).toContain('src/a.txt');
    expect(deep.text).not.toMatch(/node_modules|\.git|\.env/);
  });

  it('search_files finds literal text with line numbers, ignoring protected and secret files', async () => {
    w('.env.local', 'hello world');
    const r = await ok(prepareTool(root, 'search_files', { query: 'HELLO world' })).run();
    expect(r.text).toMatch(/^notes\.md:2: hello world\n\[Searched \d+ file\(s\)/);
    expect((await ok(prepareTool(root, 'search_files', { query: 'zzz-none' })).run()).text).toMatch(/^No matches\./);
    expect(err(prepareTool(root, 'search_files', { query: '' }))).toMatch(/must not be empty/);
  });
});

describe('write_file needs approval and shows exactly what changes', () => {
  it('creating a file: nothing is written until run()', async () => {
    const p = ok(prepareTool(root, 'write_file', { path: 'out/new.txt', content: 'a\nb' }));
    expect(p.needsApproval).toBe(true);
    if (!p.needsApproval) return;
    expect(p.action).toMatchObject({ tool: 'write_file', summary: 'Create out/new.txt' });
    expect(p.action.preview).toContain('+a');
    expect(fs.existsSync(path.join(root, 'out/new.txt'))).toBe(false);
    await p.run();
    expect(rd('out/new.txt')).toBe('a\nb');
  });

  it('overwriting shows removed and added lines', async () => {
    const p = ok(prepareTool(root, 'write_file', { path: 'src/a.txt', content: 'line1\nCHANGED\nline3\n' }));
    if (!p.needsApproval) throw new Error('expected approval');
    expect(p.action.preview).toContain('-line2');
    expect(p.action.preview).toContain('+CHANGED');
    expect(rd('src/a.txt')).toBe('line1\nline2\nline3\n'); // untouched until approved
  });

  it('refuses protected folders, secrets, oversize content, and files that changed after the request', async () => {
    expect(err(prepareTool(root, 'write_file', { path: '.git/hooks/pre-commit', content: 'x' }))).toMatch(/protected/);
    expect(err(prepareTool(root, 'write_file', { path: 'node_modules/x/index.js', content: 'x' }))).toMatch(/protected/);
    expect(err(prepareTool(root, 'write_file', { path: '.env', content: 'x' }))).toMatch(/secrets/);
    expect(err(prepareTool(root, 'write_file', { path: 'big.txt', content: 'x'.repeat(600_000) }))).toMatch(/too long/);
    const p = ok(prepareTool(root, 'write_file', { path: 'src/a.txt', content: 'new' }));
    w('src/a.txt', 'someone else edited this');
    await expect(p.needsApproval ? p.run() : Promise.reject(new Error('x'))).rejects.toThrow(/changed after this request/);
    expect(rd('src/a.txt')).toBe('someone else edited this');
  });
});

describe('edit_file', () => {
  it('replaces one exact match and previews the diff', async () => {
    const p = ok(prepareTool(root, 'edit_file', { path: 'src/a.txt', old_text: 'line2', new_text: 'two' }));
    if (!p.needsApproval) throw new Error('expected approval');
    expect(p.action.preview).toContain('-line2');
    expect(p.action.preview).toContain('+two');
    expect(rd('src/a.txt')).toContain('line2');
    await p.run();
    expect(rd('src/a.txt')).toBe('line1\ntwo\nline3\n');
  });

  it('requires exactly one match', () => {
    w('dup.txt', 'x x');
    expect(err(prepareTool(root, 'edit_file', { path: 'dup.txt', old_text: 'x', new_text: 'y' }))).toMatch(/found 2/);
    expect(err(prepareTool(root, 'edit_file', { path: 'dup.txt', old_text: 'nope', new_text: 'y' }))).toMatch(/found 0/);
    expect(err(prepareTool(root, 'edit_file', { path: 'dup.txt', old_text: '', new_text: 'y' }))).toMatch(/must not be empty/);
  });

  it('does not interpret $ patterns in the replacement text', async () => {
    const p = ok(prepareTool(root, 'edit_file', { path: 'src/a.txt', old_text: 'line2', new_text: 'cost: $& $1 $$' }));
    if (p.needsApproval) await p.run();
    expect(rd('src/a.txt')).toContain('cost: $& $1 $$');
  });

  it('refuses protected folders and secrets', () => {
    expect(err(prepareTool(root, 'edit_file', { path: '.env', old_text: 'SECRET', new_text: 'x' }))).toMatch(/secrets/);
    expect(err(prepareTool(root, 'edit_file', { path: 'node_modules/x/index.js', old_text: 'hello', new_text: 'x' }))).toMatch(/protected/);
  });
});

describe('run_command', () => {
  it('needs approval and shows the exact command', () => {
    const p = ok(prepareTool(root, 'run_command', { command: 'npm test' }));
    if (!p.needsApproval) throw new Error('expected approval');
    expect(p.action.tool).toBe('run_command');
    expect(p.action.preview).toContain('$ npm test');
  });

  it('runs in the project folder and reports output and exit code', async () => {
    const p = ok(prepareTool(root, 'run_command', { command: node("console.log(process.cwd()); console.error('warn')") }));
    const r = await p.run();
    expect(r.isError).toBe(false);
    expect(r.text).toContain('exit code 0');
    expect(r.text).toContain('warn');
    expect(r.text.toLowerCase()).toContain(fs.realpathSync(root).toLowerCase());
  });

  it('a failing command is an error result with its exit code', async () => {
    const r = await runShell(root, node('process.exit(3)'), 30_000);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('exit code 3');
  });

  it('does not pass secret-looking environment variables to commands', async () => {
    process.env.RC_TEST_SECRET_KEY = 'super-secret-value';
    try {
      const r = await runShell(root, node("console.log(process.env.RC_TEST_SECRET_KEY || 'absent')"), 30_000);
      expect(r.text).toContain('absent');
      expect(r.text).not.toContain('super-secret-value');
    } finally {
      delete process.env.RC_TEST_SECRET_KEY;
    }
  });

  it('kills a command that outlives its timeout', async () => {
    const t = Date.now();
    const r = await runShell(root, node('setTimeout(()=>{}, 60000)'), 700);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('timed out');
    expect(Date.now() - t).toBeLessThan(15_000);
  });

  it('stops a running command when aborted', async () => {
    const ctrl = new AbortController();
    const run = runShell(root, node('setTimeout(()=>{}, 60000)'), 60_000, ctrl.signal);
    setTimeout(() => ctrl.abort(), 300);
    const r = await run;
    expect(r.isError).toBe(true);
    expect(r.text).toContain('stopped by the user');
  });

  it('caps very long output', async () => {
    const r = await runShell(root, node("console.log('x'.repeat(100000))"), 30_000);
    expect(r.text.length).toBeLessThan(21_000);
    expect(r.text).toContain('bytes omitted');
  });

  it('rejects empty and oversize commands', () => {
    expect(err(prepareTool(root, 'run_command', { command: '   ' }))).toMatch(/must not be empty/);
    expect(err(prepareTool(root, 'run_command', { command: 'x'.repeat(3000) }))).toMatch(/too long/);
  });
});

describe('diffText / validateProjectPath', () => {
  it('describes changes compactly', () => {
    expect(diffText('a\nb', 'a\nb')).toBe('(no changes)');
    expect(diffText('a\nb\nc', 'a\nX\nc')).toBe('@@ line 1 @@\n a\n-b\n+X\n c');
    expect(diffText('a', 'a\nb')).toContain('+b');
    expect(diffText('', 'only')).toBe('@@ line 1 @@\n+only'); // a new file has no phantom empty line removed
    expect(diffText('x', '')).toBe('@@ line 1 @@\n-x');
    const long = diffText('', Array.from({ length: 500 }, (_, i) => `l${i}`).join('\n'), 120);
    expect(long).toContain('more lines');
  });

  it('validates the project folder setting', () => {
    expect(validateProjectPath('')).toBe('');
    expect(validateProjectPath(root)).toBe(path.resolve(root));
    expect(() => validateProjectPath(path.join(root, 'does-not-exist'))).toThrow(/existing folder/);
    expect(() => validateProjectPath(path.join(root, 'notes.md'))).toThrow(/folder/);
    expect(() => validateProjectPath('relative')).toThrow(/absolute/);
  });
});
