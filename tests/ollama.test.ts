/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import {
  CATALOG, compareVersions, estimateMemoryBytes, fitFor, formatMemory, formatSize, GIB, GpuInfo, isOllamaModelName, parseVersion,
} from '../shared/ollama';
import { checkModelsDir, OllamaManager, OllamaSystem, ProcInfo, UninstallEntry, uninstallExe, validInstallDir } from '../electron/ollama';

// ---------- pure helpers ----------
describe('ollama helpers', () => {
  it('reads and compares versions', () => {
    expect(parseVersion('v0.40.16')?.nums).toEqual([0, 40, 16]);
    expect(parseVersion('1.2.3-rc1')?.pre).toBe(true);
    expect(parseVersion('1.2')).toBeNull();
    expect(parseVersion('latest')).toBeNull();
    expect(parseVersion(5)).toBeNull();
    expect(compareVersions('0.9.0', '0.10.0')).toBeLessThan(0);
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.1', '1.0.0')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-rc1', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('x', '1.0.0')).toBeNull();
  });

  it('accepts model names from Ollama only, never a third-party registry', () => {
    for (const ok of ['qwen3:8b', 'qwen2.5-coder:7b', 'gpt-oss:20b', 'frob/hy4-preview', 'frob/hy4-preview:latest', 'llama3']) expect(isOllamaModelName(ok)).toBe(true);
    for (const bad of ['', 'Qwen3', 'a b', '../x', 'evil.com/ns/model', 'http://evil/x', '-rf', 'a:', ':b', 'a//b', 'x'.repeat(101), 'a;b', 'a\nb', 5, null])
      expect(isOllamaModelName(bad as any)).toBe(false);
  });

  it('estimates memory and decides the badge', () => {
    expect(estimateMemoryBytes(5 * 1e9)).toBeGreaterThan(5 * 1e9);
    const hw = { ramBytes: 64 * GIB, gpus: [{ name: 'GPU', vramBytes: 8 * GIB }] as GpuInfo[] };
    expect(fitFor(estimateMemoryBytes(5.2e9), hw).kind).toBe('gpu');
    expect(fitFor(estimateMemoryBytes(19e9), hw).kind).toBe('ram');
    expect(fitFor(estimateMemoryBytes(404e9), hw).kind).toBe('too-big');
    expect(fitFor(estimateMemoryBytes(5e9), { ramBytes: 16 * GIB, gpus: [] }).kind).toBe('ram');
    expect(fitFor(estimateMemoryBytes(20e9), { ramBytes: 16 * GIB, gpus: [] }).kind).toBe('too-big');
    expect(fitFor(estimateMemoryBytes(5e9), { ramBytes: 16 * GIB, gpus: [{ name: 'x', vramBytes: null }] }).kind).toBe('ram'); // VRAM unreadable: not claimed
    expect(fitFor(1e9, null).kind).toBe('unknown');
    expect(fitFor(NaN, hw).kind).toBe('unknown');
    expect(fitFor(-5, hw).kind).toBe('unknown');
    expect(fitFor(1e9, { ramBytes: 0, gpus: [] }).kind).toBe('unknown');
  });

  it('formats sizes', () => {
    expect(formatSize(5.2e9)).toBe('5.2 GB');
    expect(formatSize(404e9)).toBe('404 GB');
    expect(formatSize(450e6)).toBe('450 MB');
    expect(formatSize(NaN)).toBe('?');
    expect(formatMemory(8 * GIB)).toBe('8.0 GB');
    expect(formatMemory(64 * GIB)).toBe('64 GB');
  });

  it('has a sane catalog', () => {
    const names = CATALOG.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const c of CATALOG) {
      expect(isOllamaModelName(c.name)).toBe(true);
      expect(c.name).toContain(':'); // always an explicit tag
      expect(c.sizeBytes).toBeGreaterThan(0);
      expect(c.label.length).toBeGreaterThan(0);
    }
  });

  it('reads the program out of an uninstall command', () => {
    expect(uninstallExe('"C:\\Users\\a b\\Ollama\\unins000.exe" /SILENT')).toBe('C:\\Users\\a b\\Ollama\\unins000.exe');
    expect(uninstallExe('D:\\Apps\\Ollama\\unins000.exe')).toBe('D:\\Apps\\Ollama\\unins000.exe');
    expect(uninstallExe('D:\\Apps\\Ollama\\unins000.exe /x')).toBe('D:\\Apps\\Ollama\\unins000.exe');
    expect(uninstallExe('msiexec /x {GUID}')).toBeNull();
    expect(uninstallExe('"relative\\unins.exe"')).toBeNull();
    expect(uninstallExe('"C:\\unterminated')).toBeNull();
    expect(uninstallExe('')).toBeNull();
    expect(uninstallExe(null)).toBeNull();
  });

  it('validates an install folder', () => {
    expect(validInstallDir('D:\\Apps\\Ollama')).toBe('D:\\Apps\\Ollama');
    expect(validInstallDir('D:/Apps/Ollama/')).toBe(path.normalize('D:/Apps/Ollama'));
    expect(validInstallDir('D:\\Program Files (x86)\\Ollama')).toBeTruthy();
    for (const bad of ['D:\\a.\\b', 'D:\\a \\b', 'D:\\nul', 'D:\\CON\\x', 'D:\\x\\com1.txt', '', 'D:', 'D:\\', 'relative\\x', 'D:\\a"b', 'D:\\a&b', 'D:\\a;b', 'D:\\..\\x', 'D:\\a\\..\\b', '\\\\server\\share\\x', 'D:\\a$b', 'D:\\a\nb', 'D:\\' + 'x'.repeat(250), 5, null])
      expect(validInstallDir(bad as any)).toBeNull();
  });
});

// ---------- fakes ----------
const GITHUB_TAG = 'v9.9.9';

async function freePort(): Promise<number> {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); }); });
}

class FakeOllama {
  server: http.Server | null = null;
  mode: 'ollama' | 'foreign' = 'ollama';
  models: { name: string; size: number }[] = [];
  loaded: { name: string; size_vram: number }[] = [];
  pullLines: string[] = [];
  pullHold = false;
  pullRequests: any[] = [];
  deleted: string[] = [];
  version = '0.40.0';
  constructor(public port: number) {}
  get running() { return !!this.server; }
  async listen() {
    if (this.server) return;
    const s = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('close', () => { /* client left */ });
      req.on('end', () => {
        const url = req.url ?? '';
        if (url === '/api/version') {
          if (this.mode === 'foreign') { res.writeHead(200, { 'content-type': 'text/plain' }); return void res.end('hello'); }
          res.writeHead(200, { 'content-type': 'application/json' });
          return void res.end(JSON.stringify({ version: this.version }));
        }
        if (url === '/api/tags') {
          res.writeHead(200, { 'content-type': 'application/json' });
          return void res.end(JSON.stringify({ models: this.models.map((m) => ({ name: m.name, model: m.name, size: m.size, digest: 'x', details: { parameter_size: '8B', quantization_level: 'Q4_K_M', family: 'qwen' } })) }));
        }
        if (url === '/api/ps') {
          res.writeHead(200, { 'content-type': 'application/json' });
          return void res.end(JSON.stringify({ models: this.loaded.map((m) => ({ name: m.name, model: m.name, size: 1, size_vram: m.size_vram })) }));
        }
        if (url === '/api/pull' && req.method === 'POST') {
          this.pullRequests.push(JSON.parse(body));
          res.writeHead(200, { 'content-type': 'application/x-ndjson' });
          for (const l of this.pullLines) res.write(l + '\n');
          if (!this.pullHold) res.end();
          return;
        }
        if (url === '/api/delete' && req.method === 'DELETE') {
          const name = JSON.parse(body).model;
          const i = this.models.findIndex((m) => m.name === name);
          if (i < 0) { res.writeHead(404); return void res.end(); }
          this.models.splice(i, 1); this.deleted.push(name);
          res.writeHead(200); return void res.end();
        }
        res.writeHead(404); res.end();
      });
    });
    await new Promise<void>((r) => s.listen(this.port, '127.0.0.1', () => r()));
    this.server = s;
  }
  async close() {
    const s = this.server;
    this.server = null;
    if (!s) return;
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
}

