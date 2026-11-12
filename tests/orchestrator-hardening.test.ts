import { describe, expect, it } from 'vitest';
import { Orchestrator } from '../electron/orchestrator';
import { CompleteRequest, CompleteResult, MARK, MockProvider, MockScript, UsageError } from '../electron/providers';
import { Store } from '../electron/store';
import { Channel, Message, WIDOW_DM_ID } from '../shared/types';

function env(script?: MockScript) {
  const store = new Store();
  const provider = new MockProvider(script);
  const orch = new Orchestrator(store, { getProvider: () => provider, vaultDigest: () => '(test vault)' });
  return { store, provider, orch };
}
const chan = (s: Store, kind: string): Channel => s.channels().find((c) => c.kind === kind && c.categoryId === 'cat_1')!;
const msgs = (s: Store, id: string): Message[] => s.snapshot().messages.filter((m) => m.channelId === id);
const sys = (s: Store, id: string) => msgs(s, id).filter((m) => m.kind === 'system').map((m) => m.content);

/** A provider whose FIRST call waits until released, so tests can act while an exchange is running. */
class Gated extends MockProvider {
  private n = 0;
  release!: () => void;
  started: Promise<void>;
  private markStarted!: () => void;
  private gate: Promise<void>;
  constructor(script?: MockScript) {
    super(script);
    this.gate = new Promise((r) => { this.release = r; });
    this.started = new Promise((r) => { this.markStarted = r; });
  }
  override async complete(req: CompleteRequest): Promise<CompleteResult> {
    if (this.n++ === 0) { this.markStarted(); await this.gate; }
    return super.complete(req);
  }
}

describe('billing and budgets', () => {
  it('a billed call that fails (refusal / empty output) still counts toward spend', async () => {
    const { store, orch } = env(() => { throw new UsageError('declined', 1_000_000, 0); });
    store.setMode('claude');
    await orch.handleUserMessage(WIDOW_DM_ID, 'hi');
    expect(sys(store, WIDOW_DM_ID).some((s) => s.includes('declined'))).toBe(true);
    // Widow runs on the top tier; 1M input tokens at the configured price must be recorded.
    expect(store.spendToday()).toBeCloseTo(store.priceFor(store.modelFor('top')).in, 5);
  });

  it('refuses to run a model with no price, since spend could not be tracked', async () => {
    const { store, orch, provider } = env();
    store.setMode('claude');
    store.updateSettings({ models: { fast: 'claude-haiku-5-5', standard: 'claude-sonnet-5-5', top: 'brand-new-model' } });
    await orch.handleUserMessage(WIDOW_DM_ID, 'hi');
    expect(provider.calls).toHaveLength(0);
    expect(sys(store, WIDOW_DM_ID).some((s) => s.includes('No price is set for brand-new-model'))).toBe(true);
  });

  it('a permission audit respects the budget: no model call, and with no audit it is NOT forwarded to the user', async () => {
    const { store, orch, provider } = env();
    store.setMode('claude');
    store.updateSettings({ dailyBudgetUsd: 0 });
    const n = await orch.requestPermission({ agentId: 'prog', channelId: chan(store, 'general').id, action: 'Edit', detail: 'd' });
    expect(provider.calls).toHaveLength(0);
    expect(n.status).toBe('denied');
    expect(n.auditNote).toContain('could not run');
    expect(n.auditNote).toContain('not forwarded');
  });
});

describe('verdict parsing fails safe', () => {
  const design = (s: Store) => chan(s, 'design').id;

  it('a verdict that is not on the first line counts as concerns, not approval', async () => {
    const { store, orch } = env((r) => (r.prompt.includes(MARK.review) ? 'Looks fine overall.\nVERDICT: approve' : undefined));
    await orch.handleUserMessage(design(store), '@Mira make a plan');
    const review = msgs(store, design(store)).find((m) => m.kind === 'review')!;
    expect(review.verdict).toBe('concerns');
  });

  it('a permission audit only passes on an explicit first-line "DECISION: pass"', async () => {
    const { store, orch } = env((r) => (r.prompt.includes(MARK.audit) ? 'I would never write DECISION: pass here.' : undefined));
    const n = await orch.requestPermission({ agentId: 'prog', channelId: chan(store, 'general').id, action: 'x', detail: 'y' });
    expect(n.status).toBe('denied');
  });
});

