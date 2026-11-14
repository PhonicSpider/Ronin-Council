// The Local models manager: finds Ollama on any drive, starts and stops it, lists and downloads models, checks for updates and
// installs or removes it. Everything here starts from a click in the Local models popup; no agent can reach any of it.
//
// Windows-specific work (registry, processes, signatures, graphics cards, spawning) sits behind OllamaSystem so the rules can be
// tested with fakes. Ollama's own API is only ever called on this computer.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import {
  CATALOG, CATALOG_CHECKED, catalogEntry, compareVersions, estimateMemoryBytes, fitFor, GIB, GpuInfo, Hardware, InstallSource,
  isOllamaModelName, OllamaBusy, OllamaCatalogRow, OllamaDownload, OllamaInstall, OllamaLatest, OllamaModelRow, OllamaPlan,
  OllamaPull, OllamaState, parseVersion, formatSize,
} from '../shared/ollama';
import { isLoopbackHost } from '../shared/vendors';

// ---------- the part that touches Windows ----------

export interface UninstallEntry { name: string; version: string | null; installLocation: string | null; uninstallString: string | null }
export interface ProcInfo { pid: number; name: string; exePath: string | null }

export interface OllamaSystem {
  /** Root folders of the fixed drives, such as "C:\\". */
  fixedDrives(): Promise<string[]>;
  /** Entries of the Windows uninstall list whose name starts with "Ollama". */
  uninstallEntries(): Promise<UninstallEntry[]>;
  /** Running processes named ollama.exe or ollama app.exe. */
  processes(): Promise<ProcInfo[]>;
  pathDirs(): string[];
  /** A user environment variable as saved in Windows (not this process's copy). */
  userEnv(name: string): Promise<string | null>;
  /** A program's version from its file properties. Never runs it. */
  fileVersion(file: string): Promise<string | null>;
  signature(file: string): Promise<{ status: string; subject: string | null }>;
  gpus(): Promise<GpuInfo[]>;
  ramBytes(): number;
  freeRamBytes(): number;
  freeDiskBytes(dir: string): Promise<number | null>;
  /** Starts `ollama serve` hidden. */
  startServer(exe: string, env?: NodeJS.ProcessEnv): { pid: number | null; onExit(cb: () => void): void };
  kill(pids: number[]): Promise<void>;
  /** Runs a program in its own window and waits for it to exit. Returns the exit code, or null if it could not be started. */
  run(exe: string, args: string[], o?: { verbatim?: boolean; env?: NodeJS.ProcessEnv }): Promise<number | null>;
}

export interface OllamaDeps {
  sys: OllamaSystem;
  /** Where downloaded installers are kept. */
  downloadDir: string;
  /** Ollama's API address; always this computer. */
  origin: () => string;
  getSavedDir: () => string;
  setSavedDir: (dir: string) => void;
  addressSaved: () => boolean;
  localAgents: () => { id: string; name: string }[];
  resetAgent: (id: string) => void;
  /** Folders a deletion must never touch (the app's own data, the user's home). */
  protectedDirs: string[];
  home: string;
  localAppData: string;
  fetch?: typeof fetch;
  /** Overridable only by tests. */
  net?: { releaseApi?: string; allowHost?: (host: string) => boolean; looseAssetPath?: boolean };
  timing?: { startMs?: number; stopMs?: number; pollMs?: number; uninstallMs?: number; scanMs?: number; stallMs?: number };
  now?: () => number;
  /** Environment for programs this app starts: the app's own, minus anything that looks like a secret. */
  childEnv: () => NodeJS.ProcessEnv;
  /** A confirmation shown by the main process itself (not the page) before a program is run or removed. True = the user agreed. */
  confirmNative: (o: { title: string; message: string; detail: string; ok: string }) => Promise<boolean>;
}

const EXE = 'ollama.exe';
const PROC_NAMES = ['ollama.exe', 'ollama app.exe'];
const TRUSTED: InstallSource[] = ['registry', 'default', 'saved'];
const RELEASE_API = 'https://api.github.com/repos/ollama/ollama/releases/latest';
const SKIP_DIRS = new Set(['windows', '$recycle.bin', 'system volume information', 'node_modules', '$windows.~bt', 'recovery', 'config.msi']);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const lc = (p: string) => path.resolve(p).toLowerCase();
const inDir = (file: string, dir: string) => { const r = path.relative(lc(dir), lc(file)); return !!r && !r.startsWith('..') && !path.isAbsolute(r); };

/** Reads a reply body, refusing anything larger than `max` bytes (a hostile program on the port could send endless data). */
async function readLimited(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const dec = new TextDecoder();
  let out = '';
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) { void reader.cancel().catch(() => undefined); throw new Error('A reply was larger than expected.'); }
    out += dec.decode(value, { stream: true });
  }
  return out + dec.decode();
}
const readJson = async (res: Response, max = 4_000_000): Promise<unknown> => JSON.parse(await readLimited(res, max));
/** Frees the connection for a reply whose body is not wanted. */
const drop = (res: Response) => { void res.body?.cancel().catch(() => undefined); };

async function isRealFile(p: string): Promise<boolean> {
  try { const s = await fs.promises.lstat(p); return s.isFile() && !s.isSymbolicLink(); } catch { return false; }
}
async function isRealDir(p: string): Promise<boolean> {
  try { const s = await fs.promises.lstat(p); return s.isDirectory() && !s.isSymbolicLink(); } catch { return false; }
}

/** The program path inside a registry uninstall command, quoted or not ("C:\x\unins000.exe" /SILENT). */
export function uninstallExe(cmd: string | null): string | null {
  if (!cmd) return null;
  const s = cmd.trim();
  let p: string | null = null;
  if (s.startsWith('"')) { const end = s.indexOf('"', 1); p = end > 1 ? s.slice(1, end) : null; }
  else { const m = /^(.+?\.exe)(?:\s|$)/i.exec(s); p = m ? m[1] : null; }
  return p && path.isAbsolute(p) && /\.exe$/i.test(p) ? p : null;
}

