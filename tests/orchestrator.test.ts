import { describe, expect, it } from 'vitest';
import { Orchestrator, parseMentions } from '../electron/orchestrator';
import { CompleteRequest, CompleteResult, MARK, MockProvider, MockScript, Provider } from '../electron/providers';
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

describe('parseMentions', () => {
  const s = new Store();
  const members = s.agents();
  it('matches case-insensitively, in order of appearance', () => {
    expect(parseMentions(members, 'hey @probe and @HEX').map((a) => a.name)).toEqual(['Probe', 'Hex']);
  });
  it('respects name boundaries', () => {
    expect(parseMentions(members, '@Hexagon hi')).toHaveLength(0);
    expect(parseMentions(members, '@Hex, hi').map((a) => a.name)).toEqual(['Hex']);
  });
  it('can exclude an author', () => {
    expect(parseMentions(members, '@Hex @Probe', 'prog').map((a) => a.name)).toEqual(['Probe']);
  });
});

describe('routing', () => {
  it('Widow DM goes to Widow only, with no routing call', async () => {
    const { store, provider, orch } = env();
    await orch.handleUserMessage(WIDOW_DM_ID, 'hello');
    expect(msgs(store, WIDOW_DM_ID).map((m) => m.authorId)).toEqual(['user', 'widow']);
    expect(provider.calls).toHaveLength(1);
  });

  it('@mention skips routing and only that agent replies', async () => {
    const { store, provider, orch } = env();
    const ch = chan(store, 'research');
    await orch.handleUserMessage(ch.id, "@Orin what's the latest?");
    expect(msgs(store, ch.id).map((m) => m.authorId)).toEqual(['user', 'res-b']);
    expect(provider.calls.some((c) => c.prompt.includes(MARK.route))).toBe(false);
  });

  it('a single candidate answers without a routing call', async () => {
    const { store, provider, orch } = env();
    const ch = store.createChannel('cat_1', 'solo', 'custom', ['art']);
    await orch.handleUserMessage(ch.id, 'hi');
    expect(msgs(store, ch.id).map((m) => m.authorId)).toEqual(['user', 'art']);
    expect(provider.calls).toHaveLength(1);
  });

  it('with several candidates Widow routes using the cheap tier', async () => {
    const { store, provider, orch } = env();
    const ch = chan(store, 'design');
    await orch.handleUserMessage(ch.id, 'hello');
    expect(provider.calls[0].prompt).toContain(MARK.route);
    expect(provider.calls[0].model).toBe(store.modelFor('fast'));
    expect(msgs(store, ch.id).map((m) => m.authorId)).toEqual(['user', 'ux-a']);
  });

  it('follows the names Widow returns', async () => {
    const { store, orch } = env((r) => (r.prompt.includes(MARK.route) ? '["Kade"]' : undefined));
    const ch = chan(store, 'design');
    await orch.handleUserMessage(ch.id, 'hello');
    expect(msgs(store, ch.id)[1].authorId).toBe('ux-b');
  });

  it('falls back to the channel specialty when routing output is garbage or the call fails', async () => {
    const garbage = env((r) => (r.prompt.includes(MARK.route) ? 'no idea' : undefined));
    const c1 = chan(garbage.store, 'design');
    await garbage.orch.handleUserMessage(c1.id, 'hello');
    expect(msgs(garbage.store, c1.id)[1].authorId).toBe('ux-a');

    const failing = env((r) => { if (r.prompt.includes(MARK.route)) throw new Error('down'); return undefined; });
    const c2 = chan(failing.store, 'engineering');
    await failing.orch.handleUserMessage(c2.id, 'hello');
    expect(msgs(failing.store, c2.id)[1].authorId).toBe('eng-a');
  });

  it('agents can pull in teammates by @mention, but nobody is asked twice', async () => {
    const { store, orch } = env((r) => {
      if (/Reply as Hex /.test(r.prompt)) return 'Asking @Atlas to weigh in';
      if (/Reply as Atlas /.test(r.prompt)) return 'Back to @Hex, done';
      return undefined;
    });
    const ch = chan(store, 'general');
    await orch.handleUserMessage(ch.id, '@Hex hi');
    expect(msgs(store, ch.id).map((m) => m.authorId)).toEqual(['user', 'prog', 'eng-a']);
  });
});

