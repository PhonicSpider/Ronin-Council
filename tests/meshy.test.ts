/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { AddressInfo } from 'net';
import { HttpMeshyClient, MeshyClient, MockMeshyClient, prepareMeshyTool, safeDownloadUrl, MESHY_TOOLS } from '../electron/meshy';
import { Orchestrator } from '../electron/orchestrator';
import { MockProvider, MockStepScript, StepResult } from '../electron/providers';
import { Store } from '../electron/store';
import { meshyEstimate, meshySteps } from '../shared/meshy';

// ---------- a fake Meshy ----------
interface Seen { method: string; url: string; headers: http.IncomingHttpHeaders; body: any }
let server: http.Server;
let base = '';
let seen: Seen[] = [];
/** Each test says how the fake answers; `files` are served on /files/*. */
let handler: (r: Seen) => { status: number; body: unknown; raw?: Buffer } | undefined;
const GLB = Buffer.concat([Buffer.from('glTF'), Buffer.alloc(20)]);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      const entry: Seen = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: raw ? JSON.parse(raw) : {} };
      seen.push(entry);
      if (entry.url.startsWith('/files/')) {
        const f = entry.url.endsWith('.glb') ? GLB : entry.url.endsWith('big.bin') ? Buffer.alloc(3000) : PNG;
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        return res.end(f);
      }
      const r = handler(entry) ?? { status: 404, body: { message: 'no handler' } };
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(r.raw ?? JSON.stringify(r.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => { seen = []; handler = () => undefined; });

const client = (key = 'msy_secret_key') => new HttpMeshyClient(key, { baseUrl: base, retryDelayMs: 1, allowInsecureDownloads: true });
const ok = (task: Record<string, unknown>) => ({ status: 200, body: { id: 'task_abcdef12', status: 'SUCCEEDED', progress: 100, ...task } });

/** A fake that creates tasks and finishes them, remembering what was created. */
function workingMeshy(over: Partial<{ consumed: number; failFirst: boolean; slow: boolean }> = {}) {
  let n = 0;
  const created: any[] = [];
  handler = (r) => {
    if (r.method === 'POST') {
      created.push({ url: r.url, body: r.body });
      return { status: 202, body: { result: `task_${++n}_abcdef` } };
    }
    if (r.url.includes('/balance')) return { status: 200, body: { balance: 400, monthly_credits: 100, permanent_credits: 300 } };
    if (over.slow) return { status: 200, body: { id: 'x', status: 'IN_PROGRESS', progress: 10 } };
    if (over.failFirst) return { status: 200, body: { id: 'x', status: 'FAILED', task_error: { message: 'bad prompt', type: 'invalid_input' }, consumed_credits: 0 } };
    return ok({ consumed_credits: over.consumed, model_urls: { glb: `${base}/files/m.glb` }, thumbnail_url: `${base}/files/t.png`, image_urls: [`${base}/files/i.png`] });
  };
  return created;
}

// ---------- estimates ----------
describe('credit estimates', () => {
  it('follow the published table', () => {
    expect(meshyEstimate({ kind: 'text_to_3d', quality: 'draft', texture: false })).toBe(5);
    expect(meshyEstimate({ kind: 'text_to_3d', quality: 'standard', texture: false })).toBe(20);
    expect(meshyEstimate({ kind: 'text_to_3d', quality: 'standard', texture: true })).toBe(30);
    expect(meshyEstimate({ kind: 'image_to_3d', quality: 'standard', texture: true })).toBe(30);
    expect(meshyEstimate({ kind: 'image_to_3d', quality: 'draft', texture: false })).toBe(5);
    expect(meshyEstimate({ kind: 'text_to_image', quality: 'draft', texture: false })).toBe(3);
    expect(meshySteps({ kind: 'text_to_3d', quality: 'draft', texture: true })).toHaveLength(2);
  });
});

// ---------- the client ----------
describe('HttpMeshyClient', () => {
  it('sends the bearer key, creates a task and returns its id', async () => {
    handler = () => ({ status: 202, body: { result: 'task_12345678' } });
    expect(await client().create('/openapi/v2/text-to-3d', { mode: 'preview', prompt: 'x' })).toBe('task_12345678');
    expect(seen[0]!.headers.authorization).toBe('Bearer msy_secret_key');
    expect(seen[0]!.url).toBe('/openapi/v2/text-to-3d');
    expect(seen[0]!.body).toEqual({ mode: 'preview', prompt: 'x' });
  });
  it('never retries a create (a retry could be billed twice) but retries reads', async () => {
    handler = () => ({ status: 500, body: { message: 'boom' } });
    await client().create('/openapi/v2/text-to-3d', {}).catch(() => undefined);
    expect(seen).toHaveLength(1);
    seen = [];
    let n = 0;
    handler = () => (++n < 3 ? { status: 503, body: {} } : { status: 200, body: { id: 'task_abcdef', status: 'SUCCEEDED' } });
    expect((await client().get('/openapi/v1/image-to-3d', 'task_abcdef')).status).toBe('SUCCEEDED');
    expect(seen).toHaveLength(3);
  });
  it('rejects an odd task id from the server and a bad id from the caller', async () => {
    handler = () => ({ status: 202, body: { result: '../../etc' } });
    await expect(client().create('/x', {})).rejects.toThrow(/task id/);
    await expect(client().get('/x', '../evil')).rejects.toThrow(/Invalid task id/);
  });
  it('explains a bad key and missing credits without echoing the key', async () => {
    handler = () => ({ status: 401, body: { message: 'bad key msy_secret_key' } });
    const e1 = await client().balance().catch((e): any => e);
    expect(e1.message).toMatch(/Invalid or missing Meshy key/);
    expect(e1.message).not.toContain('msy_secret_key');
    handler = () => ({ status: 402, body: { message: 'insufficient credits for msy_secret_key' } });
    const e2 = await client().create('/x', {}).catch((e): any => e);
    expect(e2.message).toMatch(/not enough credits/);
    expect(e2.message).not.toContain('msy_secret_key');
  });
  it('reads the balance', async () => {
    workingMeshy();
    expect(await client().balance()).toEqual({ balance: 400, monthly: 100, permanent: 300 });
  });
  it('downloads without sending the key, and enforces the size limit', async () => {
    const c = client();
    expect((await c.download(`${base}/files/m.glb`, 1000)).subarray(0, 4).toString()).toBe('glTF');
    expect(seen[0]!.headers.authorization).toBeUndefined();
    await expect(c.download(`${base}/files/big.bin`, 1000)).rejects.toThrow(/larger than/);
  });
  it('only downloads from public https addresses', () => {
    expect(() => safeDownloadUrl('https://assets.meshy.ai/a/b.glb?Expires=1')).not.toThrow();
    for (const bad of ['http://assets.meshy.ai/a.glb', 'https://localhost/a', 'https://127.0.0.1/a', 'https://192.168.1.5/a', 'https://10.0.0.1/a',
      'https://172.20.1.1/a', 'https://169.254.169.254/latest', 'https://user:pw@assets.meshy.ai/a', 'file:///etc/passwd', 'not a url', 'https://x.internal/a']) {
      expect(() => safeDownloadUrl(bad), bad).toThrow(/not allowed|not a valid/);
    }
  });
});

// ---------- the tools, against a real project folder ----------
let dir = '';
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-meshy-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function deps(c: MeshyClient, over: { used?: number; cap?: number; timeoutMs?: number } = {}) {
  const ledger = { used: over.used ?? 0, log: [] as number[] };
  return {
    ledger,
    d: {
      client: c, creditsToday: () => ledger.used, dailyCap: () => over.cap ?? 100,
      addCredits: (n: number) => { ledger.used = Math.max(0, ledger.used + n); ledger.log.push(n); },
      poll: { intervalMs: 1, timeoutMs: over.timeoutMs ?? 2000 },
    },
  };
}
const gen = (input: unknown, d: ReturnType<typeof deps>['d']) => {
  const p = prepareMeshyTool(dir, 'meshy_generate', input, d);
  if ('error' in p) throw new Error(p.error);
  if (!p.needsApproval) throw new Error('expected an approval request');
  return p;
};
const files = (sub = 'assets/meshy') => (fs.existsSync(path.join(dir, sub)) ? fs.readdirSync(path.join(dir, sub)).sort() : []);

describe('meshy_generate: the approval request', () => {
  it('always needs approval and shows the prompt, the steps and the credit estimate before anything is sent', () => {
    const created = workingMeshy();
    const { d } = deps(client());
    const p = gen({ kind: 'text_to_3d', prompt: 'a rusty iron sword', quality: 'draft', texture: true }, d);
    expect(p.action.tool).toBe('meshy_generate');
    expect(p.action.summary).toMatch(/about 15 credits/);
    expect(p.action.preview).toContain('Prompt: a rusty iron sword');
    expect(p.action.preview).toContain('Estimated total: about 15 credits');
    expect(p.action.preview).toContain('Credits left today under the cap: 100 of 100');
    expect(p.action.preview).toMatch(/Stop ends the wait, but Meshy may still finish/);
    expect(created).toHaveLength(0);
    expect(seen).toHaveLength(0); // nothing reaches Meshy before approval
  });
  it('shows hidden characters in the prompt instead of hiding them', () => {
    const { d } = deps(client());
    const p = gen({ kind: 'text_to_image', prompt: 'a cat‮​meow' }, d);
    expect(p.action.preview).toContain('⟦U+202E⟧');
    expect(p.action.preview).toContain('⟦U+200B⟧');
  });
  it('refuses a request that would pass today\'s credit cap, telling the agent how much is left', () => {
    const { d } = deps(client(), { used: 95, cap: 100 });
    const r = prepareMeshyTool(dir, 'meshy_generate', { kind: 'text_to_3d', prompt: 'x', quality: 'standard', texture: false }, d);
    expect('error' in r && r.error).toMatch(/about 20 Meshy credits but only 5 are left/);
  });
  it('validates the input', () => {
    const { d } = deps(client());
    const bad = (input: unknown) => { const r = prepareMeshyTool(dir, 'meshy_generate', input, d); return 'error' in r ? r.error : 'accepted'; };
    expect(bad({ kind: 'sculpt', prompt: 'x' })).toMatch(/"kind" must be/);
    expect(bad({ kind: 'text_to_3d' })).toMatch(/"prompt" is required/);
    expect(bad({ kind: 'text_to_3d', prompt: 'x'.repeat(801) })).toMatch(/too long/);
    expect(bad({ kind: 'text_to_3d', prompt: 'x', quality: 'ultra' })).toMatch(/"quality"/);
    expect(bad({ kind: 'text_to_image', prompt: 'x', aspect_ratio: '3:2' })).toMatch(/aspect_ratio/);
    expect(bad({ kind: 'image_to_3d' })).toMatch(/"image_path" is required/);
    expect(bad(null)).toMatch(/"kind" must be/);
  });
});

describe('meshy_generate: running it', () => {
  it('text to 3D with texture makes two paid steps (shape, then texture) and saves the model and preview in the project', async () => {
    const created = workingMeshy({ consumed: undefined });
    const { d, ledger } = deps(client());
    const out = await gen({ kind: 'text_to_3d', prompt: 'a rusty iron sword', quality: 'draft', texture: true, name: 'sword' }, d).run();
    expect(out.isError).toBeFalsy();
    expect(created.map((c) => c.body.mode)).toEqual(['preview', 'refine']);
    expect(created[0].body).toMatchObject({ mode: 'preview', prompt: 'a rusty iron sword', ai_model: 'meshy-6-lite', target_formats: ['glb'] });
    expect(created[1].body.preview_task_id).toBe('task_1_abcdef'); // the texture step builds on the shape
    const saved = files();
    expect(saved.some((f) => /^sword-.*-model\.glb$/.test(f))).toBe(true);
    expect(saved.some((f) => /^sword-.*-preview\.png$/.test(f))).toBe(true);
    expect(ledger.used).toBe(15); // 5 + 10, no real figure reported so the estimates stand
    expect(out.text).toMatch(/Done\. Saved: assets\/meshy\/sword-/);
  });
  it('settles to the real credits Meshy reports instead of the estimate', async () => {
    workingMeshy({ consumed: 4 });
    const { d, ledger } = deps(client());
    await gen({ kind: 'text_to_3d', prompt: 'a lamp', quality: 'draft', texture: false }, d).run();
    expect(ledger.used).toBe(4); // estimate 5 reserved, then 4 reported
    expect(ledger.log).toEqual([5, -1]);
  });
  it('a failed task is refunded in the counter and the agent gets Meshy\'s reason', async () => {
    workingMeshy({ failFirst: true });
    const { d, ledger } = deps(client());
    await expect(gen({ kind: 'text_to_3d', prompt: 'x', quality: 'standard', texture: false }, d).run()).rejects.toThrow(/could not finish this task: bad prompt/);
    expect(ledger.used).toBe(0);
    expect(files()).toEqual([]);
  });
  it('Stop ends the wait, keeps the reserved credits (Meshy may still charge) and saves nothing', async () => {
    workingMeshy({ slow: true });
    const { d, ledger } = deps(client());
    const ctrl = new AbortController();
    const run = gen({ kind: 'text_to_3d', prompt: 'x', quality: 'draft', texture: false }, d).run(ctrl.signal);
    setTimeout(() => ctrl.abort(), 30);
    await expect(run).rejects.toThrow(/Stopped/);
    expect(ledger.used).toBe(5);
    expect(files()).toEqual([]);
  });
  it('a task that takes too long returns its id so meshy_fetch can finish the job later', async () => {
    workingMeshy({ slow: true });
    const { d } = deps(client(), { timeoutMs: 20 });
    const out = await gen({ kind: 'text_to_3d', prompt: 'x', quality: 'draft', texture: false }, d).run();
    expect(out.text).toMatch(/Task id\(s\): task_1_abcdef/);
    expect(out.text).toMatch(/meshy_fetch/);
  });
  it('re-checks the cap at the moment it runs', async () => {
    const created = workingMeshy();
    const { d, ledger } = deps(client(), { used: 0, cap: 100 });
    const p = gen({ kind: 'text_to_3d', prompt: 'x', quality: 'standard', texture: false }, d);
    ledger.used = 90; // other work used the credits while the user was deciding
    const out = await p.run();
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/Not started/);
    expect(created).toHaveLength(0);
  });
  it('text to image saves the pictures, with the aspect ratio and background options', async () => {
    const created = workingMeshy();
    const { d } = deps(client());
    const out = await gen({ kind: 'text_to_image', prompt: 'a banner', aspect_ratio: '16:9', remove_background: true, name: 'banner' }, d).run();
    expect(created[0].body).toMatchObject({ ai_model: 'nano-banana-2-lite', prompt: 'a banner', aspect_ratio: '16:9', remove_background: true });
    expect(files().some((f) => /^banner-.*-image\.png$/.test(f))).toBe(true);
    expect(out.text).toMatch(/Done/);
  });
  it('rejects a downloaded file that is not really a GLB', async () => {
    let n = 0;
    handler = (r) => (r.method === 'POST' ? { status: 202, body: { result: `task_${++n}_abcdef` } } : ok({ model_urls: { glb: `${base}/files/not-a-model.png` } }));
    const { d } = deps(client());
    await expect(gen({ kind: 'text_to_3d', prompt: 'x', texture: false }, d).run()).rejects.toThrow(/not a valid GLB/);
    expect(files()).toEqual([]);
  });
  it('never overwrites an earlier result', async () => {
    workingMeshy();
    const { d } = deps(client());
    const input = { kind: 'text_to_3d', prompt: 'x', texture: false, name: 'same' };
    await gen(input, d).run();
    await gen(input, d).run();
    expect(files().filter((f) => f.endsWith('.glb'))).toHaveLength(2);
  });
});

