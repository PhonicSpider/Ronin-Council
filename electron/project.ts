// The "hands" agents get in phase 6: read, change and run things inside ONE project folder.
// Reads run freely; anything that changes files or runs a command is returned as an approval request
// (with the COMPLETE diff or exact command line) and only executes after Widow's audit and the user's approval.
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { ActionRequest } from '../shared/types';
import { safeJoin, validateVaultPath } from './vault';

export interface ToolDef {
  name: string;
  description: string;
  input_schema: { type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties: false };
}
export interface ToolOutput { text: string; detail?: string; isError?: boolean }

export type Prepared =
  | { error: string }
  | { needsApproval: false; label: string; run: (signal?: AbortSignal) => Promise<ToolOutput> }
  | { needsApproval: true; label: string; action: ActionRequest; run: (signal?: AbortSignal) => Promise<ToolOutput> };

const MAX_READ_FILE = 2_000_000; // read_file may open files up to this size, but only returns a window
const MAX_EDIT_FILE = 1_000_000; // write/edit refuse to rewrite files larger than this
const MAX_WRITE = 500_000;
const MAX_RESULT = 20_000; // characters of file content returned to the model per read_file call
export const MAX_PREVIEW = 40_000; // a change whose full diff is longer than this must be split into smaller ones
const MAX_COMMAND = 2_000;
const HEAD_BYTES = 10_000; // command output keeps the first and last 10 KB (build errors are usually at the end)
const TAIL_BYTES = 10_000;
const SKIP_DIRS = new Set(['.git', 'node_modules']);
// Files that commonly hold secrets: never readable, searchable or writable by agents (their text goes to the API).
const SENSITIVE = /(^|[\\/])(\.env[^\\/]*|[^\\/]*\.(pem|key|p12|pfx|keystore|jks)|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|\.npmrc|\.netrc|\.pypirc|credentials(\.[^\\/]*)?|secrets?(\.[^\\/]*)?)$/i;
const RESERVED_DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
// Characters that make a preview misleading (bidi overrides, zero-width, control characters).
const INVISIBLE = /[\u0000-\u0008\u000B-\u001F\u007F­​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

/** Make hidden characters visible so a preview cannot hide what it really contains. */
export const visible = (s: string) => s.replace(INVISIBLE, (c) => `⟦U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}⟧`);

export const TOOL_DEFS: ToolDef[] = [
  {
    name: 'read_file',
    description: 'Read a text file inside the project folder. Free to use; no approval needed. Long files are returned in windows of about 20,000 characters; use start_line/end_line (1-based) to read further.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to the project folder' },
        start_line: { type: 'number', description: 'First line to return (1-based)' },
        end_line: { type: 'number', description: 'Last line to return (inclusive)' },
      },
      required: ['path'], additionalProperties: false,
    },
  },
  {
    name: 'list_files',
    description: 'List files and folders inside the project folder (skips .git and node_modules). No approval needed.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Folder relative to the project folder; default "."' },
        recursive: { type: 'boolean', description: 'Include subfolders (up to 4 levels deep)' },
      },
      required: [], additionalProperties: false,
    },
  },
  {
    name: 'search_files',
    description: 'Find text (case-insensitive, literal) in project files. Returns path:line: text. No approval needed.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' }, path: { type: 'string', description: 'Folder to search; default "."' } },
      required: ['query'], additionalProperties: false,
    },
  },
  {
    name: 'write_file',
    description: 'Create or fully overwrite a file. REQUIRES approval: Widow audits it and the user sees the complete diff before anything is written. Prefer edit_file for small changes. Changes too large to review in full are refused; split them up.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string', description: 'Complete new file content' } },
      required: ['path', 'content'], additionalProperties: false,
    },
  },
  {
    name: 'edit_file',
    description: 'Replace one exact piece of text in a file. old_text must match exactly once. REQUIRES approval (Widow audit, then the user sees the complete diff).',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } },
      required: ['path', 'old_text', 'new_text'], additionalProperties: false,
    },
  },
  {
    name: 'run_command',
    description: 'Run a single-line shell command in the project folder (build, tests, git, ...). REQUIRES approval: Widow audits it and the user sees the exact command first. Keep commands short-lived and non-interactive; chain with && or ;.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeout_seconds: { type: 'number', description: 'Default 120, max 600' },
      },
      required: ['command'], additionalProperties: false,
    },
  },
];

