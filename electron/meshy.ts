import { createHash } from 'crypto';
import {
  MESHY_PROMPT_MAX, MESHY_KINDS, MeshyKind, MeshyQuality, MeshySpec, meshyEstimate, meshySteps,
} from '../shared/meshy';
import { imageMatchesExt, Prepared, readProjectImage, saveProjectFile, ToolDef, ToolOutput, visible } from './project';

/**
 * Meshy (3D and image generation) for agents that have the ability. Three tools: meshy_generate (costs credits, needs Widow's audit
 * and the user's approval), meshy_fetch (download a finished task, free) and meshy_balance (free). Results are saved into the project
 * folder at once, because Meshy deletes API results after a few days.
 */

// ---------- the client ----------
export interface MeshyTask {
  id: string;
  status: 'PENDING' | 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED' | 'CANCELED' | string;
  progress?: number;
  consumed_credits?: number;
  model_urls?: Record<string, string>;
  thumbnail_url?: string;
  image_urls?: string[];
  task_error?: { message?: string; type?: string } | null;
}
export interface MeshyBalance { balance: number; monthly?: number; permanent?: number }

export interface MeshyClient {
  /** True for the free placeholder client: nothing is billed, so credits are not counted. */
  readonly mock: boolean;
  balance(signal?: AbortSignal): Promise<MeshyBalance>;
  /** Starts a task and returns its id. Never retried: a retry could be billed twice. */
  create(endpoint: string, body: unknown, signal?: AbortSignal): Promise<string>;
  get(endpoint: string, id: string, signal?: AbortSignal): Promise<MeshyTask>;
  download(url: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer>;
}

/** An error from Meshy. `definitive` means Meshy clearly refused (so nothing was started or charged); otherwise the outcome is unknown. */
export class MeshyApiError extends Error {
  constructor(message: string, public definitive: boolean) { super(message); }
}

export const EP = {
  text_to_3d: '/openapi/v2/text-to-3d',
  image_to_3d: '/openapi/v1/image-to-3d',
  text_to_image: '/openapi/v1/text-to-image',
} as const;
const BASE = 'https://api.meshy.ai';

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) return reject(new Error('Stopped'));
  const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(t); reject(new Error('Stopped')); };
  signal?.addEventListener('abort', onAbort, { once: true });
});

/** A download URL comes from Meshy's reply, so it is still checked: https, and not an address on this computer or network. */
export function safeDownloadUrl(raw: string, allowInsecure = false): URL {
  // Tests point this at a local fake server; real use accepts Meshy's own file hosts only.
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error('Meshy returned a file address that is not a valid URL'); }
  if (allowInsecure) return u;
  const h = u.hostname.toLowerCase();
  const privateHost = h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || h === '[::1]' || /^\[?(fc|fd|fe80)/.test(h)
    || /^(127|10|0)\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
  const meshyHost = h === 'meshy.ai' || h.endsWith('.meshy.ai');
  if (u.protocol !== 'https:' || u.username || u.password || privateHost || !meshyHost) {
    throw new Error('Meshy returned a file address that is not allowed (it must be https on a meshy.ai host)');
  }
  return u;
}

export interface HttpMeshyOptions { baseUrl?: string; fetchImpl?: typeof fetch; retryDelayMs?: number; allowInsecureDownloads?: boolean }

export class HttpMeshyClient implements MeshyClient {
  readonly mock = false;
  private base: string;
  private f: typeof fetch;
  constructor(private apiKey: string, private o: HttpMeshyOptions = {}) {
    this.base = (o.baseUrl ?? BASE).replace(/\/+$/, '');
    this.f = o.fetchImpl ?? fetch;
  }

  private scrub(s: string) { return this.apiKey ? s.split(this.apiKey).join('[key]') : s; }

  private fail(status: number, text: string): MeshyApiError {
    let msg = text;
    try { const j = JSON.parse(text); msg = String(j?.message ?? j?.error ?? text); } catch { /* plain text */ }
    msg = this.scrub(msg).replace(/\s+/g, ' ').trim().slice(0, 300);
    const clear = status >= 400 && status < 500; // a 4xx means the request was refused, not started
    if (status === 401) return new MeshyApiError('Invalid or missing Meshy key (Settings, API & Models).', clear);
    if (status === 402) return new MeshyApiError(`Meshy says there are not enough credits, or this plan cannot use that feature${msg ? `: ${msg}` : ''}.`, clear);
    if (status === 429) return new MeshyApiError('Meshy is rate limiting requests or has too many tasks running. Wait a moment and try again.', clear);
    return new MeshyApiError(`Meshy error ${status}: ${msg}`, clear);
  }