/** A folder for the installer, typed or picked by the user. Checked because it ends up on a command line. */
export function validInstallDir(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().replace(/[\\/]+$/, '');
  if (s.length < 4 || s.length > 200) return null;
  if (!/^[A-Za-z]:[\\/][A-Za-z0-9 _.()\\/-]+$/.test(s)) return null;
  if (/(^|[\\/])\.\.?([\\/]|$)/.test(s) || /[\\/]{2,}/.test(s.slice(3))) return null;
  // Windows quietly trims a trailing space or dot and reserves some names, so the installed folder could differ from what was shown.
  const segs = s.slice(3).split(/[\\/]/);
  if (segs.some((seg) => !seg || /[ .]$/.test(seg) || /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(seg))) return null;
  return path.normalize(s);
}

/**
 * Checks that a folder is safe to delete as Ollama's models folder. Returns a reason when it is not.
 * It must really look like one (a manifests and a blobs folder), not be a link or a drive root, and not hold anything important.
 */
export async function checkModelsDir(dir: string, protectedDirs: string[], home: string): Promise<string | null> {
  if (!path.isAbsolute(dir)) return 'The models folder is not an absolute path.';
  if (!/^[A-Za-z]:[\\/]/.test(dir)) return 'The models folder must be on a local drive.';
  const resolved = path.resolve(dir);
  if (path.parse(resolved).root.toLowerCase() === resolved.toLowerCase()) return 'The models folder is a drive root.';
  if (!(await isRealDir(resolved))) return 'The models folder is missing or is a link.';
  // Compare real locations, so a short (8.3) name, a link in a parent folder or a network path cannot hide what is being deleted.
  let real: string;
  try { real = await fs.promises.realpath(resolved); } catch { return 'The models folder could not be resolved.'; }
  if (!/^[A-Za-z]:[\\/]/.test(real)) return 'The models folder must be on a local drive.';
  if (lc(real) !== lc(resolved)) return 'The models folder is reached through a link or alias, so it was not touched.';
  for (const p of [home, ...protectedDirs]) {
    if (!p) continue;
    let rp: string;
    try { rp = await fs.promises.realpath(p); } catch { rp = path.resolve(p); }
    const r = path.relative(lc(real), lc(rp));
    if (r === '' || (!r.startsWith('..') && !path.isAbsolute(r))) return 'The models folder holds your home or app folders.';
  }
  for (const sub of ['manifests', 'blobs']) {
    if (!(await isRealDir(path.join(real, sub)))) return 'That folder does not look like an Ollama models folder.';
  }
  let blobs: string[] = [];
  try { blobs = await fs.promises.readdir(path.join(real, 'blobs')); } catch { blobs = []; }
  if (path.basename(real).toLowerCase() !== 'models' && !blobs.some((b) => b.startsWith('sha256-'))) return 'That folder does not look like an Ollama models folder.';
  return null;
}

async function folderBytes(dir: string, budgetMs = 4000): Promise<number | null> {
  const end = Date.now() + budgetMs;
  let total = 0;
  const walk = async (d: string): Promise<boolean> => {
    let items: fs.Dirent[];
    try { items = await fs.promises.readdir(d, { withFileTypes: true }); } catch { return true; }
    for (const it of items) {
      if (Date.now() > end) return false;
      const p = path.join(d, it.name);
      if (it.isSymbolicLink()) continue;
      if (it.isDirectory()) { if (!(await walk(p))) return false; }
      else if (it.isFile()) { try { total += (await fs.promises.stat(p)).size; } catch { /* vanished */ } }
    }
    return true;
  };
  return (await walk(dir)) ? total : null;
}

interface Found { dir: string; sources: Set<InstallSource>; entryVersion: string | null; uninstall: string | null }
interface Pending { action: 'download' | 'uninstall'; args: { dir?: string; deleteModels?: boolean }; expires: number }

export class OllamaManager {
  private f: typeof fetch;
  private now: () => number;
  private found: Found[] = [];
  private scanned = false;
  private detecting: Promise<void> | null = null;
  private latest: OllamaLatest | null = null;
  private latestInstaller: { size: number; sha256: string; url: string; tag: string } | null = null;
  private pullState: OllamaPull | null = null;
  private pullAbort: AbortController | null = null;
  private download: OllamaDownload = { phase: 'idle', tag: '', completed: 0, total: 0 };
  private downloadFile: string | null = null;
  private downloadDirChoice: string | undefined;
  private busy: OllamaBusy = null;
  private error: string | null = null;
  private owned: { pid: number | null } | null = null;
  private tokens = new Map<string, Pending>();
  private hw: { at: number; hardware: Hardware; modelsDir: string; modelsFree: number | null } | null = null;
  private hwPromise: Promise<void> | null = null;
  private versions = new Map<string, Promise<string | null>>();
  private stopWaiting = false;

  constructor(private d: OllamaDeps) {
    this.f = d.fetch ?? fetch;
    this.now = d.now ?? Date.now;
  }

  private get t() { return { startMs: 20_000, stopMs: 8_000, pollMs: 300, uninstallMs: 15 * 60_000, scanMs: 12_000, stallMs: 60_000, ...this.d.timing }; }

  // ---------- Ollama's API (this computer only) ----------

  private base(): string {
    const u = new URL(this.d.origin());
    if (!isLoopbackHost(u.hostname)) throw new Error('Ollama must be on this computer.');
    return u.origin;
  }

