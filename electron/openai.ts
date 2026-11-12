import { vendorInfo, VendorId } from '../shared/vendors';
import {
  CacheUsage, CompleteRequest, CompleteResult, ContentBlock, Provider, promptContent, StepRequest, StepResult, Turn, UsageError,
} from './providers';

/**
 * Talks to any server that speaks the OpenAI chat-completions API: OpenAI, Google's compatibility endpoint, xAI, DeepSeek,
 * and local servers (Ollama, LM Studio, llama.cpp, vLLM). The app's internal messages are Anthropic-style blocks
 * (text, tool_use, tool_result); this class translates them both ways so the rest of the app does not care.
 */

interface OaiToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
type OaiPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
export type OaiMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | OaiPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: OaiToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v));

/** Internal turns to chat-completions messages. A tool_result becomes its own `tool` message, placed right after the assistant call. */
export function toOaiMessages(system: string, turns: Turn[]): OaiMessage[] {
  const out: OaiMessage[] = [{ role: 'system', content: system }];
  for (const t of turns) {
    if (typeof t.content === 'string') { out.push({ role: t.role, content: t.content } as OaiMessage); continue; }
    if (t.role === 'assistant') {
      const text = t.content.filter((b) => b.type === 'text').map((b) => str(b.text)).join('');
      const calls: OaiToolCall[] = t.content.filter((b) => b.type === 'tool_use').map((b) => ({
        id: str(b.id), type: 'function', function: { name: str(b.name), arguments: JSON.stringify(b.input ?? {}) },
      }));
      out.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    for (const b of t.content) {
      if (b.type === 'tool_result') {
        out.push({ role: 'tool', tool_call_id: str(b.tool_use_id), content: `${b.is_error ? 'Error: ' : ''}${str(b.content)}` });
      }
    }
    const parts: OaiPart[] = [];
    for (const b of t.content) {
      if (b.type === 'text') parts.push({ type: 'text', text: str(b.text) });
      else if (b.type === 'image') {
        const s = b.source as { media_type?: string; data?: string } | undefined;
        if (s?.data) parts.push({ type: 'image_url', image_url: { url: `data:${s.media_type ?? 'image/png'};base64,${s.data}` } });
      }
    }
    if (parts.length) out.push({ role: 'user', content: parts });
  }
  return out;
}

const STOP: Record<string, string> = { stop: 'end_turn', tool_calls: 'tool_use', function_call: 'tool_use', length: 'max_tokens' };

export interface OpenAIOptions {
  vendor: VendorId;
  baseUrl: string;
  apiKey?: string;
  /** Test hook. */
  fetchImpl?: typeof fetch;
  retryDelayMs?: number;
}

export class OpenAIProvider implements Provider {
  private label: string;
  constructor(private o: OpenAIOptions) {
    this.label = vendorInfo(o.vendor).label;
  }

  private async post(path: string, body: unknown, signal?: AbortSignal, method: 'POST' | 'GET' = 'POST'): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const f = this.o.fetchImpl ?? fetch;
    const timeout = AbortSignal.timeout(300_000);
    const sig = signal && 'any' in AbortSignal ? (AbortSignal as unknown as { any(s: AbortSignal[]): AbortSignal }).any([signal, timeout]) : signal ?? timeout;
    let last: Error = new Error('request failed');
    for (let attempt = 0; attempt < 3; attempt++) {
      if (signal?.aborted) throw new Error('Stopped');
      let res: Response;
      try {
        res = await f(`${this.o.baseUrl}${path}`, {
          method,
          headers: { 'content-type': 'application/json', ...(this.o.apiKey ? { authorization: `Bearer ${this.o.apiKey}` } : {}) },
          ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
          signal: sig,
        });
      } catch (e) {
        if (signal?.aborted) throw new Error('Stopped');
        last = new Error(vendorInfo(this.o.vendor).editableUrl
          ? `Could not reach ${this.o.baseUrl}. Is the server running, and is the address right (Settings → API & Models)?`
          : `Could not reach ${this.label} (network).`);
        if (attempt < 2) { await new Promise((r) => setTimeout(r, (this.o.retryDelayMs ?? 800) * (attempt + 1))); continue; }
        throw last;
      }
      const text = await res.text();
      if (res.ok) {
        try { return JSON.parse(text); } catch { throw new Error(`${this.label} sent a reply that was not JSON.`); }
      }
      last = this.httpError(res.status, text);
      if ((res.status === 429 || res.status >= 500) && attempt < 2) {
        await new Promise((r) => setTimeout(r, (this.o.retryDelayMs ?? 800) * (attempt + 1)));
        continue;
      }
      throw last;
    }
    throw last;
  }

  private httpError(status: number, text: string): Error {
    let msg = text;
    try { const j = JSON.parse(text); msg = str(j?.error?.message ?? j?.message ?? j?.error ?? text); } catch { /* plain text */ }
    if (this.o.apiKey) msg = msg.split(this.o.apiKey).join('[key]'); // an error body must never echo the key into the UI
    msg = msg.replace(/\s+/g, ' ').trim().slice(0, 300);
    if (status === 401 || status === 403) return new Error(`Invalid or missing API key for ${this.label} (Settings → API & Models).`);
    if (status === 404) return new Error(`${this.label} does not know that model or address: ${msg || 'not found'}. Check the model name${vendorInfo(this.o.vendor).id === 'local' ? ' (has it been pulled or loaded?)' : ''}.`);
    if (status === 429) return new Error(`Rate limited by ${this.label}. Wait a moment and retry.`);
    return new Error(`${this.label} error ${status}: ${msg}`);
  }

  /** The models the server offers (used by the "Detect models" button). */
  async listModels(signal?: AbortSignal): Promise<string[]> {
    const j = await this.post('/models', undefined, signal, 'GET');
    const rows: unknown[] = Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : [];
    return rows.map((r) => str((r as { id?: unknown; name?: unknown })?.id ?? (r as { name?: unknown })?.name)).filter(Boolean).slice(0, 200);
  }

  private body(req: { model: string; maxTokens: number }, messages: OaiMessage[], tools?: StepRequest['tools']) {
    // OpenAI's newer models take max_completion_tokens; the others take max_tokens. Hosted reasoning models (GPT-5, Gemini, Grok,
    // DeepSeek) count hidden thinking against the limit, so a small cap could come back empty: hosted vendors get headroom.
    // Local servers get exactly what was asked.
    const openai = this.o.vendor === 'openai';
    const limit = this.o.vendor === 'local' ? req.maxTokens : req.maxTokens + 8000;
    return {
      model: req.model,
      messages,
      ...(openai ? { max_completion_tokens: limit } : { max_tokens: limit }),
      ...(tools?.length ? { tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })) } : {}),
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private usage(res: any, sentChars: number) {
    const u = res?.usage ?? {};
    // Some gateways omit usage. Billing that as zero would blind the budget, so estimate from the text (about 4 characters a token).
    if (u.prompt_tokens === undefined && u.completion_tokens === undefined) {
      const m = res?.choices?.[0]?.message ?? {};
      const out = str(m.content).length + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0);
      return { inTokens: Math.ceil(sentChars / 4), outTokens: Math.ceil(out / 4), cache: { read: 0, write5m: 0, write1h: 0 } as CacheUsage };
    }
    const inTokens = Number(u.prompt_tokens ?? 0) || 0;
    const cached = Number(u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0) || 0;
    const cache: CacheUsage = { read: Math.min(cached, inTokens), write5m: 0, write1h: 0 };
    return { inTokens, outTokens: Number(u.completion_tokens ?? 0) || 0, cache };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private parse(res: any, sentChars: number) {
    const choice = res?.choices?.[0];
    const { inTokens, outTokens, cache } = this.usage(res, sentChars);
    if (!choice) throw new UsageError(`${this.label} returned no answer.`, inTokens, outTokens);
    const m = choice.message ?? {};
    if (choice.finish_reason === 'content_filter' || (typeof m.refusal === 'string' && m.refusal)) {
      throw new UsageError(`${this.label} declined the request${m.refusal ? `: ${str(m.refusal).slice(0, 200)}` : '.'}`, inTokens, outTokens);
    }
    const text = Array.isArray(m.content)
      ? m.content.map((p: { text?: unknown }) => str(p?.text)).join('')
      : str(m.content);
    const blocks: ContentBlock[] = [];
    if (text.trim()) blocks.push({ type: 'text', text });
    for (const c of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
      let input: unknown = {};
      try { input = JSON.parse(str(c?.function?.arguments) || '{}'); } catch { input = {}; } // missing fields are reported back to the model by the tool itself
      blocks.push({ type: 'tool_use', id: str(c?.id) || `call_${blocks.length}`, name: str(c?.function?.name), input });
    }
    const hasCalls = blocks.some((b) => b.type === 'tool_use');
    const stopReason = hasCalls && choice.finish_reason !== 'length' ? 'tool_use' : (STOP[String(choice.finish_reason)] ?? 'end_turn');
    return { blocks, text: text.trim(), stopReason, inTokens, outTokens, cache };
  }

  async complete(req: CompleteRequest, signal?: AbortSignal): Promise<CompleteResult> {
    const messages = toOaiMessages(req.system, [{ role: 'user', content: promptContent(req.prompt, req.images) }]);
    const body = this.body(req, messages);
    const r = this.parse(await this.post('/chat/completions', body, signal), JSON.stringify(body).length);
    if (!r.text) throw new UsageError(`Empty response from ${this.label} (${r.stopReason}). Try again or pick another model.`, r.inTokens, r.outTokens);
    return { text: r.stopReason === 'max_tokens' ? `${r.text}\n\n[This reply was cut off at the length limit.]` : r.text, inTokens: r.inTokens, outTokens: r.outTokens, cache: r.cache };
  }

  async step(req: StepRequest, signal?: AbortSignal): Promise<StepResult> {
    const messages = toOaiMessages(req.system, req.messages);
    const body = this.body(req, messages, req.tools);
    const r = this.parse(await this.post('/chat/completions', body, signal), JSON.stringify(body).length);
    return { content: r.blocks, stopReason: r.stopReason, inTokens: r.inTokens, outTokens: r.outTokens, cache: r.cache };
  }
}