export const TOOL_NAMES = new Set(TOOL_DEFS.map((t) => t.name));

/** '' (talk-only) or an existing absolute folder that is not a drive root or the home folder. */
export function validateProjectPath(input: string): string {
  const p = validateVaultPath(input);
  if (p && !(fs.existsSync(p) && fs.statSync(p).isDirectory())) throw new Error('The project folder must be an existing folder');
  return p;
}

/** Refuses a project folder that is, contains, or sits inside the app's own data or a system folder. */
export function assertProjectPathAllowed(p: string, protectedRoots: (string | undefined)[]): void {
  if (!p) return;
  const canon = (x: string) => {
    let r = x;
    try { r = fs.realpathSync.native(x); } catch { r = path.resolve(x); }
    return r.replace(/[\\/]+$/, '').toLowerCase();
  };
  const proj = canon(p);
  for (const raw of protectedRoots) {
    if (!raw) continue;
    const root = canon(raw);
    if (proj === root || proj.startsWith(root + path.sep) || root.startsWith(proj + path.sep)) {
      throw new Error("That folder overlaps this app's own data or a system folder, so agents cannot be given access to it");
    }
  }
}

// ---------- path handling ----------
function str(input: unknown, key: string, opts: { optional?: boolean; max?: number } = {}): string {
  const v = (input as Record<string, unknown> | null)?.[key];
  if (v === undefined && opts.optional) return '';
  if (typeof v !== 'string') throw new Error(`"${key}" must be a string`);
  if (opts.max !== undefined && v.length > opts.max) throw new Error(`"${key}" is too long (max ${opts.max} characters)`);
  return v;
}

function whole(input: unknown, key: string): number | undefined {
  const v = (input as Record<string, unknown> | null)?.[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 1) throw new Error(`"${key}" must be a number 1 or higher`);
  return Math.floor(v);
}

const segments = (rel: string) => rel.split(/[\\/]/).filter(Boolean);

/** Real path of `full` even if it does not exist yet (the nearest existing ancestor is resolved, expanding case and 8.3 names). */
function canonical(full: string): string {
  let probe = full;
  const rest: string[] = [];
  while (!fs.existsSync(probe)) {
    const up = path.dirname(probe);
    if (up === probe) break;
    rest.unshift(path.basename(probe));
    probe = up;
  }
  return path.join(fs.realpathSync.native(probe), ...rest);
}

interface Target { full: string; rel: string }

/**
 * Resolve an agent-supplied path to a real location inside the project, or throw.
 * Protection checks use the CANONICAL relative path, so aliases (case, 8.3 short names, links) cannot dodge them.
 */
function resolveTarget(root: string, input: string): Target {
  if (!input.trim()) throw new Error('A path is required');
  const rootReal = fs.realpathSync.native(root);
  const full = safeJoin(root, input, 'project folder');
  // Windows-only tricks that name the same file differently from how it looks.
  for (const seg of segments(path.relative(rootReal, full))) {
    if (seg.includes(':')) throw new Error(`"${seg}" is not an allowed name (alternate data streams and drive prefixes are refused)`);
    if (/[. ]$/.test(seg) && seg !== '.' && seg !== '..') throw new Error(`"${seg}" ends with a dot or space, which Windows treats as a different name`);
    if (RESERVED_DEVICE.test(seg)) throw new Error(`"${seg}" is a reserved device name`);
  }
  const real = canonical(full);
  const relative = path.relative(rootReal, real);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Path is outside the project folder');
  return { full: real, rel: (relative || '.').split(path.sep).join('/') };
}

const isProtectedDir = (rel: string) => segments(rel).some((s) => SKIP_DIRS.has(s.toLowerCase()));
export const isSensitive = (rel: string) => SENSITIVE.test(rel);

function guardRead(rel: string) {
  if (isSensitive(rel)) throw new Error(`${rel} may contain secrets, so it is off limits`);
  if (isProtectedDir(rel)) throw new Error(`${rel} is in a protected folder (.git / node_modules)`);
}
function guardWrite(rel: string) {
  guardRead(rel);
}

