// Pure helpers for the Local models popup: model names, versions, memory estimates, the "fits your machine" badge, and the
// catalog of models offered for download. No I/O here, so the main process and the interface share one set of rules.

export const GIB = 1024 ** 3;
export const GB = 1e9;

/** Ollama's address when nothing else is set. Always this computer. */
export const OLLAMA_DEFAULT_ORIGIN = 'http://localhost:11434';

// ---------- names ----------

/**
 * A model name this app will ask Ollama to download or delete: `name` or `namespace/name`, optionally `:tag`, lowercase.
 * Two slashes (a host such as `example.com/ns/name`) are refused so a download can never come from a third-party registry.
 */
const NAME_RE = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?(?::[A-Za-z0-9][A-Za-z0-9._-]*)?$/;
export const isOllamaModelName = (s: unknown): s is string => typeof s === 'string' && s.length <= 100 && NAME_RE.test(s);

// ---------- versions ----------

/** "0.40.16", "v0.40.16" and "0.40.16-rc1" are read; anything else is null. */
export function parseVersion(s: unknown): { nums: [number, number, number]; pre: boolean } | null {
  if (typeof s !== 'string') return null;
  const m = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(-[0-9A-Za-z.+-]+)?$/.exec(s.trim());
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: !!m[4] };
}

/** Negative when a is older than b, 0 when equal, positive when newer; null when either cannot be read. */
export function compareVersions(a: unknown, b: unknown): number | null {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] < y.nums[i] ? -1 : 1;
  if (x.pre !== y.pre) return x.pre ? -1 : 1; // a pre-release is older than its release
  return 0;
}

// ---------- memory and fit ----------

/**
 * A rough figure for the memory a model needs while it runs: its file size plus working memory (the context cache and buffers).
 * It assumes a context of a few thousand tokens; a longer context needs more. Always shown as an estimate.
 */
export const estimateMemoryBytes = (fileBytes: number): number => Math.round(fileBytes * 1.15 + 0.8 * GIB);

export interface GpuInfo { name: string; /** Total video memory in bytes, or null when it could not be read. */ vramBytes: number | null; usedBytes?: number | null }
export interface Hardware { ramBytes: number; gpus: GpuInfo[] }

export type FitKind = 'gpu' | 'ram' | 'too-big' | 'unknown';
export interface Fit { kind: FitKind; label: string; detail: string }

const GPU_SHARE = 0.9; // leave room for the desktop and the driver
const RAM_SHARE = 0.8; // leave room for Windows and the other programs

/** Whether a model with this estimated need fits: in the graphics card, in RAM (slower), or not at all. */
export function fitFor(needBytes: number, hw: Hardware | null): Fit {
  if (!hw || !(hw.ramBytes > 0) || !Number.isFinite(needBytes) || needBytes <= 0) {
    return { kind: 'unknown', label: 'Unknown', detail: 'Your hardware could not be read.' };
  }
  const vram = Math.max(0, ...hw.gpus.map((g) => g.vramBytes ?? 0));
  if (vram > 0 && needBytes <= vram * GPU_SHARE) {
    return { kind: 'gpu', label: 'Fits on GPU', detail: 'Should run fully in the graphics card.' };
  }
  if (needBytes <= hw.ramBytes * RAM_SHARE) {
    return {
      kind: 'ram', label: 'Fits in RAM (slower)',
      detail: vram > 0 ? 'Too big for the graphics card alone; runs partly or fully on the processor, which is slower.' : 'Runs on the processor, which is slower than a graphics card.',
    };
  }
  return { kind: 'too-big', label: 'Too big', detail: 'Needs more memory than this computer has to spare.' };
}

// ---------- formatting ----------