describe('audit pairs', () => {
  it('a deliverable is reviewed by the partner and approved', async () => {
    const { store, orch } = env();
    const ch = chan(store, 'design');
    await orch.handleUserMessage(ch.id, '@Mira make a plan');
    const [, d, r] = msgs(store, ch.id);
    expect(d).toMatchObject({ authorId: 'ux-a', kind: 'deliverable' });
    expect(d.content.startsWith('DELIVERABLE')).toBe(false);
    expect(r).toMatchObject({ authorId: 'ux-b', kind: 'review', verdict: 'approve', reviewOf: d.id });
    expect(msgs(store, ch.id)).toHaveLength(3);
  });

  it('Widow reviews when the partner is not in the channel', async () => {
    const { store, orch } = env();
    const ch = store.createChannel('cat_1', 'solo', 'custom', ['prog']);
    await orch.handleUserMessage(ch.id, '@Hex write a plan');
    expect(msgs(store, ch.id).map((m) => m.authorId)).toEqual(['user', 'prog', 'widow']);
  });

  it("Widow's own deliverables are not audited", async () => {
    const { store, orch } = env();
    await orch.handleUserMessage(WIDOW_DM_ID, 'give me a plan');
    expect(msgs(store, WIDOW_DM_ID)).toHaveLength(2);
  });

  const concerns: MockScript = (r) => {
    const p = r.prompt;
    if (p.includes(MARK.review)) return 'VERDICT: concerns\nMissing error handling.';
    if (p.includes(MARK.decision)) return 'DECISION: revise\nFix it.';
    if (p.includes('sent back for revision')) return 'DELIVERABLE: v2 with handling';
    if (/Reply as Mira /.test(p)) return 'DELIVERABLE: v1';
    return undefined;
  };

  it('concerns -> Widow decides -> one revision -> second review -> unresolved goes to the user', async () => {
    const { store, orch } = env(concerns);
    const ch = chan(store, 'design');
    await orch.handleUserMessage(ch.id, '@Mira draft the layout');
    expect(msgs(store, ch.id).slice(1).map((m) => `${m.authorId}:${m.kind}`)).toEqual([
      'ux-a:deliverable', 'ux-b:review', 'widow:decision', 'ux-a:deliverable', 'ux-b:review', 'system:system',
    ]);
    const n = store.snapshot().notifications.find((x) => x.kind === 'disagreement');
    expect(n).toMatchObject({ status: 'awaiting-user', channelId: ch.id, agentId: 'ux-a' });
  });

  it('Widow can accept despite concerns, ending the cycle', async () => {
    const { store, orch } = env((r) => (r.prompt.includes(MARK.decision) ? 'DECISION: accept\nFine.' : concerns(r)));
    const ch = chan(store, 'design');
    await orch.handleUserMessage(ch.id, '@Mira draft the layout');
    expect(msgs(store, ch.id).slice(1).map((m) => m.kind)).toEqual(['deliverable', 'review', 'decision']);
    expect(store.snapshot().notifications).toHaveLength(0);
  });

  it('review/decision header lines are stripped from displayed text', async () => {
    const { store, orch } = env(concerns);
    const ch = chan(store, 'design');
    await orch.handleUserMessage(ch.id, '@Mira draft the layout');
    const review = msgs(store, ch.id).find((m) => m.kind === 'review')!;
    expect(review.content).toBe('Missing error handling.');
    expect(review.verdict).toBe('concerns');
  });
});

