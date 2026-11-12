/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { AddressInfo } from 'net';
import { KeyVault } from '../electron/keys';
import { OpenAIProvider, toOaiMessages } from '../electron/openai';
import { Orchestrator } from '../electron/orchestrator';
import { CompleteRequest, MockProvider, Provider, StepRequest, StepResult, UsageError, CompleteResult, cachePrices } from '../electron/providers';
import { RouterProvider } from '../electron/router';
import { Store } from '../electron/store';
import { cleanModelRef, toolsAllowed, validBaseUrl, VENDORS, VendorId } from '../shared/vendors';

// ---------- shared helpers ----------
describe('vendor helpers', () => {
  it('accepts https addresses and plain http only for this computer', () => {
    expect(validBaseUrl('https://api.example.com/v1/')).toBe('https://api.example.com/v1');
    expect(validBaseUrl('http://localhost:11434/v1')).toBe('http://localhost:11434/v1');
    expect(validBaseUrl('http://127.0.0.1:1234/v1')).toBe('http://127.0.0.1:1234/v1');
    expect(validBaseUrl('http://example.com/v1')).toBeNull(); // a key would cross the network in clear text
    expect(validBaseUrl('http://localhost.evil.com/v1')).toBeNull();
    expect(validBaseUrl('https://user:pw@example.com/v1')).toBeNull();
    expect(validBaseUrl('https://example.com/v1?key=1')).toBeNull();
    expect(validBaseUrl('ftp://example.com')).toBeNull();
    expect(validBaseUrl('not a url')).toBeNull();
  });
  it('validates a model reference', () => {
    expect(cleanModelRef({ vendor: 'openai', model: 'gpt-5-codex' })).toEqual({ vendor: 'openai', model: 'gpt-5-codex' });
    expect(cleanModelRef({ vendor: 'local', model: 'llama3.1:8b' }).model).toBe('llama3.1:8b');
    expect(() => cleanModelRef({ vendor: 'nope', model: 'x' })).toThrow(/vendor/);
    expect(() => cleanModelRef({ vendor: 'openai', model: '' })).toThrow();
    expect(() => cleanModelRef({ vendor: 'openai', model: 'a b' })).toThrow();
    expect(() => cleanModelRef({ vendor: 'openai', model: '../x' })).toThrow();
    expect(() => cleanModelRef(null)).toThrow();
  });
  it('allows tools by default for hosted vendors only, and honours an override', () => {
    expect(toolsAllowed({ vendor: 'openai', model: 'gpt-5' }, {})).toBe(true);
    expect(toolsAllowed({ vendor: 'local', model: 'llama3' }, {})).toBe(false);
    expect(toolsAllowed({ vendor: 'custom', model: 'x' }, undefined)).toBe(false);
    expect(toolsAllowed({ vendor: 'local', model: 'llama3' }, { llama3: true })).toBe(true);
    expect(toolsAllowed({ vendor: 'openai', model: 'gpt-5' }, { 'gpt-5': false })).toBe(false);
  });
  it('fixes the address of every hosted vendor, and only local and custom are editable', () => {
    for (const v of VENDORS) {
      if (v.editableUrl) expect(['local', 'custom']).toContain(v.id);
      else if (v.api === 'openai') expect(v.baseUrl.startsWith('https://')).toBe(true);
    }
  });
  it('uses a conservative cache rate for other vendors', () => {
    expect(cachePrices('gpt-5', 'openai')).toEqual({ read: 0.5, write5m: 1, write1h: 1 });
    expect(cachePrices('claude-haiku-5-5').write1h).toBe(2);
  });
});

