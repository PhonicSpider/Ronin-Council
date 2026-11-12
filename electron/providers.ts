import Anthropic from '@anthropic-ai/sdk';
import type { VendorId } from '../shared/vendors';

export interface CompleteRequest {
  model: string;
  /** Whose API serves this model. Absent = Anthropic. */
  vendor?: VendorId;
  system: string;
  prompt: string;
  maxTokens: number;
  effort?: 'low' | 'medium' | 'high';
  /** Images shown to the model alongside the prompt (base64, no data: prefix). */
  images?: ImageInput[];
  /** The first this-many characters of `system` are identical for many calls; the API is asked to cache them. */
  cachePrefix?: number;
}
export interface ImageInput { mime: string; data: string }
/** The API content blocks for a prompt with optional images (images first, as the API recommends). */
export function promptContent(prompt: string, images?: ImageInput[]): string | ContentBlock[] {
  if (!images?.length) return prompt;
  return [
    ...images.map((i): ContentBlock => ({ type: 'image', source: { type: 'base64', media_type: i.mime, data: i.data } })),
    { type: 'text', text: prompt },
  ];
}
/** Input tokens served from or written to the prompt cache (all already included in `inTokens`). */
export interface CacheUsage { read: number; write5m: number; write1h: number }
export interface CompleteResult { text: string; inTokens: number; outTokens: number; cache?: CacheUsage }

// ----- tool-use step (agents that can read/change files and run commands) -----
export interface ToolSchema { name: string; description: string; input_schema: unknown }
/** A raw API content block (text, tool_use, tool_result, thinking...). Passed back to the API unchanged. */
export interface ContentBlock { type: string; [key: string]: unknown }
export interface Turn { role: 'user' | 'assistant'; content: string | ContentBlock[] }
export interface StepRequest {
  model: string;
  vendor?: VendorId;
  system: string;
  messages: Turn[];
  tools: ToolSchema[];
  maxTokens: number;
  effort?: 'low' | 'medium' | 'high';
  cachePrefix?: number;
}
export interface StepResult { content: ContentBlock[]; stopReason: string; inTokens: number; outTokens: number; cache?: CacheUsage }

export interface Provider {
  complete(req: CompleteRequest, signal?: AbortSignal): Promise<CompleteResult>;
  /** One model call in a tool loop. Providers without it can only chat. */
  step?(req: StepRequest, signal?: AbortSignal): Promise<StepResult>;
}

/** An error from a call that still used tokens (refusal, empty output); lets the caller bill it. */
export class UsageError extends Error {
  constructor(message: string, public inTokens: number, public outTokens: number) {
    super(message);
    this.name = 'UsageError';
  }
}

/** Markers the orchestrator puts in prompts so the mock provider (and tests) can tell call types apart. */
export const MARK = {
  route: '[[ROUTE]]',
  review: '[[REVIEW]]',
  decision: '[[DECISION]]',
  audit: '[[AUDIT]]',
  scribe: '[[SCRIBE]]',
  report: '[[REPORT]]',
} as const;

export type MockScript = (req: CompleteRequest) => string | undefined;
export type MockStepScript = (req: StepRequest, callNumber: number) => StepResult | undefined;

const estimate = (chars: number) => Math.ceil(chars / 4);