/**
 * Refuse to write through a symbolic link or junction ANYWHERE in the path (not just the last part).
 * A dangling link cannot be resolved, so it would otherwise look like a missing folder and a write
 * through it could create files outside the project.
 */
function assertNoLink(root: string, full: string) {
  const rootReal = fs.realpathSync.native(root);
  let cur = rootReal;
  for (const seg of segments(path.relative(rootReal, full))) {
    cur = path.join(cur, seg);
    try {
      if (fs.lstatSync(cur).isSymbolicLink()) throw new Error(`Refusing to write through a symbolic link or junction (${seg})`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; // nothing further exists, so nothing further can be a link
      throw e;
    }
  }
}

function readText(full: string, rel: string, opts: { max: number; strict?: boolean }): string {
  const stat = fs.statSync(full);
  if (!stat.isFile()) throw new Error(`${rel} is not a file`);
  if (stat.size > opts.max) throw new Error(`${rel} is too large (${stat.size} bytes, limit ${opts.max}).`);
  const buf = fs.readFileSync(full);
  if (buf.includes(0)) throw new Error(`${rel} looks like a binary file`);
  const text = buf.toString('utf8');
  // Rewriting a file that is not valid UTF-8 would silently destroy its non-ASCII bytes.
  if (opts.strict && !Buffer.from(text, 'utf8').equals(buf)) throw new Error(`${rel} is not valid UTF-8, so changing it could corrupt it`);
  return text;
}

const usesCrlfOnly = (text: string) => text.includes('\r\n') && !/(?<!\r)\n/.test(text);
const toEol = (s: string, crlf: boolean) => (crlf ? s.replace(/\r?\n/g, '\r\n') : s);

function countOverlapping(hay: string, needle: string): number {
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) n++;
  return n;
}

/** Compact line diff: trims the common start and end, shows 3 lines of context around the change. Hidden characters are made visible. */
export function diffText(before: string, after: string, maxLines = 5000): string {
  if (before === after) return '(no changes)';
  const a = before === '' ? [] : before.split(/\r?\n/); // an empty file has no lines (not one empty line)
  const b = after === '' ? [] : after.split(/\r?\n/);
  if (a.length === b.length && a.every((l, i) => l === b[i])) return '(only the line endings differ)';
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) { endA--; endB--; }
  const ctx = 3;
  const out: string[] = [`@@ line ${Math.max(1, start - ctx + 1)} @@`];
  for (let i = Math.max(0, start - ctx); i < start; i++) out.push(` ${visible(a[i])}`);
  for (let i = start; i <= endA; i++) out.push(`-${visible(a[i])}`);
  for (let i = start; i <= endB; i++) out.push(`+${visible(b[i])}`);
  for (let i = endA + 1; i <= Math.min(a.length - 1, endA + ctx); i++) out.push(` ${visible(a[i])}`);
  if (out.length > maxLines) return `${out.slice(0, maxLines).join('\n')}\n… (${out.length - maxLines} more lines)`;
  return out.join('\n');
}

/** The preview must be complete: what the user and Widow review is exactly what will be written. */
function completePreview(header: string, rootReal: string, diff: string): string {
  const preview = `Project: ${rootReal}\n${header}\n${diff}`;
  if (preview.length > MAX_PREVIEW) {
    throw new Error(`This change is too large to review in full (${preview.length} characters, limit ${MAX_PREVIEW}). Split it into smaller edits.`);
  }
  return preview;
}

// ---------- running commands ----------
export function scrubbedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)/i.test(k)) env[k] = v;
  return env;
}

export function killTree(pid: number | undefined, fallback: () => void) {
  if (pid && process.platform === 'win32') {
    try {
      const k = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      k.on('error', fallback);
      return;
    } catch { /* fall through */ }
  }
  fallback();
}