// ---------- message translation ----------
describe('toOaiMessages', () => {
  it('translates a tool round trip: assistant tool_calls, then tool messages, then more user text', () => {
    const out = toOaiMessages('SYS', [
      { role: 'user', content: 'do it' },
      { role: 'assistant', content: [{ type: 'text', text: 'on it' }, { type: 'tool_use', id: 'c1', name: 'read_file', input: { path: 'a.txt' } }] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'c1', content: 'file text' },
        { type: 'tool_result', tool_use_id: 'c2', content: 'nope', is_error: true },
      ] },
    ]);
    expect(out[0]).toEqual({ role: 'system', content: 'SYS' });
    expect(out[1]).toEqual({ role: 'user', content: 'do it' });
    expect(out[2]).toEqual({ role: 'assistant', content: 'on it', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] });
    expect(out[3]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'file text' });
    expect(out[4]).toEqual({ role: 'tool', tool_call_id: 'c2', content: 'Error: nope' });
  });
  it('sends images as data URLs and gives a tool-only assistant turn null content', () => {
    const out = toOaiMessages('S', [
      { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } }, { type: 'text', text: 'look' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'list_files', input: {} }] },
    ]);
    expect(out[1]).toEqual({ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } }, { type: 'text', text: 'look' }] });
    expect((out[2] as { content: unknown }).content).toBeNull();
  });
  it('drops thinking blocks, which other vendors do not understand', () => {
    const out = toOaiMessages('S', [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'hm' }, { type: 'text', text: 'hi' }] }]);
    expect(out[1]).toEqual({ role: 'assistant', content: 'hi' });
  });
});

// ---------- the adapter against a fake server ----------
interface Seen { method: string; url: string; headers: http.IncomingHttpHeaders; body: Record<string, any> } // eslint-disable-line @typescript-eslint/no-explicit-any
let server: http.Server;
let base = '';
let seen: Seen[] = [];
let respond: (r: Seen, n: number) => { status: number; body: unknown };

const choice = (message: Record<string, unknown>, finish = 'stop', usage: Record<string, unknown> = { prompt_tokens: 20, completion_tokens: 7 }) =>
  ({ choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: finish }], usage });

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      const entry: Seen = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: raw ? JSON.parse(raw) : {} };
      seen.push(entry);
      const r = respond(entry, seen.length);
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => { seen = []; respond = () => ({ status: 200, body: choice({ content: 'hi there' }) }); });

const provider = (vendor: VendorId = 'custom', apiKey: string | null = 'sk-secret-123') =>
  new OpenAIProvider({ vendor, baseUrl: base, apiKey: apiKey ?? undefined, retryDelayMs: 1 });
const creq = (over: Partial<CompleteRequest> = {}): CompleteRequest => ({ model: 'm1', system: 'sys', prompt: 'hello', maxTokens: 500, ...over });

