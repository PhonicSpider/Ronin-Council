import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { autoBackupIfDue, createBackup, listBackups, pruneBackups, restoreBackup } from '../electron/backup';
import { planDelegation } from '../electron/delegation';
import { Orchestrator } from '../electron/orchestrator';
import { CompleteRequest, CompleteResult, MockProvider, Provider } from '../electron/providers';
import { LEGACY_AGENT_IDS } from '../electron/seed';
import { Store } from '../electron/store';
import { USER_ID, WIDOW_DM_ID } from '../shared/types';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rc-bk-'));
const engineering = (s: Store, cat = 'cat_1') => s.channels().find((c) => c.categoryId === cat && c.kind === 'engineering')!;
const general = (s: Store, cat = 'cat_1') => s.channels().find((c) => c.categoryId === cat && c.kind === 'general')!;

describe('Cloud specialist', () => {
  it('is Nimbus: in every general and engineering channel, audited by Cipher', () => {
    const s = new Store();
    const n = s.agent('cloud')!;
    expect(n.name).toBe('Nimbus');
    expect(n.partnerId).toBe('sec-b');
    for (const cat of s.categories()) {
      expect(general(s, cat.id).memberIds).toContain('cloud');
      expect(engineering(s, cat.id).memberIds).toContain('cloud');
    }
    expect(s.channels().find((c) => c.kind === 'design')!.memberIds).not.toContain('cloud');
  });

  it('joins an existing council once, and stays gone if the user removes it', () => {
    const dir = tmp();
    const file = path.join(dir, 'council.json');
    const fresh = new Store(file);
    fresh.flush();
    // Make the file look like one written before Nimbus existed.
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.agents = raw.agents.filter((a: { id: string }) => a.id !== 'cloud');
    for (const ch of raw.channels) ch.memberIds = ch.memberIds.filter((m: string) => m !== 'cloud');
    delete raw.provisioned;
    fs.writeFileSync(file, JSON.stringify(raw));

    const upgraded = new Store(file);
    expect(upgraded.agent('cloud')?.name).toBe('Nimbus');
    expect(engineering(upgraded).memberIds).toContain('cloud');
    expect(general(upgraded).memberIds).toContain('cloud');
    expect(upgraded.channel(WIDOW_DM_ID)!.memberIds).not.toContain('cloud');
    expect(LEGACY_AGENT_IDS).not.toContain('cloud');

    upgraded.removeAgent('cloud');
    upgraded.flush();
    expect(new Store(file).agent('cloud')).toBeUndefined();
  });

  it('does not take a name the user already uses', () => {
    const dir = tmp();
    const file = path.join(dir, 'council.json');
    const a = new Store(file);
    a.flush();
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.agents = raw.agents.filter((x: { id: string }) => x.id !== 'cloud');
    raw.agents.push({ ...raw.agents[1], id: 'mine', name: 'Nimbus' });
    delete raw.provisioned;
    fs.writeFileSync(file, JSON.stringify(raw));
    const b = new Store(file);
    expect(b.agents().filter((x) => x.name === 'Nimbus')).toHaveLength(1);
    expect(b.agent('cloud')).toBeUndefined();
  });

  it('is reached by @cloud, @aws, @integration or @devops, sending the team to #engineering with Nimbus first', () => {
    const s = new Store();
    for (const w of ['cloud', 'aws', 'integrations', 'devops']) {
      const p = planDelegation(`@${w} set up hosting`, general(s), s.channels().filter((c) => c.categoryId === 'cat_1'), s.snapshot().agents)!;
      expect(p.jobs).toHaveLength(1);
      expect(p.jobs[0]!.channel.kind).toBe('engineering');
      expect(p.jobs[0]!.team.map((a) => a.name)).toEqual(['Nimbus']);
    }
  });
});

