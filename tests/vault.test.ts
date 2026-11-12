import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Category } from '../shared/types';
import {
  INDEX_FILE, buildIndex, digestFor, listFiles, readVaultFile, refreshIndexes, resolveVaultPath, validateVaultPath,
  writeVaultNote,
} from '../electron/vault';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rc-vault-'));
const cat = (id: string, name: string, vaultPath: string): Category => ({ id, name, order: 0, vaultPath, projectPath: '', repoUrl: '', collapsed: false });
const resolve = (c: Category) => c.vaultPath;

describe('listFiles / readVaultFile', () => {
  it('lists notes and images, skipping dot folders and node_modules', () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, '.obsidian'));
    fs.mkdirSync(path.join(root, 'node_modules'));
    fs.mkdirSync(path.join(root, 'notes'));
    fs.writeFileSync(path.join(root, '.obsidian', 'x.md'), 'x');
    fs.writeFileSync(path.join(root, 'node_modules', 'y.md'), 'y');
    fs.writeFileSync(path.join(root, 'a.md'), 'a');
    fs.writeFileSync(path.join(root, 'notes', 'b.md'), 'b');
    fs.writeFileSync(path.join(root, 'pic.png'), 'png');
    fs.writeFileSync(path.join(root, 'binary.exe'), 'bin');
    expect(listFiles(root).sort()).toEqual(['a.md', 'notes/b.md', 'pic.png']);
  });

  it('returns [] for a folder that does not exist', () => {
    expect(listFiles(path.join(tmp(), 'nope'))).toEqual([]);
  });

  it('reads text and images, and refuses unsupported types', () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, 'a.md'), '# hi');
    fs.writeFileSync(path.join(root, 'p.png'), Buffer.from([1, 2, 3]));
    fs.writeFileSync(path.join(root, 'x.exe'), 'z');
    expect(readVaultFile(root, 'a.md')).toMatchObject({ kind: 'text', content: '# hi' });
    expect(readVaultFile(root, 'p.png').content.startsWith('data:image/png;base64,')).toBe(true);
    expect(() => readVaultFile(root, 'x.exe')).toThrow();
  });

  it('blocks path traversal on read and write', () => {
    const root = tmp();
    const outside = path.join(path.dirname(root), 'secret.md');
    fs.writeFileSync(outside, 'secret');
    expect(() => readVaultFile(root, '../secret.md')).toThrow(/outside/);
    expect(() => writeVaultNote(root, '../evil.md', 'x', 'librarian')).toThrow(/outside/);
    expect(fs.existsSync(path.join(path.dirname(root), 'evil.md'))).toBe(false);
  });

  it('blocks reads that escape through a symlink (when symlinks are permitted)', () => {
    const root = tmp();
    const outsideDir = tmp();
    fs.writeFileSync(path.join(outsideDir, 'secret.md'), 'secret');
    try {
      fs.symlinkSync(outsideDir, path.join(root, 'link'), 'junction');
    } catch {
      return; // cannot create links in this environment; nothing to assert
    }
    expect(() => readVaultFile(root, 'link/secret.md')).toThrow(/outside/);
  });
});

describe('validateVaultPath / defaults', () => {
  it('accepts blank (default) and absolute folders; rejects relative paths, drive roots, home, and files', () => {
    expect(validateVaultPath('   ')).toBe('');
    const dir = tmp();
    expect(validateVaultPath(dir)).toBe(path.resolve(dir));
    expect(() => validateVaultPath('relative/folder')).toThrow(/absolute/);
    expect(() => validateVaultPath(path.parse(dir).root)).toThrow(/drive root/);
    expect(() => validateVaultPath(os.homedir())).toThrow(/home folder/);
    const file = path.join(dir, 'f.txt');
    fs.writeFileSync(file, 'x');
    expect(() => validateVaultPath(file)).toThrow(/folder/);
  });

  it('the default vault folder is keyed by category id, so renaming a category keeps its vault', () => {
    const c = cat('cat_9', 'Before', '');
    const before = resolveVaultPath(c, '/root');
    expect(resolveVaultPath({ ...c, name: 'After' }, '/root')).toBe(before);
    expect(before).toBe(path.join('/root', 'cat_9'));
  });

  it('refuses to create a new file through a link that points outside the vault (when links are permitted)', () => {
    const root = tmp();
    const outside = tmp();
    try {
      fs.symlinkSync(outside, path.join(root, 'link'), 'junction');
    } catch {
      return; // cannot create links in this environment
    }
    expect(() => writeVaultNote(root, 'link/new.md', 'x', 'librarian')).toThrow(/outside/);
    expect(fs.existsSync(path.join(outside, 'new.md'))).toBe(false);
  });
});

describe('writeVaultNote', () => {
  it('only the Librarian or Widow may write', () => {
    const root = tmp();
    expect(() => writeVaultNote(root, 'n.md', 'x', 'prog')).toThrow(/Librarian or Widow/);
    writeVaultNote(root, 'sub/n.md', 'ok', 'librarian');
    writeVaultNote(root, 'w.md', 'ok', 'widow');
    expect(fs.readFileSync(path.join(root, 'sub', 'n.md'), 'utf8')).toBe('ok');
  });

  it('only writes markdown', () => {
    expect(() => writeVaultNote(tmp(), 'a.exe', 'x', 'librarian')).toThrow(/\.md/);
  });
});

describe('cross-vault index', () => {
  it('lists the other vaults but not itself, and refreshIndexes writes one per vault', () => {
    const a = tmp(); const b = tmp(); const c = path.join(tmp(), 'not-created-yet');
    fs.writeFileSync(path.join(b, 'design.md'), 'd');
    const cats = [cat('1', 'Alpha', a), cat('2', 'Beta', b), cat('3', 'Gamma', c)];
    const text = buildIndex(cats, '1', resolve);
    expect(text).toContain('## Beta');
    expect(text).toContain('## Gamma');
    expect(text).not.toContain('## Alpha');
    expect(text).toContain('does not exist yet');
    const written = refreshIndexes(cats, resolve);
    expect(written).toHaveLength(3);
    for (const root of [a, b, c]) expect(fs.existsSync(path.join(root, INDEX_FILE))).toBe(true);
    expect(fs.readFileSync(path.join(a, INDEX_FILE), 'utf8')).toContain('## Beta');
  });

  it('refreshIndexes creates every vault first, so no index claims a sibling is missing, and never counts the index itself', () => {
    const base = tmp();
    const cats = [cat('1', 'Alpha', path.join(base, 'a')), cat('2', 'Beta', path.join(base, 'b'))];
    refreshIndexes(cats, resolve);
    refreshIndexes(cats, resolve); // second run now sees the first run's index files
    const alpha = fs.readFileSync(path.join(base, 'a', INDEX_FILE), 'utf8');
    expect(alpha).not.toContain('does not exist yet');
    expect(alpha).toMatch(/## Beta[\s\S]*- Files: 0/);
    expect(alpha).toMatch(/Top level: _\(empty\)_/);
  });

  it('digest mentions the other vaults and stays within the size cap', () => {
    const a = tmp(); const b = tmp();
    for (let i = 0; i < 80; i++) fs.writeFileSync(path.join(a, `very-long-note-name-number-${i}.md`), 'x');
    const cats = [cat('1', 'Alpha', a), cat('2', 'Beta', b)];
    const d = digestFor(cats, '1', resolve);
    expect(d).toContain('Beta');
    expect(d.length).toBeLessThanOrEqual(3000);
    expect(digestFor(cats, null, resolve)).toContain('Alpha');
  });
});