describe('OpenAIProvider.complete', () => {
  it('posts to /chat/completions with a bearer key, the model, system and user messages, and max_tokens', async () => {
    const out = await provider().complete(creq());
    expect(out).toEqual({ text: 'hi there', inTokens: 20, outTokens: 7, cache: { read: 0, write5m: 0, write1h: 0 } });
    expect(seen[0]!.method).toBe('POST');
    expect(seen[0]!.url).toBe('/chat/completions');
    expect(seen[0]!.headers.authorization).toBe('Bearer sk-secret-123');
    expect(seen[0]!.body).toMatchObject({ model: 'm1', max_tokens: 8500, messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hello' }] });
    expect(seen[0]!.body).not.toHaveProperty('tools');
  });
  it('sends no Authorization header when there is no key (a local server)', async () => {
    await provider('local', null).complete(creq());
    expect(seen[0]!.headers.authorization).toBeUndefined();
  });
  it('uses max_completion_tokens with headroom for OpenAI proper', async () => {
    await provider('openai').complete(creq());
    expect(seen[0]!.body).toHaveProperty('max_completion_tokens');
    expect(seen[0]!.body).not.toHaveProperty('max_tokens');
    expect(seen[0]!.body.max_completion_tokens).toBeGreaterThan(500);
  });
  it('reports cached prompt tokens, from either field name', async () => {
    respond = () => ({ status: 200, body: choice({ content: 'x' }, 'stop', { prompt_tokens: 100, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 60 } }) });
    expect((await provider().complete(creq())).cache).toEqual({ read: 60, write5m: 0, write1h: 0 });
    respond = () => ({ status: 200, body: choice({ content: 'x' }, 'stop', { prompt_tokens: 100, completion_tokens: 1, prompt_cache_hit_tokens: 40 }) });
    expect((await provider().complete(creq())).cache?.read).toBe(40);
  });
  it('notes a reply cut off at the length limit', async () => {
    respond = () => ({ status: 200, body: choice({ content: 'partial' }, 'length') });
    expect((await provider().complete(creq())).text).toMatch(/^partial\n\n\[This reply was cut off/);
  });
  it('turns a refusal or content filter into a billed UsageError', async () => {
    respond = () => ({ status: 200, body: choice({ content: null, refusal: 'I cannot help with that' }, 'stop', { prompt_tokens: 30, completion_tokens: 4 }) });
    const e = await provider().complete(creq()).catch((x) => x);
    expect(e).toBeInstanceOf(UsageError);
    expect(e.inTokens).toBe(30);
    expect(e.message).toMatch(/declined/);
    respond = () => ({ status: 200, body: choice({ content: '' }, 'content_filter') });
    expect(await provider().complete(creq()).catch((x) => x)).toBeInstanceOf(UsageError);
  });
  it('reports an empty reply as a UsageError so the tokens still count', async () => {
    respond = () => ({ status: 200, body: choice({ content: '   ' }) });
    const e = await provider().complete(creq()).catch((x) => x);
    expect(e).toBeInstanceOf(UsageError);
    expect(e.message).toMatch(/Empty response/);
  });
  it('accepts content given as an array of parts', async () => {
    respond = () => ({ status: 200, body: choice({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }) });
    expect((await provider().complete(creq())).text).toBe('ab');
  });
});

describe('OpenAIProvider.step (tools)', () => {
  const tools = [{ name: 'read_file', description: 'Read', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }];
  const sreq = (over: Partial<StepRequest> = {}): StepRequest => ({ model: 'm1', system: 's', messages: [{ role: 'user', content: 'go' }], tools, maxTokens: 800, ...over });

  it('offers the tools as functions and maps tool_calls back to tool_use blocks', async () => {
    respond = () => ({ status: 200, body: choice({ content: 'reading', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] }, 'tool_calls') });
    const r = await provider().step(sreq());
    expect(seen[0]!.body.tools).toEqual([{ type: 'function', function: { name: 'read_file', description: 'Read', parameters: tools[0]!.input_schema } }]);
    expect(r.stopReason).toBe('tool_use');
    expect(r.content).toEqual([{ type: 'text', text: 'reading' }, { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.txt' } }]);
  });
  it('ends the turn on a plain answer', async () => {
    const r = await provider().step(sreq());
    expect(r.stopReason).toBe('end_turn');
    expect(r.content).toEqual([{ type: 'text', text: 'hi there' }]);
  });
  it('never acts on tool calls from a truncated reply (length wins)', async () => {
    respond = () => ({ status: 200, body: choice({ content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'read_file', arguments: '{"pa' } }] }, 'length') });
    expect((await provider().step(sreq())).stopReason).toBe('max_tokens');
  });
  it('survives unparseable arguments by passing an empty input (the tool then reports what is missing)', async () => {
    respond = () => ({ status: 200, body: choice({ content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'read_file', arguments: 'not json' } }] }, 'tool_calls') });
    const r = await provider().step(sreq());
    expect(r.content).toEqual([{ type: 'tool_use', id: 'c', name: 'read_file', input: {} }]);
  });
  it('replays earlier tool results as tool messages on the next call', async () => {
    await provider().step(sreq({ messages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'read_file', input: { path: 'a' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'DATA' }] },
    ] }));
    const roles = (seen[0]!.body.messages as { role: string }[]).map((m) => m.role);
    expect(roles).toEqual(['system', 'user', 'assistant', 'tool']);
  });
});