describe('meshy_generate: image to 3D reads a project image', () => {
  const writePng = (name: string) => { fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); fs.writeFileSync(path.join(dir, name), PNG); };

  it('sends the project image as a data URI, and says on the card that the file is sent', async () => {
    writePng('refs/guard.png');
    const created = workingMeshy();
    const { d } = deps(client());
    const p = gen({ kind: 'image_to_3d', image_path: 'refs/guard.png', quality: 'draft', texture: true }, d);
    expect(p.action.preview).toMatch(/Input image: refs\/guard\.png \(\d+ KB\)\. This file is sent to Meshy\./);
    await p.run();
    expect(created[0].body.image_url).toBe(`data:image/png;base64,${PNG.toString('base64')}`);
    expect(created[0].body).toMatchObject({ ai_model: 'meshy-6-lite', should_texture: true });
    expect(files().some((f) => /^guard-.*-model\.glb$/.test(f))).toBe(true);
  });
  it('refuses if the image changed while the user was deciding', async () => {
    writePng('a.png');
    const created = workingMeshy();
    const { d } = deps(client());
    const p = gen({ kind: 'image_to_3d', image_path: 'a.png' }, d);
    fs.writeFileSync(path.join(dir, 'a.png'), Buffer.concat([PNG, Buffer.from('x')]));
    await expect(p.run()).rejects.toThrow(/changed after this request/);
    expect(created).toHaveLength(0);
  });
  it('refuses files that are not real images, are secrets, or are outside the project', () => {
    const { d } = deps(client());
    fs.writeFileSync(path.join(dir, 'fake.png'), 'this is text');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'hi');
    fs.writeFileSync(path.join(dir, '.env'), 'KEY=1');
    const bad = (p: string) => { const r = prepareMeshyTool(dir, 'meshy_generate', { kind: 'image_to_3d', image_path: p }, d); return 'error' in r ? r.error : 'accepted'; };
    expect(bad('fake.png')).toMatch(/does not contain a real/);
    expect(bad('notes.txt')).toMatch(/not a PNG, JPG or WebP/);
    expect(bad('.env')).toMatch(/off limits|not a PNG/);
    expect(bad('../outside.png')).toMatch(/outside the project/);
    expect(bad('missing.png')).not.toBe('accepted');
  });
});