/** Deterministic stand-in used when there is no API key (and in tests). Costs nothing. */
export class MockProvider implements Provider {
  calls: CompleteRequest[] = [];
  stepCalls: StepRequest[] = [];
  constructor(private script?: MockScript, private stepScript?: MockStepScript) {}

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    this.calls.push(req);
    const text = this.script?.(req) ?? this.fallback(req);
    return { text, inTokens: estimate(req.system.length + req.prompt.length), outTokens: estimate(text.length) };
  }

  async step(req: StepRequest): Promise<StepResult> {
    this.stepCalls.push(req);
    const scripted = this.stepScript?.(req, this.stepCalls.length);
    if (scripted) return scripted;
    return this.defaultStep(req);
  }

  /**
   * Default tool behaviour, so the whole approval flow can be tried without an API key:
   * a user message containing "!tool read <path>", "!tool list [path]", "!tool write <path> <text>"
   * or "!tool run <command>" makes the mock agent call that tool once.
   */
  private defaultStep(req: StepRequest): StepResult {
    const first = req.messages[0];
    const prompt = typeof first?.content === 'string'
      ? first.content
      : (first?.content ?? []).filter((b) => b.type === 'text').map((b) => String(b.text ?? '')).join('');
    const results = req.messages.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((b) => b.type === 'tool_result') : []));
    const inTokens = estimate(req.system.length + prompt.length);
    if (results.length > 0) {
      const last = String(results[results.length - 1].content ?? '').replace(/\s+/g, ' ').slice(0, 80);
      const text = `[mock] Done. Tool result: ${last}`;
      return { content: [{ type: 'text', text }], stopReason: 'end_turn', inTokens, outTokens: estimate(text.length) };
    }
    const said = /Latest user message: ([^\n]*)/.exec(prompt)?.[1] ?? '';
    const m = /!tool (read|list|write|run)\b\s*(.*)$/.exec(said);
    if (m && req.tools.length) {
      const [, verb, rest] = m;
      let name = '';
      let input: Record<string, unknown> = {};
      if (verb === 'read') { name = 'read_file'; input = { path: rest.trim() }; }
      else if (verb === 'list') { name = 'list_files'; input = { path: rest.trim() || '.' }; }
      else if (verb === 'write') {
        const [file, ...body] = rest.trim().split(/\s+/);
        name = 'write_file'; input = { path: file, content: body.join(' ') };
      } else { name = 'run_command'; input = { command: rest.trim() }; }
      return {
        content: [{ type: 'text', text: `[mock] Using ${name}.` }, { type: 'tool_use', id: `toolu_mock_${this.stepCalls.length}`, name, input }],
        stopReason: 'tool_use', inTokens, outTokens: 30,
      };
    }
    const imgs = Array.isArray(first?.content) ? first.content.filter((b) => b.type === 'image').length : 0;
    const text = this.fallback({ model: req.model, system: req.system, prompt, maxTokens: req.maxTokens })
      + (imgs ? ` (${imgs} image${imgs > 1 ? 's' : ''} received.)` : '');
    return { content: [{ type: 'text', text }], stopReason: 'end_turn', inTokens, outTokens: estimate(text.length) };
  }

  private fallback(req: CompleteRequest): string {
    const p = req.prompt;
    if (p.includes(MARK.route)) {
      const line = /Candidates:\s*(.+)/.exec(p)?.[1] ?? '';
      const first = line.split(',')[0]?.replace(/\s*\(.*$/, '').trim();
      return JSON.stringify(first ? [first] : []);
    }
    if (p.includes(MARK.scribe)) {
      return JSON.stringify({ highlights: ['[mock] Key point from the conversation.'], note: '[mock] Summary of the recent conversation.' });
    }
    if (p.includes(MARK.report)) return '[mock] The team discussed the task and has nothing blocking; details are in the channel.';
    if (p.includes(MARK.review)) return 'VERDICT: approve\n[mock] Reviewed; no blocking issues found.';
    if (p.includes(MARK.decision)) return 'DECISION: accept\n[mock] Accepting as-is.';
    if (p.includes(MARK.audit)) return 'DECISION: pass\n[mock] Within scope; passing to the user for approval.';
    const name = /Reply as ([A-Za-z0-9_-]+)\b/.exec(p)?.[1] ?? 'Agent';
    const role = /You are [A-Za-z0-9_-]+, ([^\n]+?) on a small team/.exec(req.system)?.[1] ?? 'agent';
    const said = (/Latest user message: ([^\n]*)/.exec(p)?.[1] ?? '').slice(0, 60);
    const body = `[mock] ${name} (${role}) on "${said}": this is a simulated reply. Add an API key in Settings to talk to real agents.`;
    const imgs = req.images?.length ?? 0;
    const seen = imgs ? ` (${imgs} image${imgs > 1 ? 's' : ''} received.)` : '';
    return /\b(plan|design|spec|proposal)\b/i.test(said) ? `DELIVERABLE: ${body}${seen}` : body + seen;
  }
}

/** Models that accept the server-side refusal-fallback beta (per the API docs). */
const FALLBACK_MODEL_RE = /^claude-(opus-5-5|sonnet-5-5|fable-5)/;

export class ClaudeProvider implements Provider {
  private client: Anthropic;
  /** `baseURL` is optional (proxies, and tests that point the SDK at a local fake server). */
  constructor(apiKey: string, baseURL?: string) {
    this.client = new Anthropic({ apiKey, maxRetries: 2, ...(baseURL ? { baseURL } : {}) });
  }

