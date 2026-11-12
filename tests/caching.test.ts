import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { Orchestrator } from '../electron/orchestrator';
import { CompleteRequest, CompleteResult, MARK, MockProvider, Provider } from '../electron/providers';
import { Store } from '../electron/store';
import { Channel } from '../shared/types';

const general = (s: Store): Channel => s.channels().find((c) => c.categoryId === 'cat_1' && c.kind === 'general')!;

describe('system prompt layout for caching', () => {
  it('shares one identical prefix across agents and keeps the persona after it', async () => {
    const store = new Store();
    const provider = new MockProvider();
    const orch = new Orchestrator(store, { getProvider: () => provider, vaultDigest: () => '(vault)' });
    await orch.handleUserMessage(general(store).id, '@Hex hi');
    await orch.handleUserMessage(general(store).id, '@Sentinel hi');
    const calls = provider.calls.filter((c) => !c.prompt.includes(MARK.route) && !c.prompt.includes(MARK.scribe));
    const hex = calls.find((c) => c.system.includes('You are Hex,'))!;
    const sen = calls.find((c) => c.system.includes('You are Sentinel,'))!;
    expect(hex.cachePrefix).toBeGreaterThan(200);
    expect(hex.cachePrefix).toBe(sen.cachePrefix);
    expect(hex.system.slice(0, hex.cachePrefix)).toBe(sen.system.slice(0, sen.cachePrefix));
    expect(hex.system.slice(hex.cachePrefix!)).toContain('You are Hex,');
    expect(hex.system.slice(0, hex.cachePrefix)).not.toContain('Hex');
    expect(hex.system).not.toContain('\u0001'); // the boundary marker never reaches the provider
  });

  it('asks for short, human replies and cuts needless back-and-forth', async () => {
    const store = new Store();
    const provider = new MockProvider();
    const orch = new Orchestrator(store, { getProvider: () => provider, vaultDigest: () => '(vault)' });
    await orch.handleUserMessage(general(store).id, '@Hex hi');
    const sys = provider.calls.find((c) => c.system.includes('You are Hex,'))!;
    expect(sys.system).toMatch(/one to three short sentences/);
    expect(sys.system).toMatch(/Do not @mention a teammate just to agree/);
    expect(sys.maxTokens).toBeLessThanOrEqual(1500);
  });

  it('starts new installs at 12 replies per message', () => {
    expect(new Store().settings.turnCap).toBe(12);
  });
});

describe('billing with cached input', () => {
  const run = async (cache?: { read: number; write5m: number; write1h: number }) => {
    const store = new Store();
    store.mode = 'claude';
    const provider: Provider = {
      async complete(_r: CompleteRequest): Promise<CompleteResult> {
        return { text: '[mock] ok', inTokens: 10_000, outTokens: 100, cache };
      },
    };
    const orch = new Orchestrator(store, { getProvider: () => provider, vaultDigest: () => '(vault)' });
    await orch.handleUserMessage(general(store).id, '@Hex hi');
    return store.snapshot().spend.usd;
  };

  it('charges reads at a fraction and writes at a premium, not everything at the full input price', async () => {
    const plain = await run();
    const cached = await run({ read: 8000, write5m: 0, write1h: 1000 });
    // The standard tier model is $2 in / $10 out per million. Cached: 1000 fresh + 8000 x 0.05 + 1000 x 2 = 3400 input-equivalents.
    expect(plain).toBeCloseTo((10_000 / 1e6) * 2 + (100 / 1e6) * 10, 6);
    expect(cached).toBeCloseTo((3_400 / 1e6) * 2 + (100 / 1e6) * 10, 6);
    expect(cached).toBeLessThan(plain);
    const t = new Store();
    t.recordInput(1000, 8000, 1000);
    expect(t.snapshot().spend).toMatchObject({ inputFresh: 1000, cacheRead: 8000, cacheWrite: 1000 });
  });
});

describe('turn cap migration', () => {
  const load = (cap: number) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-cap-'));
    try {
      const file = path.join(dir, 'db.json');
      const a = new Store(file);
      a.updateSettings({ turnCap: cap });
      a.flush();
      return new Store(file).settings.turnCap;
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  };
  it('moves the old default of 8 to 12 and keeps any other value the user chose', () => {
    expect(load(8)).toBe(12);
    expect(load(5)).toBe(5);
    expect(load(20)).toBe(20);
  });
});

describe('shared prefix size', () => {
  it('is large enough to be worth caching (the models need at least 512 tokens, about 2000 characters)', async () => {
    const store = new Store();
    const provider = new MockProvider();
    const orch = new Orchestrator(store, { getProvider: () => provider, vaultDigest: () => '(vault)' });
    await orch.handleUserMessage(general(store).id, '@Hex hi');
    const c = provider.calls.find((x) => x.system.includes('You are Hex,'))!;
    expect(c.cachePrefix).toBeGreaterThan(0);
  });
});
