import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import {
  Agent, AgentStatus, Attachment, Category, Channel, ChannelKind, Message, Note, Notification, Settings, Snapshot,
  Spend, Tier, WIDOW_DM_ID, WIDOW_ID, Price,
} from '../shared/types';
import { isAbility } from '../shared/meshy';
import { cleanModelRef, isModelName, isVendorId, ModelRef, validBaseUrl, validLocalUrl, vendorInfo, VendorId } from '../shared/vendors';
import { DEFAULT_CHANNELS, DEFAULT_SETTINGS, LEGACY_AGENT_IDS, SEED_AGENTS, seedCategories, widowDm } from './seed';

interface Data {
  /** Ids of built-in agents already given to this council (so one the user removed is not brought back). */
  provisioned: string[];
  agents: Agent[];
  categories: Category[];
  channels: Channel[];
  messages: Message[];
  notifications: Notification[];
  notes: Note[];
  settings: Settings;
  spend: Spend;
}

export interface NewAgent {
  name: string; role: string; specialty: string; personality: string; tier: Tier;
  /** null clears an explicit model (back to the tier). */
  model?: ModelRef | null;
  abilities?: string[];
  color?: string; image?: string; partnerId?: string;
}

/** Marker in `provisioned`: Iris was given the Meshy ability once. A later removal of it by the user sticks. */
const ABILITY_MESHY_ART = 'ability:meshy-art';

const NAME_RE = /^[A-Za-z0-9_-]{1,24}$/;
const PALETTE = ['#4f8fd6', '#d6784f', '#6fae8a', '#c9a64e', '#d66f9a', '#9a6fd6', '#4fb3b3', '#d64f4f'];

export const todayKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const newId = (prefix: string) => `${prefix}_${randomUUID().slice(0, 8)}`;

/** Move `id` to `toIndex` within `items` (sorted by order) and renumber. Mutates the items' order fields. */
function reorder<T extends { id: string; order: number }>(items: T[], id: string, toIndex: number): void {
  const sorted = [...items].sort((a, b) => a.order - b.order);
  const from = sorted.findIndex((i) => i.id === id);
  if (from < 0) throw new Error('Item not found');
  const [moved] = sorted.splice(from, 1);
  const to = Math.max(0, Math.min(sorted.length, Math.floor(toIndex)));
  sorted.splice(to, 0, moved);
  sorted.forEach((item, i) => { item.order = i; });
}

const cleanAbilities = (list: unknown): string[] => {
  if (!Array.isArray(list) || !list.every(isAbility)) throw new Error('Unknown ability');
  return [...new Set(list as string[])];
};

export class Store {
  private data: Data;
  private busy: Record<string, boolean> = {};
  private listeners = new Set<() => void>();
  private timer: NodeJS.Timeout | null = null;
  mode: 'claude' | 'mock' = 'mock';

  /** `file` null = in-memory only (tests). */
  constructor(private file: string | null = null) {
    this.data = this.load() ?? this.seed();
    for (const a of this.data.agents) a.status = 'idle';
  }

  // ---------- persistence ----------
  private seed(): Data {
    const categories = seedCategories();
    const channels: Channel[] = [widowDm()];
    for (const cat of categories) {
      DEFAULT_CHANNELS.forEach((c, i) => {
        const members = new Set([WIDOW_ID, ...c.members]);
        channels.push({
          id: `${cat.id}_${c.kind}`, categoryId: cat.id, name: c.name, kind: c.kind, order: i,
          memberIds: [...members],
        });
      });
    }
    return {
      provisioned: [...SEED_AGENTS.map((a) => a.id), ABILITY_MESHY_ART],
      agents: SEED_AGENTS.map((a) => ({ ...a })),
      categories, channels, messages: [], notifications: [], notes: [],
      settings: structuredClone(DEFAULT_SETTINGS),
      spend: { date: todayKey(), usd: 0, byCategory: {} },
    };
  }

