import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Store } from '../electron/store';
import { WIDOW_DM_ID, WIDOW_ID } from '../shared/types';

const channelsOf = (s: Store, catId: string) =>
  s.channels().filter((c) => c.categoryId === catId).sort((a, b) => a.order - b.order);

describe('seed', () => {
  it('creates 14 agents, 3 categories with 6 channels each, and a Widow DM', () => {
    const s = new Store();
    expect(s.agents()).toHaveLength(14);
    expect(s.categories()).toHaveLength(3);
    for (const c of s.categories()) expect(channelsOf(s, c.id)).toHaveLength(6);
    expect(s.channel(WIDOW_DM_ID)?.categoryId).toBeNull();
  });

  it('puts Widow in every channel and gives every agent a valid partner', () => {
    const s = new Store();
    for (const ch of s.channels()) expect(ch.memberIds).toContain(WIDOW_ID);
    for (const a of s.agents()) if (a.partnerId) expect(s.agent(a.partnerId)).toBeDefined();
  });

  it('pairs the auditors reciprocally (research, ux, engineering, security, programming/qa)', () => {
    const s = new Store();
    for (const [a, b] of [['res-a', 'res-b'], ['ux-a', 'ux-b'], ['eng-a', 'eng-b'], ['sec-a', 'sec-b'], ['prog', 'qa']]) {
      expect(s.agent(a)?.partnerId).toBe(b);
      expect(s.agent(b)?.partnerId).toBe(a);
    }
  });

  it('has unique, mention-safe agent names', () => {
    const s = new Store();
    const names = s.agents().map((a) => a.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(/^[a-z0-9_-]+$/);
  });
});

describe('channel rules', () => {
  it('moveChannel reorders only inside the same category', () => {
    const s = new Store();
    const [c1, c2] = s.categories();
    const before2 = channelsOf(s, c2.id).map((c) => c.id);
    const first = channelsOf(s, c1.id)[0];
    s.moveChannel(first.id, 3);
    const after = channelsOf(s, c1.id);
    expect(after[3].id).toBe(first.id);
    expect(after.map((c) => c.order)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(after.every((c) => c.categoryId === c1.id)).toBe(true);
    expect(channelsOf(s, c2.id).map((c) => c.id)).toEqual(before2);
  });

  it('clamps out-of-range indexes and never changes categoryId', () => {
    const s = new Store();
    const c1 = s.categories()[0];
    const ch = channelsOf(s, c1.id)[2];
    s.moveChannel(ch.id, 999);
    expect(channelsOf(s, c1.id).at(-1)?.id).toBe(ch.id);
    s.moveChannel(ch.id, -5);
    expect(channelsOf(s, c1.id)[0].id).toBe(ch.id);
    expect(s.channel(ch.id)?.categoryId).toBe(c1.id);
  });

  it('exposes no way to change a channel category', () => {
    const s = new Store();
    expect('moveChannelToCategory' in s).toBe(false);
  });

  it('refuses to move, rename or delete the Widow DM', () => {
    const s = new Store();
    expect(() => s.moveChannel(WIDOW_DM_ID, 0)).toThrow();
    expect(() => s.renameChannel(WIDOW_DM_ID, 'x')).toThrow();
    expect(() => s.deleteChannel(WIDOW_DM_ID)).toThrow();
  });

  it('new channels always include Widow and append to the end of their category', () => {
    const s = new Store();
    const cat = s.categories()[0];
    const ch = s.createChannel(cat.id, 'Level Design', 'custom', ['art']);
    expect(ch.name).toBe('level-design');
    expect(ch.memberIds).toContain(WIDOW_ID);
    expect(ch.memberIds).toContain('art');
    expect(channelsOf(s, cat.id).at(-1)?.id).toBe(ch.id);
  });

  it('deleting a channel renumbers siblings and removes its messages', () => {
    const s = new Store();
    const cat = s.categories()[0];
    const mid = channelsOf(s, cat.id)[2];
    s.addMessage({ channelId: mid.id, authorId: 'user', content: 'hi', kind: 'chat' });
    s.deleteChannel(mid.id);
    expect(channelsOf(s, cat.id).map((c) => c.order)).toEqual([0, 1, 2, 3, 4]);
    expect(s.snapshot().messages.some((m) => m.channelId === mid.id)).toBe(false);
  });
});

describe('membership', () => {
  it('cannot remove Widow from a channel', () => {
    const s = new Store();
    const ch = s.channels().find((c) => c.categoryId)!;
    expect(() => s.setMember(ch.id, WIDOW_ID, false)).toThrow(/Widow/);
  });

  it('adds and removes members, ignoring duplicates', () => {
    const s = new Store();
    const ch = s.channels().find((c) => c.kind === 'research')!;
    s.setMember(ch.id, 'art', true);
    s.setMember(ch.id, 'art', true);
    expect(ch.memberIds.filter((m) => m === 'art')).toHaveLength(1);
    s.setMember(ch.id, 'art', false);
    expect(ch.memberIds).not.toContain('art');
  });

  it('refuses membership changes on the DM', () => {
    const s = new Store();
    expect(() => s.setMember(WIDOW_DM_ID, 'art', true)).toThrow();
  });
});

describe('categories', () => {
  it('reorders and renumbers', () => {
    const s = new Store();
    const last = s.categories()[2];
    s.moveCategory(last.id, 0);
    const sorted = [...s.categories()].sort((a, b) => a.order - b.order);
    expect(sorted[0].id).toBe(last.id);
    expect(sorted.map((c) => c.order)).toEqual([0, 1, 2]);
  });

  it('deleting every category does not throw and cleans up channels', () => {
    const s = new Store();
    for (const c of [...s.categories()]) s.deleteCategory(c.id);
    expect(s.categories()).toHaveLength(0);
    expect(s.channels().map((c) => c.id)).toEqual([WIDOW_DM_ID]);
  });

  it('rejects empty names', () => {
    const s = new Store();
    expect(() => s.createCategory('   ')).toThrow();
    expect(() => s.renameCategory(s.categories()[0].id, '')).toThrow();
  });
});

describe('agents', () => {
  const base = { role: 'Tester', specialty: '', personality: '', tier: 'fast' as const };

  it('adds a valid agent and rejects bad or duplicate names', () => {
    const s = new Store();
    const a = s.addAgent({ ...base, name: 'Nova' });
    expect(s.agent(a.id)?.name).toBe('Nova');
    expect(() => s.addAgent({ ...base, name: 'nova' })).toThrow(/exists/);
    expect(() => s.addAgent({ ...base, name: 'two words' })).toThrow();
    expect(() => s.addAgent({ ...base, name: '' })).toThrow();
    expect(() => s.addAgent({ ...base, name: 'Ok', partnerId: 'nope' })).toThrow();
  });

  it('refuses to remove Widow', () => {
    const s = new Store();
    expect(() => s.removeAgent(WIDOW_ID)).toThrow();
    expect(s.agent(WIDOW_ID)).toBeDefined();
  });

  it('removing an agent drops memberships and partner links', () => {
    const s = new Store();
    s.removeAgent('res-b');
    expect(s.agent('res-b')).toBeUndefined();
    expect(s.agent('res-a')?.partnerId).toBeUndefined();
    for (const ch of s.channels()) expect(ch.memberIds).not.toContain('res-b');
  });

  it('updates personality, tier and prevents self-partnering or duplicate names', () => {
    const s = new Store();
    s.updateAgent('prog', { personality: 'Terse.', tier: 'top' });
    expect(s.agent('prog')?.personality).toBe('Terse.');
    expect(s.agent('prog')?.tier).toBe('top');
    expect(() => s.updateAgent('prog', { partnerId: 'prog' })).toThrow();
    expect(() => s.updateAgent('prog', { name: 'Probe' })).toThrow(/exists/);
    s.updateAgent('prog', { name: 'Hex' }); // same name for itself is fine
  });
});

describe('settings', () => {
  it('clamps numeric settings and ignores junk', () => {
    const s = new Store();
    s.updateSettings({ turnCap: 999, dailyBudgetUsd: -5 });
    expect(s.settings.turnCap).toBe(30);
    expect(s.settings.dailyBudgetUsd).toBe(0);
    s.updateSettings({ turnCap: Number.NaN });
    expect(s.settings.turnCap).toBe(30);
  });

  it('merges model and price overrides without dropping defaults', () => {
    const s = new Store();
    s.updateSettings({ models: { fast: 'claude-haiku-5-5', standard: 'claude-opus-5-5', top: 'claude-fable-5-2' } });
    expect(s.modelFor('standard')).toBe('claude-opus-5-5');
    s.updateSettings({ prices: { 'claude-opus-5-5': { in: 1, out: 2 } } });
    expect(s.priceFor('claude-opus-5-5')).toEqual({ in: 1, out: 2 });
    expect(s.priceFor('claude-haiku-5-5').in).toBeGreaterThan(0);
  });
});

describe('persistence', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rc-store-'));

  it('round-trips through disk', () => {
    const dir = tmp();
    const file = path.join(dir, 'council.json');
    const a = new Store(file);
    a.createCategory('Persisted');
    a.addMessage({ channelId: WIDOW_DM_ID, authorId: 'user', content: 'remember me', kind: 'chat' });
    a.flush();
    const b = new Store(file);
    expect(b.categories().some((c) => c.name === 'Persisted')).toBe(true);
    expect(b.messagesFor(WIDOW_DM_ID).at(-1)?.content).toBe('remember me');
  });

  it('keeps a copy of a corrupt file and falls back to a fresh seed', () => {
    const dir = tmp();
    const file = path.join(dir, 'council.json');
    fs.writeFileSync(file, '{ not json');
    const s = new Store(file);
    expect(s.agents()).toHaveLength(14);
    expect(fs.readdirSync(dir).some((f) => f.includes('.corrupt-'))).toBe(true);
  });

  it('resets transient agent status on load', () => {
    const dir = tmp();
    const file = path.join(dir, 'council.json');
    const a = new Store(file);
    a.setAgentStatus('prog', 'thinking');
    a.updateAgent('prog', { role: 'Programming' }); // forces a save with the transient status inside
    a.flush();
    expect(new Store(file).agent('prog')?.status).toBe('idle');
  });
});
