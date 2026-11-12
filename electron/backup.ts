import * as fs from 'fs';
import * as path from 'path';
import type { Store } from './store';

/**
 * Backups of the council: the database (agents, channels, chats, notes, settings) and the attached files.
 * Not included: your vault and project folders (they are ordinary folders you already own) and the API key
 * (it stays in the operating system's secure storage, so a backup file never contains it).
 */

export type BackupKind = 'manual' | 'auto' | 'before-restore';

export interface BackupInfo {
  name: string;
  kind: BackupKind;
  /** When it was made, as milliseconds since 1970. */
  ts: number;
  bytes: number;
}

const NAME_RE = /^(manual|auto|before-restore)-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-(\d{1,3}))?$/;
const KEEP: Partial<Record<BackupKind, number>> = { auto: 7, 'before-restore': 3 }; // manual backups are never pruned
const AUTO_EVERY_MS = 20 * 3600 * 1000;

const pad = (n: number) => String(n).padStart(2, '0');

function stamp(d: Date): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function parseName(name: string): { kind: BackupKind; ts: number } | null {
  const m = NAME_RE.exec(name);
  if (!m) return null;
  const ts = new Date(+m[2]!, +m[3]! - 1, +m[4]!, +m[5]!, +m[6]!, +m[7]!).getTime();
  return Number.isFinite(ts) ? { kind: m[1] as BackupKind, ts } : null;
}

function sizeOf(p: string): number {
  let total = 0;
  try {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const full = path.join(p, e.name);
      total += e.isDirectory() ? sizeOf(full) : e.isFile() ? fs.statSync(full).size : 0;
    }
  } catch { /* unreadable: counts as empty */ }
  return total;
}

export function listBackups(root: string): BackupInfo[] {
  let names: string[];
  try { names = fs.readdirSync(root); } catch { return []; }
  const out: BackupInfo[] = [];
  for (const name of names) {
    const meta = parseName(name);
    if (!meta) continue;
    const dir = path.join(root, name);
    try { if (!fs.statSync(dir).isDirectory() || !fs.existsSync(path.join(dir, 'council.json'))) continue; } catch { continue; }
    out.push({ name, kind: meta.kind, ts: meta.ts, bytes: sizeOf(dir) });
  }
  return out.sort((a, b) => b.ts - a.ts || b.name.localeCompare(a.name));
}

/** Copies the database and attachments into a new, finished-or-absent folder (never a half-written one). */
export function createBackup(store: Store, root: string, kind: BackupKind, now = new Date()): BackupInfo {
  const dbFile = store.dbFile;
  const dataDir = store.dir;
  if (!dbFile || !dataDir) throw new Error('Nothing to back up: this council is not saved to disk');
  store.flush();
  if (!fs.existsSync(dbFile)) throw new Error('The council has not been saved yet');
  fs.mkdirSync(root, { recursive: true });

  let name = `${kind}-${stamp(now)}`;
  for (let i = 2; fs.existsSync(path.join(root, name)); i++) name = `${kind}-${stamp(now)}-${i}`;
  const final = path.join(root, name);
  const partial = `${final}.partial`;
  fs.rmSync(partial, { recursive: true, force: true });
  try {
    fs.mkdirSync(partial);
    fs.copyFileSync(dbFile, path.join(partial, 'council.json'));
    const att = path.join(dataDir, 'attachments');
    if (fs.existsSync(att)) fs.cpSync(att, path.join(partial, 'attachments'), { recursive: true });
    fs.renameSync(partial, final);
  } catch (e) {
    fs.rmSync(partial, { recursive: true, force: true });
    throw new Error(`The backup could not be written: ${(e as Error).message}`);
  }
  const info = listBackups(root).find((b) => b.name === name);
  if (!info) throw new Error('The backup could not be verified');
  return info;
}

/** Keeps only the newest few automatic backups (and safety copies made before restores). */
export function pruneBackups(root: string) {
  const all = listBackups(root);
  for (const kind of Object.keys(KEEP) as BackupKind[]) {
    for (const b of all.filter((x) => x.kind === kind).slice(KEEP[kind]!)) {
      fs.rmSync(path.join(root, b.name), { recursive: true, force: true });
    }
  }
}

/** Makes an automatic backup when the newest one is more than about a day old. Never throws. */
export function autoBackupIfDue(store: Store, root: string, now = new Date()): BackupInfo | null {
  try {
    if (!store.dbFile) return null;
    const newest = listBackups(root)[0];
    if (newest && now.getTime() - newest.ts < AUTO_EVERY_MS) return null;
    const made = createBackup(store, root, 'auto', now);
    pruneBackups(root);
    return made;
  } catch (e) {
    console.error('auto backup failed:', (e as Error).message);
    return null;
  }
}

/**
 * Puts a backup back in place of the current council. A safety copy of the current state is taken first, so a restore
 * can itself be undone. Throws before changing anything if the backup is unreadable.
 */
export function restoreBackup(store: Store, root: string, name: string): { safety: BackupInfo } {
  if (!parseName(name)) throw new Error('Unknown backup');
  const dir = path.join(root, name);
  const dataDir = store.dir;
  if (!dataDir) throw new Error('Nothing to restore into');
  let json: string;
  try { json = fs.readFileSync(path.join(dir, 'council.json'), 'utf8'); } catch { throw new Error('That backup is missing or damaged'); }
  try {
    const raw = JSON.parse(json) as { agents?: unknown; categories?: unknown; channels?: unknown };
    if (!Array.isArray(raw.agents) || !Array.isArray(raw.categories) || !Array.isArray(raw.channels)) throw new Error('shape');
  } catch { throw new Error('That backup is not a council database'); }

  const safety = createBackup(store, root, 'before-restore');
  // Files first, then the database that refers to them.
  const att = path.join(dir, 'attachments');
  if (fs.existsSync(att)) fs.cpSync(att, path.join(dataDir, 'attachments'), { recursive: true, force: true });
  store.restore(json);
  pruneBackups(root);
  return { safety };
}