describe('safeguards', () => {
  it('stops at the turn cap and says so', async () => {
    const { store, orch } = env();
    store.updateSettings({ turnCap: 2 });
    const ch = chan(store, 'general');
    await orch.handleUserMessage(ch.id, '@Hex @Probe @Lyra @Orin hi');
    const agentReplies = msgs(store, ch.id).filter((m) => !['user', 'system'].includes(m.authorId));
    expect(agentReplies).toHaveLength(2);
    expect(sys(store, ch.id).some((s) => s.includes('Turn cap reached (2'))).toBe(true);
  });

  it('detects agents repeating each other and stops the exchange', async () => {
    const same = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet';
    const { store, orch } = env(() => same);
    const ch = chan(store, 'general');
    await orch.handleUserMessage(ch.id, '@Hex @Probe @Lyra go');
    const replies = msgs(store, ch.id).filter((m) => !['user', 'system'].includes(m.authorId));
    expect(replies.map((m) => m.authorId)).toEqual(['prog', 'qa']);
    expect(sys(store, ch.id).some((s) => s.includes('repeating'))).toBe(true);
  });

  it('blocks all model calls once the daily budget is spent, with one notification', async () => {
    const { store, provider, orch } = env();
    store.setMode('claude');
    store.updateSettings({ dailyBudgetUsd: 0 });
    await orch.handleUserMessage(WIDOW_DM_ID, 'hi');
    await orch.handleUserMessage(WIDOW_DM_ID, 'hi again');
    expect(provider.calls).toHaveLength(0);
    expect(sys(store, WIDOW_DM_ID).some((s) => s.includes('Daily budget reached'))).toBe(true);
    expect(store.snapshot().notifications.filter((n) => n.kind === 'budget')).toHaveLength(1);
  });

  it('records spend in claude mode and not in mock mode', async () => {
    const live = env();
    live.store.setMode('claude');
    await live.orch.handleUserMessage(WIDOW_DM_ID, 'hi');
    expect(live.store.spendToday()).toBeGreaterThan(0);

    const mock = env();
    await mock.orch.handleUserMessage(WIDOW_DM_ID, 'hi');
    expect(mock.store.spendToday()).toBe(0);
  });

  it('enforces the per-category budget but not on the Widow DM', async () => {
    const { store, orch, provider } = env();
    store.setMode('claude');
    store.updateSettings({ categoryBudgetUsd: 0 });
    const ch = chan(store, 'general');
    await orch.handleUserMessage(ch.id, '@Hex hi');
    expect(provider.calls).toHaveLength(0);
    await orch.handleUserMessage(WIDOW_DM_ID, 'hi');
    expect(provider.calls).toHaveLength(1);
  });

  it('a provider error becomes a message and never leaves the agent stuck "blocked"', async () => {
    let fail = true;
    const { store, orch } = env(() => { if (fail) throw new Error('boom'); return undefined; });
    await orch.handleUserMessage(WIDOW_DM_ID, 'hi');
    expect(sys(store, WIDOW_DM_ID).some((s) => s.includes("couldn't reply: boom"))).toBe(true);
    expect(store.agent('widow')?.status).toBe('idle');
    expect(store.isBusy(WIDOW_DM_ID)).toBe(false);
    fail = false;
    await orch.handleUserMessage(WIDOW_DM_ID, 'hi');
    expect(msgs(store, WIDOW_DM_ID).filter((m) => m.authorId === 'widow')).toHaveLength(1);
    expect(store.agent('widow')?.status).toBe('idle');
  });

  it('stop aborts a running exchange; a message sent meanwhile is stored without starting a second run', async () => {
    class Slow implements Provider {
      calls = 0;
      started: Promise<void>;
      private markStarted!: () => void;
      constructor() { this.started = new Promise((r) => { this.markStarted = r; }); }
      complete(_req: CompleteRequest, signal?: AbortSignal): Promise<CompleteResult> {
        this.calls++;
        this.markStarted();
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }
    }
    const store = new Store();
    const slow = new Slow();
    const orch = new Orchestrator(store, { getProvider: () => slow, vaultDigest: () => '' });
    const first = orch.handleUserMessage(WIDOW_DM_ID, 'hi');
    await slow.started;
    expect(store.isBusy(WIDOW_DM_ID)).toBe(true);
    await orch.handleUserMessage(WIDOW_DM_ID, 'second'); // returns immediately
    expect(slow.calls).toBe(1);
    orch.stop(WIDOW_DM_ID);
    await first;
    const m = msgs(store, WIDOW_DM_ID);
    expect(m.map((x) => x.content)).toEqual(['hi', 'second', 'Stopped.']);
    expect(store.isBusy(WIDOW_DM_ID)).toBe(false);
    expect(store.agent('widow')?.status).toBe('idle');
  });
});

describe('permissions', () => {
  const req = (chId: string) => ({ agentId: 'prog', channelId: chId, action: 'Edit Player.cs', detail: 'change a constant' });

  it('Widow passes it to the user, who approves; resolving twice is refused', async () => {
    const { store, orch } = env();
    const ch = chan(store, 'general');
    const n = await orch.requestPermission(req(ch.id));
    expect(n.status).toBe('awaiting-user');
    expect(n.auditNote).toContain('Within scope');
    expect(store.agent('prog')?.status).toBe('blocked');
    expect(sys(store, ch.id).some((s) => s.includes('passed it to you'))).toBe(true);
    orch.resolveNotification(n.id, true);
    expect(store.notification(n.id)?.status).toBe('approved');
    expect(store.agent('prog')?.status).toBe('idle');
    expect(() => orch.resolveNotification(n.id, false)).toThrow(/not waiting/);
  });

  it('Widow can deny outright, and it never reaches the user', async () => {
    const { store, orch } = env((r) => (r.prompt.includes(MARK.audit) ? 'DECISION: deny\nToo risky.' : undefined));
    const ch = chan(store, 'general');
    const n = await orch.requestPermission(req(ch.id));
    expect(n.status).toBe('denied');
    expect(n.auditNote).toBe('Too risky.');
    expect(store.agent('prog')?.status).toBe('idle');
  });

  it('if the audit cannot run, the request fails closed and is never forwarded to the user', async () => {
    const { store, orch } = env((r) => { if (r.prompt.includes(MARK.audit)) throw new Error('offline'); return undefined; });
    const n = await orch.requestPermission(req(chan(store, 'general').id));
    expect(n.status).toBe('denied');
    expect(n.auditNote).toContain('could not run');
    expect(store.agent('prog')?.status).toBe('idle');
  });

  it('refuses unknown notifications and unknown agents', async () => {
    const { store, orch } = env();
    expect(() => orch.resolveNotification('nope', true)).toThrow();
    await expect(orch.requestPermission({ ...req(chan(store, 'general').id), agentId: 'ghost' })).rejects.toThrow();
  });
});
