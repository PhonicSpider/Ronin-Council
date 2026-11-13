import * as path from 'path';
import { Category, ChannelKind, Tier } from '../shared/types';
import { isAbility } from '../shared/meshy';
import { cleanModelRef, isKeyId, isVendorId, KeyId, VendorId } from '../shared/vendors';
import { ingestAttachments, normalizeRepoUrl, validateAvatar } from './attachments';
import { createBackup, listBackups, restoreBackup } from './backup';
import { Orchestrator } from './orchestrator';
import { assertProjectPathAllowed, validateProjectPath } from './project';
import { NewAgent, Store } from './store';
import { listFiles, readVaultFile, refreshIndexes, resolveVaultPath, validateVaultPath } from './vault';

export interface ApiContext {
  store: Store;
  orch: Orchestrator;
  defaultVaultRoot: string;
  pickFolder(): Promise<string | null>;
  setApiKey(key: string, vendor: KeyId): void;
  clearApiKey(vendor: KeyId): void;
  /** Models a local or OpenAI-compatible server offers. */
  listModels(vendor: VendorId): Promise<string[]>;
  refreshMode(): void;
  /** True only in development runs; enables the fake permission request. */
  devTools: boolean;
  /** Folders a project folder may not overlap (the app's own data, system folders). */
  protectedRoots: (string | undefined)[];
  /** Where backups of the council are kept. */
  backupRoot: string;
}

const str = (v: unknown): string => {
  if (typeof v !== 'string') throw new Error('Invalid argument');
  return v;
};
const num = (v: unknown): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('Invalid argument');
  return v;
};
/** The vendor an API call is about; older callers omit it and mean Anthropic. */
const vendorArg = (v: unknown): VendorId => {
  if (v === undefined) return 'anthropic';
  if (!isVendorId(v)) throw new Error('Unknown vendor');
  return v;
};
/** Like vendorArg, but a key may also belong to Meshy. */
const keyArg = (v: unknown): KeyId => {
  if (v === undefined) return 'anthropic';
  if (!isKeyId(v)) throw new Error('Unknown vendor');
  return v;
};
const abilitiesArg = (v: unknown): string[] => {
  if (!Array.isArray(v) || !v.every(isAbility)) throw new Error('Unknown ability');
  return v as string[];
};
const obj = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Invalid argument');
  return v as Record<string, unknown>;
};