  private async call(method: 'GET' | 'POST', path: string, body: unknown, signal: AbortSignal | undefined, retry: boolean): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const sig = signal && 'any' in AbortSignal ? (AbortSignal as unknown as { any(s: AbortSignal[]): AbortSignal }).any([signal, AbortSignal.timeout(60_000)]) : signal ?? AbortSignal.timeout(60_000);
    let last: Error = new Error('request failed');
    for (let attempt = 0; attempt < (retry ? 3 : 1); attempt++) {
      if (signal?.aborted) throw new Error('Stopped');
      let res: Response;
      try {
        res = await this.f(`${this.base}${path}`, {
          method, signal: sig,
          headers: { authorization: `Bearer ${this.apiKey}`, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
          ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
        });
      } catch {
        if (signal?.aborted) throw new Error('Stopped');
        last = new Error('Could not reach Meshy (network).');
        if (retry && attempt < 2) { await sleep((this.o.retryDelayMs ?? 800) * (attempt + 1), signal); continue; }
        throw last;
      }
      const text = await res.text();
      if (res.ok) { try { return JSON.parse(text); } catch { throw new Error('Meshy sent a reply that was not JSON.'); } }
      last = this.fail(res.status, text);
      if (retry && (res.status === 429 || res.status >= 500) && attempt < 2) { await sleep((this.o.retryDelayMs ?? 800) * (attempt + 1), signal); continue; }
      throw last;
    }
    throw last;
  }

  async balance(signal?: AbortSignal): Promise<MeshyBalance> {
    const j = await this.call('GET', '/openapi/v1/balance', undefined, signal, true);
    return { balance: Number(j?.balance) || 0, monthly: j?.monthly_credits, permanent: j?.permanent_credits };
  }

  async create(endpoint: string, body: unknown, signal?: AbortSignal): Promise<string> {
    const j = await this.call('POST', endpoint, body, signal, false);
    const id = typeof j?.result === 'string' ? j.result : '';
    if (!/^[A-Za-z0-9_-]{4,80}$/.test(id)) throw new Error('Meshy did not return a task id.');
    return id;
  }

  async get(endpoint: string, id: string, signal?: AbortSignal): Promise<MeshyTask> {
    if (!/^[A-Za-z0-9_-]{4,80}$/.test(id)) throw new Error('Invalid task id');
    const j = await this.call('GET', `${endpoint}/${id}`, undefined, signal, true);
    return j as MeshyTask;
  }

  async download(url: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
    // No Authorization header: the file host is not Meshy's API, and the key must never go there.
    // Redirects are followed by hand so every hop is checked like the first address, and a stalled download is cut off.
    const timeout = AbortSignal.timeout(180_000);
    const sig = signal && 'any' in AbortSignal ? (AbortSignal as unknown as { any(s: AbortSignal[]): AbortSignal }).any([signal, timeout]) : signal ?? timeout;
    let target = safeDownloadUrl(url, this.o.allowInsecureDownloads);
    let res: Response | undefined;
    for (let hop = 0; hop < 4; hop++) {
      res = await this.f(target, { signal: sig, redirect: 'manual' });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        target = safeDownloadUrl(new URL(res.headers.get('location')!, target).toString(), this.o.allowInsecureDownloads);
        continue;
      }
      break;
    }
    if (!res || (res.status >= 300 && res.status < 400)) throw new Error('The file address redirected too many times.');
    if (!res.ok) throw new Error(`Could not download the file (HTTP ${res.status}).`);
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > maxBytes) throw new Error(`The file is larger than the ${Math.round(maxBytes / 1e6)} MB limit.`);
    const chunks: Buffer[] = [];
    let total = 0;
    const reader = res.body?.getReader();
    if (!reader) {
      const whole = Buffer.from(await res.arrayBuffer());
      if (whole.length > maxBytes) throw new Error(`The file is larger than the ${Math.round(maxBytes / 1e6)} MB limit.`);
      return whole;
    }
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { void reader.cancel(); throw new Error(`The file is larger than the ${Math.round(maxBytes / 1e6)} MB limit.`); }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }
}

