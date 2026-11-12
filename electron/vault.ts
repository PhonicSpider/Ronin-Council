import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Category, LIBRARIAN_ID, WIDOW_ID } from '../shared/types';

export const INDEX_FILE = '_Other Vaults.md';
const SKIP_DIRS = new Set(['node_modules', '.git', '.obsidian', '.trash']);
const TEXT_EXT = /\.(md|txt|json|cs|ts|tsx|js|py|yaml|yml|csv)$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;
const MAX_TEXT = 1_000_000;
const MAX_IMAGE = 5_000_000;

export type Resolver = (cat: Category) => string;

export function resolveVaultPath(cat: Category, defaultRoot: string): string {
  // Keyed by id, not name, so renaming a category never orphans its default vault.
  return cat.vaultPath || path.join(defaultRoot, cat.id);
}

/** Resolve `rel` inside `root`, refusing anything that escapes it (including via symlinks). */
export function safeJoin(root: string, rel: string, what = 'vault'): string {
  const rootReal = fs.existsSync(root) ? fs.realpathSync(root) : path.resolve(root);
  const full = path.resolve(rootReal, rel);
  if (full !== rootReal && !full.startsWith(rootReal + path.sep)) throw new Error(`Path is outside the ${what}`);
  // Resolve symlinks/junctions on the nearest existing ancestor, so a file that does not exist yet
  // cannot be created through a link that points outside the vault.
  let probe = full;
  while (!fs.existsSync(probe) && probe !== rootReal) probe = path.dirname(probe);
  if (fs.existsSync(probe)) {
    const real = fs.realpathSync(probe);
    if (real !== rootReal && !real.startsWith(rootReal + path.sep)) throw new Error(`Path is outside the ${what}`);
  }
  return full;
}

/** Accepts '' (use the default location) or an absolute folder that is not a drive root or the home folder. */
export function validateVaultPath(input: string): string {
  const t = input.trim();
  if (!t) return '';
  if (!path.isAbsolute(t)) throw new Error('The path must be an absolute folder path');
  const resolved = path.resolve(t);
  if (path.parse(resolved).root === resolved) throw new Error('Choose a folder, not a drive root');
  if (resolved.toLowerCase() === os.homedir().toLowerCase()) throw new Error('Choose a folder inside your home folder, not the home folder itself');
  if (fs.existsSync(resolved) && !fs.statSync(resolved).isDirectory()) throw new Error('The path must be a folder');
  return resolved;
}

/** Relative (posix) paths of viewable files, breadth-first, capped. */
export function listFiles(root: string, limit = 300): string[] {
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  const queue: string[] = [''];
  while (queue.length && out.length < limit) {
    const dir = queue.shift()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) queue.push(rel);
      else if (e.isFile() && (TEXT_EXT.test(e.name) || IMAGE_EXT.test(e.name))) {
        out.push(rel);
        if (out.length >= limit) break;
      }
    }
  }
  return out;
}

export interface VaultFile { name: string; kind: 'text' | 'image'; content: string }

export function readVaultFile(root: string, rel: string): VaultFile {
  const full = safeJoin(root, rel);
  const stat = fs.statSync(full);
  if (!stat.isFile()) throw new Error('Not a file');
  const name = path.basename(full);
  if (IMAGE_EXT.test(name)) {
    if (stat.size > MAX_IMAGE) throw new Error('Image is too large to preview (5 MB max)');
    const ext = path.extname(name).slice(1).toLowerCase();
    const mime = ext === 'svg' ? 'image/svg+xml' : `image/${ext === 'jpg' ? 'jpeg' : ext}`;
    return { name, kind: 'image', content: `data:${mime};base64,${fs.readFileSync(full).toString('base64')}` };
  }
  if (!TEXT_EXT.test(name)) throw new Error('Unsupported file type');
  if (stat.size > MAX_TEXT) throw new Error('File is too large to preview (1 MB max)');
  return { name, kind: 'text', content: fs.readFileSync(full, 'utf8') };
}