/** Model files use decimal gigabytes, as Ollama shows them. */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '?';
  if (bytes >= GB) return `${(bytes / GB).toFixed(bytes >= 10 * GB ? 0 : 1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}
/** RAM and video memory are quoted the way everyone sells them: 8 GB means 8 GiB. */
export function formatMemory(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '?';
  const g = bytes / GIB;
  return `${g >= 10 ? Math.round(g) : g.toFixed(1)} GB`;
}

// ---------- catalog ----------

export interface CatalogEntry {
  /** The exact name to download, tag included. */
  name: string;
  /** Short title for the list. */
  label: string;
  /** Download size in bytes, as shown on the Ollama library page. */
  sizeBytes: number;
  /** The library page lists the "tools" capability, which the agents need to edit files or run commands. */
  tools: boolean;
  note?: string;
}

/** When the sizes and capabilities below were read from ollama.com/library. Names and sizes change; this is a starting list. */
export const CATALOG_CHECKED = '2026-11-13';

const m = (name: string, label: string, gb: number, tools: boolean, note?: string): CatalogEntry =>
  ({ name, label, sizeBytes: Math.round(gb * GB), tools, ...(note ? { note } : {}) });

export const CATALOG: CatalogEntry[] = [
  m('qwen3:4b', 'Qwen3 4B', 2.5, true, 'Small and quick; good for reviews and short tasks.'),
  m('qwen3:8b', 'Qwen3 8B', 5.2, true, 'A good all-rounder for a mid-range graphics card.'),
  m('qwen3:14b', 'Qwen3 14B', 9.3, true),
  m('qwen3:30b', 'Qwen3 30B', 19, true),
  m('qwen3:32b', 'Qwen3 32B', 20, true),
  m('qwen3-coder:30b', 'Qwen3 Coder 30B', 19, true, 'Tuned for programming.'),
  m('qwen2.5-coder:7b', 'Qwen2.5 Coder 7B', 4.7, true, 'Tuned for programming.'),
  m('qwen2.5-coder:14b', 'Qwen2.5 Coder 14B', 9.0, true, 'Tuned for programming.'),
  m('qwen2.5-coder:32b', 'Qwen2.5 Coder 32B', 20, true, 'Tuned for programming.'),
  m('deepseek-r1:8b', 'DeepSeek R1 8B', 5.2, true, 'Reasons step by step; a distilled model.'),
  m('deepseek-r1:14b', 'DeepSeek R1 14B', 9.0, true, 'Reasons step by step; a distilled model.'),
  m('deepseek-r1:32b', 'DeepSeek R1 32B', 20, true, 'Reasons step by step; a distilled model.'),
  m('deepseek-r1:70b', 'DeepSeek R1 70B', 43, true, 'Reasons step by step; a distilled model.'),
  m('deepseek-r1:671b', 'DeepSeek R1 671B', 404, true, 'The full model. Needs a server, not a desktop.'),
  m('gpt-oss:20b', 'gpt-oss 20B', 14, true, "OpenAI's open-weight model."),
  m('gpt-oss:120b', 'gpt-oss 120B', 65, true, "OpenAI's open-weight model."),
  m('llama3.1:8b', 'Llama 3.1 8B', 4.9, true),
  m('llama3.1:70b', 'Llama 3.1 70B', 43, true),
  m('llama3.2:3b', 'Llama 3.2 3B', 2.0, true, 'Very small.'),
  m('mistral:7b', 'Mistral 7B', 4.4, true),
  m('mistral-small:24b', 'Mistral Small 24B', 14, true),
  m('devstral:24b', 'Devstral 24B', 14, true, 'Tuned for programming agents.'),
  m('granite3.3:8b', 'Granite 3.3 8B', 4.9, true),
  m('gemma3:4b', 'Gemma 3 4B', 3.4, false, 'Does not advertise tool use.'),
  m('gemma3:12b', 'Gemma 3 12B', 8.2, false, 'Does not advertise tool use.'),
  m('gemma3:27b', 'Gemma 3 27B', 17, false, 'Does not advertise tool use.'),
  m('phi4:14b', 'Phi-4 14B', 9.1, false, 'Does not advertise tool use.'),
];

/** The catalog row for a model name, matched exactly (a bare name means its `:latest` tag only if listed that way). */
export const catalogEntry = (name: string): CatalogEntry | undefined => CATALOG.find((c) => c.name === name);

// ---------- what the popup shows ----------

export type InstallSource = 'registry' | 'default' | 'saved' | 'process' | 'path' | 'scan';

export interface OllamaInstall {
  dir: string;
  exe: string;
  version: string | null;
  sources: InstallSource[];
  /** Found in the Windows uninstall list, the default folder, or chosen by the user. Only a trusted copy is ever run. */
  trusted: boolean;
  /** A registered uninstaller exists inside the folder. */
  uninstallable: boolean;
}

export interface OllamaModelRow {
  name: string;
  sizeBytes: number;
  params: string;
  quant: string;
  estBytes: number;
  fit: Fit;
  loaded: boolean;
  vramBytes: number | null;
}

export interface OllamaCatalogRow extends CatalogEntry {
  estBytes: number;
  fit: Fit;
  installed: boolean;
}

export interface OllamaPull {
  model: string;
  status: string;
  completed: number;
  total: number;
  done: boolean;
  cancelled?: boolean;
  error?: string;
}

export interface OllamaDownload {
  phase: 'idle' | 'downloading' | 'verifying' | 'ready' | 'failed';
  tag: string;
  completed: number;
  total: number;
  signature?: { status: string; subject: string | null };
  error?: string;
}

export interface OllamaLatest {
  tag: string;
  version: string;
  /** null when the installed version is unknown. */
  upToDate: boolean | null;
  installerSize: number | null;
  checkedAt: number;
}

export type OllamaBusy = null | 'starting' | 'stopping' | 'installing' | 'uninstalling';

export interface OllamaState {
  supported: boolean;
  scanned: boolean;
  install: OllamaInstall | null;
  candidates: OllamaInstall[];
  server: { running: boolean; version: string | null; ownedByApp: boolean; origin: string; foreign: boolean };
  models: OllamaModelRow[];
  catalog: OllamaCatalogRow[];
  catalogChecked: string;
  hardware: { ramBytes: number; freeRamBytes: number; gpus: GpuInfo[]; modelsDir: string; modelsFreeBytes: number | null } | null;
  latest: OllamaLatest | null;
  pull: OllamaPull | null;
  download: OllamaDownload;
  busy: OllamaBusy;
  error: string | null;
  localAgents: { id: string; name: string }[];
  addressSaved: boolean;
}

/** What the user is asked to confirm before anything is downloaded, run or deleted. */
export interface OllamaPlan {
  token: string;
  action: 'download' | 'uninstall';
  title: string;
  lines: string[];
  warnings: string[];
  /** For uninstall: whether the "also delete models" box starts ticked, and how much it would remove. */
  deleteModels?: { default: boolean; bytes: number; count: number };
  expiresAt: number;
}