describe('OpenAIProvider errors', () => {
  it('explains a bad key without echoing it', async () => {
    respond = () => ({ status: 401, body: { error: { message: 'Incorrect API key provided: sk-secret-123' } } });
    const e = await provider('openai').complete(creq()).catch((x): any => x);
    expect(e.message).toMatch(/Invalid or missing API key for OpenAI/);
    expect(e.message).not.toContain('sk-secret-123');
  });
  it('never lets an error body carry the key into a message', async () => {
    respond = () => ({ status: 500, body: { error: { message: 'boom sk-secret-123 boom' } } });
    const e = await provider().complete(creq()).catch((x): any => x);
    expect(e.message).not.toContain('sk-secret-123');
    expect(e.message).toContain('[key]');
  });
  it('explains an unknown model, mentioning pulling it for a local server', async () => {
    respond = () => ({ status: 404, body: { error: { message: 'model "zzz" not found' } } });
    expect((await provider('local', null).complete(creq()).catch((x): any => x)).message).toMatch(/pulled or loaded/);
    expect((await provider('openai').complete(creq()).catch((x): any => x)).message).toMatch(/does not know that model/);
  });
  it('retries a rate limit and a server error, then succeeds', async () => {
    respond = (_r, n) => n === 1 ? { status: 429, body: { error: { message: 'slow' } } } : n === 2 ? { status: 503, body: 'down' } : { status: 200, body: choice({ content: 'ok now' }) };
    expect((await provider().complete(creq())).text).toBe('ok now');
    expect(seen).toHaveLength(3);
  });
  it('gives up after the retries on a persistent rate limit', async () => {
    respond = () => ({ status: 429, body: {} });
    expect((await provider().complete(creq()).catch((x): any => x)).message).toMatch(/Rate limited/);
    expect(seen).toHaveLength(3);
  });
  it('does not retry a client error', async () => {
    respond = () => ({ status: 400, body: { error: { message: 'bad request' } } });
    await provider().complete(creq()).catch(() => undefined);
    expect(seen).toHaveLength(1);
  });
  it('says so when a local server is not running', async () => {
    const dead = new OpenAIProvider({ vendor: 'local', baseUrl: 'http://127.0.0.1:1', retryDelayMs: 1 });
    expect((await dead.complete(creq()).catch((x): any => x)).message).toMatch(/Could not reach http:\/\/127\.0\.0\.1:1/);
  });
  it('stops at once when aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    expect((await provider().complete(creq(), ctrl.signal).catch((x): any => x)).message).toBe('Stopped');
    expect(seen).toHaveLength(0);
  });
  it('lists models from /models', async () => {
    respond = () => ({ status: 200, body: { data: [{ id: 'llama3.1' }, { id: 'qwen2.5-coder' }] } });
    expect(await provider('local', null).listModels()).toEqual(['llama3.1', 'qwen2.5-coder']);
    expect(seen[0]!.method).toBe('GET');
    expect(seen[0]!.url).toBe('/models');
  });
});