/** Free placeholder used in Mock mode: every task succeeds at once with a tiny model or image, and nothing is billed. */
export class MockMeshyClient implements MeshyClient {
  readonly mock = true;
  created: { endpoint: string; body: unknown }[] = [];
  async balance(): Promise<MeshyBalance> { return { balance: 1000, monthly: 600, permanent: 400 }; }
  async create(endpoint: string, body: unknown): Promise<string> {
    this.created.push({ endpoint, body });
    return `mock_${this.created.length}_${endpoint.split('/').pop()}`;
  }
  async get(_endpoint: string, id: string): Promise<MeshyTask> {
    return {
      id, status: 'SUCCEEDED', progress: 100, consumed_credits: 0,
      model_urls: { glb: `mock://${id}/model.glb` }, thumbnail_url: `mock://${id}/thumb.png`, image_urls: [`mock://${id}/image.png`],
    };
  }
  async download(url: string): Promise<Buffer> {
    if (url.endsWith('.glb')) { const b = Buffer.alloc(12); b.write('glTF', 0); b.writeUInt32LE(2, 4); b.writeUInt32LE(12, 8); return b; }
    // a 1x1 transparent PNG
    return Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  }
}

// ---------- running a request ----------
export interface MeshyDeps {
  client: MeshyClient;
  /** Credits used today so far, the daily cap, and how to add (or take back) credits. */
  creditsToday(): number;
  dailyCap(): number;
  addCredits(delta: number): void;
  poll?: { intervalMs: number; timeoutMs: number };
  /** Asked again at the moment a paid request runs: false if the user switched modes or removed the key while it waited for approval. */
  stillAvailable?(): boolean;
}

const MODEL_MAX = 100_000_000;
const IMAGE_MAX = 25_000_000;
const INPUT_IMAGE_MAX = 20_000_000;
const FOLDER = 'assets/meshy';

interface Wanted { url: string; kind: 'model' | 'preview' | 'image'; ext: string }

const extOf = (url: string, fallback: string) => {
  try { const e = new URL(url).pathname.split('.').pop()?.toLowerCase() ?? ''; return /^(png|jpg|jpeg|webp)$/.test(e) ? e : fallback; } catch { return fallback; }
};

interface RunResult { done: boolean; taskIds: string[]; files: Wanted[]; consumed: number; note?: string }

/** Waits for a task to reach a final state, honouring Stop and a time limit. Returns null on timeout (the task may still finish). */
async function waitFor(d: MeshyDeps, endpoint: string, id: string, signal: AbortSignal | undefined): Promise<MeshyTask | null> {
  const { intervalMs, timeoutMs } = d.poll ?? { intervalMs: 5000, timeoutMs: 600_000 };
  const start = Date.now();
  for (;;) {
    const t = await d.client.get(endpoint, id, signal);
    if (t.status === 'SUCCEEDED') return t;
    if (t.status === 'FAILED' || t.status === 'CANCELED') {
      const why = t.task_error?.message ? `: ${String(t.task_error.message).slice(0, 300)}` : '';
      throw new MeshyFailed(`Meshy ${t.status === 'FAILED' ? 'could not finish this task' : 'cancelled this task'}${why}`);
    }
    if (Date.now() - start > timeoutMs) return null;
    await sleep(intervalMs, signal);
  }
}
class MeshyFailed extends Error {}

async function runSpec(
  d: MeshyDeps, spec: MeshySpec, input: { prompt: string; imageUrl?: string; aspect?: string; removeBackground?: boolean }, signal: AbortSignal | undefined,
  res: RunResult,
): Promise<RunResult> {
  const steps = meshySteps(spec);
  const draft = spec.quality === 'draft';
  // The caller has already reserved the whole estimate. What has not been started when we stop is given back at the end.
  let unstarted = d.client.mock ? 0 : steps.reduce((n, s) => n + s.credits, 0);
  try {
    return await runSteps(d, spec, input, signal, res, steps, draft, (n) => { unstarted -= n; });
  } finally {
    if (unstarted > 0) d.addCredits(-unstarted);
  }
}