describe('meshy_fetch and meshy_balance', () => {
  it('fetch downloads a finished task for free, and reports one that is still running', async () => {
    workingMeshy();
    const { d, ledger } = deps(client());
    const f = prepareMeshyTool(dir, 'meshy_fetch', { kind: 'text_to_3d', task_id: 'task_abcdef12', name: 'late' }, d);
    expect('needsApproval' in f && f.needsApproval).toBe(false);
    if (!('run' in f)) throw new Error('no run');
    expect((await f.run()).text).toMatch(/Saved: assets\/meshy\/late-/);
    expect(ledger.used).toBe(0);
    workingMeshy({ slow: true });
    const g = prepareMeshyTool(dir, 'meshy_fetch', { kind: 'text_to_3d', task_id: 'task_abcdef12' }, d);
    if (!('run' in g)) throw new Error('no run');
    expect((await g.run()).text).toMatch(/IN_PROGRESS \(10%\)/);
  });
  it('fetch rejects a bad task id before any network call', () => {
    const { d } = deps(client());
    const r = prepareMeshyTool(dir, 'meshy_fetch', { kind: 'text_to_3d', task_id: '../x' }, d);
    expect('error' in r && r.error).toMatch(/not a valid Meshy task id/);
    expect(seen).toHaveLength(0);
  });
  it('balance reports credits and today\'s use against the cap', async () => {
    workingMeshy();
    const { d } = deps(client(), { used: 12, cap: 100 });
    const b = prepareMeshyTool(dir, 'meshy_balance', {}, d);
    if (!('run' in b)) throw new Error('no run');
    const out = await b.run();
    expect(out.text).toContain('Meshy credits left: 400');
    expect(out.text).toContain('Used today by the council: 12 of the daily cap of 100');
  });
});