class FakeSys implements OllamaSystem {
  drives: string[] = [];
  entries: UninstallEntry[] = [];
  procs: ProcInfo[] = [];
  pathList: string[] = [];
  env: Record<string, string> = {};
  versions: Record<string, string | null> = {};
  sig: { status: string; subject: string | null } = { status: 'Valid', subject: 'CN=Ollama' };
  gpuList: GpuInfo[] = [{ name: 'Test GPU', vramBytes: 8 * GIB }];
  free: number | null = 500 * GIB;
  killed: number[][] = [];
  runs: { exe: string; args: string[]; verbatim?: boolean; env?: NodeJS.ProcessEnv }[] = [];
  started: string[] = [];
  serverPids = new Set<number>();
  runImpl: ((exe: string, args: string[]) => Promise<number | null>) | null = null;
  exitCbs: (() => void)[] = [];
  gpusThrow = false;
  constructor(public ollama: FakeOllama) {}
  async fixedDrives() { return this.drives; }
  async uninstallEntries() { if (this.entriesFail > 0) { this.entriesFail--; throw new Error('registry busy'); } return this.entries; }
  async processes() { return this.procs; }
  pathDirs() { return this.pathList; }
  async userEnv(name: string) { return this.env[name] ?? null; }
  async fileVersion(file: string) { return this.versions[path.dirname(file).toLowerCase()] ?? null; }
  async signature() { return this.sig; }
  async gpus() { if (this.gpusThrow) throw new Error('boom'); return this.gpuList; }
  ramBytes() { return 64 * GIB; }
  freeRamBytes() { return 30 * GIB; }
  async freeDiskBytes() { return this.free; }
  serverEnv: NodeJS.ProcessEnv | undefined;
  entriesFail = 0; // how many reads of the uninstall list fail before they work again
  startServer(exe: string, env?: NodeJS.ProcessEnv) {
    this.started.push(exe);
    this.serverEnv = env;
    void this.ollama.listen();
    return { pid: 4242, onExit: (cb: () => void) => { this.exitCbs.push(cb); } };
  }
  async kill(pids: number[]) {
    this.killed.push(pids);
    if (pids.some((p) => this.serverPids.has(p) || p === 4242)) await this.ollama.close();
  }
  async run(exe: string, args: string[], o?: { verbatim?: boolean; env?: NodeJS.ProcessEnv }) {
    this.runs.push({ exe, args, verbatim: o?.verbatim, env: o?.env });
    return this.runImpl ? this.runImpl(exe, args) : 0;
  }
}