// ---------- key storage ----------
const fakeCrypto = (over: Partial<{ ok: boolean; backend: string }> = {}) => ({
  isEncryptionAvailable: () => over.ok ?? true,
  encryptString: (s: string) => Buffer.from(`enc:${Buffer.from(s).toString('base64')}`),
  decryptString: (b: Buffer) => Buffer.from(b.toString().replace(/^enc:/, ''), 'base64').toString(),
  getSelectedStorageBackend: () => over.backend ?? 'dpapi',
});
describe('KeyVault', () => {
  let dir = '';
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-keys-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('stores each vendor separately, encrypted, and reloads them', () => {
    const v = new KeyVault(dir, fakeCrypto());
    v.set('anthropic', 'sk-ant-A');
    v.set('openai', 'sk-O');
    expect(fs.existsSync(path.join(dir, 'api-key.bin'))).toBe(true); // the file name an existing install already uses
    expect(fs.existsSync(path.join(dir, 'keys', 'openai.bin'))).toBe(true);
    for (const f of [path.join(dir, 'api-key.bin'), path.join(dir, 'keys', 'openai.bin')]) {
      expect(fs.readFileSync(f).toString()).not.toContain('sk-'); // never plain text on disk
    }
    const again = new KeyVault(dir, fakeCrypto());
    expect(again.get('anthropic')).toBe('sk-ant-A');
    expect(again.get('openai')).toBe('sk-O');
    expect(again.get('google')).toBeUndefined();
    expect(again.flags()).toEqual({ anthropic: true, openai: true });
  });
  it('removes one vendor without touching the others', () => {
    const v = new KeyVault(dir, fakeCrypto());
    v.set('anthropic', 'a'); v.set('xai', 'x');
    v.clear('xai');
    expect(v.has('xai')).toBe(false);
    expect(v.has('anthropic')).toBe(true);
    expect(fs.existsSync(path.join(dir, 'keys', 'xai.bin'))).toBe(false);
  });
  it('refuses to save when encryption is missing or only pretend (basic_text)', () => {
    expect(() => new KeyVault(dir, fakeCrypto({ ok: false })).set('openai', 'k')).toThrow(/Secure storage/);
    expect(() => new KeyVault(dir, fakeCrypto({ backend: 'basic_text' })).set('openai', 'k')).toThrow(/Secure storage/);
    expect(fs.existsSync(path.join(dir, 'keys'))).toBe(false);
  });
  it('rejects an empty key and an unknown vendor name', () => {
    const v = new KeyVault(dir, fakeCrypto());
    expect(() => v.set('openai', '')).toThrow();
    expect(() => v.set('../evil' as VendorId, 'k')).toThrow(/Unknown vendor/);
  });
});

// ---------- store ----------
describe('store: agent models and vendor settings', () => {
  it('sets and clears an agent\'s explicit model, validating it', () => {
    const s = new Store();
    s.updateAgent('prog', { model: { vendor: 'openai', model: 'gpt-5-codex' } });
    expect(s.agent('prog')!.model).toEqual({ vendor: 'openai', model: 'gpt-5-codex' });
    expect(() => s.updateAgent('prog', { model: { vendor: 'nope', model: 'x' } as never })).toThrow();
    expect(s.agent('prog')!.model!.vendor).toBe('openai'); // a bad update changes nothing
    s.updateAgent('prog', { model: null });
    expect(s.agent('prog')!.model).toBeUndefined();
  });
  it('lets a new agent start on any vendor', () => {
    const s = new Store();
    const a = s.addAgent({ name: 'Zed', role: 'x', specialty: '', personality: '', tier: 'standard', model: { vendor: 'local', model: 'llama3.1' } });
    expect(a.model).toEqual({ vendor: 'local', model: 'llama3.1' });
  });
  it('accepts addresses only for local and custom, and only safe ones', () => {
    const s = new Store();
    s.updateSettings({ vendorUrls: { local: 'http://localhost:1234/v1/' } });
    expect(s.settings.vendorUrls.local).toBe('http://localhost:1234/v1');
    expect(() => s.updateSettings({ vendorUrls: { openai: 'https://evil.example.com/v1' } })).toThrow(/cannot be changed/);
    expect(() => s.updateSettings({ vendorUrls: { custom: 'http://example.com/v1' } })).toThrow(/https/);
    expect(s.settings.vendorUrls.custom).toBeUndefined();
    s.updateSettings({ vendorUrls: { local: '' } });
    expect(s.settings.vendorUrls.local).toBeUndefined();
  });
  it('records per-model tool permission and rejects junk', () => {
    const s = new Store();
    s.updateSettings({ modelTools: { llama3: true } });
    expect(s.settings.modelTools.llama3).toBe(true);
    expect(() => s.updateSettings({ modelTools: { 'bad name': true } })).toThrow();
    expect(() => s.updateSettings({ modelTools: { ok: 'yes' as never } })).toThrow();
  });
  it('starts every existing agent on its tier (no behaviour change)', () => {
    expect(new Store().snapshot().agents.every((a) => a.model === undefined)).toBe(true);
  });
});