describe('Mock mode client', () => {
  it('makes placeholder files for free and counts no credits', async () => {
    const mock = new MockMeshyClient();
    const { d, ledger } = deps(mock);
    const out = await gen({ kind: 'text_to_3d', prompt: 'a chair', quality: 'standard', texture: true, name: 'chair' }, d).run();
    expect(out.text).toMatch(/Done/);
    expect(files().some((f) => f.endsWith('-model.glb'))).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'assets/meshy', files().find((f) => f.endsWith('.glb'))!)).subarray(0, 4).toString()).toBe('glTF');
    expect(ledger.log).toEqual([]);
    expect(mock.created.map((c) => (c.body as any).mode)).toEqual(['preview', 'refine']);
  });
  it('is not stopped by the cap, because nothing is billed', () => {
    const { d } = deps(new MockMeshyClient(), { used: 100, cap: 100 });
    expect(() => gen({ kind: 'text_to_3d', prompt: 'x', quality: 'standard' }, d)).not.toThrow();
  });
});

// ---------- inside the orchestrator ----------
describe('agents and the Meshy tools', () => {
  const chan = (s: Store, kind: string) => s.channels().find((c) => c.kind === kind && c.categoryId === 'cat_1')!;
  const toolNames = (p: MockProvider) => p.stepCalls[0]?.tools.map((t) => t.name) ?? [];
  const setup = (opts: { ability?: boolean; client?: MeshyClient | null; project?: boolean; script?: MockStepScript } = {}) => {
    const store = new Store();
    if (opts.project !== false) store.setProjectPath('cat_1', dir);
    if (opts.ability === false) store.updateAgent('art', { abilities: [] }); // Iris has it by default
    const provider = new MockProvider(undefined, opts.script);
    const orch = new Orchestrator(store, { getProvider: () => provider, vaultDigest: () => '', meshy: () => (opts.client === undefined ? new MockMeshyClient() : opts.client) });
    return { store, provider, orch };
  };

  it('Iris has the ability by default, and nobody else does', () => {
    const s = new Store();
    expect(s.agent('art')!.abilities).toEqual(['meshy']);
    expect(s.snapshot().agents.filter((a) => a.abilities?.length).map((a) => a.id)).toEqual(['art']);
    expect(s.agent('ux-a')!.abilities).toBeUndefined();
    expect(s.agent('ux-b')!.abilities).toBeUndefined();
  });
  it('offers the three tools only to an agent with the ability, a project folder and a set-up client', async () => {
    const yes = setup();
    await yes.orch.handleUserMessage(chan(yes.store, 'art').id, '@Iris hello');
    expect(toolNames(yes.provider)).toEqual(expect.arrayContaining(MESHY_TOOLS.map((t) => t.name)));
    expect(yes.provider.stepCalls[0]!.system).toMatch(/A CHARACTER is made by the user's Blender character skill/);
    expect(yes.provider.stepCalls[0]!.system).toContain('assets/requests/');

    for (const [label, opts] of [['no ability', { ability: false }], ['no key (client null)', { client: null }]] as const) {
      const s = setup(opts);
      await s.orch.handleUserMessage(chan(s.store, 'art').id, '@Iris hello');
      expect(toolNames(s.provider).some((n) => n.startsWith('meshy_')), label).toBe(false);
      expect(s.provider.stepCalls[0]!.system, label).not.toMatch(/make art with Meshy/);
    }
    const noProject = setup({ project: false });
    await noProject.orch.handleUserMessage(chan(noProject.store, 'art').id, '@Iris hello');
    expect(noProject.provider.stepCalls).toHaveLength(0); // talk-only: no tools at all
    // Another agent in the same project does not get them.
    const other = setup();
    await other.orch.handleUserMessage(chan(other.store, 'programming').id, '@Hex hello');
    expect(toolNames(other.provider).some((n) => n.startsWith('meshy_'))).toBe(false);
  });

  it('an agent that calls a Meshy tool it was not given is told it is not available', async () => {
    const script: MockStepScript = (_req, n): StepResult | undefined => n === 1
      ? { content: [{ type: 'tool_use', id: 't1', name: 'meshy_generate', input: { kind: 'text_to_image', prompt: 'x' } }], stopReason: 'tool_use', inTokens: 5, outTokens: 5 }
      : undefined;
    const s = setup({ ability: false, script });
    await s.orch.handleUserMessage(chan(s.store, 'programming').id, '@Hex make art');
    expect(s.store.snapshot().notifications.some((n) => n.action?.tool === 'meshy_generate')).toBe(false);
    expect(files()).toEqual([]);
  });

  it('end to end: Iris asks, Widow audits, the user approves, the file lands in the project and the agent continues', async () => {
    const script: MockStepScript = (_req, n): StepResult | undefined => n === 1
      ? { content: [{ type: 'tool_use', id: 't1', name: 'meshy_generate', input: { kind: 'text_to_3d', prompt: 'a wooden barrel', quality: 'draft', name: 'barrel' } }], stopReason: 'tool_use', inTokens: 5, outTokens: 5 }
      : undefined;
    const s = setup({ script });
    const ch = chan(s.store, 'art');
    const run = s.orch.handleUserMessage(ch.id, '@Iris make a barrel');
    const until = async (c: () => boolean) => { const t = Date.now(); while (!c()) { if (Date.now() - t > 3000) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 5)); } };
    await until(() => s.store.snapshot().notifications.some((n) => n.status === 'awaiting-user' && n.action?.tool === 'meshy_generate'));
    const n = s.store.snapshot().notifications.find((x) => x.action?.tool === 'meshy_generate')!;
    expect(n.action!.preview).toContain('Prompt: a wooden barrel');
    expect(n.auditNote).toBeTruthy(); // Widow audited first
    expect(files()).toEqual([]);       // nothing saved before the user decides
    s.orch.resolveNotification(n.id, true);
    await run;
    expect(files().some((f) => /^barrel-.*-model\.glb$/.test(f))).toBe(true);
    expect(s.store.meshyCreditsToday()).toBe(0); // Mock mode bills nothing
  });

  it('a "no" from the user means nothing is generated or saved', async () => {
    const script: MockStepScript = (_req, n): StepResult | undefined => n === 1
      ? { content: [{ type: 'tool_use', id: 't1', name: 'meshy_generate', input: { kind: 'text_to_image', prompt: 'a banner' } }], stopReason: 'tool_use', inTokens: 5, outTokens: 5 }
      : undefined;
    const client = new MockMeshyClient();
    const s = setup({ script, client });
    const run = s.orch.handleUserMessage(chan(s.store, 'art').id, '@Iris make a banner');
    const until = async (c: () => boolean) => { const t = Date.now(); while (!c()) { if (Date.now() - t > 3000) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 5)); } };
    await until(() => s.store.snapshot().notifications.some((n) => n.status === 'awaiting-user' && n.action));
    s.orch.resolveNotification(s.store.snapshot().notifications.find((n) => n.action)!.id, false);
    await run;
    expect(client.created).toHaveLength(0);
    expect(files()).toEqual([]);
  });
});