// ---------- the manager ----------
describe('OllamaManager', () => {
  let tmp: string;
  let port: number;
  let ollama: FakeOllama;
  let sys: FakeSys;
  let mgr: OllamaManager;
  let saved = '';
  let agentsLocal: { id: string; name: string }[] = [];
  let reset: string[] = [];
  let skew = 0;
  let gh: http.Server;
  let ghPort: number;
  let installerBytes: Buffer;
  let releaseJson: any;
  let ghDownloads: string[] = [];
  let confirms: { title: string; message: string; detail: string; ok: string }[] = [];
  let confirmAnswer = true;
  let downloadHandler: (req: http.IncomingMessage, res: http.ServerResponse) => void;

  const p = (...x: string[]) => path.join(tmp, ...x);
  const touchExe = (dir: string) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'ollama.exe'), 'MZ'); };
  const mk = (over: any = {}) => new OllamaManager({
    sys, downloadDir: p('downloads'), origin: () => `http://127.0.0.1:${port}`,
    getSavedDir: () => saved, setSavedDir: (d) => { saved = d; }, addressSaved: () => false,
    localAgents: () => agentsLocal, resetAgent: (id) => { reset.push(id); },
    protectedDirs: [p('userdata')], home: p('home'), localAppData: p('c', 'Users', 'me', 'AppData', 'Local'),
    now: () => Date.now() + skew,
    childEnv: () => ({ PATH: 'test-path', USERPROFILE: 'x' }),
    confirmNative: async (o: any) => { confirms.push(o); return confirmAnswer; },
    net: { releaseApi: `http://127.0.0.1:${ghPort}/release`, allowHost: (h: string) => h === '127.0.0.1', looseAssetPath: true },
    timing: { startMs: 3000, stopMs: 2000, pollMs: 15, uninstallMs: 1500, scanMs: 5000, stallMs: 600 },
    ...over,
  });
  const waitFor = async (cond: () => boolean | Promise<boolean>, ms = 4000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await cond()) return; await new Promise((r) => setTimeout(r, 10)); }
    throw new Error('timed out waiting');
  };
  const defaultDir = () => p('c', 'Users', 'me', 'AppData', 'Local', 'Programs', 'Ollama');

  beforeAll(async () => {
    installerBytes = crypto.randomBytes(5000);
    ghPort = await freePort();
    gh = http.createServer((req, res) => downloadHandler(req, res));
    await new Promise<void>((r) => gh.listen(ghPort, '127.0.0.1', () => r()));
  });
  afterAll(async () => { gh.closeAllConnections(); await new Promise<void>((r) => gh.close(() => r())); });

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-ollama-'));
    fs.mkdirSync(p('c'), { recursive: true }); fs.mkdirSync(p('d'), { recursive: true });
    fs.mkdirSync(p('home'), { recursive: true }); fs.mkdirSync(p('userdata'), { recursive: true });
    port = await freePort();
    ollama = new FakeOllama(port);
    sys = new FakeSys(ollama);
    sys.drives = [p('c'), p('d')];
    saved = ''; agentsLocal = []; reset = []; skew = 0; ghDownloads = []; confirms = []; confirmAnswer = true;
    releaseJson = {
      tag_name: GITHUB_TAG,
      assets: [{ name: 'OllamaSetup.exe', size: installerBytes.length, digest: `sha256:${crypto.createHash('sha256').update(installerBytes).digest('hex')}`, browser_download_url: `http://127.0.0.1:${ghPort}/dl/OllamaSetup.exe` }],
    };
    downloadHandler = (req, res) => {
      if (req.url === '/release') { res.writeHead(200, { 'content-type': 'application/json' }); return void res.end(JSON.stringify(releaseJson)); }
      if (req.url === '/dl/OllamaSetup.exe') { ghDownloads.push(req.url); res.writeHead(302, { location: '/cdn/blob' }); return void res.end(); }
      if (req.url === '/cdn/blob') { res.writeHead(200, { 'content-length': String(installerBytes.length) }); return void res.end(installerBytes); }
      res.writeHead(404); res.end();
    };
    mgr = mk();
  });
  afterEach(async () => {
    await mgr.shutdown();
    await ollama.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // ----- detection -----
  describe('detection', () => {
    it('reports nothing when Ollama is not installed (no crash)', async () => {
      await mgr.detect();
      const st = await mgr.state();
      expect(st.scanned).toBe(true);
      expect(st.install).toBeNull();
      expect(st.candidates).toEqual([]);
      expect(st.server.running).toBe(false);
      expect(st.catalog.length).toBe(CATALOG.length);
      expect(st.hardware?.gpus[0].name).toBe('Test GPU');
    });

    it('trusts the default folder and reads its version without running it', async () => {
      touchExe(defaultDir());
      sys.versions[defaultDir().toLowerCase()] = '0.40.1';
      await mgr.detect();
      const st = await mgr.state();
      expect(st.install?.dir).toBe(defaultDir());
      expect(st.install?.trusted).toBe(true);
      expect(st.install?.version).toBe('0.40.1');
      expect(sys.started).toEqual([]);
      expect(sys.runs).toEqual([]);
    });

    it('prefers the Windows uninstall entry (on another drive) over the default folder, and keeps the other as a candidate', async () => {
      touchExe(defaultDir());
      const other = p('d', 'Apps', 'Ollama');
      touchExe(other);
      fs.writeFileSync(path.join(other, 'unins000.exe'), 'x');
      sys.entries = [{ name: 'Ollama version 0.41.0', version: '0.41.0', installLocation: other, uninstallString: `"${path.join(other, 'unins000.exe')}"` }];
      await mgr.detect();
      const st = await mgr.state();
      expect(st.install?.dir).toBe(other);
      expect(st.install?.version).toBe('0.41.0');
      expect(st.install?.sources).toContain('registry');
      expect(st.install?.uninstallable).toBe(true);
      expect(st.candidates.map((c) => c.dir)).toEqual([defaultDir()]);
    });

    it('finds an install on any drive by scanning, but does not trust it or run it', async () => {
      const odd = p('d', 'Tools', 'Ollama');
      touchExe(odd);
      await mgr.detect();
      const st = await mgr.state();
      expect(st.install).toBeNull();
      expect(st.candidates).toHaveLength(1);
      expect(st.candidates[0]).toMatchObject({ dir: odd, trusted: false });
      await expect(mgr.start()).rejects.toThrow(/No confirmed copy/);
      expect(sys.started).toEqual([]);
    });

    it('finds the per-user folder on another drive two levels down', async () => {
      const dir = p('d', 'Users', 'bob', 'AppData', 'Local', 'Programs', 'Ollama');
      touchExe(dir);
      await mgr.detect();
      expect((await mgr.state()).candidates.map((c) => c.dir)).toEqual([dir]);
    });

    it('skips links and ignored folders', async () => {
      const real = p('d', 'real'); touchExe(path.join(real, 'Ollama'));
      try { fs.symlinkSync(real, p('d', 'linked'), 'junction'); } catch { /* no permission */ }
      touchExe(p('d', 'node_modules', 'Ollama'));
      await mgr.detect();
      const dirs = (await mgr.state()).candidates.map((c) => c.dir);
      expect(dirs).toContain(path.join(real, 'Ollama'));
      expect(dirs.some((d) => d.includes('node_modules') || d.includes('linked'))).toBe(false);
    });

    it('lets the user confirm a found copy, which then becomes the one used, and remembers it', async () => {
      const odd = p('d', 'Tools', 'Ollama');
      touchExe(odd);
      await mgr.detect();
      await expect(mgr.use(p('d', 'Elsewhere'))).rejects.toThrow(/not found by the scan/);
      await expect(mgr.use('relative')).rejects.toThrow(/Invalid/);
      await expect(mgr.use(5 as any)).rejects.toThrow();
      await mgr.use(odd);
      expect(saved).toBe(odd);
      const st = await mgr.state();
      expect(st.install?.dir).toBe(odd);
      expect(st.install?.trusted).toBe(true);
      mgr.forget();
      expect(saved).toBe('');
      expect((await mgr.state()).install).toBeNull();
    });

    it('does not trust a copy that only a running process or PATH points at', async () => {
      const proc = p('d', 'weird', 'bin'); touchExe(proc);
      const onPath = p('d', 'pathdir'); touchExe(onPath);
      sys.procs = [{ pid: 7, name: 'ollama.exe', exePath: path.join(proc, 'ollama.exe') }];
      sys.pathList = [onPath];
      await mgr.detect();
      const st = await mgr.state();
      expect(st.install).toBeNull();
      expect(st.candidates.map((c) => c.sources[0]).sort()).toEqual(['path', 'process']);
      await expect(mgr.stop()).resolves.toBe(true); // nothing running that we know of, and nothing killed
      expect(sys.killed).toEqual([]);
    });

    it('ignores a saved folder that nothing else points at (it could have been written into the settings by anything)', async () => {
      const planted = p('d', 'x', 'y', 'z'); touchExe(planted);
      saved = planted;
      await mgr.detect();
      const st = await mgr.state();
      expect(st.install).toBeNull();
      expect(st.candidates).toEqual([]);
      await expect(mgr.start()).rejects.toThrow(/No confirmed copy/);
      expect(sys.started).toEqual([]);
    });

    it('forgetting a choice leaves no empty candidate behind', async () => {
      const odd = p('d', 'Tools', 'Ollama'); touchExe(odd);
      await mgr.detect();
      await mgr.use(odd);
      mgr.forget();
      const st = await mgr.state();
      expect(st.install).toBeNull();
      expect(st.candidates.every((c) => c.sources.length > 0)).toBe(true);
    });

    it('asks in a native dialog before using a found copy, and does nothing if refused', async () => {
      const odd = p('d', 'Tools', 'Ollama'); touchExe(odd);
      await mgr.detect();
      confirmAnswer = false;
      await expect(mgr.use(odd)).rejects.toThrow(/Cancelled/);
      expect(saved).toBe('');
      expect(confirms).toHaveLength(1);
      expect(confirms[0].message).toContain(odd);
    });

    it('ignores a saved folder whose program has gone', async () => {
      saved = p('d', 'gone');
      await mgr.detect();
      expect((await mgr.state()).install).toBeNull();
    });

    it('survives failing system calls', async () => {
      sys.uninstallEntries = async () => { throw new Error('reg'); };
      sys.processes = async () => { throw new Error('wmi'); };
      sys.fixedDrives = async () => { throw new Error('cim'); };
      sys.gpusThrow = true;
      touchExe(defaultDir());
      await mgr.detect();
      const st = await mgr.state();
      expect(st.install?.dir).toBe(defaultDir());
      expect(st.hardware?.gpus).toEqual([]);
      expect(st.catalog.every((c) => c.fit.kind === 'ram' || c.fit.kind === 'too-big')).toBe(true);
    });
  });

  // ----- start and stop -----
  describe('start and stop', () => {
    beforeEach(async () => { touchExe(defaultDir()); await mgr.detect(); });

    it('starts the confirmed copy, notices when it is already up, and stops it on shutdown', async () => {
      await expect(mgr.start()).resolves.toBe(true);
      expect(sys.started).toEqual([path.join(defaultDir(), 'ollama.exe')]);
      const st = await mgr.state();
      expect(st.server).toMatchObject({ running: true, ownedByApp: true, version: '0.40.0' });
      await mgr.start(); // already running: nothing more is started
      expect(sys.started).toHaveLength(1);
      await mgr.shutdown();
      expect(sys.killed).toEqual([[4242]]);
      expect(ollama.running).toBe(false);
    });

    it('starts the server with the models folder shown in the panel and no secret-looking variables', async () => {
      sys.env.OLLAMA_MODELS = p('d', 'bigdrive', 'models');
      mgr = mk(); await mgr.detect();
      await mgr.start();
      expect(sys.serverEnv).toMatchObject({ PATH: 'test-path', OLLAMA_MODELS: p('d', 'bigdrive', 'models') });
      expect(Object.keys(sys.serverEnv ?? {}).some((k) => /KEY|TOKEN|SECRET/i.test(k))).toBe(false);
    });

    it('leaves a server it did not start alone on shutdown', async () => {
      await ollama.listen();
      await mgr.start();
      expect(sys.started).toEqual([]);
      await mgr.shutdown();
      expect(sys.killed).toEqual([]);
      expect(ollama.running).toBe(true);
    });

    it('refuses when something else uses the port', async () => {
      ollama.mode = 'foreign';
      await ollama.listen();
      await expect(mgr.start()).rejects.toThrow(/Something else/);
      expect((await mgr.state()).server).toMatchObject({ running: false, foreign: true });
      expect(sys.started).toEqual([]);
    });

    it('reports a server that never answers, and kills what it started', async () => {
      sys.startServer = (exe: string) => { sys.started.push(exe); return { pid: 99, onExit: () => undefined }; };
      mgr = mk({ timing: { startMs: 200, stopMs: 200, pollMs: 15, uninstallMs: 300, scanMs: 5000, stallMs: 600 } });
      await mgr.detect();
      await expect(mgr.start()).rejects.toThrow(/did not start/);
      expect(sys.killed).toEqual([[99]]);
      expect((await mgr.state()).busy).toBeNull();
    });

    it('stops only processes from the confirmed folder, tray first', async () => {
      await ollama.listen();
      const inside = (n: string) => path.join(defaultDir(), n);
      sys.procs = [
        { pid: 101, name: 'ollama.exe', exePath: inside('ollama.exe') },
        { pid: 100, name: 'ollama app.exe', exePath: inside('ollama app.exe') },
        { pid: 200, name: 'ollama.exe', exePath: p('d', 'other', 'ollama.exe') },
        { pid: 201, name: 'ollama.exe', exePath: null },
        { pid: 202, name: 'ollama.exe', exePath: defaultDir() + '-evil\\ollama.exe' }, // a sibling folder with a similar name
      ];
      sys.serverPids = new Set([101]);
      await expect(mgr.stop()).resolves.toBe(true);
      expect(sys.killed).toEqual([[100], [101]]);
      expect(ollama.running).toBe(false);
    });

    it('does not stop a server from an unconfirmed folder', async () => {
      await ollama.listen();
      sys.procs = [{ pid: 300, name: 'ollama.exe', exePath: p('d', 'other', 'ollama.exe') }];
      await expect(mgr.stop()).rejects.toThrow(/not confirmed/);
      expect(sys.killed).toEqual([]);
    });

    it('reports a server that will not stop', async () => {
      await ollama.listen();
      sys.procs = [{ pid: 101, name: 'ollama.exe', exePath: path.join(defaultDir(), 'ollama.exe') }];
      // serverPids is empty, so the kill does nothing to the fake server
      mgr = mk({ timing: { startMs: 200, stopMs: 150, pollMs: 15, uninstallMs: 300, scanMs: 5000, stallMs: 600 } });
      await mgr.detect();
      await expect(mgr.stop()).rejects.toThrow(/did not stop/);
      expect((await mgr.state()).busy).toBeNull();
    });

    it('does not let two actions overlap', async () => {
      sys.startServer = (exe: string) => { sys.started.push(exe); return { pid: 99, onExit: () => undefined }; };
      mgr = mk({ timing: { startMs: 300, stopMs: 200, pollMs: 15, uninstallMs: 300, scanMs: 5000, stallMs: 600 } });
      await mgr.detect();
      const first = mgr.start();
      await expect(mgr.start()).rejects.toThrow(/Wait/);
      await expect(mgr.stop()).rejects.toThrow(/Wait/);
      await expect(first).rejects.toThrow();
    });
  });

  // ----- models -----
  describe('models', () => {
    beforeEach(async () => { touchExe(defaultDir()); await mgr.detect(); await ollama.listen(); });

    it('lists downloaded models with size, memory estimate, badge and loaded state', async () => {
      ollama.models = [{ name: 'qwen3:8b', size: 5.2e9 }, { name: 'deepseek-r1:70b', size: 43e9 }, { name: 'huge:1t', size: 900e9 }];
      ollama.loaded = [{ name: 'qwen3:8b', size_vram: 5e9 }];
      const st = await mgr.state();
      const by = Object.fromEntries(st.models.map((m) => [m.name, m]));
      expect(by['qwen3:8b']).toMatchObject({ sizeBytes: 5.2e9, params: '8B', quant: 'Q4_K_M', loaded: true, vramBytes: 5e9 });
      expect(by['qwen3:8b'].fit.kind).toBe('gpu');
      expect(by['deepseek-r1:70b'].fit.kind).toBe('ram');
      expect(by['huge:1t'].fit.kind).toBe('too-big');
      expect(by['qwen3:8b'].estBytes).toBe(estimateMemoryBytes(5.2e9));
      expect(st.catalog.find((c) => c.name === 'qwen3:8b')?.installed).toBe(true);
      expect(st.catalog.find((c) => c.name === 'qwen3:4b')?.installed).toBe(false);
    });

    it('ignores malformed answers from the server', async () => {
      ollama.models = [{ name: 'ok:1', size: 1e9 }, { name: 5 as any, size: 1 }, { name: 'nosize' } as any];
      const st = await mgr.state();
      expect(st.models.map((m) => m.name)).toEqual(['ok:1']);
    });

    it('downloads with progress and finishes', async () => {
      ollama.pullLines = [
        '{"status":"pulling manifest"}',
        '{"status":"pulling abc","digest":"sha256:abc","total":1000,"completed":250}',
        '{"status":"pulling abc","digest":"sha256:abc","total":1000,"completed":1000}',
        '{"status":"verifying sha256 digest"}', '{"status":"writing manifest"}', '{"status":"success"}',
      ];
      await expect(mgr.pull('qwen3:4b')).resolves.toBe(true);
      await waitFor(async () => (await mgr.state()).pull?.done === true);
      const st = await mgr.state();
      expect(st.pull).toMatchObject({ model: 'qwen3:4b', status: 'success', total: 1000, completed: 1000, done: true });
      expect(st.pull?.error).toBeUndefined();
      expect(ollama.pullRequests).toEqual([{ model: 'qwen3:4b', stream: true }]);
      mgr.clearPull();
      expect((await mgr.state()).pull).toBeNull();
    });

    it('reports an error line and a download that ends early', async () => {
      ollama.pullLines = ['{"error":"pull model manifest: file does not exist"}'];
      await mgr.pull('nope:1b');
      await waitFor(async () => (await mgr.state()).pull?.done === true);
      expect((await mgr.state()).pull?.error).toMatch(/does not exist/);
      ollama.pullLines = ['{"status":"pulling manifest"}'];
      await mgr.pull('qwen3:4b');
      await waitFor(async () => (await mgr.state()).pull?.done === true && (await mgr.state()).pull?.model === 'qwen3:4b');
      expect((await mgr.state()).pull?.error).toMatch(/ended before it finished/);
    });

    it('cancels a download', async () => {
      ollama.pullHold = true;
      ollama.pullLines = ['{"status":"pulling x","total":10,"completed":1}'];
      await mgr.pull('qwen3:4b');
      await waitFor(async () => ((await mgr.state()).pull?.total ?? 0) === 10);
      await expect(mgr.pull('qwen3:8b')).rejects.toThrow(/already running/);
      mgr.cancelPull();
      await waitFor(async () => (await mgr.state()).pull?.done === true);
      expect((await mgr.state()).pull).toMatchObject({ cancelled: true, done: true });
    });

    it('refuses bad names, a stopped server and too little disk space', async () => {
      for (const bad of ['evil.com/a/b', 'A B', '', '../x', 5]) await expect(mgr.pull(bad as any)).rejects.toThrow(/Model names/);
      expect(ollama.pullRequests).toEqual([]);
      sys.free = 1e9;
      mgr = mk(); await mgr.detect();
      await expect(mgr.pull('qwen3:30b')).rejects.toThrow(/free space/);
      expect((await mgr.state()).pull).toBeNull(); // a refused request leaves nothing claimed
      await ollama.close();
      await expect(mgr.pull('qwen3:4b')).rejects.toThrow(/Start Ollama/);
      expect((await mgr.state()).pull).toBeNull();
    });

    it('deletes a model, and says so when it is not there', async () => {
      ollama.models = [{ name: 'qwen3:8b', size: 5e9 }];
      await expect(mgr.deleteModel('qwen3:8b')).resolves.toBe(true);
      expect(ollama.deleted).toEqual(['qwen3:8b']);
      await expect(mgr.deleteModel('qwen3:8b')).rejects.toThrow(/does not have/);
      for (const bad of ['', 5, 'a\nb', 'x'.repeat(300)]) await expect(mgr.deleteModel(bad as any)).rejects.toThrow(/Invalid/);
      await expect(mgr.deleteModel('../etc')).rejects.toThrow(/does not have/); // not something Ollama lists, so never sent on
      await ollama.close();
      await expect(mgr.deleteModel('qwen3:8b')).rejects.toThrow(/Start Ollama/);
    });

    it('can delete a model Ollama lists even when its name would not be accepted for a download', async () => {
      ollama.models = [{ name: 'hf.co/bartowski/Llama-3.2-3B-GGUF:Q4_K_M', size: 2e9 }, { name: 'MyModel:latest', size: 1e9 }];
      await expect(mgr.deleteModel('hf.co/bartowski/Llama-3.2-3B-GGUF:Q4_K_M')).resolves.toBe(true);
      await expect(mgr.deleteModel('MyModel:latest')).resolves.toBe(true);
      expect(ollama.deleted).toEqual(['hf.co/bartowski/Llama-3.2-3B-GGUF:Q4_K_M', 'MyModel:latest']);
    });

    it('lets Cancel work while a download is still being set up', async () => {
      ollama.pullHold = true;
      ollama.pullLines = ['{"status":"pulling x","total":10,"completed":1}'];
      const slow = new Promise<void>((r) => setTimeout(r, 80));
      const orig = sys.freeDiskBytes.bind(sys);
      sys.freeDiskBytes = async () => { await slow; return orig(); };
      mgr = mk(); await mgr.detect();
      const started = mgr.pull('qwen3:4b');
      await new Promise((r) => setTimeout(r, 10));
      mgr.cancelPull(); // during the checks, before the download exists
      await started;
      await waitFor(async () => (await mgr.state()).pull?.done === true);
      expect((await mgr.state()).pull).toMatchObject({ cancelled: true, done: true });
      expect(ollama.pullRequests).toEqual([]); // it never started
    });

    it('does not start a download while another action is running', async () => {
      sys.startServer = (exe: string) => { sys.started.push(exe); return { pid: 99, onExit: () => undefined }; };
      await ollama.close();
      mgr = mk({ timing: { startMs: 300, stopMs: 200, pollMs: 15, uninstallMs: 300, scanMs: 5000, stallMs: 600 } }); await mgr.detect();
      const starting = mgr.start();
      await expect(mgr.pull('qwen3:4b')).rejects.toThrow(/Wait/);
      await expect(mgr.deleteModel('qwen3:4b')).rejects.toThrow(/Wait/);
      await expect(starting).rejects.toThrow();
    });

    it('refuses an enormous reply from whatever is on the port', async () => {
      const big = 'x'.repeat(5_000_000);
      const f = (async () => new Response(JSON.stringify({ models: [{ name: big, size: 1 }] }), { status: 200 })) as unknown as typeof fetch;
      const m = mk({ fetch: f });
      await expect(m.state()).resolves.toBeTruthy(); // the oversized answer is dropped, not trusted
      expect((await m.state()).models).toEqual([]);
    });

    it('only ever talks to this computer', async () => {
      const bad = mk({ origin: () => 'http://example.com:11434' });
      await expect(bad.state()).rejects.toThrow(/this computer/);
    });
  });

  // ----- updates and the installer -----
  describe('update and installer', () => {
    it('compares the installed version with the latest release', async () => {
      touchExe(defaultDir());
      sys.versions[defaultDir().toLowerCase()] = '0.1.0';
      await mgr.detect();
      const l = await mgr.checkUpdate();
      expect(l).toMatchObject({ tag: GITHUB_TAG, version: '9.9.9', installerSize: installerBytes.length });
      expect((await mgr.state()).latest?.upToDate).toBe(false);
      sys.versions[defaultDir().toLowerCase()] = '99.0.0';
      mgr = mk(); await mgr.detect(); await mgr.checkUpdate();
      expect((await mgr.state()).latest?.upToDate).toBe(true);
      sys.versions[defaultDir().toLowerCase()] = null;
      mgr = mk(); await mgr.detect(); await mgr.checkUpdate();
      expect((await mgr.state()).latest?.upToDate).toBeNull();
    });

    it('never offers an older release than the one installed', async () => {
      touchExe(defaultDir());
      sys.versions[defaultDir().toLowerCase()] = '99.0.0';
      await mgr.detect();
      await mgr.checkUpdate();
      await expect(mgr.prepare('download', {})).rejects.toThrow(/older than the version you have/);
    });

    it('rejects an odd release answer and an asset it cannot verify', async () => {
      releaseJson.tag_name = 'nightly';
      await expect(mgr.checkUpdate()).rejects.toThrow(/unexpected version/);
      releaseJson.tag_name = GITHUB_TAG;
      releaseJson.assets[0].digest = 'md5:abc';
      const l = await mgr.checkUpdate();
      expect(l.installerSize).toBeNull();
      await expect(mgr.prepare('download', {})).rejects.toThrow(/Check for an update/);
    });

    it('uses a strict asset address in production mode', async () => {
      const strict = mk({ net: { releaseApi: `http://127.0.0.1:${ghPort}/release`, allowHost: () => false, looseAssetPath: false } });
      releaseJson.assets[0].browser_download_url = 'https://github.com/ollama/ollama/releases/download/v9.9.9/OllamaSetup.exe';
      expect((await strict.checkUpdate()).installerSize).toBe(installerBytes.length);
      for (const bad of ['https://evil.com/ollama/ollama/releases/download/v9.9.9/OllamaSetup.exe', 'http://github.com/ollama/ollama/releases/download/v9.9.9/OllamaSetup.exe',
        'https://github.com/other/repo/releases/download/v9.9.9/OllamaSetup.exe', 'https://github.com/ollama/ollama/releases/download/v1.0.0/OllamaSetup.exe',
        'https://user:pw@github.com/ollama/ollama/releases/download/v9.9.9/OllamaSetup.exe', 'https://github.com/ollama/ollama/releases/download/v9.9.9/OllamaSetup.exe?x=1']) {
        releaseJson.assets[0].browser_download_url = bad;
        expect((await strict.checkUpdate()).installerSize).toBeNull();
      }
    });

    const prepared = async (dir?: string) => {
      await mgr.checkUpdate();
      const plan = await mgr.prepare('download', dir ? { dir } : {});
      await mgr.confirm(plan.token);
      await waitFor(async () => ['ready', 'failed'].includes((await mgr.state()).download.phase));
      return plan;
    };

    it('shows what it will do, downloads, verifies the fingerprint and signature, and waits for a click', async () => {
      const plan = await prepared();
      expect(plan.title).toMatch(/Install Ollama 9\.9\.9/);
      expect(plan.lines.join(' ')).toMatch(/SHA-256/);
      const st = await mgr.state();
      expect(st.download).toMatchObject({ phase: 'ready', tag: GITHUB_TAG, completed: installerBytes.length, signature: { status: 'Valid' } });
      expect(sys.runs).toEqual([]); // nothing runs until the user presses Run
      expect(ghDownloads).toHaveLength(1);
      const file = fs.readdirSync(p('downloads')).find((f) => f.endsWith('.exe'))!;
      expect(fs.readFileSync(path.join(p('downloads'), file)).equals(installerBytes)).toBe(true);
      expect(fs.readdirSync(p('downloads')).some((f) => f.endsWith('.part'))).toBe(false);
    });

    it('runs the verified installer with the chosen folder, stopping a running Ollama first', async () => {
      touchExe(defaultDir());
      await mgr.detect();
      await ollama.listen();
      sys.procs = [{ pid: 101, name: 'ollama.exe', exePath: path.join(defaultDir(), 'ollama.exe') }];
      sys.serverPids = new Set([101]);
      await prepared('D:\\Apps\\My Ollama');
      await mgr.runInstaller();
      await waitFor(async () => (await mgr.state()).busy === null && sys.runs.length === 1);
      expect(sys.killed).toEqual([[101]]);
      expect(sys.runs[0].args).toEqual(['/DIR="D:\\Apps\\My Ollama"']);
      expect(sys.runs[0].verbatim).toBe(true);
      expect(sys.runs[0].env).toMatchObject({ PATH: 'test-path' });
      expect(path.basename(sys.runs[0].exe)).toMatch(/^OllamaSetup-.*\.exe$/);
      expect((await mgr.state()).download.phase).toBe('idle');
      expect(fs.readdirSync(p('downloads'))).toEqual([]); // the installer is removed once it has run
      expect(confirms).toHaveLength(1);
      expect(confirms[0].detail).toMatch(/signature: valid/);
    });

    it('refuses to run an installer that changed after it was checked', async () => {
      await prepared();
      const file = path.join(p('downloads'), fs.readdirSync(p('downloads')).find((f) => f.endsWith('.exe'))!);
      fs.appendFileSync(file, 'tamper');
      await mgr.runInstaller();
      await waitFor(async () => (await mgr.state()).busy === null);
      const st = await mgr.state();
      expect(st.error).toMatch(/changed after/);
      expect(sys.runs).toEqual([]);
      expect(st.download.phase).toBe('failed');
    });

    it('does nothing if the user declines the native question, and keeps the verified installer', async () => {
      await prepared();
      confirmAnswer = false;
      await expect(mgr.runInstaller()).rejects.toThrow(/Cancelled/);
      expect(sys.runs).toEqual([]);
      expect((await mgr.state()).download.phase).toBe('ready');
      expect((await mgr.state()).busy).toBeNull();
    });

    it('reports an installer that was closed, and lets the user try again', async () => {
      await prepared();
      sys.runImpl = async () => 1;
      await mgr.runInstaller();
      await waitFor(async () => (await mgr.state()).busy === null);
      const st = await mgr.state();
      expect(st.error).toMatch(/closed with code 1/);
      expect(st.download.phase).toBe('ready');
      sys.runImpl = async () => null;
      await mgr.runInstaller();
      await waitFor(async () => (await mgr.state()).busy === null);
      expect((await mgr.state()).error).toMatch(/could not be started/);
    });

    it('does not run two installers at once', async () => {
      await prepared();
      sys.runImpl = () => new Promise((r) => setTimeout(() => r(0), 150));
      await mgr.runInstaller();
      await expect(mgr.runInstaller()).rejects.toThrow(/Wait/);
      await waitFor(async () => (await mgr.state()).busy === null);
      expect(sys.runs).toHaveLength(1);
    });

    it('will not run anything that was not downloaded and verified', async () => {
      await expect(mgr.runInstaller()).rejects.toThrow(/No verified installer/);
    });

    it('discards a download whose fingerprint does not match', async () => {
      releaseJson.assets[0].digest = `sha256:${'0'.repeat(64)}`;
      await prepared();
      const st = await mgr.state();
      expect(st.download.phase).toBe('failed');
      expect(st.download.error).toMatch(/fingerprint/);
      expect(fs.readdirSync(p('downloads'))).toEqual([]);
      await expect(mgr.runInstaller()).rejects.toThrow();
    });

    it('discards an installer with a bad signature but allows an unsigned one (shown as a warning)', async () => {
      sys.sig = { status: 'NotTrusted', subject: 'CN=Evil' };
      await prepared();
      expect((await mgr.state()).download.error).toMatch(/signature is not trusted \(NotTrusted\)/);
      expect(fs.readdirSync(p('downloads'))).toEqual([]);
      sys.sig = { status: 'HashMismatch', subject: null };
      await prepared();
      expect((await mgr.state()).download.phase).toBe('failed');
      sys.sig = { status: 'NotSigned', subject: null };
      await prepared();
      expect((await mgr.state()).download).toMatchObject({ phase: 'ready', signature: { status: 'NotSigned' } });
    });

    it('rejects a size that differs from the release, either way', async () => {
      releaseJson.assets[0].size = installerBytes.length + 10;
      await prepared();
      expect((await mgr.state()).download.error).toMatch(/smaller/);
      releaseJson.assets[0].size = installerBytes.length - 10;
      await prepared();
      expect((await mgr.state()).download.error).toMatch(/larger/);
    });

    it('refuses a redirect to a site that is not allowed', async () => {
      const strictish = mk({ net: { releaseApi: `http://127.0.0.1:${ghPort}/release`, allowHost: (h: string) => h === '127.0.0.1', looseAssetPath: true } });
      downloadHandler = (req, res) => {
        if (req.url === '/release') { res.writeHead(200, { 'content-type': 'application/json' }); return void res.end(JSON.stringify(releaseJson)); }
        res.writeHead(302, { location: 'https://evil.example.com/x.exe' }); res.end();
      };
      await strictish.checkUpdate();
      await strictish.confirm((await strictish.prepare('download', {})).token);
      await waitFor(async () => (await strictish.state()).download.phase === 'failed');
      expect((await strictish.state()).download.error).toMatch(/not on an allowed site/);
    });

    it('stops a redirect loop, and a download that stalls', async () => {
      downloadHandler = (req, res) => {
        if (req.url === '/release') { res.writeHead(200, { 'content-type': 'application/json' }); return void res.end(JSON.stringify(releaseJson)); }
        res.writeHead(302, { location: '/dl/OllamaSetup.exe' }); res.end();
      };
      await mgr.checkUpdate();
      await mgr.confirm((await mgr.prepare('download', {})).token);
      await waitFor(async () => (await mgr.state()).download.phase === 'failed');
      expect((await mgr.state()).download.error).toMatch(/too many times/);

      downloadHandler = (req, res) => {
        if (req.url === '/release') { res.writeHead(200, { 'content-type': 'application/json' }); return void res.end(JSON.stringify(releaseJson)); }
        res.writeHead(200, { 'content-length': String(installerBytes.length) }); res.write(installerBytes.subarray(0, 100)); // then silence
      };
      await mgr.confirm((await mgr.prepare('download', {})).token);
      await waitFor(async () => (await mgr.state()).download.phase === 'failed', 6000);
      expect((await mgr.state()).download.error).toMatch(/stalled/);
      expect(fs.readdirSync(p('downloads')).some((f) => f.endsWith('.part'))).toBe(false);
    });

    it('will not start a second download from a second token', async () => {
      await mgr.checkUpdate();
      downloadHandler = (req, res) => {
        if (req.url === '/release') { res.writeHead(200, { 'content-type': 'application/json' }); return void res.end(JSON.stringify(releaseJson)); }
        if (req.url === '/dl/OllamaSetup.exe') { res.writeHead(302, { location: '/cdn/blob' }); return void res.end(); }
        setTimeout(() => { res.writeHead(200, { 'content-length': String(installerBytes.length) }); res.end(installerBytes); }, 200);
      };
      const a = await mgr.prepare('download', {});
      const b = await mgr.prepare('download', {});
      await mgr.confirm(a.token);
      await expect(mgr.confirm(b.token)).rejects.toThrow(/already running/);
      await waitFor(async () => (await mgr.state()).download.phase === 'ready');
    });

    it('treats a confirmation as single-use and short-lived', async () => {
      await mgr.checkUpdate();
      const a = await mgr.prepare('download', {});
      await mgr.confirm(a.token);
      await waitFor(async () => (await mgr.state()).download.phase === 'ready');
      await expect(mgr.confirm(a.token)).rejects.toThrow(/expired/);
      const b = await mgr.prepare('download', {});
      skew += 3 * 60_000;
      await expect(mgr.confirm(b.token)).rejects.toThrow(/expired/);
      await expect(mgr.confirm('nope')).rejects.toThrow(/expired/);
      await expect(mgr.confirm(5 as any)).rejects.toThrow(/Invalid/);
    });

    it('validates the install folder and the action', async () => {
      await mgr.checkUpdate();
      await expect(mgr.prepare('download', { dir: 'D:\\a"; calc & "' })).rejects.toThrow(/install folder/);
      await expect(mgr.prepare('format', {})).rejects.toThrow(/Unknown action/);
      await expect(mgr.prepare('download', null)).resolves.toBeTruthy();
    });
  });

  // ----- uninstall -----
  describe('uninstall', () => {
    let install: string;
    let uninst: string;
    const modelsDir = () => p('home', '.ollama', 'models');
    const seedModels = () => {
      fs.mkdirSync(path.join(modelsDir(), 'manifests'), { recursive: true });
      fs.mkdirSync(path.join(modelsDir(), 'blobs'), { recursive: true });
      fs.writeFileSync(path.join(modelsDir(), 'blobs', 'sha256-abc'), Buffer.alloc(1000));
      fs.writeFileSync(p('home', '.ollama', 'id_ed25519'), 'key'); // the user's Ollama key must survive
    };
    beforeEach(async () => {
      install = p('d', 'Apps', 'Ollama');
      touchExe(install);
      uninst = path.join(install, 'unins000.exe');
      fs.writeFileSync(uninst, 'x');
      sys.entries = [{ name: 'Ollama', version: '0.40.0', installLocation: install, uninstallString: `"${uninst}"` }];
      seedModels();
      agentsLocal = [{ id: 'a1', name: 'Hex' }, { id: 'a2', name: 'Kade' }];
      // The real uninstaller hands over to a copy of itself and exits at once; the entry disappears a little later.
      sys.runImpl = async (exe) => {
        expect(exe).toBe(uninst);
        setTimeout(() => { sys.entries = []; fs.rmSync(install, { recursive: true, force: true }); }, 80);
        return 0;
      };
      await mgr.detect();
    });

    it('describes the plan, including the agents and the models', async () => {
      const plan = await mgr.prepare('uninstall', {});
      expect(plan.lines.join(' ')).toContain(install);
      expect(plan.warnings.join(' ')).toMatch(/Hex, Kade/);
      expect(plan.deleteModels).toMatchObject({ default: true });
      expect(plan.deleteModels!.bytes).toBeGreaterThanOrEqual(1000);
    });

    it('uninstalls, deletes the models folder only (not the key), and resets the agents', async () => {
      const plan = await mgr.prepare('uninstall', {});
      await mgr.confirm(plan.token, { deleteModels: true });
      await waitFor(async () => (await mgr.state()).busy === null && reset.length > 0, 6000);
      expect((await mgr.state()).error).toBeNull();
      expect(sys.runs.map((r) => r.exe)).toEqual([uninst]);
      expect(sys.runs[0].args).toEqual([]); // no silent switches: the uninstaller shows its own window
      expect(fs.existsSync(modelsDir())).toBe(false);
      expect(fs.existsSync(p('home', '.ollama', 'id_ed25519'))).toBe(true);
      expect(reset).toEqual(['a1', 'a2']);
      expect((await mgr.state()).install).toBeNull();
    });

    it('keeps the models when asked to', async () => {
      const plan = await mgr.prepare('uninstall', {});
      await mgr.confirm(plan.token, { deleteModels: false });
      await waitFor(async () => (await mgr.state()).busy === null && reset.length > 0, 6000);
      expect(fs.existsSync(path.join(modelsDir(), 'blobs', 'sha256-abc'))).toBe(true);
      expect(reset).toEqual(['a1', 'a2']);
    });

    it('asks in a native dialog, built by the app, and does nothing if refused', async () => {
      confirmAnswer = false;
      const plan = await mgr.prepare('uninstall', {});
      await expect(mgr.confirm(plan.token, { deleteModels: true })).rejects.toThrow(/Cancelled/);
      expect(sys.runs).toEqual([]);
      expect(confirms[0].detail).toMatch(/will also be deleted/);
      expect(confirms[0].message).toContain(install);
      expect((await mgr.state()).busy).toBeNull();
      confirmAnswer = true;
      await mgr.confirm((await mgr.prepare('uninstall', {})).token, { deleteModels: false });
      await waitFor(async () => (await mgr.state()).busy === null && reset.length > 0, 6000);
      expect(confirms[confirms.length - 1].detail).toMatch(/kept/);
    });

    it('does not take a failed read of the uninstall list as proof that it is gone', async () => {
      sys.runImpl = async () => 0; // the uninstaller window is still open: the entry stays
      const m = mk({ timing: { startMs: 200, stopMs: 200, pollMs: 15, uninstallMs: 250, scanMs: 5000, stallMs: 600 } });
      await m.detect();
      sys.entriesFail = 1000; // and from now on every read of the uninstall list fails
      await m.confirm((await m.prepare('uninstall', {})).token, { deleteModels: true });
      await waitFor(async () => (await m.state()).busy === null);
      expect((await m.state()).error).toMatch(/was not uninstalled/);
      expect(fs.existsSync(path.join(modelsDir(), 'blobs', 'sha256-abc'))).toBe(true);
      expect(reset).toEqual([]);
    });

    it('needs two clean reads, so one good read between failures is not enough on its own', async () => {
      sys.runImpl = async () => { sys.entries = []; fs.rmSync(install, { recursive: true, force: true }); return 0; };
      await mgr.confirm((await mgr.prepare('uninstall', {})).token, { deleteModels: false });
      sys.entriesFail = 3; // three failed reads, then clean ones
      await waitFor(async () => (await mgr.state()).busy === null && reset.length > 0, 6000);
      expect((await mgr.state()).error).toBeNull();
    });

    it('lets the user stop waiting for an uninstaller that was closed', async () => {
      sys.runImpl = async () => 0; // never finishes
      await mgr.confirm((await mgr.prepare('uninstall', {})).token, { deleteModels: true });
      await waitFor(async () => (await mgr.state()).busy === 'uninstalling');
      await new Promise((r) => setTimeout(r, 60));
      mgr.cancelWait();
      await waitFor(async () => (await mgr.state()).busy === null, 3000);
      expect((await mgr.state()).error).toMatch(/Stopped waiting/);
      expect(fs.existsSync(path.join(modelsDir(), 'blobs', 'sha256-abc'))).toBe(true);
      expect(reset).toEqual([]);
    });

    it('stops a running server first and cancels a download', async () => {
      await ollama.listen();
      sys.procs = [{ pid: 101, name: 'ollama.exe', exePath: path.join(install, 'ollama.exe') }];
      sys.serverPids = new Set([101]);
      await mgr.confirm((await mgr.prepare('uninstall', {})).token, { deleteModels: false });
      await waitFor(async () => (await mgr.state()).busy === null && reset.length > 0, 6000);
      expect(sys.killed[0]).toEqual([101]);
    });

    it('changes nothing when the uninstaller is closed without finishing', async () => {
      sys.runImpl = async () => 0; // the entry never goes away
      const m = mk({ timing: { startMs: 200, stopMs: 200, pollMs: 15, uninstallMs: 200, scanMs: 5000, stallMs: 600 } });
      await m.detect();
      await m.confirm((await m.prepare('uninstall', {})).token, { deleteModels: true });
      await waitFor(async () => (await m.state()).busy === null);
      expect((await m.state()).error).toMatch(/was not uninstalled/);
      expect(fs.existsSync(path.join(modelsDir(), 'blobs', 'sha256-abc'))).toBe(true);
      expect(reset).toEqual([]);
    });

    it('reports an uninstaller that could not start', async () => {
      sys.runImpl = async () => null;
      await mgr.confirm((await mgr.prepare('uninstall', {})).token, {});
      await waitFor(async () => (await mgr.state()).busy === null);
      expect((await mgr.state()).error).toMatch(/could not be started/);
      expect(reset).toEqual([]);
    });

    it('refuses before doing anything when the models folder looks wrong', async () => {
      fs.rmSync(path.join(modelsDir(), 'blobs'), { recursive: true });
      await mgr.confirm((await mgr.prepare('uninstall', {})).token, { deleteModels: true });
      await waitFor(async () => (await mgr.state()).busy === null);
      expect((await mgr.state()).error).toMatch(/Nothing was changed/);
      expect(sys.runs).toEqual([]);
    });

    it('offers no uninstall when there is no registered uninstaller inside the folder', async () => {
      sys.entries = [{ name: 'Ollama', version: '0.40.0', installLocation: install, uninstallString: '"C:\\Windows\\System32\\cmd.exe" /c evil' }];
      await mgr.detect();
      expect((await mgr.state()).install?.uninstallable).toBe(false);
      await expect(mgr.prepare('uninstall', {})).rejects.toThrow(/no registered uninstaller/i);
      sys.entries = [];
      await mgr.detect();
      const st = await mgr.state();
      expect(st.install).toBeNull(); // with no entry the copy is only a scan hit, so it is not confirmed
      expect(st.candidates[0]).toMatchObject({ dir: install, trusted: false, uninstallable: false });
    });

    it('needs a confirmed copy', async () => {
      sys.entries = []; fs.rmSync(install, { recursive: true, force: true });
      await mgr.detect();
      await expect(mgr.prepare('uninstall', {})).rejects.toThrow(/No confirmed copy/);
    });
  });

  // ----- the models-folder safety checks -----
  describe('models folder safety', () => {
    const good = () => {
      const d = p('home', '.ollama', 'models');
      fs.mkdirSync(path.join(d, 'manifests'), { recursive: true }); fs.mkdirSync(path.join(d, 'blobs'), { recursive: true });
      return d;
    };
    it('accepts a real models folder', async () => {
      expect(await checkModelsDir(good(), [p('userdata')], p('home'))).toBeNull();
    });
    it('refuses a folder not named models that holds no model files, but accepts a custom folder that does', async () => {
      const custom = p('d', 'my-llms');
      fs.mkdirSync(path.join(custom, 'manifests'), { recursive: true }); fs.mkdirSync(path.join(custom, 'blobs'), { recursive: true });
      expect(await checkModelsDir(custom, [p('userdata')], p('home'))).toMatch(/does not look like/);
      fs.writeFileSync(path.join(custom, 'blobs', 'sha256-1234'), 'x');
      expect(await checkModelsDir(custom, [p('userdata')], p('home'))).toBeNull();
    });

    it('is not fooled by a link in a parent folder', async () => {
      const real = p('home', '.ollama', 'models');
      fs.mkdirSync(path.join(real, 'manifests'), { recursive: true }); fs.mkdirSync(path.join(real, 'blobs'), { recursive: true });
      try { fs.symlinkSync(p('home'), p('d', 'sneaky'), 'junction'); } catch { return; /* cannot create links here */ }
      // d\sneaky\.ollama\models is really the home folder's models: reached through a link, so it is not deleted
      expect(await checkModelsDir(path.join(p('d', 'sneaky'), '.ollama', 'models'), [], p('userdata'))).toMatch(/link or alias/);
    });

    it('refuses everything else', async () => {
      const d = good();
      expect(await checkModelsDir('relative', [], p('home'))).toMatch(/absolute/);
      expect(await checkModelsDir(path.parse(tmp).root, [], p('home'))).toMatch(/drive root/);
      expect(await checkModelsDir(p('home'), [], p('home'))).toMatch(/home or app/);
      expect(await checkModelsDir(tmp, [], p('home'))).toMatch(/home or app/); // an ancestor of the home folder
      expect(await checkModelsDir(p('userdata'), [p('userdata')], p('home'))).toMatch(/home or app/);
      expect(await checkModelsDir(p('home', 'nothing'), [], p('home'))).toMatch(/missing or is a link/);
      fs.mkdirSync(p('d', 'plain'), { recursive: true });
      expect(await checkModelsDir('\\\\server\\share\\models', [], p('home'))).toMatch(/local drive/);
      expect(await checkModelsDir(p('d', 'plain'), [], p('home'))).toMatch(/does not look like/);
      try {
        fs.symlinkSync(d, p('d', 'link'), 'junction');
        expect(await checkModelsDir(p('d', 'link'), [], p('home'))).toMatch(/link/);
      } catch { /* cannot create links here */ }
    });
  });
});