  /** Fills in anything a database from an older version lacks. Returns null when it is not a council database at all. */
  private parse(raw: Partial<Data>): Data | null {
    if (!raw || !Array.isArray(raw.agents) || !Array.isArray(raw.categories) || !Array.isArray(raw.channels)) return null;
    const d = this.seed();
    const data = {
      ...d,
      ...raw,
      // Older databases predate project folders.
      categories: raw.categories.map((c) => ({ ...c, projectPath: c.projectPath ?? '', repoUrl: c.repoUrl ?? '' })),
      settings: {
        ...d.settings, ...raw.settings,
        models: { ...d.settings.models, ...raw.settings?.models },
        prices: { ...d.settings.prices, ...raw.settings?.prices },
        // The old default of 8 ran out quickly; anyone still on it moves to the new default of 12 (other values are theirs).
        turnCap: raw.settings?.turnCap === 8 ? d.settings.turnCap : raw.settings?.turnCap ?? d.settings.turnCap,
      },
      provisioned: Array.isArray(raw.provisioned) ? raw.provisioned : [...LEGACY_AGENT_IDS],
    } as Data;
    this.provisionNewAgents(data);
    if (!data.provisioned.includes(ABILITY_MESHY_ART)) {
      data.provisioned.push(ABILITY_MESHY_ART);
      const iris = data.agents.find((a) => a.id === 'art');
      if (iris && !iris.abilities) iris.abilities = ['meshy'];
    }
    return data;
  }

  /**
   * Built-in agents added in a later version join an existing council once: put in the roster and in the default channels
   * they belong to. An agent the user later removes stays removed, because it is recorded as already provisioned.
   */
  private provisionNewAgents(data: Data) {
    for (const seedAgent of SEED_AGENTS) {
      if (data.provisioned.includes(seedAgent.id)) continue;
      data.provisioned.push(seedAgent.id);
      if (data.agents.some((a) => a.id === seedAgent.id)) continue;
      const taken = new Set(data.agents.map((a) => a.name.toLowerCase()));
      if (taken.has(seedAgent.name.toLowerCase())) continue; // the user already has someone by that name
      data.agents.push({ ...seedAgent, status: 'idle' });
      for (const ch of data.channels) {
        const wanted = ch.kind === 'general' || DEFAULT_CHANNELS.some((c) => c.kind === ch.kind && c.members.includes(seedAgent.id));
        if (ch.categoryId && wanted && !ch.memberIds.includes(seedAgent.id)) ch.memberIds.push(seedAgent.id);
      }
    }
  }

  private load(): Data | null {
    if (!this.file || !fs.existsSync(this.file)) return null;
    try {
      return this.parse(JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<Data>);
    } catch {
      // Keep the unreadable file for recovery rather than silently overwriting it.
      try { fs.copyFileSync(this.file, `${this.file}.corrupt-${Date.now()}`); } catch { /* ignore */ }
      return null;
    }
  }

