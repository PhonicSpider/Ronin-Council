import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as http from 'http';
import { AddressInfo } from 'net';
import { ClaudeProvider, UsageError, systemParam, withTailCache, cachePrices } from '../electron/providers';

interface Seen { url: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }

let server: http.Server;
let base = '';
let seen: Seen[] = [];
// Each test sets how the fake API should answer the next request(s).
let respond: (req: Seen, n: number) => { status: number; body: unknown };

const message = (content: unknown[], extra: Record<string, unknown> = {}) => ({
  id: 'msg_test', type: 'message', role: 'assistant', model: 'x', content,
  stop_reason: 'end_turn', stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 },
  ...extra,
});

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const entry: Seen = { url: req.url ?? '', headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') };
      seen.push(entry);
      const r = respond(entry, seen.length);
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  seen = [];
  respond = () => ({ status: 200, body: message([{ type: 'text', text: 'hi' }]) });
});

const req = (model: string) => ({ model, system: 'sys', prompt: 'hello', maxTokens: 1234, effort: 'low' as const });

describe('ClaudeProvider request shape', () => {
  it('sends attached images as base64 image blocks ahead of the text', async () => {
    const p = new ClaudeProvider('sk-ant-test', base);
    await p.complete({ ...req('claude-haiku-5-5'), images: [{ mime: 'image/png', data: 'QUJD' }] });
    const content = (seen[0]!.body.messages as { content: unknown[] }[])[0]!.content;
    expect(content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
      { type: 'text', text: 'hello' },
    ]);
    // Without images the prompt stays a plain string.
    await p.complete(req('claude-haiku-5-5'));
    expect((seen[1]!.body.messages as { content: unknown }[])[0]!.content).toBe('hello');
  });

  it('sends the key, model, max_tokens and effort; no sampling or thinking params', async () => {
    const p = new ClaudeProvider('sk-ant-test', base);
    const out = await p.complete(req('claude-haiku-5-5'));
    expect(out).toEqual({ text: 'hi', inTokens: 15, outTokens: 5, cache: { read: 3, write5m: 2, write1h: 0 } }); // input + cache creation + cache read
    expect(seen).toHaveLength(1);
    const s = seen[0];
    expect(s.url.split('?')[0]).toBe('/v1/messages');
    expect(s.headers['x-api-key']).toBe('sk-ant-test');
    expect(s.headers['anthropic-version']).toBeTruthy();
    expect(s.body).toMatchObject({
      model: 'claude-haiku-5-5', max_tokens: 1234, system: 'sys',
      messages: [{ role: 'user', content: 'hello' }], output_config: { effort: 'low' },
    });
    for (const banned of ['temperature', 'top_p', 'top_k', 'thinking', 'fallbacks']) expect(s.body).not.toHaveProperty(banned);
    expect(s.headers['anthropic-beta']).toBeUndefined();
  });

  it('opts Sonnet/Opus/Fable models into server-side refusal fallbacks', async () => {
    const p = new ClaudeProvider('k', base);
    for (const model of ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-2']) {
      seen = [];
      await p.complete(req(model));
      expect(seen[0].body.fallbacks, model).toBe('default');
      expect(String(seen[0].headers['anthropic-beta']), model).toContain('server-side-fallback-2026-07-01');
    }
  });

  it('retries once without the fallback beta if the API rejects it', async () => {
    respond = (r) => (r.body.fallbacks
      ? { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'fallbacks not supported' } } }
      : { status: 200, body: message([{ type: 'text', text: 'ok' }]) });
    const out = await new ClaudeProvider('k', base).complete(req('claude-opus-5-5'));
    expect(out.text).toBe('ok');
    expect(seen).toHaveLength(2);
    expect(seen[1].body).not.toHaveProperty('fallbacks');
  });
});