/** Every method the renderer may call. Arguments come from an untrusted boundary, so they are validated here. */
export function createApi(c: ApiContext) {
  const { store, orch } = c;
  const resolver = (cat: Category) => resolveVaultPath(cat, c.defaultVaultRoot);
  const vaultRoot = (categoryId: string) => {
    const cat = store.category(str(categoryId));
    if (!cat) throw new Error('Category not found');
    return resolver(cat);
  };
  const mustChannel = (id: unknown) => {
    const ch = store.channel(str(id));
    if (!ch) throw new Error('Channel not found');
    return ch;
  };

  return {
    getSnapshot: () => store.snapshot(),

    createCategory: (name: unknown) => store.createCategory(str(name)),
    renameCategory: (id: unknown, name: unknown) => store.renameCategory(str(id), str(name)),
    moveCategory: (id: unknown, index: unknown) => store.moveCategory(str(id), num(index)),
    toggleCollapse: (id: unknown) => store.toggleCollapse(str(id)),
    setVaultPath: (id: unknown, p: unknown) => {
      const clean = validateVaultPath(str(p));
      return store.setVaultPath(str(id), clean);
    },
    setProjectPath: (id: unknown, p: unknown) => {
      const clean = validateProjectPath(str(p));
      assertProjectPathAllowed(clean, c.protectedRoots);
      store.setProjectPath(str(id), clean);
      return true;
    },
    setRepoUrl: (id: unknown, url: unknown) => { store.setRepoUrl(str(id), normalizeRepoUrl(str(url))); return true; },
    deleteCategory: (id: unknown) => {
      for (const ch of store.channels()) if (ch.categoryId === str(id)) orch.stop(ch.id);
      return store.deleteCategory(str(id));
    },

    createChannel: (categoryId: unknown, name: unknown, kind?: unknown) =>
      store.createChannel(str(categoryId), str(name), (kind ? str(kind) : 'custom') as ChannelKind),
    renameChannel: (id: unknown, name: unknown) => store.renameChannel(str(id), str(name)),
    moveChannel: (id: unknown, index: unknown) => store.moveChannel(str(id), num(index)),
    deleteChannel: (id: unknown) => { orch.stop(str(id)); return store.deleteChannel(str(id)); },
    setMember: (channelId: unknown, agentId: unknown, on: unknown) =>
      store.setMember(str(channelId), str(agentId), !!on),

    addAgent: (input: unknown) => {
      const i = obj(input);
      const tier = str(i.tier) as Tier;
      if (!['fast', 'standard', 'top'].includes(tier)) throw new Error('Invalid tier');
      const a: NewAgent = {
        name: str(i.name), role: str(i.role ?? ''), specialty: str(i.specialty ?? ''),
        personality: str(i.personality ?? ''), tier,
        ...(i.model ? { model: cleanModelRef(i.model) } : {}),
        ...(i.abilities !== undefined ? { abilities: abilitiesArg(i.abilities) } : {}),
        image: typeof i.image === 'string' && i.image ? validateAvatar(i.image) : undefined,
        partnerId: typeof i.partnerId === 'string' && i.partnerId ? i.partnerId : undefined,
      };
      return store.addAgent(a);
    },
    updateAgent: (id: unknown, patch: unknown) => {
      const p = obj(patch);
      const out: Partial<NewAgent> = {};
      for (const k of ['name', 'role', 'specialty', 'personality', 'image', 'partnerId', 'color'] as const) {
        if (p[k] !== undefined) out[k] = k === 'image' ? validateAvatar(str(p[k])) : str(p[k]);
      }
      if (p.abilities !== undefined) out.abilities = abilitiesArg(p.abilities);
      if (p.model !== undefined) out.model = p.model === null ? null : cleanModelRef(p.model);
      if (p.tier !== undefined) {
        const t = str(p.tier) as Tier;
        if (!['fast', 'standard', 'top'].includes(t)) throw new Error('Invalid tier');
        out.tier = t;
      }
      return store.updateAgent(str(id), out);
    },
    removeAgent: (id: unknown) => store.removeAgent(str(id)),

    sendMessage: (channelId: unknown, text: unknown, attachments?: unknown) => {
      const ch = mustChannel(channelId);
      // Validated before anything is stored, so a bad file rejects the whole send and the renderer keeps the draft.
      const files = ingestAttachments(attachments);
      void orch.handleUserMessage(ch.id, str(text), files).catch((e) => console.error('orchestrator:', (e as Error).message));
      return true;
    },
    /** Full contents of an attached file, for viewing in the side panel. */
    attachmentRead: (id: unknown) => {
      const a = store.attachment(str(id));
      const buf = a ? store.blob(a.id) : undefined;
      if (!a || !buf) throw new Error('That file is no longer available');
      return {
        name: a.name, kind: a.kind,
        content: a.kind === 'image' ? `data:${a.mime};base64,${buf.toString('base64')}` : buf.toString('utf8'),
      };
    },
    stop: (channelId: unknown) => orch.stop(str(channelId)),
    /** Emergency brake: cancels every running agent and mission, and withdraws every pending approval. */
    stopAll: () => orch.stopAll(),

    backupList: () => ({ folder: c.backupRoot, backups: listBackups(c.backupRoot) }),
    backupCreate: () => createBackup(store, c.backupRoot, 'manual'),
    backupRestore: async (name: unknown) => {
      // Nothing may be mid-write while the database is swapped.
      orch.stopAll();
      for (let i = 0; i < 30 && store.anyBusy(); i++) await new Promise((r) => setTimeout(r, 100));
      if (store.anyBusy()) throw new Error('Agents are still stopping. Try again in a moment.');
      const r = restoreBackup(store, c.backupRoot, str(name));
      c.refreshMode();
      return r;
    },
    refreshNotes: (channelId: unknown) => orch.scribe(str(channelId), true),

    resolveNotification: (id: unknown, approve: unknown) => orch.resolveNotification(str(id), !!approve),
    dismissNotification: (id: unknown) => store.updateNotification(str(id), { status: 'dismissed', read: true }),
    markNotificationsRead: () => store.markAllRead(),
    devPermissionRequest: (channelId: unknown, agentId: unknown) => {
      if (!c.devTools) throw new Error('Testing tools are disabled in packaged builds');
      const ch = mustChannel(channelId);
      void orch.requestPermission({
        agentId: str(agentId), channelId: ch.id,
        action: 'Edit src/Player.cs', detail: 'Change jump height constant from 4.5 to 5.0 (test request).',
      }).catch((e) => console.error('permission', e));
      return true;
    },

    addNote: (channelId: unknown, text: unknown, sourceMessageId?: unknown) =>
      store.addNote(str(channelId), str(text), sourceMessageId ? str(sourceMessageId) : undefined),
    deleteNote: (id: unknown) => store.deleteNote(str(id)),

    updateSettings: (patch: unknown) => {
      const p = obj(patch);
      store.updateSettings(p as never);
      c.refreshMode();
    },
    setApiKey: (key: unknown, vendor?: unknown) => { c.setApiKey(str(key).trim(), keyArg(vendor)); c.refreshMode(); return true; },
    clearApiKey: (vendor?: unknown) => { c.clearApiKey(keyArg(vendor)); c.refreshMode(); return true; },
    listVendorModels: (vendor: unknown) => c.listModels(vendorArg(vendor)),

    pickFolder: () => c.pickFolder(),

    vaultList: (categoryId: unknown) => listFiles(vaultRoot(str(categoryId))),
    vaultRead: (categoryId: unknown, rel: unknown) => readVaultFile(vaultRoot(str(categoryId)), str(rel)),
    vaultPath: (categoryId: unknown) => path.resolve(vaultRoot(str(categoryId))),
    refreshVaultIndex: () => refreshIndexes(store.categories(), resolver).length,
  };
}

export type Api = ReturnType<typeof createApi>;
