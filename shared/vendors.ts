// Vendors an agent's model can come from. Shared by the main process and the interface.

export type VendorId = 'anthropic' | 'openai' | 'google' | 'xai' | 'deepseek' | 'local' | 'custom';
export interface ModelRef { vendor: VendorId; model: string }

export interface VendorInfo {
  id: VendorId;
  label: string;
  /** Which wire format it speaks. */
  api: 'anthropic' | 'openai';
  /** Fixed for hosted vendors. For local and custom this is only the default; the user can change it. */
  baseUrl: string;
  editableUrl: boolean;
  needsKey: boolean;
  /** Suggestions only. Names change often, so the interface always allows typing another. */
  models: string[];
  note: string;
}

export const VENDORS: VendorInfo[] = [
  { id: 'anthropic', label: 'Anthropic (Claude)', api: 'anthropic', baseUrl: '', editableUrl: false, needsKey: true,
    models: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-2'], note: 'Claude models.' },
  { id: 'openai', label: 'OpenAI', api: 'openai', baseUrl: 'https://api.openai.com/v1', editableUrl: false, needsKey: true,
    models: ['gpt-5', 'gpt-5-mini'], note: "GPT models. Some (such as Codex) are served only by OpenAI's newer Responses API and may not work here." },
  { id: 'google', label: 'Google (Gemini)', api: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', editableUrl: false, needsKey: true,
    models: ['gemini-2.5-pro', 'gemini-2.5-flash'], note: 'Gemini models through Google\'s OpenAI-compatible endpoint.' },
  { id: 'xai', label: 'xAI (Grok)', api: 'openai', baseUrl: 'https://api.x.ai/v1', editableUrl: false, needsKey: true,
    models: ['grok-4'], note: 'Grok models.' },
  { id: 'deepseek', label: 'DeepSeek', api: 'openai', baseUrl: 'https://api.deepseek.com', editableUrl: false, needsKey: true,
    models: ['deepseek-chat', 'deepseek-reasoner'], note: 'DeepSeek models.' },
  { id: 'local', label: 'Open source (local)', api: 'openai', baseUrl: 'http://localhost:11434/v1', editableUrl: true, needsKey: false,
    models: [], note: 'A model running on this computer through Ollama, LM Studio, llama.cpp or vLLM. Free, nothing leaves your machine.' },
  { id: 'custom', label: 'Other (OpenAI-compatible)', api: 'openai', baseUrl: '', editableUrl: true, needsKey: true,
    models: [], note: 'Any service that speaks the OpenAI chat API, such as OpenRouter, Together or Groq. Enter its address and key.' },
];

/** Where a local model server usually listens, for the quick-fill buttons. */
export const LOCAL_PRESETS: { label: string; url: string }[] = [
  { label: 'Ollama', url: 'http://localhost:11434/v1' },
  { label: 'LM Studio', url: 'http://localhost:1234/v1' },
];

export const isVendorId = (v: unknown): v is VendorId => typeof v === 'string' && VENDORS.some((x) => x.id === v);
export const vendorInfo = (id: VendorId): VendorInfo => VENDORS.find((v) => v.id === id)!;

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,99}$/;
export const isModelName = (s: unknown): s is string => typeof s === 'string' && MODEL_RE.test(s);

/** Validates an agent's explicit model. Throws a readable error; returns the clean value. */
export function cleanModelRef(v: unknown): ModelRef {
  const o = (v && typeof v === 'object' ? v : {}) as { vendor?: unknown; model?: unknown };
  if (!isVendorId(o.vendor)) throw new Error('Unknown vendor');
  if (!isModelName(o.model)) throw new Error('Model names use letters, numbers and . _ : / @ + - only (up to 100 characters)');
  return { vendor: o.vendor, model: o.model };
}

/**
 * The address a key may be sent to must be https, or plain http only to this machine (a local model server).
 * Credentials inside the URL are refused. Returns the normalised address without a trailing slash, or null.
 */
export function validBaseUrl(url: string): string | null {
  let u: URL;
  try { u = new URL(url.trim()); } catch { return null; }
  if (u.username || u.password || u.search || u.hash) return null;
  if (u.protocol === 'https:' || (u.protocol === 'http:' && isLoopbackHost(u.hostname))) return u.toString().replace(/\/+$/, '');
  return null;
}

/** Only this computer: names that can never resolve elsewhere. */
export const isLoopbackHost = (h: string) => h === 'localhost' || h === '127.0.0.1' || h === '[::1]';

/** The "local" vendor must really be local: otherwise its free pricing and "stays on this computer" claim would be false. */
export function validLocalUrl(url: string): string | null {
  const clean = validBaseUrl(url);
  return clean && isLoopbackHost(new URL(clean).hostname) ? clean : null;
}

/** Tool use (file edits, commands) is on by default for hosted vendors and off for local/custom, where models vary a lot. */
export function toolsAllowed(ref: ModelRef, overrides: Record<string, boolean> | undefined): boolean {
  // Own keys only: a model named "constructor" must not inherit from Object.
  const set = overrides && Object.hasOwn(overrides, ref.model) ? overrides[ref.model] : undefined;
  if (set !== undefined) return set;
  return ref.vendor !== 'local' && ref.vendor !== 'custom';
}