  /** One Messages API call, opting into server-side refusal fallbacks where the model supports them. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async send(params: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
    const plain = () => (this.client.messages.create as any).call(this.client.messages, params, { signal }); // eslint-disable-line @typescript-eslint/no-explicit-any
    const wantFallback = FALLBACK_MODEL_RE.test(String(params.model));
    try {
      return wantFallback
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ? await (this.client.beta.messages.create as any).call(
            this.client.beta.messages,
            { ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' },
            { signal },
          )
        : await plain();
    } catch (e) {
      if (wantFallback && e instanceof Anthropic.BadRequestError && /fallback|beta/i.test(e.message)) {
        // The fallback beta was rejected for this key/model: retry once without it.
        try { return await plain(); } catch (e2) { throw friendly(e2); }
      }
      throw friendly(e);
    }
  }

  async complete(req: CompleteRequest, signal?: AbortSignal): Promise<CompleteResult> {
    // Thinking is left at the model default (adaptive). Sampling params are not sent (rejected on current models).
    const res = await this.send({
      model: req.model,
      max_tokens: req.maxTokens,
      system: systemParam(req.system, req.cachePrefix),
      messages: [{ role: 'user', content: promptContent(req.prompt, req.images) }],
      output_config: { effort: req.effort ?? 'medium' },
    }, signal);
    const { inTokens, outTokens, cache } = usageOf(res);
    // Failures below still consumed tokens, so they carry usage for the budget meter.
    if (res.stop_reason === 'refusal') {
      throw new UsageError('The request was declined by Anthropic safety classifiers.', inTokens, outTokens);
    }
    let text = textOf(res.content);
    if (!text) {
      throw new UsageError(`Empty response (stop_reason: ${res.stop_reason}). Try again or raise the model/effort.`, inTokens, outTokens);
    }
    if (res.stop_reason === 'max_tokens') text += '\n\n[This reply was cut off at the length limit.]';
    return { text, inTokens, outTokens, cache };
  }

  async step(req: StepRequest, signal?: AbortSignal): Promise<StepResult> {
    const res = await this.send({
      model: req.model,
      max_tokens: req.maxTokens,
      system: systemParam(req.system, req.cachePrefix),
      messages: withTailCache(req.messages),
      ...(req.tools.length ? { tools: req.tools } : {}),
      output_config: { effort: req.effort ?? 'medium' },
    }, signal);
    const { inTokens, outTokens, cache } = usageOf(res);
    if (res.stop_reason === 'refusal') {
      throw new UsageError('The request was declined by Anthropic safety classifiers.', inTokens, outTokens);
    }
    // The content (including any thinking blocks) goes back to the API unchanged on the next step.
    return { content: res.content as ContentBlock[], stopReason: String(res.stop_reason), inTokens, outTokens, cache };
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function usageOf(res: any) {
  const u = res.usage ?? {};
  const read = (u.cache_read_input_tokens ?? 0) as number;
  const created = (u.cache_creation_input_tokens ?? 0) as number;
  const write1h = Math.min(created, (u.cache_creation?.ephemeral_1h_input_tokens ?? 0) as number);
  return {
    inTokens: (u.input_tokens ?? 0) + created + read,
    outTokens: (u.output_tokens ?? 0) as number,
    cache: { read, write5m: created - write1h, write1h } as CacheUsage,
  };
}

/**
 * The system prompt, with its shared leading part marked for caching (1 hour: chats have gaps longer than 5 minutes,
 * and one entry serves every agent in a project). Prompts under the model's minimum size simply do not cache.
 */
export function systemParam(system: string, cachePrefix?: number): string | { type: 'text'; text: string; cache_control?: unknown }[] {
  if (!cachePrefix || cachePrefix <= 0 || cachePrefix >= system.length) return system;
  return [
    { type: 'text', text: system.slice(0, cachePrefix), cache_control: { type: 'ephemeral', ttl: '1h' } },
    { type: 'text', text: system.slice(cachePrefix) },
  ];
}

/** In a tool loop the conversation only grows, so a marker on its last block lets the next step read everything before it. */
export function withTailCache(messages: Turn[]): Turn[] {
  if (messages.length < 2) return messages; // a single-step answer would pay the cache write for nothing
  const last = messages[messages.length - 1]!;
  const mark = { type: 'ephemeral' };
  let content: ContentBlock[];
  if (typeof last.content === 'string') content = [{ type: 'text', text: last.content, cache_control: mark }];
  else if (last.content.length) content = [...last.content.slice(0, -1), { ...last.content[last.content.length - 1]!, cache_control: mark }];
  else return messages;
  return [...messages.slice(0, -1), { ...last, content }];
}

/** Cache price multipliers on the base input price (reads are cheaper on the newer models; writes are 1.25x for 5 minutes, 2x for 1 hour). */
export function cachePrices(model: string, vendor: VendorId = 'anthropic') {
  // Other vendors cache differently (and often automatically); a flat 50% read rate with no write premium never under-counts much.
  if (vendor !== 'anthropic') return { read: 0.5, write5m: 1, write1h: 1 };
  const read = /fable|mythos/.test(model) ? 0.025 : /opus-5-5|sonnet-5-5/.test(model) ? 0.05 : 0.1;
  return { read, write5m: 1.25, write1h: 2 };
}

const textOf = (content: { type: string; text?: string }[]) =>
  content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('').trim();

function friendly(e: unknown): Error {
  if (e instanceof Anthropic.AuthenticationError) return new Error('Invalid or missing API key (Settings → API & Models).');
  if (e instanceof Anthropic.PermissionDeniedError) return new Error('This API key is not allowed to use that model.');
  if (e instanceof Anthropic.NotFoundError) return new Error('Model not found — check the model names in Settings → API & Models.');
  if (e instanceof Anthropic.RateLimitError) return new Error('Rate limited by the API — wait a moment and retry.');
  if (e instanceof Anthropic.APIConnectionError) return new Error('Could not reach the Anthropic API (network).');
  if (e instanceof Anthropic.APIError) return new Error(`API error ${e.status}: ${e.message}`);
  return e instanceof Error ? e : new Error(String(e));
}