  private scheduleSave() {
    if (!this.file) return;
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 300);
  }

  flush() {
    if (!this.file) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('Failed to save database', e);
    }
  }

  /** Folder holding the database file and its attachments; null for an in-memory store. */
  get dir(): string | null { return this.file ? path.dirname(this.file) : null; }
  get dbFile(): string | null { return this.file; }

  /** Replace everything with a backed-up database. Throws, changing nothing, if the text is not a usable council database. */
  restore(json: string) {
    let raw: Partial<Data>;
    try { raw = JSON.parse(json) as Partial<Data>; } catch { throw new Error('That backup could not be read'); }
    const data = this.parse(raw);
    if (!data) throw new Error('That backup is not a council database');
    for (const a of data.agents) a.status = 'idle';
    this.data = data;
    this.busy = {};
    this.expireStaleApprovals(); // nothing is waiting on a request from before the restore
    this.flush();
    this.changed(false);
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(persist = true) {
    if (persist) this.scheduleSave();
    for (const l of this.listeners) l();
  }

  // ---------- reads ----------
  snapshot(): Snapshot {
    this.rollSpend();
    return {
      agents: this.data.agents,
      categories: this.data.categories,
      channels: this.data.channels,
      messages: this.data.messages,
      notifications: this.data.notifications,
      notes: this.data.notes,
      settings: this.data.settings,
      spend: this.data.spend,
      busy: { ...this.busy },
      mode: this.mode,
    };
  }

  get settings(): Settings { return this.data.settings; }
  agent(id: string) { return this.data.agents.find((a) => a.id === id); }
  agentByName(name: string) {
    return this.data.agents.find((a) => a.name.toLowerCase() === name.toLowerCase());
  }
  agents() { return this.data.agents; }
  channel(id: string) { return this.data.channels.find((c) => c.id === id); }
  channels() { return this.data.channels; }
  category(id: string | null) { return id ? this.data.categories.find((c) => c.id === id) : undefined; }
  categories() { return this.data.categories; }
  notification(id: string) { return this.data.notifications.find((n) => n.id === id); }
  messagesFor(channelId: string, limit = 20) {
    return this.data.messages.filter((m) => m.channelId === channelId).slice(-limit);
  }
  members(channelId: string): Agent[] {
    const ch = this.channel(channelId);
    if (!ch) return [];
    return ch.memberIds.map((id) => this.agent(id)).filter((a): a is Agent => !!a);
  }
  modelFor(tier: Tier) { return this.data.settings.models[tier]; }
  priceFor(model: string): Price { return Object.hasOwn(this.data.settings.prices, model) ? this.data.settings.prices[model]! : { in: 0, out: 0 }; }

  // ---------- categories ----------
  createCategory(name: string): Category {
    name = name.trim();
    if (!name) throw new Error('Category needs a name');
    const order = this.data.categories.reduce((m, c) => Math.max(m, c.order), -1) + 1;
    const cat: Category = { id: newId('cat'), name, order, vaultPath: '', projectPath: '', repoUrl: '', collapsed: false };
    this.data.categories.push(cat);
    this.changed();
    return cat;
  }
  renameCategory(id: string, name: string) {
    const c = this.mustCategory(id);
    if (!name.trim()) throw new Error('Category needs a name');
    c.name = name.trim();
    this.changed();
  }
  moveCategory(id: string, toIndex: number) {
    this.mustCategory(id);
    reorder(this.data.categories, id, toIndex);
    this.changed();
  }
  toggleCollapse(id: string) {
    const c = this.mustCategory(id);
    c.collapsed = !c.collapsed;
    this.changed();
  }
  setVaultPath(id: string, p: string) {
    this.mustCategory(id).vaultPath = p.trim();
    this.changed();
  }
  /** The single folder this project's agents may touch. '' turns real actions off (talk-only). */
  setProjectPath(id: string, p: string) {
    this.mustCategory(id).projectPath = p.trim();
    this.changed();
  }
  setRepoUrl(id: string, url: string) {
    this.mustCategory(id).repoUrl = url;
    this.changed();
  }
  /** Approval requests cannot survive a restart (nothing is waiting on them any more), so close them. */
  expireStaleApprovals(): number {
    let n = 0;
    for (const x of this.data.notifications) {
      if (x.action && (x.status === 'pending-widow' || x.status === 'awaiting-user')) {
        x.status = 'dismissed';
        x.auditNote = `${x.auditNote ? `${x.auditNote} ` : ''}(Expired: the app restarted before this was decided.)`;
        n++;
      }
    }
    if (n) this.changed();
    return n;
  }
  deleteCategory(id: string) {
    this.mustCategory(id);
    const chIds = new Set(this.data.channels.filter((c) => c.categoryId === id).map((c) => c.id));
    this.data.channels = this.data.channels.filter((c) => c.categoryId !== id);
    this.dropBlobs(this.data.messages.filter((m) => chIds.has(m.channelId)).flatMap((m) => (m.attachments ?? []).map((a) => a.id)));
    this.data.messages = this.data.messages.filter((m) => !chIds.has(m.channelId));
    this.data.notes = this.data.notes.filter((n) => !chIds.has(n.channelId));
    this.data.notifications = this.data.notifications.filter((n) => !n.channelId || !chIds.has(n.channelId));
    this.data.categories = this.data.categories.filter((c) => c.id !== id);
    this.data.categories.sort((a, b) => a.order - b.order).forEach((c, i) => { c.order = i; });
    this.changed();
  }
  private mustCategory(id: string) {
    const c = this.category(id);
    if (!c) throw new Error('Category not found');
    return c;
  }

  // ---------- channels ----------
  createChannel(categoryId: string, name: string, kind: ChannelKind = 'custom', memberIds: string[] = []): Channel {
    this.mustCategory(categoryId);
    name = name.trim().toLowerCase().replace(/\s+/g, '-');
    if (!name) throw new Error('Channel needs a name');
    if (kind === 'dm') throw new Error('Cannot create a DM channel');
    const order = this.data.channels.filter((c) => c.categoryId === categoryId)
      .reduce((m, c) => Math.max(m, c.order), -1) + 1;
    const members = new Set([WIDOW_ID, ...memberIds.filter((id) => this.agent(id))]);
    const ch: Channel = { id: newId('ch'), categoryId, name, kind, order, memberIds: [...members] };
    this.data.channels.push(ch);
    this.changed();
    return ch;
  }
  renameChannel(id: string, name: string) {
    const ch = this.mustChannel(id);
    if (ch.kind === 'dm') throw new Error('Cannot rename the Widow DM');
    name = name.trim().toLowerCase().replace(/\s+/g, '-');
    if (!name) throw new Error('Channel needs a name');
    ch.name = name;
    this.changed();
  }
  /** Channels may only be reordered inside the category they were created in. */
  moveChannel(id: string, toIndex: number) {
    const ch = this.mustChannel(id);
    if (ch.kind === 'dm' || !ch.categoryId) throw new Error('This channel cannot be moved');
    reorder(this.data.channels.filter((c) => c.categoryId === ch.categoryId), id, toIndex);
    this.changed();
  }
  deleteChannel(id: string) {
    const ch = this.mustChannel(id);
    if (ch.kind === 'dm') throw new Error('Cannot delete the Widow DM');
    this.data.channels = this.data.channels.filter((c) => c.id !== id);
    this.dropBlobs(this.data.messages.filter((m) => m.channelId === id).flatMap((m) => (m.attachments ?? []).map((a) => a.id)));
    this.data.messages = this.data.messages.filter((m) => m.channelId !== id);
    this.data.notes = this.data.notes.filter((n) => n.channelId !== id);
    this.data.notifications = this.data.notifications.filter((n) => n.channelId !== id);
    const siblings = this.data.channels.filter((c) => c.categoryId === ch.categoryId)
      .sort((a, b) => a.order - b.order);
    siblings.forEach((c, i) => { c.order = i; });
    this.changed();
  }
  setMember(channelId: string, agentId: string, on: boolean) {
    const ch = this.mustChannel(channelId);
    if (ch.kind === 'dm') throw new Error('The Widow DM has a fixed membership');
    if (!this.agent(agentId)) throw new Error('Agent not found');
    if (agentId === WIDOW_ID && !on) throw new Error('Widow must stay in every channel');
    const has = ch.memberIds.includes(agentId);
    if (on && !has) ch.memberIds.push(agentId);
    if (!on && has) ch.memberIds = ch.memberIds.filter((m) => m !== agentId);
    this.changed();
  }
  private mustChannel(id: string) {
    const c = this.channel(id);
    if (!c) throw new Error('Channel not found');
    return c;
  }

  // ---------- agents ----------
  addAgent(input: NewAgent): Agent {
    const name = input.name.trim();
    if (!NAME_RE.test(name)) throw new Error('Name must be one word (letters, numbers, - or _), used for @mentions');
    if (this.agentByName(name)) throw new Error('An agent with that name already exists');
    if (input.partnerId && !this.agent(input.partnerId)) throw new Error('Partner not found');
    const agent: Agent = {
      id: newId('agent'), name, role: input.role.trim() || 'Agent', specialty: input.specialty.trim(),
      personality: input.personality.trim(), tier: input.tier,
      ...(input.model ? { model: cleanModelRef(input.model) } : {}),
      ...(input.abilities?.length ? { abilities: cleanAbilities(input.abilities) } : {}),
      color: input.color ?? PALETTE[this.data.agents.length % PALETTE.length],
      image: input.image, partnerId: input.partnerId, status: 'idle',
    };
    this.data.agents.push(agent);
    this.changed();
    return agent;
  }
  updateAgent(id: string, patch: Partial<NewAgent>) {
    const a = this.agent(id);
    if (!a) throw new Error('Agent not found');
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!NAME_RE.test(name)) throw new Error('Name must be one word (letters, numbers, - or _)');
      const other = this.agentByName(name);
      if (other && other.id !== id) throw new Error('An agent with that name already exists');
      a.name = name;
    }
    if (patch.role !== undefined) a.role = patch.role.trim() || a.role;
    if (patch.specialty !== undefined) a.specialty = patch.specialty;
    if (patch.personality !== undefined) a.personality = patch.personality;
    if (patch.tier !== undefined) a.tier = patch.tier;
    if (patch.abilities !== undefined) a.abilities = patch.abilities.length ? cleanAbilities(patch.abilities) : undefined;
    if (patch.model !== undefined) a.model = patch.model ? cleanModelRef(patch.model) : undefined;
    if (patch.color !== undefined) a.color = patch.color;
    if (patch.image !== undefined) a.image = patch.image || undefined;
    if (patch.partnerId !== undefined) {
      if (patch.partnerId && (!this.agent(patch.partnerId) || patch.partnerId === id)) throw new Error('Invalid partner');
      a.partnerId = patch.partnerId || undefined;
    }
    this.changed();
  }
  removeAgent(id: string) {
    if (id === WIDOW_ID) throw new Error('Widow cannot be removed');
    if (!this.agent(id)) throw new Error('Agent not found');
    this.data.agents = this.data.agents.filter((a) => a.id !== id);
    for (const ch of this.data.channels) ch.memberIds = ch.memberIds.filter((m) => m !== id);
    for (const a of this.data.agents) if (a.partnerId === id) a.partnerId = undefined;
    this.changed();
  }
  setAgentStatus(id: string, status: AgentStatus) {
    const a = this.agent(id);
    if (a && a.status !== status) { a.status = status; this.changed(false); }
  }

  // ---------- attachments ----------
  // File bytes stay out of the database (and out of every snapshot): they sit in an `attachments` folder next to it.
  private memBlobs = new Map<string, Buffer>();
  private blobPath(id: string): string | null {
    if (!this.file || !/^att_[a-f0-9-]{4,40}$/.test(id)) return null;
    return path.join(path.dirname(this.file), 'attachments', id);
  }
  putBlob(id: string, buf: Buffer) {
    const p = this.blobPath(id);
    if (!this.file) { this.memBlobs.set(id, buf); return; }
    if (!p) throw new Error('Bad attachment id');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, buf);
  }
  blob(id: string): Buffer | undefined {
    if (!this.file) return this.memBlobs.get(id);
    const p = this.blobPath(id);
    try { return p ? fs.readFileSync(p) : undefined; } catch { return undefined; }
  }
  private dropBlobs(ids: string[]) {
    for (const id of ids) {
      this.memBlobs.delete(id);
      const p = this.blobPath(id);
      if (p) { try { fs.rmSync(p, { force: true }); } catch { /* already gone */ } }
    }
  }
  attachment(id: string): Attachment | undefined {
    for (const m of this.data.messages) {
      const a = m.attachments?.find((x) => x.id === id);
      if (a) return a;
    }
    return undefined;
  }

  // ---------- messages ----------
  addMessage(m: Omit<Message, 'id' | 'ts'>): Message {
    this.mustChannel(m.channelId);
    const msg: Message = { ...m, id: newId('msg'), ts: Date.now() };
    this.data.messages.push(msg);
    this.changed();
    return msg;
  }

  // ---------- notifications / notes ----------
  addNotification(n: Omit<Notification, 'id' | 'ts' | 'read'>): Notification {
    const notif: Notification = { ...n, id: newId('ntf'), ts: Date.now(), read: false };
    this.data.notifications.push(notif);
    this.changed();
    return notif;
  }
  updateNotification(id: string, patch: Partial<Pick<Notification, 'status' | 'auditNote' | 'read'>>) {
    const n = this.notification(id);
    if (!n) throw new Error('Notification not found');
    Object.assign(n, patch);
    this.changed();
  }
  markAllRead() {
    let any = false;
    for (const n of this.data.notifications) if (!n.read) { n.read = true; any = true; }
    if (any) this.changed();
  }
  addNote(channelId: string, text: string, sourceMessageId?: string, extra?: Pick<Note, 'kind' | 'auto' | 'until'>): Note {
    this.mustChannel(channelId);
    if (!text.trim()) throw new Error('Note is empty');
    const note: Note = { id: newId('note'), channelId, text: text.trim(), sourceMessageId, ts: Date.now(), ...extra };
    this.data.notes.push(note);
    this.changed();
    return note;
  }
  deleteNote(id: string) {
    this.data.notes = this.data.notes.filter((n) => n.id !== id);
    this.changed();
  }

  // ---------- settings / spend ----------
  updateSettings(patch: Partial<Omit<Settings, 'hasApiKey' | 'vendorKeys' | 'hasMeshyKey'>>) {
    const s = this.data.settings;
    if (patch.vendorUrls) {
      // Only the vendors whose address is the user's to set; a hosted vendor's address is fixed so its key cannot be redirected.
      const next = { ...s.vendorUrls };
      for (const [k, v] of Object.entries(patch.vendorUrls)) {
        if (!isVendorId(k) || !vendorInfo(k).editableUrl) throw new Error('That vendor\'s address cannot be changed');
        if (v === '' || v == null) { delete next[k]; continue; }
        const clean = typeof v === 'string' ? (k === 'local' ? validLocalUrl(v) : validBaseUrl(v)) : null;
        if (!clean) {
          throw new Error(k === 'local'
            ? 'A local server must be on this computer: use an address like http://localhost:11434/v1. For a remote service, use "Other (OpenAI-compatible)".'
            : 'The address must start with https:// (or http:// for a server on this computer) and have no password or query in it');
        }
        next[k] = clean;
      }
      s.vendorUrls = next;
    }
    if (patch.modelTools) {
      const next = { ...s.modelTools };
      for (const [k, v] of Object.entries(patch.modelTools)) {
        if (!isModelName(k) || typeof v !== 'boolean') throw new Error('Invalid model tool setting');
        next[k] = v;
      }
      s.modelTools = next;
    }
    if (patch.models) s.models = { ...s.models, ...patch.models };
    if (patch.prices) {
      const next = { ...s.prices };
      for (const [k, v] of Object.entries(patch.prices)) {
        const ok = isModelName(k) && !!v && typeof v === 'object' && Number.isFinite(v.in) && Number.isFinite(v.out) && v.in >= 0 && v.out >= 0;
        if (!ok) throw new Error('Prices must be numbers of zero or more, for a valid model name');
        next[k] = { in: v.in, out: v.out };
      }
      s.prices = next;
    }
    const num = (v: unknown, min: number, max: number, fallback: number) =>
      typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
    if (patch.dailyBudgetUsd !== undefined) s.dailyBudgetUsd = num(patch.dailyBudgetUsd, 0, 10000, s.dailyBudgetUsd);
    if (patch.categoryBudgetUsd !== undefined) s.categoryBudgetUsd = num(patch.categoryBudgetUsd, 0, 10000, s.categoryBudgetUsd);
    if (patch.turnCap !== undefined) s.turnCap = Math.round(num(patch.turnCap, 1, 30, s.turnCap));
    if (patch.useMock !== undefined) s.useMock = !!patch.useMock;
    if (patch.meshyDailyCredits !== undefined) s.meshyDailyCredits = Math.round(num(patch.meshyDailyCredits, 0, 100000, s.meshyDailyCredits));
    if (patch.autoNotes !== undefined) s.autoNotes = !!patch.autoNotes;
    this.changed();
  }
  setHasMeshyKey(v: boolean) {
    if (this.data.settings.hasMeshyKey === v) return;
    this.data.settings.hasMeshyKey = v;
    this.changed();
  }
  setHasApiKey(v: boolean) {
    if (this.data.settings.hasApiKey === v) return;
    this.data.settings.hasApiKey = v;
    this.changed();
  }
  /** Which vendors have a key saved. Only the flags are kept here. */
  setVendorKeys(flags: Partial<Record<VendorId, boolean>>) {
    const a = JSON.stringify(this.data.settings.vendorKeys), b = JSON.stringify(flags);
    if (a === b) return;
    this.data.settings.vendorKeys = flags;
    this.changed();
  }
  setMode(m: 'claude' | 'mock') {
    if (this.mode !== m) { this.mode = m; this.changed(false); }
  }
  private rollSpend() {
    const t = todayKey();
    if (this.data.spend.date !== t) this.data.spend = { date: t, usd: 0, byCategory: {} };
  }
  recordSpend(usd: number, categoryId: string | null) {
    if (!Number.isFinite(usd) || usd < 0) return; // a bad figure must never poison the running total the budgets compare against
    this.rollSpend();
    this.data.spend.usd += usd;
    if (categoryId) this.data.spend.byCategory[categoryId] = (this.data.spend.byCategory[categoryId] ?? 0) + usd;
    this.changed();
  }
  recordInput(fresh: number, read: number, write: number) {
    this.rollSpend();
    const s = this.data.spend;
    s.inputFresh = (s.inputFresh ?? 0) + fresh;
    s.cacheRead = (s.cacheRead ?? 0) + read;
    s.cacheWrite = (s.cacheWrite ?? 0) + write;
    this.changed(false);
  }
  spendToday() { this.rollSpend(); return this.data.spend.usd; }
  meshyCreditsToday() { this.rollSpend(); return this.data.spend.meshyCredits ?? 0; }
  /** Adds (or, with a negative number, takes back) Meshy credits. The total never goes below zero. */
  addMeshyCredits(delta: number) {
    if (!Number.isFinite(delta)) return;
    this.rollSpend();
    this.data.spend.meshyCredits = Math.max(0, (this.data.spend.meshyCredits ?? 0) + delta);
    this.changed(false);
  }
  spendCategory(categoryId: string | null) {
    this.rollSpend();
    return categoryId ? this.data.spend.byCategory[categoryId] ?? 0 : 0;
  }
  setBusy(channelId: string, v: boolean) {
    if (v) this.busy[channelId] = true; else delete this.busy[channelId];
    this.changed(false);
  }
  isBusy(channelId: string) { return !!this.busy[channelId]; }
  anyBusy() { return Object.keys(this.busy).length > 0; }
}

export { WIDOW_DM_ID };