/** A note path an agent may ask to write: markdown, inside the vault, no hidden folders (Obsidian's settings live in .obsidian), not the generated index. */
export function validateNoteRel(raw: string): string {
  const rel = raw.replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (!rel || rel.length > 200 || !/\.md$/i.test(rel)) throw new Error('Notes must be .md files, for example "Reports/backend-audit.md"');
  // eslint-disable-next-line no-control-regex
  if (rel.split('/').some((s) => !s || s.startsWith('.') || /[<>:"|?*\u0000-\u001f]/.test(s))) {
    throw new Error('That note path is not allowed (no empty parts, hidden folders, or special characters)');
  }
  if (rel === INDEX_FILE) throw new Error('That file is generated automatically; choose another name');
  return rel;
}

/** All agents may read any vault. Agents' notes are written here only after Widow's audit and the user's approval. */
export function writeVaultNote(root: string, rel: string, content: string, actorId: string): void {
  if (actorId !== LIBRARIAN_ID && actorId !== WIDOW_ID) {
    throw new Error('Only the Librarian or Widow can write to a vault');
  }
  if (!/\.md$/i.test(rel)) throw new Error('Only .md notes can be written');
  const full = safeJoin(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

/** Number of viewable files, not counting the generated cross-vault index itself. */
const countNotes = (root: string) => listFiles(root, 1000).filter((f) => f !== INDEX_FILE).length;

function topLevel(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => !e.name.startsWith('.') && !SKIP_DIRS.has(e.name) && e.name !== INDEX_FILE)
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort()
      .slice(0, 15);
  } catch { return []; }
}

export function buildIndex(categories: Category[], selfId: string, resolve: Resolver, now = new Date()): string {
  const self = categories.find((c) => c.id === selfId);
  const lines = [
    '# Other Vaults',
    `_Generated by the Librarian, verified by Widow. Last refreshed: ${now.toISOString().slice(0, 10)}._`,
    '',
    `You are working in **${self?.name ?? 'this project'}**. These are the other project vaults you can read:`,
    '',
  ];
  for (const c of categories.filter((x) => x.id !== selfId)) {
    const root = resolve(c);
    const exists = fs.existsSync(root);
    lines.push(`## ${c.name}`);
    lines.push(`- Location: \`${root}\`${exists ? '' : ' _(folder does not exist yet)_'}`);
    lines.push(`- Files: ${exists ? countNotes(root) : 0}`);
    const top = topLevel(root);
    lines.push(`- Top level: ${top.length ? top.join(', ') : '_(empty)_'}`);
    lines.push(`- Relationship to ${self?.name ?? 'this project'}: _Widow to confirm how this project relates._`);
    lines.push('');
  }
  return lines.join('\n');
}

/** Write a fresh `_Other Vaults.md` into every category's vault. Returns the files written. */
export function refreshIndexes(categories: Category[], resolve: Resolver): string[] {
  const written: string[] = [];
  // Create every vault folder first so each index describes the others accurately.
  for (const c of categories) fs.mkdirSync(resolve(c), { recursive: true });
  for (const c of categories) {
    const root = resolve(c);
    writeVaultNote(root, INDEX_FILE, buildIndex(categories, c.id, resolve), LIBRARIAN_ID);
    written.push(path.join(root, INDEX_FILE));
  }
  return written;
}

/** Compact text for agent prompts: this vault's files, plus a one-line summary of each other vault. */
export function digestFor(categories: Category[], categoryId: string | null, resolve: Resolver): string {
  const parts: string[] = [];
  const self = categories.find((c) => c.id === categoryId);
  if (self) {
    const root = resolve(self);
    const files = listFiles(root, 40);
    parts.push(`This project's vault (${self.name}) has ${files.length ? files.length + '+' : 'no'} files: ${files.join(', ') || '(empty)'}`);
  }
  const others = categories.filter((c) => c.id !== categoryId);
  if (others.length) {
    parts.push(`Other project vaults you may read: ${others.map((c) => `${c.name} (${countNotes(resolve(c))} files)`).join('; ')}`);
  }
  if (self) {
    try {
      const idx = path.join(resolve(self), INDEX_FILE);
      if (fs.existsSync(idx)) parts.push(`Cross-vault index:\n${fs.readFileSync(idx, 'utf8').slice(0, 1200)}`);
    } catch { /* optional */ }
  }
  return (parts.join('\n') || '(no vaults configured)').slice(0, 3000);
}