describe('store: Meshy ability and credits', () => {
  it('validates abilities and keeps them off agents that were not given them', () => {
    const s = new Store();
    s.updateAgent('ux-a', { abilities: ['meshy'] });
    expect(s.agent('ux-a')!.abilities).toEqual(['meshy']);
    expect(() => s.updateAgent('ux-a', { abilities: ['root'] })).toThrow(/Unknown ability/);
    s.updateAgent('ux-a', { abilities: [] });
    expect(s.agent('ux-a')!.abilities).toBeUndefined();
  });
  it('counts credits, never goes below zero, ignores junk, and takes the cap from settings', () => {
    const s = new Store();
    s.addMeshyCredits(10); s.addMeshyCredits(-3);
    expect(s.meshyCreditsToday()).toBe(7);
    s.addMeshyCredits(-100);
    expect(s.meshyCreditsToday()).toBe(0);
    s.addMeshyCredits(NaN);
    expect(s.meshyCreditsToday()).toBe(0);
    s.updateSettings({ meshyDailyCredits: 250 });
    expect(s.settings.meshyDailyCredits).toBe(250);
    s.updateSettings({ meshyDailyCredits: -5 });
    expect(s.settings.meshyDailyCredits).toBe(0);
  });
  it('gives Iris the ability once on an older database, and a later removal sticks', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-old2-'));
    try {
      const file = path.join(d, 'council.json');
      new Store(file).flush();
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      raw.provisioned = raw.provisioned.filter((x: string) => x !== 'ability:meshy-art');
      for (const a of raw.agents) delete a.abilities;
      delete raw.settings.meshyDailyCredits; delete raw.settings.hasMeshyKey;
      fs.writeFileSync(file, JSON.stringify(raw));
      const s = new Store(file);
      expect(s.agent('art')!.abilities).toEqual(['meshy']);
      expect(s.agent('ux-a')!.abilities).toBeUndefined();
      expect(s.settings.meshyDailyCredits).toBe(100);
      s.updateAgent('art', { abilities: [] });
      s.flush();
      expect(new Store(file).agent('art')!.abilities).toBeUndefined(); // removed on purpose: stays removed
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });
});