export function runShell(root: string, command: string, timeoutMs: number, signal?: AbortSignal): Promise<ToolOutput> {
  return new Promise((resolve) => {
    let head = Buffer.alloc(0);
    let tail = Buffer.alloc(0);
    let total = 0;
    let why: string | null = null;
    let done = false;
    let graceTimer: NodeJS.Timeout | undefined;
    const child = spawn(command, { shell: true, cwd: root, env: scrubbedEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const add = (d: Buffer) => {
      total += d.length;
      let rest = d;
      if (head.length < HEAD_BYTES) {
        const take = Math.min(HEAD_BYTES - head.length, rest.length);
        head = Buffer.concat([head, rest.subarray(0, take)]);
        rest = rest.subarray(take);
      }
      if (rest.length) tail = Buffer.concat([tail, rest]).subarray(-TAIL_BYTES);
    };
    child.stdout?.on('data', add);
    child.stderr?.on('data', add);
    const output = () => {
      const omitted = total - head.length - tail.length;
      return omitted > 0
        ? `${head.toString('utf8')}\n[… ${omitted} bytes omitted …]\n${tail.toString('utf8')}`
        : head.toString('utf8') + tail.toString('utf8');
    };
    const finish = (text: string, isError: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      signal?.removeEventListener('abort', onAbort);
      const out = output();
      const body = `${text}${out ? `\n${out}` : ''}`;
      resolve({ text: body, detail: body, isError });
    };
    const kill = (reason: string) => {
      if (why) return;
      why = reason;
      killTree(child.pid, () => child.kill('SIGKILL'));
      // If the process tree cannot be killed or keeps the pipes open, stop waiting rather than hang the agent.
      graceTimer = setTimeout(() => finish(`stopped (${reason}), but the process did not exit cleanly`, true), 3000);
    };
    const timer = setTimeout(() => kill(`timed out after ${Math.round(timeoutMs / 1000)}s`), timeoutMs);
    const onAbort = () => kill('stopped by the user');
    if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => finish(`Could not start the command: ${e.message}`, true));
    child.on('close', (code) => finish(`exit code ${code}${why ? ` (${why})` : ''}`, code !== 0 || !!why));
  });
}

// ---------- the tools ----------
export function prepareTool(root: string, name: string, input: unknown): Prepared {
  try {
    return prepare(root, name, input);
  } catch (e) {
    return { error: (e as Error).message };
  }
}

function prepare(root: string, name: string, input: unknown): Prepared {
  switch (name) {
    case 'read_file': {
      const { full, rel } = resolveTarget(root, str(input, 'path'));
      guardRead(rel);
      const text = readText(full, rel, { max: MAX_READ_FILE });
      const start = whole(input, 'start_line');
      const end = whole(input, 'end_line');
      let result = text;
      if (start !== undefined || end !== undefined || text.length > MAX_RESULT) {
        const lines = text.split('\n');
        const from = start ?? 1;
        if (from > lines.length) throw new Error(`${rel} has only ${lines.length} lines`);
        const to = Math.min(lines.length, end ?? lines.length);
        let chunk = lines.slice(from - 1, to).join('\n');
        let shownTo = to;
        let cut = false;
        if (chunk.length > MAX_RESULT) {
          chunk = chunk.slice(0, MAX_RESULT);
          const nl = chunk.lastIndexOf('\n');
          if (nl > 0) chunk = chunk.slice(0, nl);
          shownTo = from + chunk.split('\n').length - 1;
          cut = true;
        }
        result = `${chunk}\n[Lines ${from}-${shownTo} of ${lines.length}${cut || shownTo < lines.length ? '. Call read_file with start_line/end_line to read more' : ''}.]`;
      }
      return { needsApproval: false, label: `read ${rel}`, run: async () => ({ text: result }) };
    }

    case 'list_files': {
      const { full, rel } = resolveTarget(root, str(input, 'path', { optional: true }) || '.');
      if (isProtectedDir(rel)) throw new Error(`${rel} is in a protected folder (.git / node_modules)`);
      if (!fs.statSync(full).isDirectory()) throw new Error(`${rel} is not a folder`);
      const recursive = (input as { recursive?: unknown })?.recursive === true;
      const lines: string[] = [];
      let truncated = false;
      const walk = (dir: string, prefix: string, depth: number) => {
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        entries.sort((x, y) => x.name.localeCompare(y.name));
        for (const e of entries) {
          if (truncated) return;
          if (SKIP_DIRS.has(e.name.toLowerCase())) continue;
          if (lines.length >= 300) { truncated = true; return; }
          if (e.isDirectory()) {
            lines.push(`${prefix}${e.name}/`);
            if (recursive && depth < 4) walk(path.join(dir, e.name), `${prefix}${e.name}/`, depth + 1);
          } else if (e.isFile() && !isSensitive(e.name)) {
            lines.push(`${prefix}${e.name}`);
          }
        }
      };
      walk(full, '', 1);
      const text = lines.length ? lines.join('\n') + (truncated ? '\n[List truncated at 300 entries. List a subfolder to see more.]' : '') : '(empty)';
      return { needsApproval: false, label: `listed ${rel}`, run: async () => ({ text }) };
    }

    case 'search_files': {
      const query = str(input, 'query', { max: 200 });
      if (!query) throw new Error('"query" must not be empty');
      const { full, rel } = resolveTarget(root, str(input, 'path', { optional: true }) || '.');
      if (isProtectedDir(rel)) throw new Error(`${rel} is in a protected folder (.git / node_modules)`);
      const needle = query.toLowerCase();
      const hits: string[] = [];
      const rootReal = fs.realpathSync.native(root);
      let scanned = 0;
      let skipped = 0;
      let bytes = 0;
      let stoppedEarly = false;
      const walk = (dir: string) => {
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (stoppedEarly) return;
          if (hits.length >= 100 || scanned >= 3000 || bytes >= 30_000_000) { stoppedEarly = true; return; }
          if (SKIP_DIRS.has(e.name.toLowerCase())) continue;
          const p = path.join(dir, e.name);
          if (e.isDirectory()) { walk(p); continue; }
          if (!e.isFile() || isSensitive(e.name)) continue;
          scanned++;
          let buf: Buffer;
          try {
            const size = fs.statSync(p).size;
            if (size > 1_000_000) { skipped++; continue; }
            bytes += size;
            buf = fs.readFileSync(p);
          } catch { skipped++; continue; }
          if (buf.includes(0)) { skipped++; continue; }
          const lines = buf.toString('utf8').split('\n');
          for (let i = 0; i < lines.length && hits.length < 100; i++) {
            if (lines[i].toLowerCase().includes(needle)) {
              hits.push(`${path.relative(rootReal, p).split(path.sep).join('/')}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
            }
          }
        }
      };
      walk(full);
      const notes = [
        hits.length >= 100 ? 'results truncated at 100' : '',
        stoppedEarly ? 'search stopped at a size/file limit, so some files were not searched' : '',
        skipped ? `${skipped} file(s) skipped (binary, unreadable or over 1 MB)` : '',
      ].filter(Boolean);
      const text = `${hits.length ? hits.join('\n') : 'No matches.'}\n[Searched ${scanned} file(s)${notes.length ? `; ${notes.join('; ')}` : ''}.]`;
      return { needsApproval: false, label: `searched ${rel} for "${query.slice(0, 40)}"`, run: async () => ({ text }) };
    }

    case 'write_file': {
      const inputPath = str(input, 'path');
      const target = resolveTarget(root, inputPath);
      guardWrite(target.rel);
      assertNoLink(root, target.full);
      const rootReal = fs.realpathSync.native(root);
      let content = str(input, 'content', { max: MAX_WRITE });
      const existed = fs.existsSync(target.full);
      if (existed && !fs.statSync(target.full).isFile()) throw new Error(`${target.rel} is not a file`);
      const before = existed ? readText(target.full, target.rel, { max: MAX_EDIT_FILE, strict: true }) : null;
      // Keep the file's existing line endings instead of silently converting them.
      if (before !== null && usesCrlfOnly(before)) content = toEol(content, true);
      const lineCount = content === '' ? 0 : content.split('\n').length;
      const header = before === null ? `New file ${target.rel} (${lineCount} line${lineCount === 1 ? '' : 's'})` : `Overwrite ${target.rel}`;
      const preview = completePreview(header, rootReal, diffText(before ?? '', content));
      const verb = before === null ? 'Create' : 'Overwrite';
      return {
        needsApproval: true, label: `${verb.toLowerCase()} ${target.rel}`,
        action: { tool: 'write_file', summary: `${verb} ${visible(target.rel)}`, preview },
        run: async () => {
          // The world may have changed while the user was deciding: re-validate everything.
          const again = resolveTarget(root, inputPath);
          if (again.full !== target.full) throw new Error('The path now resolves somewhere else. Refusing.');
          guardWrite(again.rel);
          assertNoLink(root, again.full);
          const now = fs.existsSync(again.full) ? readText(again.full, again.rel, { max: MAX_EDIT_FILE, strict: true }) : null;
          if (now !== before) throw new Error(`${target.rel} changed after this request was made. Read it again and ask again.`);
          fs.mkdirSync(path.dirname(again.full), { recursive: true });
          if (path.dirname(canonical(again.full)) !== path.dirname(again.full)) throw new Error('The folder now resolves somewhere else. Refusing.');
          fs.writeFileSync(again.full, content, 'utf8');
          return { text: `Wrote ${Buffer.byteLength(content)} bytes to ${target.rel}`, detail: preview };
        },
      };
    }

    case 'edit_file': {
      const inputPath = str(input, 'path');
      const target = resolveTarget(root, inputPath);
      const oldRaw = str(input, 'old_text', { max: MAX_WRITE });
      const newRaw = str(input, 'new_text', { max: MAX_WRITE });
      guardWrite(target.rel);
      assertNoLink(root, target.full);
      if (!oldRaw) throw new Error('"old_text" must not be empty');
      const rootReal = fs.realpathSync.native(root);
      const before = readText(target.full, target.rel, { max: MAX_EDIT_FILE, strict: true });
      const crlf = usesCrlfOnly(before); // the file uses Windows line endings: match and write them that way
      const oldText = toEol(oldRaw, crlf);
      const newText = toEol(newRaw, crlf);
      const count = countOverlapping(before, oldText);
      if (count !== 1) {
        throw new Error(`old_text must match exactly once in ${target.rel} (found ${count}). Read the file and quote the text exactly, including spaces and indentation.`);
      }
      const after = before.replace(oldText, () => newText);
      const preview = completePreview(`Edit ${target.rel}`, rootReal, diffText(before, after));
      return {
        needsApproval: true, label: `edit ${target.rel}`,
        action: { tool: 'edit_file', summary: `Edit ${visible(target.rel)}`, preview },
        run: async () => {
          const again = resolveTarget(root, inputPath);
          if (again.full !== target.full) throw new Error('The path now resolves somewhere else. Refusing.');
          guardWrite(again.rel);
          assertNoLink(root, again.full);
          if (readText(again.full, again.rel, { max: MAX_EDIT_FILE, strict: true }) !== before) {
            throw new Error(`${target.rel} changed after this request was made. Read it again and ask again.`);
          }
          fs.writeFileSync(again.full, after, 'utf8');
          return { text: `Edited ${target.rel}`, detail: preview };
        },
      };
    }

    case 'run_command': {
      const command = str(input, 'command', { max: MAX_COMMAND }).trim();
      if (!command) throw new Error('"command" must not be empty');
      // One visible line only: what the user reads must be exactly what runs (cmd.exe stops at the first newline).
      if (/[\u0000-\u0008\u000A-\u001F\u007F]/.test(command)) {
        throw new Error('Commands must be a single line with no control characters. Chain steps with && or ;.');
      }
      const t = (input as { timeout_seconds?: unknown })?.timeout_seconds;
      const seconds = typeof t === 'number' && Number.isFinite(t) ? Math.min(600, Math.max(1, t)) : 120;
      const rootReal = fs.realpathSync.native(root);
      const shown = visible(command);
      const nonAscii = /[^ -~\t]/.test(command) ? '\n⚠ This command contains non-ASCII characters. Check it carefully.' : '';
      return {
        needsApproval: true, label: `run ${shown.slice(0, 60)}`,
        action: { tool: 'run_command', summary: `Run: ${shown.slice(0, 80)}`, preview: `$ ${shown}\n(in ${rootReal}, timeout ${seconds}s)${nonAscii}` },
        run: (signal) => runShell(rootReal, command, seconds * 1000, signal),
      };
    }

    default:
      throw new Error(`Unknown tool "${name}"`);
  }
}