async function runSteps(
  d: MeshyDeps, spec: MeshySpec, input: { prompt: string; imageUrl?: string; aspect?: string; removeBackground?: boolean }, signal: AbortSignal | undefined,
  res: RunResult, steps: ReturnType<typeof meshySteps>, draft: boolean, started: (credits: number) => void,
): Promise<RunResult> {

  /** One paid step: count the estimate at once, then settle to the real figure Meshy reports (a failed task is refunded). */
  const paid = async (endpoint: string, body: unknown, estimate: number): Promise<(MeshyTask & { createdId: string }) | null> => {
    let id: string;
    started(d.client.mock ? 0 : estimate);
    try {
      id = await d.client.create(endpoint, body, signal);
    } catch (e) {
      // A clear refusal means nothing started, so give the credits back. A timeout, a dropped connection or Stop could mean Meshy
      // did start (and charge) it, so the reservation stays.
      if (e instanceof MeshyApiError && e.definitive && !d.client.mock) d.addCredits(-estimate);
      throw e;
    }
    res.taskIds.push(id);
    let task: MeshyTask | null;
    try { task = await waitFor(d, endpoint, id, signal); } catch (e) {
      if (e instanceof MeshyFailed && !d.client.mock) d.addCredits(-estimate); // Meshy refunds failed tasks
      throw e;
    }
    if (!task) return null;
    // Trust Meshy's figure, but a finished task reporting 0 would blind the cap, so keep the estimate then.
    const actual = typeof task.consumed_credits === 'number' && task.consumed_credits > 0 ? task.consumed_credits : estimate;
    if (!d.client.mock) d.addCredits(actual - estimate);
    res.consumed += d.client.mock ? 0 : actual;
    return { ...task, createdId: id };
  };

  if (spec.kind === 'text_to_3d') {
    const preview = await paid(EP.text_to_3d, { mode: 'preview', prompt: input.prompt, ai_model: draft ? 'meshy-6-lite' : 'latest', target_formats: ['glb'] }, steps[0]!.credits);
    if (!preview) return { ...res, note: 'The shape is still being made.' };
    let last = preview;
    if (spec.texture) {
      const refine = await paid(EP.text_to_3d, { mode: 'refine', preview_task_id: preview.createdId, target_formats: ['glb'] }, steps[1]!.credits);
      if (!refine) return { ...res, note: 'The shape is done but texturing is still running.' };
      last = refine;
    }
    return { ...res, done: true, files: filesOf3d(last) };
  }
  if (spec.kind === 'image_to_3d') {
    const t = await paid(EP.image_to_3d, {
      image_url: input.imageUrl, ai_model: draft ? 'meshy-6-lite' : 'latest', should_texture: spec.texture, target_formats: ['glb'],
    }, steps[0]!.credits);
    if (!t) return { ...res, note: 'The model is still being made.' };
    return { ...res, done: true, files: filesOf3d(t) };
  }
  const t = await paid(EP.text_to_image, {
    ai_model: draft ? 'nano-banana-2-lite' : 'nano-banana-2', prompt: input.prompt,
    ...(input.aspect ? { aspect_ratio: input.aspect } : {}), ...(input.removeBackground ? { remove_background: true } : {}),
  }, steps[0]!.credits);
  if (!t) return { ...res, note: 'The image is still being made.' };
  return { ...res, done: true, files: (t.image_urls ?? []).slice(0, 4).map((u) => ({ url: u, kind: 'image' as const, ext: extOf(u, 'png') })) };
}

function filesOf3d(t: MeshyTask): Wanted[] {
  const out: Wanted[] = [];
  const glb = t.model_urls?.glb;
  if (glb) out.push({ url: glb, kind: 'model', ext: 'glb' });
  if (t.thumbnail_url) out.push({ url: t.thumbnail_url, kind: 'preview', ext: extOf(t.thumbnail_url, 'png') });
  return out;
}