// ---------- fixes from the independent review ----------
describe('credit reservation (review fixes)', () => {
  it('two approved requests running at once cannot both spend the same remaining credits', async () => {
    workingMeshy();
    const { d, ledger } = deps(client(), { used: 10, cap: 100 });
    const a = gen({ kind: 'text_to_3d', prompt: 'a', quality: 'standard', texture: true }, d); // 30 each
    const b = gen({ kind: 'text_to_3d', prompt: 'b', quality: 'standard', texture: true }, d);
    const c = gen({ kind: 'text_to_3d', prompt: 'c', quality: 'standard', texture: true }, d);
    const d4 = gen({ kind: 'text_to_3d', prompt: 'd', quality: 'standard', texture: true }, d);
    const outs = await Promise.all([a.run(), b.run(), c.run(), d4.run()]);
    expect(outs.filter((o) => !o.isError)).toHaveLength(3); // 10 + 3 x 30 = 100, the fourth does not fit
    expect(outs.filter((o) => /Not started/.test(o.text))).toHaveLength(1);
    expect(ledger.used).toBeLessThanOrEqual(100);
  });
  it('the texture step is reserved with the shape, so nothing can slip in between the two', async () => {
    const created = workingMeshy({ slow: true });
    const { d, ledger } = deps(client(), { cap: 100, timeoutMs: 40 });
    const out = await gen({ kind: 'text_to_3d', prompt: 'x', quality: 'standard', texture: true }, d).run();
    expect(created).toHaveLength(1); // still waiting on the shape
    expect(ledger.used).toBe(20); // the unstarted 10-credit texture step was given back, the started shape stays
    expect(out.text).toMatch(/Task id/);
  });
  it('reserves BEFORE the request is sent, and keeps it if the connection drops (Meshy may have started it)', async () => {
    const { d, ledger } = deps(new HttpMeshyClient('k', { baseUrl: 'http://127.0.0.1:1', retryDelayMs: 1 }));
    await expect(gen({ kind: 'text_to_3d', prompt: 'x', quality: 'draft', texture: false }, d).run()).rejects.toThrow(/Could not reach Meshy/);
    expect(ledger.used).toBe(5);
  });
  it('gives the credits back when Meshy clearly refuses to start the task', async () => {
    handler = () => ({ status: 402, body: { message: 'no credits' } });
    const { d, ledger } = deps(client());
    await expect(gen({ kind: 'text_to_3d', prompt: 'x', quality: 'standard', texture: true }, d).run()).rejects.toThrow(/not enough credits/);
    expect(ledger.used).toBe(0);
  });
  it('treats a finished task that reports 0 credits as an unknown figure and keeps the estimate', async () => {
    workingMeshy({ consumed: 0 });
    const { d, ledger } = deps(client());
    await gen({ kind: 'text_to_3d', prompt: 'x', quality: 'draft', texture: false }, d).run();
    expect(ledger.used).toBe(5);
  });
  it('does not start if Meshy stopped being available while the request waited for approval', async () => {
    const created = workingMeshy();
    const { d, ledger } = deps(client());
    let available = true;
    const p = gen({ kind: 'text_to_3d', prompt: 'x', quality: 'draft' }, { ...d, stillAvailable: () => available } as typeof d);
    available = false;
    const out = await p.run();
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/no longer set up/);
    expect(created).toHaveLength(0);
    expect(ledger.used).toBe(0);
  });
});