describe('ClaudeProvider responses and errors', () => {
  it('joins text blocks and ignores thinking blocks', async () => {
    respond = () => ({ status: 200, body: message([{ type: 'thinking', thinking: '', signature: 'x' }, { type: 'text', text: 'A' }, { type: 'text', text: 'B' }]) });
    expect((await new ClaudeProvider('k', base).complete(req('claude-haiku-5-5'))).text).toBe('AB');
  });

  it('surfaces a safety refusal as a clear error', async () => {
    respond = () => ({ status: 200, body: message([], { stop_reason: 'refusal' }) });
    await expect(new ClaudeProvider('k', base).complete(req('claude-haiku-5-5'))).rejects.toThrow(/declined/);
  });

  it('reports an empty response instead of posting a blank message', async () => {
    respond = () => ({ status: 200, body: message([{ type: 'thinking', thinking: '', signature: 'x' }], { stop_reason: 'max_tokens' }) });
    await expect(new ClaudeProvider('k', base).complete(req('claude-haiku-5-5'))).rejects.toThrow(/Empty response.*max_tokens/);
  });

  it('turns auth, not-found and bad-request failures into readable messages', async () => {
    const err = (status: number, type: string) => () => ({ status, body: { type: 'error', error: { type, message: 'nope' } } });
    respond = err(401, 'authentication_error');
    await expect(new ClaudeProvider('bad', base).complete(req('claude-haiku-5-5'))).rejects.toThrow(/Invalid or missing API key/);
    respond = err(404, 'not_found_error');
    await expect(new ClaudeProvider('k', base).complete(req('claude-haiku-5-5'))).rejects.toThrow(/Model not found/);
    respond = err(400, 'invalid_request_error');
    await expect(new ClaudeProvider('k', base).complete(req('claude-haiku-5-5'))).rejects.toThrow(/API error 400/);
  });

  it('failed-but-billed replies carry their token usage; truncated replies are marked', async () => {
    respond = () => ({ status: 200, body: message([], { stop_reason: 'refusal' }) });
    const err = await new ClaudeProvider('k', base).complete(req('claude-haiku-5-5')).catch((e) => e);
    expect(err).toBeInstanceOf(UsageError);
    expect(err).toMatchObject({ inTokens: 15, outTokens: 5 });

    respond = () => ({ status: 200, body: message([{ type: 'text', text: 'partial' }], { stop_reason: 'max_tokens' }) });
    const cut = await new ClaudeProvider('k', base).complete(req('claude-haiku-5-5'));
    expect(cut.text).toContain('partial');
    expect(cut.text).toContain('cut off');
  });

  it('does not retry a 400 that is unrelated to the fallback beta', async () => {
    respond = () => ({ status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long' } } });
    await expect(new ClaudeProvider('k', base).complete(req('claude-opus-5-5'))).rejects.toThrow(/API error 400/);
    expect(seen).toHaveLength(1);
  });

  it('step(): sends tools and the conversation, and returns content blocks untouched', async () => {
    const blocks = [
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'text', text: 'Reading it.' },
      { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a.txt' } },
    ];
    respond = () => ({ status: 200, body: message(blocks, { stop_reason: 'tool_use' }) });
    const tools = [{ name: 'read_file', description: 'd', input_schema: { type: 'object' } }];
    const history = [
      { role: 'user' as const, content: 'hello' },
      { role: 'assistant' as const, content: [{ type: 'tool_use', id: 'toolu_0', name: 'read_file', input: {} }] },
      { role: 'user' as const, content: [{ type: 'tool_result', tool_use_id: 'toolu_0', content: 'ok' }] },
    ];
    const out = await new ClaudeProvider('k', base).step!({ model: 'claude-haiku-5-5', system: 's', messages: history, tools, maxTokens: 999 });
    expect(out.stopReason).toBe('tool_use');
    expect(out.content).toEqual(blocks);
    expect(out).toMatchObject({ inTokens: 15, outTokens: 5 });
    expect(seen[0].body.tools).toEqual(tools);
    // The conversation is sent unchanged except for a cache marker on its last block (so the next step can read everything before it).
    const sent = seen[0].body.messages as { content: Record<string, unknown>[] }[];
    expect(sent.slice(0, -1)).toEqual(history.slice(0, -1));
    expect(sent[2]!.content).toEqual([{ type: 'tool_result', tool_use_id: 'toolu_0', content: 'ok', cache_control: { type: 'ephemeral' } }]);
    expect(seen[0].body).not.toHaveProperty('tool_choice'); // forced tool use is rejected by current models
  });

  it('step(): omits the tools field when there are none, and surfaces refusals with usage', async () => {
    const out = await new ClaudeProvider('k', base).step!({ model: 'claude-haiku-5-5', system: 's', messages: [{ role: 'user', content: 'x' }], tools: [], maxTokens: 10 });
    expect(out.stopReason).toBe('end_turn');
    expect(seen[0].body).not.toHaveProperty('tools');
    respond = () => ({ status: 200, body: message([], { stop_reason: 'refusal' }) });
    const err = await new ClaudeProvider('k', base).step!({ model: 'claude-haiku-5-5', system: 's', messages: [], tools: [], maxTokens: 10 }).catch((e) => e);
    expect(err).toBeInstanceOf(UsageError);
    expect(err).toMatchObject({ inTokens: 15, outTokens: 5 });
  });

  it('honours an abort signal', async () => {
    respond = () => ({ status: 200, body: message([{ type: 'text', text: 'late' }]) });
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(new ClaudeProvider('k', base).complete(req('claude-haiku-5-5'), ctrl.signal)).rejects.toThrow();
  });
});

describe('prompt caching', () => {
  it('marks the shared start of the system prompt for 1-hour caching and leaves the rest uncached', () => {
    expect(systemParam('abcdef', 3)).toEqual([
      { type: 'text', text: 'abc', cache_control: { type: 'ephemeral', ttl: '1h' } },
      { type: 'text', text: 'def' },
    ]);
    expect(systemParam('abcdef')).toBe('abcdef');
    expect(systemParam('abcdef', 0)).toBe('abcdef');
    expect(systemParam('abcdef', 6)).toBe('abcdef');
  });

  it('sends the split system prompt to the API', async () => {
    await new ClaudeProvider('k', base).complete({ ...req('claude-haiku-5-5'), system: 'SHAREDpersonal', cachePrefix: 6 });
    expect(seen[0].body.system).toEqual([
      { type: 'text', text: 'SHARED', cache_control: { type: 'ephemeral', ttl: '1h' } },
      { type: 'text', text: 'personal' },
    ]);
  });

  it('puts a tail marker only on multi-step conversations, without touching the originals', () => {
    const one = [{ role: 'user' as const, content: 'hi' }];
    expect(withTailCache(one)).toBe(one);
    const two = [...one, { role: 'assistant' as const, content: [{ type: 'text', text: 'x' }] }, { role: 'user' as const, content: 'more' }];
    const out = withTailCache(two);
    expect(out[2]!.content).toEqual([{ type: 'text', text: 'more', cache_control: { type: 'ephemeral' } }]);
    expect(two[2]!.content).toBe('more');
    expect(out[1]).toBe(two[1]); // earlier turns (with their thinking blocks) are passed through as they are
  });

  it('uses the right read prices per model family', () => {
    expect(cachePrices('claude-haiku-5-5').read).toBe(0.1);
    expect(cachePrices('claude-sonnet-5-5').read).toBe(0.05);
    expect(cachePrices('claude-fable-5-2').read).toBe(0.025);
    expect(cachePrices('claude-opus-5-5').write1h).toBe(2);
  });
});