/** Downloads each file and saves it in the project. Returns the project-relative paths. */
async function saveFiles(root: string, d: MeshyDeps, files: Wanted[], stem: string, taskId: string, signal: AbortSignal | undefined): Promise<string[]> {
  const saved: string[] = [];
  const skipped: string[] = [];
  const suffix = taskId.slice(-8);
  let n = 0;
  for (const f of files) {
    const label = f.kind === 'model' ? 'model' : f.kind === 'preview' ? 'preview' : `image${files.length > 1 ? ++n : ''}`;
    try {
      const data = await d.client.download(f.url, f.kind === 'model' ? MODEL_MAX : IMAGE_MAX, signal);
      if (f.kind === 'model' && data.subarray(0, 4).toString() !== 'glTF') throw new Error('Meshy sent a file that is not a valid GLB model, so it was not saved.');
      if (f.kind !== 'model' && !imageMatchesExt(f.ext, data)) throw new Error('Meshy sent a file that is not a real image, so it was not saved.');
      saved.push(saveProjectFile(root, FOLDER, stem, `${suffix}-${label}`, f.ext, data));
    } catch (e) {
      if (signal?.aborted) throw e;
      // The preview picture is a nicety: if only it fails, the model that was already saved still counts.
      if (f.kind === 'preview' && saved.length) { skipped.push(`${label} (${(e as Error).message})`); continue; }
      throw e;
    }
  }
  if (skipped.length) saved.push(`[not saved: ${skipped.join('; ')}]`);
  return saved;
}

// ---------- tools ----------
const KIND_LABEL: Record<MeshyKind, string> = { text_to_3d: 'text to 3D', image_to_3d: 'image to 3D', text_to_image: 'text to image' };

export const MESHY_TOOLS: ToolDef[] = [
  {
    name: 'meshy_generate',
    description:
      'Create art with Meshy (an outside service that costs credits). It needs Widow\'s audit and the user\'s approval, which shows the exact prompt and the estimated credits. ' +
      'Use it for objects, props, scenery and 2D art. Do NOT use it for a character unless the user asked for Meshy; for a character write a brief instead (see your rules). ' +
      'kind "text_to_3d" makes a 3D model from a prompt; "image_to_3d" makes one from an image in the project (image_path); "text_to_image" makes a picture. ' +
      'quality "draft" is cheap and good for trying an idea; "standard" costs about 4 times as much. texture adds colour and materials (it defaults to on for standard, off for draft). ' +
      'Results are saved in the project under assets/meshy/. This call can take a few minutes.',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: MESHY_KINDS, description: 'What to make' },
        prompt: { type: 'string', description: `What to make, in plain words (up to ${MESHY_PROMPT_MAX} characters). Needed for text_to_3d and text_to_image.` },
        image_path: { type: 'string', description: 'For image_to_3d: a PNG, JPG or WebP inside the project folder' },
        quality: { type: 'string', enum: ['draft', 'standard'], description: 'draft (default) or standard' },
        texture: { type: 'boolean', description: 'Add textures (3D only)' },
        name: { type: 'string', description: 'A short file name for the result, letters and numbers' },
        aspect_ratio: { type: 'string', enum: ['1:1', '16:9', '9:16', '4:3', '3:4'], description: 'text_to_image only' },
        remove_background: { type: 'boolean', description: 'text_to_image only: transparent background' },
      },
      required: ['kind'], additionalProperties: false,
    },
  },
  {
    name: 'meshy_fetch',
    description: 'Download a Meshy task that has already finished (for example one that was still running when you last checked) into the project. Free, no approval needed.',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: MESHY_KINDS, description: 'The kind of task it was' },
        task_id: { type: 'string', description: 'The task id from an earlier result' },
        name: { type: 'string', description: 'A short file name for the result' },
      },
      required: ['kind', 'task_id'], additionalProperties: false,
    },
  },
  {
    name: 'meshy_balance',
    description: 'Show the Meshy credits left on the account and how many credits have been used today against the daily cap. Free, no approval needed.',
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
];
export const MESHY_TOOL_NAMES = new Set(MESHY_TOOLS.map((t) => t.name));

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const kindOf = (v: unknown): MeshyKind => {
  if (typeof v !== 'string' || !(MESHY_KINDS as string[]).includes(v)) throw new Error(`"kind" must be one of: ${MESHY_KINDS.join(', ')}`);
  return v as MeshyKind;
};
const stemOf = (name: unknown, fallback: string) => {
  const s = typeof name === 'string' ? name.trim() : '';
  return (s || fallback).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'asset';
};