describe('failures after payment keep what was paid for (review fixes)', () => {
  it('a failed download names the task ids and says to use meshy_fetch, not to generate again', async () => {
    let n = 0;
    handler = (r) => (r.method === 'POST' ? { status: 202, body: { result: `task_${++n}_abcdef` } } : ok({ model_urls: { glb: `${base}/files/not-a-model.png` } }));
    const { d } = deps(client());
    const err = await gen({ kind: 'text_to_3d', prompt: 'x', texture: false }, d).run().catch((e): any => e);
    expect(err.message).toMatch(/not a valid GLB/);
    expect(err.message).toMatch(/Task id\(s\): task_1_abcdef/);
    expect(err.message).toMatch(/meshy_fetch/);
  });
  it('a failure in the texture step still reports the paid shape task and keeps the unknown step reserved', async () => {
    let n = 0;
    handler = (r) => {
      if (r.method === 'POST') return r.body.mode === 'refine' ? { status: 500, body: { message: 'boom' } } : { status: 202, body: { result: `task_${++n}_abcdef` } };
      return ok({ model_urls: { glb: `${base}/files/m.glb` } });
    };
    const { d, ledger } = deps(client());
    const err = await gen({ kind: 'text_to_3d', prompt: 'x', quality: 'draft', texture: true }, d).run().catch((e): any => e);
    expect(err.message).toMatch(/Task id\(s\) already started: task_1_abcdef/);
    expect(ledger.used).toBe(15); // shape settled at 5; after a 500 the refine's outcome is unknown, so its 10 stays counted
  });
  it('a bad preview picture does not undo a saved model', async () => {
    let n = 0;
    handler = (r) => (r.method === 'POST' ? { status: 202, body: { result: `task_${++n}_abcdef` } }
      : ok({ model_urls: { glb: `${base}/files/m.glb` }, thumbnail_url: `${base}/files/t.glb` })); // the fake serves a GLB here, which is not a PNG
    const { d } = deps(client());
    const out = await gen({ kind: 'text_to_3d', prompt: 'x', texture: false, name: 'keep' }, d).run();
    expect(files().some((f) => /^keep-.*-model\.glb$/.test(f))).toBe(true);
    expect(files().some((f) => f.endsWith('.png'))).toBe(false);
    expect(out.isError).toBeFalsy();
    expect(out.text).toMatch(/not saved: preview/);
  });
  it('refuses a downloaded "image" whose bytes are not an image', async () => {
    let n = 0;
    handler = (r) => (r.method === 'POST' ? { status: 202, body: { result: `task_${++n}_abcdef` } } : ok({ image_urls: [`${base}/files/x.glb`] }));
    const { d } = deps(client());
    await expect(gen({ kind: 'text_to_image', prompt: 'x' }, d).run()).rejects.toThrow(/Task id/);
    expect(files()).toEqual([]);
  });
});

