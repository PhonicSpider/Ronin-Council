// The Windows side of the Local models manager: registry, processes, file properties, signatures, graphics cards, and running
// programs. Each PowerShell script is fixed text; the only data passed in goes through environment variables, never into the script.
import { execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { GpuInfo } from '../shared/ollama';
import type { OllamaSystem, ProcInfo, UninstallEntry } from './ollama';

// Programs are started by their full path under System32, never by bare name (a bare name could pick up a planted copy from PATH or
// the current folder).
const SYS32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
const PS = path.join(SYS32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const TASKKILL = path.join(SYS32, 'taskkill.exe');

function ps(script: string, env: Record<string, string> = {}, timeoutMs = 25_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${script}`],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, ...env } },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout).trim())),
    );
  });
}

async function psJson<T>(script: string, env?: Record<string, string>): Promise<T[]> {
  const out = await ps(script, env);
  if (!out) return [];
  const j = JSON.parse(out) as unknown;
  return Array.isArray(j) ? (j as T[]) : [j as T];
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

function nvidiaSmi(): Promise<GpuInfo[]> {
  const candidates = [path.join(SYS32, 'nvidia-smi.exe'), path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'NVIDIA Corporation', 'NVSMI', 'nvidia-smi.exe')];
  const tryOne = (i: number): Promise<GpuInfo[]> => new Promise((resolve) => {
    if (i >= candidates.length) return resolve([]);
    execFile(candidates[i], ['--query-gpu=name,memory.total,memory.used', '--format=csv,noheader,nounits'], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
      if (err) return resolve(tryOne(i + 1));
      const out: GpuInfo[] = [];
      for (const line of String(stdout).split(/\r?\n/)) {
        const [name, total, used] = line.split(',').map((x) => x.trim());
        const t = Number(total);
        if (name && Number.isFinite(t) && t > 0) out.push({ name, vramBytes: t * 1024 * 1024, usedBytes: Number.isFinite(Number(used)) ? Number(used) * 1024 * 1024 : null });
      }
      resolve(out.length ? out : tryOne(i + 1));
    });
  });
  return tryOne(0);
}

const REG_GPU = `$base='HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}'; $r=@(); foreach($i in Get-ChildItem $base -ErrorAction SilentlyContinue){ if($i.PSChildName -match '^\\d{4}$'){ $p=Get-ItemProperty $i.PSPath -ErrorAction SilentlyContinue; if($p.DriverDesc){ $m=$p.'HardwareInformation.qwMemorySize'; $v=$null; if($m -is [byte[]]){ $v=[double][BitConverter]::ToUInt64($m,0) } elseif($m -ne $null){ $v=[double]$m }; $r += [pscustomobject]@{name=[string]$p.DriverDesc;mem=$v} } } }; ConvertTo-Json -InputObject @($r) -Compress`;
const VIRTUAL_GPU = /Microsoft (Basic|Hyper-V|Remote)|Virtual|Parsec|VNC|Citrix|DisplayLink|Remote Desktop/i;

export function createOllamaSystem(): OllamaSystem {
  return {
    async fixedDrives() {
      const r = await psJson<string>(`$r=@(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { $_.DeviceID + '\\' }); ConvertTo-Json -InputObject @($r) -Compress`);
      return r.filter((x) => /^[A-Za-z]:\\$/.test(x));
    },

    async uninstallEntries(): Promise<UninstallEntry[]> {
      const r = await psJson<Record<string, unknown>>(
        `$out=@(); foreach($k in 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'){ if(Test-Path $k){ foreach($i in Get-ChildItem $k -ErrorAction SilentlyContinue){ $p=Get-ItemProperty $i.PSPath -ErrorAction SilentlyContinue; if($p.DisplayName -and ($p.DisplayName -match '^Ollama')){ $out += [pscustomobject]@{name=[string]$p.DisplayName;version=[string]$p.DisplayVersion;installLocation=[string]$p.InstallLocation;uninstallString=[string]$p.UninstallString} } } } }; ConvertTo-Json -InputObject @($out) -Compress`);
      return r.map((e) => ({ name: str(e.name) ?? 'Ollama', version: str(e.version), installLocation: str(e.installLocation), uninstallString: str(e.uninstallString) }));
    },

    async processes(): Promise<ProcInfo[]> {
      const r = await psJson<Record<string, unknown>>(
        `$r=@(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('ollama.exe','ollama app.exe') } | ForEach-Object { [pscustomobject]@{pid=[int]$_.ProcessId;name=[string]$_.Name;exePath=[string]$_.ExecutablePath} }); ConvertTo-Json -InputObject @($r) -Compress`);
      return r.filter((p) => typeof p.pid === 'number' && typeof p.name === 'string').map((p) => ({ pid: p.pid as number, name: p.name as string, exePath: str(p.exePath) }));
    },

    pathDirs: () => (process.env.PATH ?? '').split(';').map((s) => s.trim().replace(/^"|"$/g, '')).filter(Boolean),

    async userEnv(name) {
      if (!/^[A-Z][A-Z0-9_]{0,40}$/.test(name)) return null;
      const out = await ps(`[Environment]::GetEnvironmentVariable($env:RC_NAME,'User')`, { RC_NAME: name });
      return out || null;
    },

    async fileVersion(file) {
      const out = await ps(`(Get-Item -LiteralPath $env:RC_PATH).VersionInfo.ProductVersion`, { RC_PATH: file });
      const m = /^(\d+)\.(\d+)\.(\d+)/.exec(out.trim());
      return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
    },

    async signature(file) {
      const r = await psJson<Record<string, unknown>>(
        `$s=Get-AuthenticodeSignature -LiteralPath $env:RC_PATH; $sub=$null; if($s.SignerCertificate){ $sub=[string]$s.SignerCertificate.Subject }; ConvertTo-Json -InputObject ([pscustomobject]@{status=$s.Status.ToString();subject=$sub}) -Compress`, { RC_PATH: file });
      return { status: str(r[0]?.status) ?? 'UnknownError', subject: str(r[0]?.subject) };
    },

    async gpus() {
      const smi = await nvidiaSmi();
      let reg: GpuInfo[] = [];
      try {
        const rows = await psJson<Record<string, unknown>>(REG_GPU);
        reg = rows.filter((x) => typeof x.name === 'string' && !VIRTUAL_GPU.test(x.name as string))
          .map((x) => ({ name: x.name as string, vramBytes: typeof x.mem === 'number' && x.mem > 0 ? x.mem : null }));
      } catch { reg = []; }
      const known = new Set(smi.map((g) => g.name.toLowerCase()));
      return [...smi, ...reg.filter((g) => !known.has(g.name.toLowerCase()))];
    },

    ramBytes: () => os.totalmem(),
    freeRamBytes: () => os.freemem(),

    async freeDiskBytes(dir) {
      let p = path.resolve(dir);
      for (let i = 0; i < 12; i++) {
        try { await fs.promises.access(p); break; } catch { const up = path.dirname(p); if (up === p) break; p = up; }
      }
      try { const s = await fs.promises.statfs(p); return Number(s.bavail) * Number(s.bsize); } catch { return null; }
    },

    startServer(exe, env) {
      const child = spawn(exe, ['serve'], { windowsHide: true, stdio: 'ignore', cwd: path.dirname(exe), ...(env ? { env } : {}) });
      const cbs: (() => void)[] = [];
      const fire = () => { for (const cb of cbs.splice(0)) cb(); };
      child.on('exit', fire);
      child.on('error', fire);
      return { pid: child.pid ?? null, onExit: (cb: () => void) => { cbs.push(cb); } };
    },

    async kill(pids) {
      for (const pid of pids) {
        if (!Number.isInteger(pid) || pid <= 4) continue;
        await new Promise<void>((resolve) => { execFile(TASKKILL, ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 }, () => resolve()); });
      }
    },

    run(exe, args, o) {
      return new Promise((resolve) => {
        try {
          // With verbatim arguments Node does not quote the program's own path, so a path with a space (such as the app's data
          // folder, "Ronin Council") would reach the program split in two. Quoting argv[0] ourselves fixes that; checked on this machine.
          const child = spawn(exe, args, {
            windowsHide: false, stdio: 'ignore', cwd: path.dirname(exe), ...(o?.env ? { env: o.env } : {}),
            ...(o?.verbatim ? { windowsVerbatimArguments: true, argv0: `"${exe}"` } : {}),
          });
          child.on('error', () => resolve(null));
          child.on('exit', (code) => resolve(code ?? 0));
        } catch { resolve(null); }
      });
    },
  };
}