describe('backups', () => {
  const setup = () => {
    const dir = tmp();
    const store = new Store(path.join(dir, 'council.json'));
    return { dir, store, root: path.join(dir, 'backups') };
  };

  it('copies the database and attachments, and lists them newest first', () => {
    const { store, root } = setup();
    store.addMessage({ channelId: WIDOW_DM_ID, authorId: USER_ID, content: 'hello', kind: 'chat' });
    store.putBlob('att_abcd1234', Buffer.from('file bytes'));
    const a = createBackup(store, root, 'manual', new Date(2026, 10, 10, 9, 0, 0));
    const b = createBackup(store, root, 'auto', new Date(2026, 10, 11, 9, 0, 0));
    expect(fs.readFileSync(path.join(root, a.name, 'attachments', 'att_abcd1234'), 'utf8')).toBe('file bytes');
    expect(JSON.parse(fs.readFileSync(path.join(root, a.name, 'council.json'), 'utf8')).messages).toHaveLength(1);
    expect(listBackups(root).map((x) => x.name)).toEqual([b.name, a.name]);
    expect(a.bytes).toBeGreaterThan(0);
    expect(fs.readdirSync(root).some((n) => n.endsWith('.partial'))).toBe(false);
  });

  it('two backups in the same second get different names', () => {
    const { store, root } = setup();
    const t = new Date(2026, 10, 10, 9, 0, 0);
    const a = createBackup(store, root, 'manual', t);
    const b = createBackup(store, root, 'manual', t);
    expect(a.name).not.toBe(b.name);
    expect(listBackups(root)).toHaveLength(2);
  });

  it('restores an earlier state, saving the current one first so the restore can be undone', () => {
    const { store, root } = setup();
    store.addMessage({ channelId: WIDOW_DM_ID, authorId: USER_ID, content: 'before', kind: 'chat' });
    store.putBlob('att_aaaa1111', Buffer.from('old'));
    const snap = createBackup(store, root, 'manual', new Date(2026, 10, 10, 9, 0, 0));
    store.addMessage({ channelId: WIDOW_DM_ID, authorId: USER_ID, content: 'after', kind: 'chat' });
    store.createCategory('Extra');
    store.setBusy(WIDOW_DM_ID, true);

    const { safety } = restoreBackup(store, root, snap.name);
    expect(store.messagesFor(WIDOW_DM_ID).map((m) => m.content)).toEqual(['before']);
    expect(store.categories().some((c) => c.name === 'Extra')).toBe(false);
    expect(store.isBusy(WIDOW_DM_ID)).toBe(false);
    expect(safety.kind).toBe('before-restore');
    // The state from before the restore is still there to go back to.
    restoreBackup(store, root, safety.name);
    expect(store.messagesFor(WIDOW_DM_ID).map((m) => m.content)).toEqual(['before', 'after']);
    // And the restore is on disk, not only in memory.
    store.flush();
    expect(new Store(path.join(store.dir!, 'council.json')).messagesFor(WIDOW_DM_ID)).toHaveLength(2);
  });

  it('refuses unknown names, path tricks, and damaged backups without touching anything', () => {
    const { store, root } = setup();
    store.addMessage({ channelId: WIDOW_DM_ID, authorId: USER_ID, content: 'keep me', kind: 'chat' });
    for (const bad of ['', '..', '../x', 'manual-20260101-000000/../..', 'manual-2026', 'council.json', 'manual-20260101-000000\\..\\..']) {
      expect(() => restoreBackup(store, root, bad), bad).toThrow(/Unknown backup/);
    }
    fs.mkdirSync(path.join(root, 'manual-20260101-000000'), { recursive: true });
    expect(() => restoreBackup(store, root, 'manual-20260101-000000')).toThrow(/missing or damaged/);
    fs.writeFileSync(path.join(root, 'manual-20260101-000000', 'council.json'), '{ nope');
    expect(() => restoreBackup(store, root, 'manual-20260101-000000')).toThrow(/not a council database/);
    fs.writeFileSync(path.join(root, 'manual-20260101-000000', 'council.json'), JSON.stringify({ hello: 1 }));
    expect(() => restoreBackup(store, root, 'manual-20260101-000000')).toThrow(/not a council database/);
    expect(store.messagesFor(WIDOW_DM_ID).map((m) => m.content)).toEqual(['keep me']);
    expect(listBackups(root).some((b) => b.kind === 'before-restore')).toBe(false); // nothing was changed, so no safety copy was needed
  });

  it('a backup from before Nimbus existed still restores, and Nimbus is there afterwards', () => {
    const { store, root } = setup();
    const old = JSON.parse(JSON.stringify({ ...JSON.parse(fs.readFileSync((store.flush(), store.dbFile!), 'utf8')) }));
    old.agents = old.agents.filter((a: { id: string }) => a.id !== 'cloud');
    for (const ch of old.channels) ch.memberIds = ch.memberIds.filter((m: string) => m !== 'cloud');
    delete old.provisioned;
    fs.mkdirSync(path.join(root, 'manual-20250101-000000'), { recursive: true });
    fs.writeFileSync(path.join(root, 'manual-20250101-000000', 'council.json'), JSON.stringify(old));
    restoreBackup(store, root, 'manual-20250101-000000');
    expect(store.agent('cloud')?.name).toBe('Nimbus');
    expect(engineering(store).memberIds).toContain('cloud');
  });

  it('keeps the newest 7 automatic backups and 3 safety copies, and never prunes manual ones', () => {
    const { store, root } = setup();
    for (let i = 0; i < 10; i++) createBackup(store, root, 'auto', new Date(2026, 0, 1 + i, 8));
    for (let i = 0; i < 5; i++) createBackup(store, root, 'before-restore', new Date(2026, 1, 1 + i, 8));
    for (let i = 0; i < 9; i++) createBackup(store, root, 'manual', new Date(2026, 2, 1 + i, 8));
    pruneBackups(root);
    const all = listBackups(root);
    expect(all.filter((b) => b.kind === 'auto')).toHaveLength(7);
    expect(all.filter((b) => b.kind === 'before-restore')).toHaveLength(3);
    expect(all.filter((b) => b.kind === 'manual')).toHaveLength(9);
    // It is the newest that survive.
    expect(Math.min(...all.filter((b) => b.kind === 'auto').map((b) => b.ts))).toBe(new Date(2026, 0, 4, 8).getTime());
  });

  it('makes an automatic backup only when the newest one is about a day old', () => {
    const { store, root } = setup();
    const t0 = new Date(2026, 5, 1, 8, 0, 0);
    expect(autoBackupIfDue(store, root, t0)?.kind).toBe('auto');
    expect(autoBackupIfDue(store, root, new Date(t0.getTime() + 3 * 3600_000))).toBeNull();
    expect(autoBackupIfDue(store, root, new Date(t0.getTime() + 21 * 3600_000))?.kind).toBe('auto');
  });

  it('an in-memory store cannot be backed up, and the automatic one never throws', () => {
    const s = new Store();
    expect(() => createBackup(s, path.join(tmp(), 'b'), 'manual')).toThrow(/not saved to disk/);
    expect(autoBackupIfDue(s, path.join(tmp(), 'b'))).toBeNull();
  });
});