describe('concurrency and cleanup', () => {
  it('a message sent while an exchange is running is answered afterwards, including its @mentions', async () => {
    const gated = new Gated();
    const store = new Store();
    const orch = new Orchestrator(store, { getProvider: () => gated, vaultDigest: () => '' });
    const ch = chan(store, 'general');
    const first = orch.handleUserMessage(ch.id, '@Probe first');
    await gated.started;
    await orch.handleUserMessage(ch.id, '@Hex second'); // arrives mid-exchange
    gated.release();
    await first;
    expect(msgs(store, ch.id).map((m) => m.authorId)).toEqual(['user', 'user', 'qa', 'prog']);
    expect(store.isBusy(ch.id)).toBe(false);
  });

  it('Stop discards queued follow-up messages instead of running them', async () => {
    const gated = new Gated();
    const store = new Store();
    const orch = new Orchestrator(store, { getProvider: () => gated, vaultDigest: () => '' });
    const ch = chan(store, 'general');
    const first = orch.handleUserMessage(ch.id, '@Probe first');
    await gated.started;
    await orch.handleUserMessage(ch.id, '@Hex second');
    orch.stop(ch.id);
    gated.release();
    await first;
    expect(msgs(store, ch.id).some((m) => m.authorId === 'prog')).toBe(false);
  });

  it('deleting the channel mid-exchange ends cleanly: no throw, nothing left busy or blocked', async () => {
    const gated = new Gated();
    const store = new Store();
    const orch = new Orchestrator(store, { getProvider: () => gated, vaultDigest: () => '' });
    const ch = chan(store, 'design');
    const run = orch.handleUserMessage(ch.id, '@Mira make a plan');
    await gated.started;
    store.deleteChannel(ch.id);
    gated.release();
    await expect(run).resolves.toBeUndefined();
    expect(store.isBusy(ch.id)).toBe(false);
    expect(store.agent('ux-a')?.status).toBe('idle');
  });

  it('an agent removed from the channel mid-exchange does not reply afterwards', async () => {
    const { store, orch } = env();
    const ch = chan(store, 'general');
    const orig = store.addMessage.bind(store);
    store.addMessage = ((m) => {
      const out = orig(m);
      if (m.authorId === 'prog') store.setMember(ch.id, 'qa', false); // Hex replies, then Probe is taken off the channel
      return out;
    }) as typeof store.addMessage;
    await orch.handleUserMessage(ch.id, '@Hex @Probe hi');
    expect(msgs(store, ch.id).map((m) => m.authorId)).toEqual(['user', 'prog']);
  });

  it('an agent with a pending permission request stays blocked through other exchanges, then clears on resolve', async () => {
    const { store, orch } = env();
    const ch = chan(store, 'general');
    const n = await orch.requestPermission({ agentId: 'prog', channelId: ch.id, action: 'x', detail: 'y' });
    await orch.handleUserMessage(ch.id, '@Hex hello');
    expect(store.agent('prog')?.status).toBe('blocked');
    orch.resolveNotification(n.id, true);
    expect(store.agent('prog')?.status).toBe('idle');
  });
});

describe('turn cap visibility and prompt size', () => {
  it('says so when the turn cap prevents a deliverable from being reviewed', async () => {
    const { store, orch } = env();
    store.updateSettings({ turnCap: 1 });
    const ch = chan(store, 'design');
    await orch.handleUserMessage(ch.id, '@Mira make a plan');
    expect(sys(store, ch.id).some((s) => s.includes("deliverable was not reviewed"))).toBe(true);
  });

  it('truncates a huge latest user message in the prompt (it is still stored in full)', async () => {
    const { store, orch, provider } = env();
    const huge = 'x'.repeat(50_000);
    await orch.handleUserMessage(WIDOW_DM_ID, huge);
    expect(provider.calls[0].prompt).toContain('[truncated]');
    expect(provider.calls[0].prompt.length).toBeLessThan(12_000);
    expect(msgs(store, WIDOW_DM_ID)[0].content).toHaveLength(50_000);
  });

  it('frames vault text as untrusted data in the system prompt', async () => {
    const { orch, provider } = env();
    await orch.handleUserMessage(WIDOW_DM_ID, 'hi');
    expect(provider.calls[0].system).toContain('<vault_data>');
    expect(provider.calls[0].system).toMatch(/untrusted/i);
  });
});