// ---------- the orchestrator across vendors ----------
/** Records which vendor and model each call asked for, and answers as that vendor. */
class RecordingProvider implements Provider {
  calls: { kind: 'complete' | 'step'; vendor?: VendorId; model: string; prompt?: string }[] = [];
  inner = new MockProvider();
  async complete(req: CompleteRequest): Promise<CompleteResult> {
    this.calls.push({ kind: 'complete', vendor: req.vendor, model: req.model, prompt: req.prompt });
    return this.inner.complete(req);
  }
  async step(req: StepRequest): Promise<StepResult> {
    this.calls.push({ kind: 'step', vendor: req.vendor, model: req.model });
    return this.inner.step(req);
  }
}
const chan = (s: Store, kind = 'general') => s.channels().find((c) => c.kind === kind && c.categoryId === 'cat_1')!;

describe('orchestrator: each agent runs on its own vendor and model', () => {
  it('sends an agent without a model to Anthropic via its tier, and one with a model to that vendor', async () => {
    const store = new Store();
    store.updateAgent('prog', { model: { vendor: 'openai', model: 'gpt-5-codex' } });
    const rec = new RecordingProvider();
    const orch = new Orchestrator(store, { getProvider: () => rec, vaultDigest: () => '' });
    await orch.handleUserMessage(chan(store, 'programming').id, '@Hex please write a plan for the login page');
    const hexCall = rec.calls.find((c) => c.model === 'gpt-5-codex');
    expect(hexCall?.vendor).toBe('openai');
    // Probe (the partner, no explicit model) reviews on Anthropic's standard tier: a different vendor audits the first.
    const probe = rec.calls.find((c) => c.model === store.modelFor('standard'));
    expect(probe?.vendor).toBe('anthropic');
  });

  it('lets one vendor audit another: the author and the reviewer are called with different vendors', async () => {
    const store = new Store();
    store.updateAgent('ux-a', { model: { vendor: 'openai', model: 'gpt-5' } });
    store.updateAgent('ux-b', { model: { vendor: 'google', model: 'gemini-2.5-pro' } });
    const rec = new RecordingProvider();
    const orch = new Orchestrator(store, { getProvider: () => rec, vaultDigest: () => '' });
    await orch.handleUserMessage(chan(store, 'design').id, '@Mira please write a plan for the menu');
    const vendors = rec.calls.map((c) => c.vendor);
    expect(vendors).toContain('openai');
    expect(vendors).toContain('google');
    const msgs = store.snapshot().messages.filter((m) => m.channelId === chan(store, 'design').id);
    expect(msgs.some((m) => m.kind === 'review' && m.authorId === 'ux-b')).toBe(true);
  });

  it('refuses a hosted model that has no price in live mode (so budgets cannot be bypassed) but runs a local one free', async () => {
    const store = new Store();
    store.setMode('claude');
    store.updateAgent('prog', { model: { vendor: 'openai', model: 'gpt-unpriced' } });
    const rec = new RecordingProvider();
    const orch = new Orchestrator(store, { getProvider: () => rec, vaultDigest: () => '' });
    const ch = chan(store, 'programming');
    await orch.handleUserMessage(ch.id, '@Hex hello');
    expect(rec.calls.some((c) => c.model === 'gpt-unpriced')).toBe(false);
    expect(store.snapshot().messages.some((m) => /No price is set for gpt-unpriced/.test(m.content))).toBe(true);

    store.updateAgent('prog', { model: { vendor: 'local', model: 'llama3.1' } });
    await orch.handleUserMessage(ch.id, '@Hex hello again');
    expect(rec.calls.some((c) => c.model === 'llama3.1' && c.vendor === 'local')).toBe(true);
    expect(store.spendToday()).toBe(0);
  });

  it('bills a priced non-Anthropic model with its own price and the generic cache rate', async () => {
    const store = new Store();
    store.setMode('claude');
    store.updateSettings({ prices: { 'gpt-5': { in: 10, out: 20 } } });
    store.updateAgent('prog', { model: { vendor: 'openai', model: 'gpt-5' } });
    const prov: Provider = {
      complete: async () => ({ text: 'hello', inTokens: 1_000_000, outTokens: 1_000_000, cache: { read: 1_000_000, write5m: 0, write1h: 0 } }),
    };
    const orch = new Orchestrator(store, { getProvider: () => prov, vaultDigest: () => '' });
    await orch.handleUserMessage(chan(store, 'programming').id, '@Hex hello');
    // All input was cached: 1M x 0.5 x $10 + 1M output x $20 = $25, per call by Hex. Others may add to it, so check the floor.
    expect(store.spendToday()).toBeGreaterThanOrEqual(25);
  });

  it('keeps an agent whose model cannot use tools to chat only, even in a project folder', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-vendor-'));
    try {
      const store = new Store();
      store.setProjectPath('cat_1', dir);
      store.updateAgent('prog', { model: { vendor: 'local', model: 'tiny' } });
      const rec = new RecordingProvider();
      const orch = new Orchestrator(store, { getProvider: () => rec, vaultDigest: () => '' });
      await orch.handleUserMessage(chan(store, 'programming').id, '@Hex !tool write a.txt hi');
      expect(rec.calls.some((c) => c.kind === 'step' && c.model === 'tiny')).toBe(false);
      expect(fs.readdirSync(dir)).toHaveLength(0);
      // Switch tools on for that model and the agent gets the tool loop.
      store.updateSettings({ modelTools: { tiny: true } });
      await orch.handleUserMessage(chan(store, 'programming').id, '@Hex !tool read a.txt');
      expect(rec.calls.some((c) => c.kind === 'step' && c.model === 'tiny' && c.vendor === 'local')).toBe(true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('RouterProvider', () => {
  it('routes by vendor, defaulting to Anthropic, and surfaces the setup error', async () => {
    const got: string[] = [];
    const make = (name: string): Provider => ({
      complete: async () => { got.push(name); return { text: name, inTokens: 1, outTokens: 1 }; },
      step: async () => { got.push(`${name}-step`); return { content: [], stopReason: 'end_turn', inTokens: 1, outTokens: 1 }; },
    });
    const r = new RouterProvider((v) => {
      if (v === 'google') throw new Error('No API key for Google');
      return make(v);
    });
    expect((await r.complete(creq({ vendor: 'openai' }))).text).toBe('openai');
    expect((await r.complete(creq())).text).toBe('anthropic');
    await r.step({ model: 'm', system: '', messages: [], tools: [], maxTokens: 1, vendor: 'local' });
    expect(got).toEqual(['openai', 'anthropic', 'local-step']);
    await expect(r.complete(creq({ vendor: 'google' }))).rejects.toThrow(/No API key for Google/);
  });
  it('end to end: an agent on a "custom" vendor really talks to the fake server through the router', async () => {
    respond = () => ({ status: 200, body: choice({ content: 'Hello from the other vendor.' }) });
    const store = new Store();
    store.updateAgent('prog', { model: { vendor: 'local', model: 'llama3.1' } });
    const router = new RouterProvider((v) => {
      if (v === 'local') return new OpenAIProvider({ vendor: 'local', baseUrl: base, retryDelayMs: 1 });
      return new MockProvider();
    });
    const orch = new Orchestrator(store, { getProvider: () => router, vaultDigest: () => '' });
    await orch.handleUserMessage(chan(store, 'programming').id, '@Hex hi');
    expect(seen.some((s) => s.body.model === 'llama3.1' && s.url === '/chat/completions')).toBe(true);
    expect(store.snapshot().messages.some((m) => m.authorId === 'prog' && m.content.includes('Hello from the other vendor.'))).toBe(true);
  });
});


describe('older databases', () => {
  it('load with the new settings filled in and every agent still on its tier', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-old-'));
    try {
      const file = path.join(dir, 'council.json');
      new Store(file).flush();
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      delete raw.settings.vendorKeys; delete raw.settings.vendorUrls; delete raw.settings.modelTools;
      fs.writeFileSync(file, JSON.stringify(raw));
      const s = new Store(file);
      expect(s.settings.vendorUrls).toEqual({});
      expect(s.settings.modelTools).toEqual({});
      expect(s.settings.vendorKeys).toEqual({});
      expect(s.agent('prog')!.model).toBeUndefined();
      expect(s.modelFor(s.agent('prog')!.tier)).toBe('claude-sonnet-5-5');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('review fixes', () => {
  it('a model named like an Object property cannot dodge the price check or inherit a tool setting', async () => {
    const store = new Store();
    store.setMode('claude');
    store.updateAgent('prog', { model: { vendor: 'openai', model: 'constructor' } });
    const rec = new RecordingProvider();
    const orch = new Orchestrator(store, { getProvider: () => rec, vaultDigest: () => '' });
    await orch.handleUserMessage(chan(store, 'programming').id, '@Hex hello');
    expect(rec.calls.some((c) => c.model === 'constructor')).toBe(false);
    expect(store.snapshot().messages.some((m) => /No price is set for constructor/.test(m.content))).toBe(true);
    expect(toolsAllowed({ vendor: 'local', model: 'toString' }, {})).toBe(false);
    expect(store.priceFor('valueOf')).toEqual({ in: 0, out: 0 });
    expect(Number.isFinite(store.spendToday())).toBe(true);
  });
  it('ignores a non-finite or negative spend figure instead of poisoning the total', () => {
    const s = new Store();
    s.recordSpend(NaN, null); s.recordSpend(-5, null); s.recordSpend(Infinity, null);
    expect(s.spendToday()).toBe(0);
    s.recordSpend(1.5, null);
    expect(s.spendToday()).toBe(1.5);
  });
  it('rejects bad prices from the interface', () => {
    const s = new Store();
    expect(() => s.updateSettings({ prices: { gpt: { in: -1, out: 1 } } })).toThrow(/Prices/);
    expect(() => s.updateSettings({ prices: { gpt: { in: NaN, out: 1 } } })).toThrow();
    expect(() => s.updateSettings({ prices: { gpt: { in: '1' as never, out: 1 } } })).toThrow();
    expect(() => s.updateSettings({ prices: { 'bad name': { in: 1, out: 1 } } })).toThrow();
    s.updateSettings({ prices: { 'gpt-5': { in: 1, out: 2 } } });
    expect(s.priceFor('gpt-5')).toEqual({ in: 1, out: 2 });
  });
  it('the "local" vendor accepts only this computer, while "custom" may be any https address', () => {
    const s = new Store();
    expect(() => s.updateSettings({ vendorUrls: { local: 'https://api.openai.com/v1' } })).toThrow(/on this computer/);
    expect(() => s.updateSettings({ vendorUrls: { local: 'http://foo.localhost:11434/v1' } })).toThrow();
    s.updateSettings({ vendorUrls: { local: 'http://127.0.0.1:11434/v1', custom: 'https://openrouter.ai/api/v1' } });
    expect(s.settings.vendorUrls.custom).toBe('https://openrouter.ai/api/v1');
    expect(validBaseUrl('http://foo.localhost/v1')).toBeNull();
  });
  it('estimates tokens when a server omits usage, so the budget is not blind', async () => {
    respond = () => ({ status: 200, body: { choices: [{ index: 0, message: { role: 'assistant', content: 'x'.repeat(400) }, finish_reason: 'stop' }] } });
    const out = await provider().complete(creq({ prompt: 'y'.repeat(2000) }));
    expect(out.inTokens).toBeGreaterThan(400);
    expect(out.outTokens).toBe(100);
  });
  it('gives hosted vendors headroom for hidden reasoning, and local servers exactly what was asked', async () => {
    await provider('google').complete(creq());
    expect(seen[0]!.body.max_tokens).toBe(8500);
    await provider('local', null).complete(creq());
    expect(seen[1]!.body.max_tokens).toBe(500);
  });
});