  private async api(method: 'GET' | 'POST' | 'DELETE', p: string, body?: unknown, timeoutMs = 4000, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const sig = signal && 'any' in AbortSignal ? (AbortSignal as unknown as { any(s: AbortSignal[]): AbortSignal }).any([signal, timeout]) : signal ?? timeout;
    return this.f(this.base() + p, {
      method, signal: sig, redirect: 'error',
      ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
  }

  /** `{ version }` when something answering like Ollama is listening; `foreign` when the port answers with anything else. */
  private async probe(): Promise<{ running: boolean; version: string | null; foreign: boolean }> {
    let r: Response;
    try { r = await this.api('GET', '/api/version', undefined, 1500); } catch { return { running: false, version: null, foreign: false }; } // nothing is listening
    // Something answered. Only a reply shaped like Ollama's counts; anything else is another program on the port.
    try {
      if (!r.ok) { drop(r); return { running: false, version: null, foreign: true }; }
      const j = (await readJson(r, 4096)) as { version?: unknown };
      return parseVersion(j.version) ? { running: true, version: String(j.version), foreign: false } : { running: false, version: null, foreign: true };
    } catch { return { running: false, version: null, foreign: true }; }
  }

  private async listTags(): Promise<{ name: string; size: number; params: string; quant: string }[]> {
    const r = await this.api('GET', '/api/tags', undefined, 5000);
    if (!r.ok) { drop(r); return []; }
    const j = (await readJson(r)) as { models?: unknown };
    if (!Array.isArray(j.models)) return [];
    const out: { name: string; size: number; params: string; quant: string }[] = [];
    for (const m of (j.models as Record<string, unknown>[]).slice(0, 500)) {
      if (!m || typeof m.name !== 'string' || m.name.length > 200 || typeof m.size !== 'number') continue;
      const det = (m.details ?? {}) as Record<string, unknown>;
      out.push({ name: m.name, size: m.size, params: typeof det.parameter_size === 'string' ? det.parameter_size : '', quant: typeof det.quantization_level === 'string' ? det.quantization_level : '' });
    }
    return out;
  }

  private async listLoaded(): Promise<{ name: string; vram: number | null }[]> {
    try {
      const r = await this.api('GET', '/api/ps', undefined, 3000);
      if (!r.ok) { drop(r); return []; }
      const j = (await readJson(r, 1_000_000)) as { models?: unknown };
      if (!Array.isArray(j.models)) return [];
      return (j.models as Record<string, unknown>[]).slice(0, 100).filter((m) => m && typeof m.name === 'string')
        .map((m) => ({ name: m.name as string, vram: typeof m.size_vram === 'number' ? m.size_vram : null }));
    } catch { return []; }
  }

  // ---------- finding Ollama ----------

  /** Looks for Ollama: the Windows uninstall list, the default folder, a saved folder, running copies, PATH, then every fixed drive. */
  detect(): Promise<void> {
    if (!this.detecting) this.detecting = this.doDetect().finally(() => { this.detecting = null; });
    return this.detecting;
  }

  private async doDetect(): Promise<void> {
    const map = new Map<string, Found>();
    const add = async (dir: string | null | undefined, source: InstallSource, extra?: { version?: string | null; uninstall?: string | null }) => {
      if (!dir || !path.isAbsolute(dir)) return;
      const clean = path.resolve(dir.replace(/^"|"$/g, ''));
      if (!(await isRealFile(path.join(clean, EXE)))) return;
      const key = lc(clean);
      const cur = map.get(key) ?? { dir: clean, sources: new Set<InstallSource>(), entryVersion: null, uninstall: null };
      cur.sources.add(source);
      if (extra?.version) cur.entryVersion = extra.version;
      if (extra?.uninstall) cur.uninstall = extra.uninstall;
      map.set(key, cur);
    };
    const safe = async <T,>(fn: () => Promise<T>, fallback: T): Promise<T> => { try { return await fn(); } catch { return fallback; } };

    for (const e of await safe(() => this.d.sys.uninstallEntries(), [])) {
      const exe = uninstallExe(e.uninstallString);
      const dir = e.installLocation?.trim() || (exe ? path.dirname(exe) : null);
      await add(dir, 'registry', { version: e.version, uninstall: e.uninstallString });
    }
    await add(path.join(this.d.localAppData, 'Programs', 'Ollama'), 'default');
    const saved = this.d.getSavedDir();
    if (saved) await add(saved, 'saved');
    for (const p of await safe(() => this.d.sys.processes(), [])) if (p.exePath) await add(path.dirname(p.exePath), 'process');
    for (const dir of this.d.sys.pathDirs()) await add(dir, 'path');
    const roots = await safe(() => this.d.sys.fixedDrives(), []);
    for (const dir of await this.scanDrives(roots)) await add(dir, 'scan');

    // A saved folder only counts when something else corroborates it (the uninstall list, the default folder, a running copy, PATH
    // or the scan). A folder that appears only in the saved settings could have been written there by anything, so it is ignored.
    for (const [k, f] of map) if (f.sources.size === 1 && f.sources.has('saved')) map.delete(k);
    this.found = [...map.values()];
    this.versions.clear();
    this.scanned = true;
  }

  /** Looks in the usual places on each drive and two folder levels down for a folder called Ollama. Bounded in time. */
  private async scanDrives(roots: string[]): Promise<string[]> {
    const end = this.now() + this.t.scanMs;
    const hits: string[] = [];
    const names = async (dir: string): Promise<string[]> => {
      try {
        return (await fs.promises.readdir(dir, { withFileTypes: true }))
          .filter((e) => e.isDirectory() && !e.isSymbolicLink() && !SKIP_DIRS.has(e.name.toLowerCase())).map((e) => e.name);
      } catch { return []; }
    };
    for (const root of roots) {
      for (const rel of [['Ollama'], ['Program Files', 'Ollama'], ['Program Files (x86)', 'Ollama'], ['Programs', 'Ollama'], ['Apps', 'Ollama']]) hits.push(path.join(root, ...rel));
      for (const top of await names(root)) {
        if (this.now() > end) break;
        const topDir = path.join(root, top);
        if (top.toLowerCase() === 'ollama') hits.push(topDir);
        for (const sub of await names(topDir)) {
          if (this.now() > end) break;
          if (sub.toLowerCase() === 'ollama') hits.push(path.join(topDir, sub));
          if (top.toLowerCase() === 'users') hits.push(path.join(topDir, sub, 'AppData', 'Local', 'Programs', 'Ollama'));
        }
      }
    }
    return hits;
  }

  private async describe(f: Found): Promise<OllamaInstall> {
    let version = f.entryVersion;
    if (!version) {
      const key = lc(f.dir);
      if (!this.versions.has(key)) this.versions.set(key, this.d.sys.fileVersion(path.join(f.dir, EXE)).catch(() => null)); // one lookup, however many polls overlap
      version = await this.versions.get(key)!;
    }
    const exe = uninstallExe(f.uninstall);
    return {
      dir: f.dir, exe: path.join(f.dir, EXE), version: parseVersion(version) ? version : null,
      sources: [...f.sources], trusted: [...f.sources].some((s) => TRUSTED.includes(s)),
      uninstallable: !!exe && inDir(exe, f.dir),
    };
  }

  private pick(): Found | null {
    const ok = (s: InstallSource) => (f: Found) => f.sources.has(s);
    for (const s of ['saved', 'registry', 'default'] as InstallSource[]) { const f = this.found.find(ok(s)); if (f) return f; }
    return null;
  }

  /** The copy of Ollama that Start, Stop, Update and Uninstall act on. Null if none has been confirmed. */
  private async trustedInstall(): Promise<{ found: Found; info: OllamaInstall } | null> {
    const f = this.pick();
    if (!f || !(await isRealFile(path.join(f.dir, EXE)))) return null;
    return { found: f, info: await this.describe(f) };
  }

  /** The user chose a copy that was found in an unexpected place. It is checked again, then remembered. */
  async use(dir: unknown): Promise<boolean> {
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new Error('Invalid folder');
    const f = this.found.find((x) => lc(x.dir) === lc(dir));
    if (!f) throw new Error('That folder was not found by the scan. Rescan, then choose it again.');
    if (!(await isRealFile(path.join(f.dir, EXE)))) throw new Error('ollama.exe is no longer in that folder.');
    // Asked by the main process itself, so what is shown is what will happen, whatever the page says.
    const ok = await this.d.confirmNative({
      title: 'Use this copy of Ollama?', ok: 'Use it',
      message: `Use the copy of Ollama in ${f.dir}?`,
      detail: 'When you press Start, this app will run ollama.exe from that folder. Only choose a copy you recognise.',
    });
    if (!ok) throw new Error('Cancelled.');
    this.d.setSavedDir(f.dir);
    f.sources.add('saved');
    return true;
  }

  /** Looks again in the background; the popup follows through state(). */
  rescan(): boolean { this.scanned = false; void this.detect().catch(() => { this.scanned = true; }); return true; }

  /** True while a server this app started is running. */
  get ownsServer(): boolean { return !!this.owned; }

  /** Forget the chosen folder (the app then falls back to what the uninstall list and default folder say). */
  forget(): boolean {
    this.d.setSavedDir('');
    for (const f of this.found) f.sources.delete('saved');
    this.found = this.found.filter((f) => f.sources.size > 0); // a copy known only by the saved choice is gone, not a "candidate"
    return true;
  }

  /** Stop waiting for an uninstaller the user has closed or abandoned. */
  cancelWait(): boolean { this.stopWaiting = true; return true; }

  // ---------- hardware ----------

  private async modelsDir(): Promise<string> {
    let env: string | null = null;
    try { env = await this.d.sys.userEnv('OLLAMA_MODELS'); } catch { env = null; }
    if (env && env.trim()) {
      const expanded = env.trim().replace(/%([^%]+)%/g, (_m, n: string) => process.env[n] ?? '');
      if (path.isAbsolute(expanded)) return path.resolve(expanded);
    }
    return path.join(this.d.home, '.ollama', 'models');
  }

  private ensureHardware(): Promise<void> {
    if (this.hw && this.now() - this.hw.at < 30_000) return Promise.resolve();
    if (!this.hwPromise) {
      this.hwPromise = (async () => {
        let gpus: GpuInfo[] = [];
        try { gpus = await this.d.sys.gpus(); } catch { gpus = []; }
        const dir = await this.modelsDir();
        let free: number | null = null;
        try { free = await this.d.sys.freeDiskBytes(dir); } catch { free = null; }
        this.hw = { at: this.now(), hardware: { ramBytes: this.d.sys.ramBytes(), gpus }, modelsDir: dir, modelsFree: free };
      })().finally(() => { this.hwPromise = null; });
    }
    // Once there is a reading, an old one is shown while a fresh one is taken, so a slow graphics-card query never freezes the popup.
    return this.hw ? Promise.resolve() : this.hwPromise;
  }

  // ---------- the state shown in the popup ----------

  async state(): Promise<OllamaState> {
    if (!this.scanned) void this.detect().catch(() => { this.scanned = true; });
    await this.ensureHardware();
    const hw = this.hw!;
    const trusted = await this.trustedInstall();
    const probe = await this.probe();
    const tags = probe.running ? await this.listTags().catch(() => []) : [];
    const loaded = probe.running ? await this.listLoaded() : [];

    const models: OllamaModelRow[] = tags.map((m) => {
      const est = estimateMemoryBytes(m.size);
      const l = loaded.find((x) => x.name === m.name);
      return { name: m.name, sizeBytes: m.size, params: m.params, quant: m.quant, estBytes: est, fit: fitFor(est, hw.hardware), loaded: !!l, vramBytes: l?.vram ?? null };
    });
    const have = new Set(tags.map((m) => m.name));
    const catalog: OllamaCatalogRow[] = CATALOG.map((c) => {
      const est = estimateMemoryBytes(c.sizeBytes);
      return { ...c, estBytes: est, fit: fitFor(est, hw.hardware), installed: have.has(c.name) };
    });

    const installs = await Promise.all(this.found.map((f) => this.describe(f)));
    const chosen = trusted?.info.dir;
    const candidates = installs.filter((i) => !chosen || lc(i.dir) !== lc(chosen));
    return {
      supported: process.platform === 'win32',
      scanned: this.scanned,
      install: trusted?.info ?? null,
      candidates,
      server: { running: probe.running, version: probe.version, ownedByApp: !!this.owned, origin: this.base(), foreign: probe.foreign },
      models, catalog, catalogChecked: CATALOG_CHECKED,
      hardware: { ramBytes: hw.hardware.ramBytes, freeRamBytes: this.d.sys.freeRamBytes(), gpus: hw.hardware.gpus, modelsDir: hw.modelsDir, modelsFreeBytes: hw.modelsFree },
      latest: this.latest ? { ...this.latest, upToDate: this.upToDate(trusted?.info.version ?? probe.version) } : null,
      pull: this.pullState, download: this.download, busy: this.busy, error: this.error,
      localAgents: this.d.localAgents(), addressSaved: this.d.addressSaved(),
    };
  }

  private upToDate(current: string | null): boolean | null {
    if (!this.latest) return null;
    const c = compareVersions(current, this.latest.version);
    return c === null ? null : c >= 0;
  }

  private guard(): void {
    if (this.busy) throw new Error('Wait for the current action to finish.');
  }

  /** Runs a long action in the background; the popup follows it through state(). */
  private background(kind: Exclude<OllamaBusy, null>, fn: () => Promise<void>): void {
    this.busy = kind;
    this.error = null;
    void fn().catch((e) => { this.error = (e as Error).message; }).finally(() => { this.busy = null; });
  }

  // ---------- start and stop ----------

  async start(): Promise<boolean> {
    this.guard();
    this.busy = 'starting';
    this.error = null;
    try {
      const p = await this.probe();
      if (p.running) return true;
      if (p.foreign) throw new Error('Something else is using the Ollama port. Close it, or change the address.');
      const inst = await this.trustedInstall();
      if (!inst) throw new Error('No confirmed copy of Ollama. Install it, or choose a copy that was found.');
      // The server gets the models folder this panel shows (not whatever the app was launched with) and no secret-looking variables.
      const h = this.d.sys.startServer(inst.info.exe, { ...this.d.childEnv(), OLLAMA_MODELS: await this.modelsDir() });
      const mine = { pid: h.pid };
      this.owned = mine;
      h.onExit(() => { if (this.owned === mine) this.owned = null; }); // a late exit of an old server must not clear a newer one
      const end = this.now() + this.t.startMs;
      while (this.now() < end) {
        if ((await this.probe()).running) return true;
        if (!this.owned) break; // it exited by itself
        await sleep(this.t.pollMs);
      }
      if (this.owned?.pid) await this.d.sys.kill([this.owned.pid]).catch(() => undefined);
      this.owned = null;
      throw new Error('Ollama did not start. Try starting it from its own window once, then use this panel again.');
    } finally { this.busy = null; }
  }

  async stop(): Promise<boolean> {
    this.guard();
    this.busy = 'stopping';
    this.error = null;
    try { return await this.doStop(); } finally { this.busy = null; }
  }

  private async doStop(): Promise<boolean> {
    const inst = await this.trustedInstall();
    const procs = await this.d.sys.processes();
    const mine = inst ? procs.filter((p) => PROC_NAMES.includes(p.name.toLowerCase()) && p.exePath && inDir(p.exePath, inst.info.dir)) : [];
    const p0 = await this.probe();
    if (!mine.length) {
      if (p0.running) throw new Error('Ollama is running from a folder this app has not confirmed. Choose that copy first, or quit it from the taskbar.');
      return true;
    }
    const tray = mine.filter((p) => p.name.toLowerCase() === 'ollama app.exe').map((p) => p.pid);
    if (tray.length) { await this.d.sys.kill(tray); await sleep(Math.min(500, this.t.pollMs * 2)); }
    await this.d.sys.kill(mine.filter((p) => !tray.includes(p.pid)).map((p) => p.pid));
    const end = this.now() + this.t.stopMs;
    while (this.now() < end) {
      if (!(await this.probe()).running) { this.owned = null; return true; }
      await sleep(this.t.pollMs);
    }
    throw new Error('Ollama did not stop. Quit it from the taskbar.');
  }

  /** Called when the app quits: stops a server this app started, and leaves any other alone. */
  async shutdown(): Promise<void> {
    const o = this.owned;
    this.owned = null;
    if (o?.pid) await this.d.sys.kill([o.pid]).catch(() => undefined);
  }

  // ---------- models ----------

  /** Starts a download. One at a time; progress is read from state(). */
  async pull(name: unknown): Promise<boolean> {
    if (!isOllamaModelName(name)) throw new Error('Model names use lowercase letters, numbers and . _ - with an optional namespace/ and :tag');
    this.guard();
    if (this.pullState && !this.pullState.done) throw new Error('A download is already running.');
    const st: OllamaPull = { model: name, status: 'starting', completed: 0, total: 0, done: false };
    const ac = new AbortController();
    this.pullState = st; // claimed now, so a second click cannot start another while the checks below run
    this.pullAbort = ac; // and Cancel works from the first moment
    try {
      if (!(await this.probe()).running) throw new Error('Start Ollama first.');
      await this.ensureHardware();
      const known = catalogEntry(name);
      const need = known ? Math.round(known.sizeBytes * 1.05 + GIB) : 2 * GIB;
      const free = this.hw?.modelsFree;
      if (typeof free === 'number' && free < need) {
        throw new Error(`Not enough free space for the models folder: ${formatSize(free)} free, about ${formatSize(need)} needed.`);
      }
    } catch (e) { this.pullState = null; if (this.pullAbort === ac) this.pullAbort = null; throw e; }
    if (ac.signal.aborted) { // cancelled while the checks ran
      st.cancelled = true; st.done = true;
      if (this.pullAbort === ac) this.pullAbort = null;
      return true;
    }
    void this.runPull(name, st, ac);
    return true;
  }

  private async runPull(name: string, st: OllamaPull, ac: AbortController): Promise<void> {
    try {
      const r = await this.api('POST', '/api/pull', { model: name, stream: true }, 24 * 3600_000, ac.signal);
      if (!r.ok || !r.body) { drop(r); throw new Error(`Ollama refused the download (${r.status}).`); }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      const line = (l: string) => {
        if (!l.trim()) return;
        let j: Record<string, unknown>;
        try { j = JSON.parse(l) as Record<string, unknown>; } catch { return; }
        if (typeof j.error === 'string') { st.error = j.error.slice(0, 300); return; }
        if (typeof j.status === 'string') st.status = j.status.slice(0, 80);
        if (typeof j.total === 'number' && Number.isFinite(j.total)) { st.total = j.total; st.completed = typeof j.completed === 'number' ? j.completed : 0; }
        if (j.status === 'success') st.status = 'success';
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split('\n');
        buf = parts.pop() ?? '';
        if (buf.length > 65_536) throw new Error('Ollama sent an unexpected reply.');
        parts.forEach(line);
      }
      line(buf);
      if (!st.error && st.status !== 'success') st.error = 'The download ended before it finished. Start it again to resume.';
    } catch (e) {
      if (ac.signal.aborted) st.cancelled = true;
      else st.error = (e as Error).message;
    } finally {
      st.done = true;
      if (this.pullAbort === ac) this.pullAbort = null;
    }
  }

  cancelPull(): boolean { this.pullAbort?.abort(); return true; }
  clearPull(): boolean { if (this.pullState?.done) this.pullState = null; return true; }

  async deleteModel(name: unknown): Promise<boolean> {
    // Any name Ollama itself lists can be deleted (models pulled from the command line may have names the download box would refuse).
    if (typeof name !== 'string' || !name || name.length > 200 || /[\u0000-\u001f]/.test(name)) throw new Error('Invalid model name');
    this.guard();
    if (this.pullState && !this.pullState.done && this.pullState.model === name) throw new Error('That model is still downloading.');
    if (!(await this.probe()).running) throw new Error('Start Ollama first.');
    if (!(await this.listTags().catch(() => [])).some((m) => m.name === name)) throw new Error('Ollama does not have that model.');
    const r = await this.api('DELETE', '/api/delete', { model: name }, 15_000);
    if (r.status === 404) throw new Error('Ollama does not have that model.');
    if (!r.ok) { drop(r); throw new Error(`Ollama could not delete it (${r.status}).`); }
    drop(r);
    return true;
  }

  // ---------- updates ----------

  /** One request to Ollama's release list on GitHub. Only when the user asks. */
  async checkUpdate(): Promise<OllamaLatest> {
    const url = this.d.net?.releaseApi ?? RELEASE_API;
    const r = await this.f(url, { redirect: 'error', headers: { accept: 'application/vnd.github+json', 'user-agent': 'ronin-council' }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) { drop(r); throw new Error(`The release list could not be read (${r.status}).`); }
    const j = (await readJson(r, 2_000_000)) as Record<string, unknown>;
    const tag = typeof j.tag_name === 'string' ? j.tag_name : '';
    if (!parseVersion(tag)) throw new Error('The release list had an unexpected version.');
    const asset = (Array.isArray(j.assets) ? (j.assets as Record<string, unknown>[]) : []).find((a) => a && a.name === 'OllamaSetup.exe');
    const digest = typeof asset?.digest === 'string' ? /^sha256:([0-9a-f]{64})$/.exec(asset.digest) : null;
    const size = typeof asset?.size === 'number' && asset.size > 0 ? asset.size : null;
    const dl = typeof asset?.browser_download_url === 'string' ? asset.browser_download_url : '';
    this.latestInstaller = digest && size && this.assetUrlOk(dl, tag) ? { size, sha256: digest[1], url: dl, tag } : null;
    const inst = await this.trustedInstall();
    const version = tag.replace(/^v/, '');
    this.latest = { tag, version, upToDate: null, installerSize: this.latestInstaller?.size ?? null, checkedAt: this.now() };
    this.latest.upToDate = this.upToDate(inst?.info.version ?? (await this.probe()).version);
    return this.latest;
  }

  private assetUrlOk(raw: string, tag: string): boolean {
    let u: URL;
    try { u = new URL(raw); } catch { return false; }
    if (u.search || u.hash || u.username || u.password) return false;
    if (this.d.net?.looseAssetPath && this.hostOk(u)) return true;
    return u.protocol === 'https:' && u.hostname === 'github.com' && u.pathname === `/ollama/ollama/releases/download/${tag}/OllamaSetup.exe`;
  }

  private hostOk(u: URL): boolean {
    if (this.d.net?.allowHost?.(u.hostname)) return true;
    if (u.protocol !== 'https:' || u.username || u.password) return false;
    return u.hostname === 'github.com' || u.hostname.endsWith('.githubusercontent.com');
  }

  // ---------- confirmations ----------

  /** Describes exactly what an action will do and returns a one-time token for confirming it. */
  async prepare(action: unknown, args: unknown): Promise<OllamaPlan> {
    this.guard();
    const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
    for (const [k, v] of this.tokens) if (v.expires < this.now()) this.tokens.delete(k);
    const token = crypto.randomBytes(16).toString('hex');
    const expires = this.now() + 2 * 60_000;
    const trusted = await this.trustedInstall();

    if (action === 'download') {
      const li = this.latestInstaller;
      if (!li || !this.latest) throw new Error('Check for an update first.');
      if (this.download.phase === 'downloading' || this.download.phase === 'verifying') throw new Error('A download is already running.');
      // Never offer an older release than the one already installed (a stale "latest" is a downgrade).
      const older = compareVersions(li.tag, trusted?.info.version ?? null);
      if (older !== null && older < 0) throw new Error(`The newest release listed (${this.latest.version}) is older than the version you have (${trusted!.info.version}).`);
      let dir: string | undefined;
      if (a.dir !== undefined && a.dir !== '') {
        const v = validInstallDir(a.dir);
        if (!v) throw new Error('The install folder must be a path such as D:\\Apps\\Ollama (letters, numbers, spaces and - _ . ( ) only).');
        dir = v;
      }
      this.tokens.set(token, { action: 'download', args: { dir }, expires });
      const host = new URL(li.url).hostname;
      return {
        token, action: 'download', expiresAt: expires,
        title: trusted ? `Update Ollama to ${this.latest.version}` : `Install Ollama ${this.latest.version}`,
        lines: [
          `Download the official installer (${formatSize(li.size)}) from ${host}.`,
          `The download is checked against the release's own SHA-256 fingerprint (${li.sha256.slice(0, 16)}…) and its digital signature is read.`,
          'Nothing runs until you press "Run installer" afterwards.',
          ...(dir ? [`Install into: ${dir}`] : trusted ? [`Current copy: ${trusted.info.dir}${trusted.info.version ? ` (version ${trusted.info.version})` : ''}`] : []),
        ],
        warnings: trusted ? ['Ollama will be stopped before the installer runs.'] : [],
      };
    }

    if (action === 'uninstall') {
      if (!trusted) throw new Error('No confirmed copy of Ollama to remove.');
      if (!trusted.info.uninstallable) throw new Error('Ollama has no registered uninstaller in its folder. Remove it from Windows Settings, Apps.');
      const dir = await this.modelsDir();
      const bytes = (await folderBytes(dir)) ?? 0;
      const count = (await this.probe()).running ? (await this.listTags().catch(() => [])).length : 0;
      const agents = this.d.localAgents();
      this.tokens.set(token, { action: 'uninstall', args: { deleteModels: false }, expires });
      return {
        token, action: 'uninstall', expiresAt: expires, title: 'Uninstall Ollama',
        lines: [
          `Remove Ollama from ${trusted.info.dir} using its own uninstaller (it opens its own window).`,
          `Models are stored in ${dir}${bytes ? ` (${formatSize(bytes)}${count ? `, ${count} model${count === 1 ? '' : 's'}` : ''})` : ''}.`,
        ],
        warnings: [
          ...(agents.length ? [`These agents use a local model and will go back to their normal Claude tier: ${agents.map((x) => x.name).join(', ')}.`] : []),
        ],
        deleteModels: { default: true, bytes, count },
      };
    }
    throw new Error('Unknown action');
  }

  /** Runs a prepared action. The token is single-use and expires. `deleteModels` is only read for an uninstall. */
  async confirm(token: unknown, options?: unknown): Promise<boolean> {
    this.guard();
    if (typeof token !== 'string') throw new Error('Invalid confirmation');
    const p = this.tokens.get(token);
    this.tokens.delete(token);
    if (!p || p.expires < this.now()) throw new Error('That confirmation expired. Open it again.');
    if (p.action === 'download') {
      if (this.download.phase === 'downloading' || this.download.phase === 'verifying') throw new Error('A download is already running.');
      void this.startDownload(p.args.dir);
      return true;
    }
    const o = (options && typeof options === 'object' ? options : {}) as Record<string, unknown>;
    const deleteModels = o.deleteModels === true;
    const inst = await this.trustedInstall();
    if (!inst) throw new Error('No confirmed copy of Ollama to remove.');
    const dir = await this.modelsDir();
    // The main process asks again in its own words, so a page cannot change what the user is agreeing to.
    const ok = await this.d.confirmNative({
      title: 'Uninstall Ollama?', ok: 'Uninstall',
      message: `Uninstall Ollama from ${inst.info.dir}?`,
      detail: deleteModels ? `The downloaded models in ${dir} will also be deleted. This cannot be undone.` : 'Your downloaded models will be kept.',
    });
    if (!ok) throw new Error('Cancelled.');
    this.background('uninstalling', () => this.runUninstall(deleteModels));
    return true;
  }

  // ---------- installer ----------

  private async startDownload(dir: string | undefined): Promise<void> {
    const li = this.latestInstaller;
    if (!li) return;
    this.downloadDirChoice = dir;
    this.error = null;
    this.download = { phase: 'downloading', tag: li.tag, completed: 0, total: li.size };
    this.downloadFile = null;
    const final = path.join(this.d.downloadDir, `OllamaSetup-${li.tag.replace(/[^0-9A-Za-z.-]/g, '')}.exe`);
    const part = `${final}.part`;
    try {
      await fs.promises.mkdir(this.d.downloadDir, { recursive: true });
      for (const f of await fs.promises.readdir(this.d.downloadDir)) if (/^OllamaSetup-.*\.exe(\.part)?$/.test(f)) await fs.promises.rm(path.join(this.d.downloadDir, f), { force: true });
      const ac = new AbortController();
      let lastData = this.now();
      const idle = setInterval(() => { if (this.now() - lastData > this.t.stallMs) ac.abort(); }, Math.max(50, Math.floor(this.t.stallMs / 6)));
      const hash = crypto.createHash('sha256');
      let received = 0;
      try {
        const res = await this.fetchInstaller(li.url, ac.signal);
        if (!res.body) throw new Error('The installer download had no content.');
        const self = this;
        await pipeline(
          Readable.fromWeb(res.body as unknown as import('stream/web').ReadableStream<Uint8Array>),
          async function* (source: AsyncIterable<Buffer>) {
            for await (const chunk of source) {
              lastData = self.now();
              received += chunk.length;
              if (received > li.size) throw new Error('The installer is larger than the release says.');
              hash.update(chunk);
              self.download.completed = received;
              yield chunk;
            }
          },
          fs.createWriteStream(part, { flags: 'wx' }),
          { signal: ac.signal },
        );
      } catch (e) {
        if (ac.signal.aborted) throw new Error('The download stalled. Try again.');
        throw e;
      } finally { clearInterval(idle); }
      this.download.phase = 'verifying';
      if (received !== li.size) throw new Error('The installer is smaller than the release says. Try again.');
      if (hash.digest('hex') !== li.sha256) throw new Error('The installer does not match the release fingerprint, so it was discarded.');
      await fs.promises.rename(part, final);
      const sig = await this.d.sys.signature(final);
      if (!['Valid', 'NotSigned'].includes(sig.status)) {
        await fs.promises.rm(final, { force: true });
        throw new Error(`The installer's digital signature is not trusted (${sig.status}), so it was discarded.`);
      }
      this.downloadFile = final;
      this.download = { phase: 'ready', tag: li.tag, completed: received, total: li.size, signature: sig };
    } catch (e) {
      await fs.promises.rm(part, { force: true }).catch(() => undefined);
      this.download = { phase: 'failed', tag: li.tag, completed: 0, total: li.size, error: (e as Error).message };
    }
  }

  /** Follows redirects by hand so every address is checked, and never sends credentials. */
  private async fetchInstaller(first: string, signal: AbortSignal): Promise<Response> {
    let u = new URL(first);
    for (let hop = 0; hop < 6; hop++) {
      if (!this.hostOk(u)) throw new Error('The installer address is not on an allowed site.');
      const r = await this.f(u, { redirect: 'manual', headers: { 'user-agent': 'ronin-council' }, signal });
      if (r.status >= 300 && r.status < 400) {
        drop(r);
        const loc = r.headers.get('location');
        if (!loc) throw new Error('The installer address redirected nowhere.');
        u = new URL(loc, u);
        continue;
      }
      if (!r.ok) { drop(r); throw new Error(`The installer could not be downloaded (${r.status}).`); }
      return r;
    }
    throw new Error('The installer address redirected too many times.');
  }

  /**
   * Runs the downloaded installer. The main process asks once more in its own words, stops Ollama, checks the file one last time
   * and starts it straight away (so there is no gap for the file to be swapped). The installer shows its own windows.
   */
  async runInstaller(): Promise<boolean> {
    this.guard();
    const li = this.latestInstaller;
    const file = this.downloadFile;
    if (this.download.phase !== 'ready' || !file || !li) throw new Error('No verified installer is ready.');
    const dir = this.downloadDirChoice;
    const sig = this.download.signature;
    const ok = await this.d.confirmNative({
      title: 'Run the Ollama installer?', ok: 'Run installer',
      message: `Run the Ollama ${li.tag.replace(/^v/, '')} installer?`,
      detail: `Its fingerprint matches the release. Digital signature: ${sig?.status === 'Valid' ? `valid, signed by ${sig.subject ?? 'an unknown publisher'}` : 'not signed (only the fingerprint was checked)'}.${dir ? ` It will install into ${dir}.` : ''}`,
    });
    if (!ok) throw new Error('Cancelled.');
    this.guard(); // something else may have started while the question was open
    if (this.download.phase !== 'ready') throw new Error('No verified installer is ready.');
    this.busy = 'installing';
    this.error = null;
    void (async () => {
      try {
        if ((await this.probe()).running) await this.doStop();
        const h = crypto.createHash('sha256');
        await new Promise<void>((resolve, reject) => { fs.createReadStream(file).on('data', (c) => h.update(c)).on('end', () => resolve()).on('error', reject); });
        if (h.digest('hex') !== li.sha256) {
          this.download = { phase: 'failed', tag: li.tag, completed: 0, total: li.size, error: 'The installer file changed after it was checked, so it was not run.' };
          throw new Error(this.download.error!);
        }
        const code = await this.d.sys.run(file, dir ? [`/DIR="${dir}"`] : [], { verbatim: true, env: this.d.childEnv() });
        if (code === null) throw new Error('The installer could not be started. You can open the downloaded file yourself.');
        await this.detect();
        if (code !== 0) {
          this.error = `The installer closed with code ${code}. If you cancelled it, nothing was changed; press Run installer to try again.`;
          return;
        }
        await fs.promises.rm(file, { force: true }).catch(() => undefined);
        this.downloadFile = null;
        this.download = { phase: 'idle', tag: '', completed: 0, total: 0 };
      } catch (e) { this.error = (e as Error).message; } finally { this.busy = null; }
    })();
    return true;
  }

  // ---------- uninstall ----------

  private async runUninstall(deleteModels: boolean): Promise<void> {
    const inst = await this.trustedInstall();
    if (!inst || !inst.info.uninstallable) throw new Error('No registered uninstaller was found.');
    const exe = uninstallExe(inst.found.uninstall);
    if (!exe || !inDir(exe, inst.info.dir) || !(await isRealFile(exe))) throw new Error('The uninstaller is missing. Remove Ollama from Windows Settings, Apps.');
    const modelsDir = await this.modelsDir();
    if (deleteModels) {
      const why = await checkModelsDir(modelsDir, this.d.protectedDirs, this.d.home);
      if (why) throw new Error(`${why} Nothing was changed.`);
    }
    const agents = this.d.localAgents();

    this.cancelPull();
    if ((await this.probe()).running) await this.doStop();
    const code = await this.d.sys.run(exe, [], { env: this.d.childEnv() });
    if (code === null) throw new Error('The uninstaller could not be started.');
    // The uninstaller may hand over to a copy of itself and exit at once, so wait for its entry to disappear. A failed read of the
    // uninstall list means "don't know", never "gone": two clean reads in a row without the entry are needed.
    this.stopWaiting = false;
    const end = this.now() + this.t.uninstallMs;
    let clean = 0;
    while (this.now() < end && !this.stopWaiting && clean < 2) {
      let entries: UninstallEntry[] | null;
      try { entries = await this.d.sys.uninstallEntries(); } catch { entries = null; }
      if (entries) {
        const still = entries.some((e) => { const x = uninstallExe(e.uninstallString); return x && lc(x) === lc(exe); }) && (await isRealFile(exe));
        clean = still ? 0 : clean + 1;
      }
      if (clean < 2) await sleep(this.t.pollMs);
    }
    if (clean < 2) {
      throw new Error(this.stopWaiting
        ? 'Stopped waiting. If the uninstaller is still open, finish or close it, then use Rescan drives.'
        : 'Ollama was not uninstalled (the uninstaller was closed or did not finish). Nothing else was changed.');
    }

    if (deleteModels) {
      const why = await checkModelsDir(modelsDir, this.d.protectedDirs, this.d.home);
      if (why) throw new Error(`Ollama was uninstalled, but the models were kept: ${why}`);
      await fs.promises.rm(modelsDir, { recursive: true, force: true, maxRetries: 3 });
    }
    for (const a of agents) this.d.resetAgent(a.id);
    this.found = [];
    await this.detect();
  }
}