export function prepareMeshyTool(root: string, name: string, input: unknown, d: MeshyDeps): Prepared {
  try {
    if (name === 'meshy_balance') return prepareBalance(d);
    if (name === 'meshy_fetch') return prepareFetch(root, input, d);
    if (name === 'meshy_generate') return prepareGenerate(root, input, d);
    return { error: `Unknown tool "${name}".` };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

function prepareBalance(d: MeshyDeps): Prepared {
  return {
    needsApproval: false, label: 'checked the Meshy balance',
    run: async (signal) => {
      const b = await d.client.balance(signal);
      const used = d.creditsToday();
      return { text: `Meshy credits left: ${b.balance}${b.monthly !== undefined ? ` (monthly ${b.monthly}, permanent ${b.permanent ?? 0})` : ''}. Used today by the council: ${used} of the daily cap of ${d.dailyCap()}.` };
    },
  };
}

function prepareFetch(root: string, input: unknown, d: MeshyDeps): Prepared {
  const i = obj(input);
  const kind = kindOf(i.kind);
  const id = typeof i.task_id === 'string' ? i.task_id.trim() : '';
  if (!/^[A-Za-z0-9_-]{4,80}$/.test(id)) throw new Error('"task_id" is not a valid Meshy task id');
  const stem = stemOf(i.name, kind);
  return {
    needsApproval: false, label: `fetched Meshy task ${id.slice(-8)}`,
    run: async (signal) => {
      const t = await d.client.get(EP[kind], id, signal);
      if (t.status !== 'SUCCEEDED') return { text: `That task is ${t.status}${typeof t.progress === 'number' ? ` (${t.progress}%)` : ''}. Try again later.`, isError: t.status === 'FAILED' || t.status === 'CANCELED' };
      const files = kind === 'text_to_image'
        ? (t.image_urls ?? []).slice(0, 4).map((u) => ({ url: u, kind: 'image' as const, ext: extOf(u, 'png') }))
        : filesOf3d(t);
      if (!files.length) return { text: 'That task finished but has no files to download (they may have expired).', isError: true };
      const saved = await saveFiles(root, d, files, stem, id, signal);
      return { text: `Saved: ${saved.join(', ')}`, detail: saved.join('\n') };
    },
  };
}

function prepareGenerate(root: string, input: unknown, d: MeshyDeps): Prepared {
  const i = obj(input);
  const kind = kindOf(i.kind);
  const quality: MeshyQuality = i.quality === 'standard' ? 'standard' : 'draft';
  if (i.quality !== undefined && i.quality !== 'draft' && i.quality !== 'standard') throw new Error('"quality" must be "draft" or "standard"');
  const is3d = kind !== 'text_to_image';
  const texture = is3d ? (typeof i.texture === 'boolean' ? i.texture : quality === 'standard') : false;
  const spec: MeshySpec = { kind, quality, texture };

  const prompt = typeof i.prompt === 'string' ? i.prompt.trim() : '';
  if (kind !== 'image_to_3d') {
    if (!prompt) throw new Error('"prompt" is required for this kind');
    if (prompt.length > MESHY_PROMPT_MAX) throw new Error(`"prompt" is too long (max ${MESHY_PROMPT_MAX} characters)`);
  } else if (prompt.length > MESHY_PROMPT_MAX) throw new Error(`"prompt" is too long (max ${MESHY_PROMPT_MAX} characters)`);

  let image: { rel: string; mime: string; data: Buffer } | undefined;
  let imageHash = '';
  if (kind === 'image_to_3d') {
    if (typeof i.image_path !== 'string' || !i.image_path.trim()) throw new Error('"image_path" is required for image_to_3d');
    image = readProjectImage(root, i.image_path, INPUT_IMAGE_MAX);
    imageHash = createHash('sha256').update(image.data).digest('hex');
  }
  const aspect = typeof i.aspect_ratio === 'string' && ['1:1', '16:9', '9:16', '4:3', '3:4'].includes(i.aspect_ratio) ? i.aspect_ratio : undefined;
  if (i.aspect_ratio !== undefined && !aspect) throw new Error('"aspect_ratio" must be 1:1, 16:9, 9:16, 4:3 or 3:4');
  const removeBackground = i.remove_background === true;
  const stem = stemOf(i.name, image ? image.rel.split('/').pop()!.replace(/\.[^.]+$/, '') : prompt.split(/\s+/).slice(0, 3).join('-') || kind);

  const steps = meshySteps(spec);
  const estimate = meshyEstimate(spec);
  const used = d.creditsToday();
  const left = Math.max(0, d.dailyCap() - used);
  if (!d.client.mock && estimate > left) {
    throw new Error(`This would use about ${estimate} Meshy credits but only ${left} are left under today's cap of ${d.dailyCap()} (${used} used). Ask the user to raise the cap in Settings, Budgets, or use a cheaper quality.`);
  }

  const preview = [
    'Generator: Meshy (an outside service; it costs credits)',
    `Kind: ${KIND_LABEL[kind]}    Quality: ${quality}${is3d ? `    Textured: ${texture ? 'yes' : 'no'}` : ''}`,
    ...(prompt ? [`Prompt: ${visible(prompt)}`] : []),
    ...(image ? [`Input image: ${image.rel} (${Math.ceil(image.data.length / 1024)} KB). This file is sent to Meshy.`] : []),
    ...(kind === 'text_to_image' ? [`Aspect ratio: ${aspect ?? '1:1'}${removeBackground ? '    Transparent background' : ''}`] : []),
    '',
    ...steps.map((s) => `  ${s.label}: about ${s.credits} credits`),
    `Estimated total: about ${estimate} credits (Meshy reports the real figure afterwards)`,
    `Credits left today under the cap: ${left} of ${d.dailyCap()}${d.client.mock ? '    [Mock mode: nothing is billed]' : ''}`,
    `Saved in the project under: ${FOLDER}/`,
    'Pressing Stop ends the wait, but Meshy may still finish and charge a task that has already started.',
  ].join('\n');

  return {
    needsApproval: true, label: `generated art with Meshy (${KIND_LABEL[kind]})`,
    action: { tool: 'meshy_generate', summary: `Make art with Meshy: ${KIND_LABEL[kind]}, ${quality}, about ${estimate} credits`, preview },
    run: async (signal) => {
      // Everything is re-checked at the moment it runs: the cap and the input image may have changed while the user was deciding.
      if (d.stillAvailable && !d.stillAvailable()) return { text: 'Not started: Meshy is no longer set up (the mode or the key changed while this waited). Nothing was sent or charged.', isError: true };
      const leftNow = Math.max(0, d.dailyCap() - d.creditsToday());
      if (!d.client.mock && estimate > leftNow) return { text: `Not started: only ${leftNow} credits are left under today's cap.`, isError: true };
      // Reserve the WHOLE estimate now, in the same breath as the check (nothing awaited in between), so several agents running at
      // once cannot each pass the check against the same remaining credits. What never starts is released as the run ends.
      if (!d.client.mock) d.addCredits(estimate);
      let imageUrl: string | undefined;
      if (image) {
        const again = readProjectImage(root, image.rel, INPUT_IMAGE_MAX);
        if (createHash('sha256').update(again.data).digest('hex') !== imageHash) throw new Error(`${image.rel} changed after this request was made. Ask again.`);
        imageUrl = `data:${again.mime};base64,${again.data.toString('base64')}`;
      }
      const progress: RunResult = { done: false, taskIds: [], files: [], consumed: 0 };
      let r: RunResult;
      try {
        r = await runSpec(d, spec, { prompt, imageUrl, aspect, removeBackground }, signal, progress);
      } catch (e) {
        // Keep the ids so a paid, finished task can be downloaded with meshy_fetch instead of generating (and paying) again.
        if (progress.taskIds.length && !signal?.aborted) {
          throw new Error(`${(e as Error).message} Task id(s) already started: ${progress.taskIds.join(', ')}. Credits may have been charged. Use meshy_fetch with ${kind} and the last task id to download a finished task; do not generate again.`);
        }
        throw e;
      }
      const used = r.consumed ? ` Credits used: ${r.consumed}.` : '';
      if (!r.done) {
        return { text: `${r.note ?? 'Still running.'} It is taking longer than expected. Task id(s): ${r.taskIds.join(', ')}. Use meshy_fetch with ${kind} and the last task id later to download it.${used}` };
      }
      let saved: string[];
      try {
        saved = await saveFiles(root, d, r.files, stem, r.taskIds[r.taskIds.length - 1] ?? 'task', signal);
      } catch (e) {
        throw new Error(`${(e as Error).message} The task finished and was paid for. Task id(s): ${r.taskIds.join(', ')}. Use meshy_fetch to try the download again; do not generate again.`);
      }
      const out: ToolOutput = { text: `Done. Saved: ${saved.join(', ')}.${used}`, detail: `${saved.join('\n')}\nTask ids: ${r.taskIds.join(', ')}` };
      return out;
    },
  };
}