describe('download safety (review fixes)', () => {
  it('only accepts https on meshy.ai hosts', () => {
    expect(() => safeDownloadUrl('https://assets.meshy.ai/x/model.glb?Expires=1')).not.toThrow();
    for (const bad of ['https://evil.example.com/a.glb', 'https://meshy.ai.evil.com/a', 'https://notmeshy.ai/a', 'https://[::ffff:7f00:1]/a', 'https://100.64.0.1/a']) {
      expect(() => safeDownloadUrl(bad), bad).toThrow(/not allowed/);
    }
  });
  it('follows a redirect by hand and refuses one that leaves the allowed hosts', async () => {
    const hops: string[] = [];
    const f = (async (u: any) => {
      hops.push(String(u));
      if (String(u).includes('first')) return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } });
      return new Response(Buffer.from('glTFxxxx'), { status: 200 });
    }) as unknown as typeof fetch;
    await expect(new HttpMeshyClient('k', { fetchImpl: f }).download('https://assets.meshy.ai/first.glb', 1000)).rejects.toThrow(/not allowed/);
    expect(hops).toEqual(['https://assets.meshy.ai/first.glb']); // the second address was never contacted
  });
  it('gives up on a redirect loop', async () => {
    const f = (async () => new Response(null, { status: 302, headers: { location: 'https://assets.meshy.ai/again.glb' } })) as unknown as typeof fetch;
    await expect(new HttpMeshyClient('k', { fetchImpl: f }).download('https://assets.meshy.ai/a.glb', 1000)).rejects.toThrow(/redirected too many times/);
  });
  it('applies a time limit even when the caller passes a signal', async () => {
    let received: AbortSignal | undefined;
    const f = (async (_u: any, init: any) => { received = init.signal; return new Response(Buffer.from('glTF'), { status: 200 }); }) as unknown as typeof fetch;
    const ctrl = new AbortController();
    await new HttpMeshyClient('k', { fetchImpl: f }).download('https://assets.meshy.ai/a.glb', 1000, ctrl.signal);
    expect(received).toBeDefined();
    expect(received).not.toBe(ctrl.signal); // combined with a timeout, not the bare turn signal
  });
});