describe('Stop all', () => {
  it('cancels every running channel at once, including queued messages and approvals', async () => {
    const gate = new Promise<void>(() => { /* never released: only Stop ends these runs */ });
    const slow: Provider = {
      async complete(_req: CompleteRequest, signal?: AbortSignal): Promise<CompleteResult> {
        await new Promise<void>((resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')));
          void gate.then(resolve);
        });
        return { text: '[mock] ok', inTokens: 1, outTokens: 1 };
      },
    };
    const store = new Store();
    const orch = new Orchestrator(store, { getProvider: () => slow, vaultDigest: () => '(vault)' });
    const a = store.channels().find((c) => c.categoryId === 'cat_1' && c.kind === 'research')!;
    const b = store.channels().find((c) => c.categoryId === 'cat_2' && c.kind === 'design')!;
    const runs = [orch.handleUserMessage(a.id, 'first'), orch.handleUserMessage(b.id, 'second')];
    await new Promise((r) => setTimeout(r, 50));
    await orch.handleUserMessage(a.id, 'queued behind the first');
    expect(store.isBusy(a.id) && store.isBusy(b.id)).toBe(true);

    expect(orch.stopAll()).toBe(2);
    await Promise.all(runs);
    expect(store.anyBusy()).toBe(false);
    for (const ch of [a, b]) {
      expect(store.messagesFor(ch.id).some((m) => m.kind === 'system' && m.content === 'Stopped.')).toBe(true);
    }
    expect(store.messagesFor(a.id).filter((m) => m.authorId !== USER_ID && m.kind !== 'system')).toHaveLength(0);
  });

  it('does nothing when nothing is running', () => {
    const store = new Store();
    const orch = new Orchestrator(store, { getProvider: () => new MockProvider(), vaultDigest: () => '(vault)' });
    expect(orch.stopAll()).toBe(0);
  });
});

import { createApi } from '../electron/api';

describe('api: backups and Stop all', () => {
  const make = () => {
    const dir = tmp();
    const store = new Store(path.join(dir, 'council.json'));
    const orch = new Orchestrator(store, { getProvider: () => new MockProvider(), vaultDigest: () => '(vault)' });
    let refreshed = 0;
    const api = createApi({
      store, orch, ollama: undefined as never, defaultVaultRoot: dir, pickFolder: async () => null, setApiKey: () => undefined, clearApiKey: () => undefined, listModels: async () => [],
      refreshMode: () => { refreshed++; }, devTools: false, protectedRoots: [], backupRoot: path.join(dir, 'backups'),
    });
    return { api, store, dir, refreshed: () => refreshed };
  };

  it('backs up, lists, restores, and refreshes the live/mock mode afterwards', async () => {
    const { api, store, refreshed } = make();
    store.addMessage({ channelId: WIDOW_DM_ID, authorId: USER_ID, content: 'one', kind: 'chat' });
    const b = api.backupCreate();
    store.addMessage({ channelId: WIDOW_DM_ID, authorId: USER_ID, content: 'two', kind: 'chat' });
    expect(api.backupList().backups.map((x) => x.name)).toEqual([b.name]);
    await api.backupRestore(b.name);
    expect(store.messagesFor(WIDOW_DM_ID).map((m) => m.content)).toEqual(['one']);
    expect(refreshed()).toBe(1);
    await expect(api.backupRestore('../../evil')).rejects.toThrow(/Unknown backup/);
    await expect(api.backupRestore(42 as never)).rejects.toThrow(/Invalid argument/);
  });

  it('restoring stops running agents first and refuses if they will not stop', async () => {
    const { api, store } = make();
    const b = api.backupCreate();
    store.setBusy(WIDOW_DM_ID, true); // a run that never ends
    await expect(api.backupRestore(b.name)).rejects.toThrow(/still stopping/);
    store.setBusy(WIDOW_DM_ID, false);
    await expect(api.backupRestore(b.name)).resolves.toBeTruthy();
  }, 10000);

  it('stopAll is callable from the renderer', () => {
    expect(make().api.stopAll()).toBe(0);
  });
});
