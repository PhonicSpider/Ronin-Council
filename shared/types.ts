// Types shared by the Electron main process and the React renderer.
import type { ModelRef, VendorId } from './vendors';
export type { ModelRef, VendorId } from './vendors';

export const USER_ID = 'user';
export const SYSTEM_ID = 'system';
export const WIDOW_ID = 'widow';
export const LIBRARIAN_ID = 'librarian';
export const WIDOW_DM_ID = 'widow-dm';

export type Tier = 'fast' | 'standard' | 'top';
export type AgentStatus = 'idle' | 'thinking' | 'reviewing' | 'blocked';

export interface Agent {
  id: string;
  name: string;
  role: string;
  specialty: string;
  personality: string;
  tier: Tier;
  /** An explicit vendor and model. Absent = use the tier's model (Anthropic). */
  model?: ModelRef;
  color: string;
  image?: string; // data URL
  partnerId?: string; // audit partner
  status: AgentStatus;
}

export interface Category {
  id: string;
  name: string;
  order: number;
  vaultPath: string; // '' = default location under app data
  projectPath: string; // '' = talk-only; otherwise the one folder this project's agents may read and (with approval) change
  repoUrl: string; // '' or https://github.com/owner/repo; told to the agents so Widow knows which remote to update
  collapsed: boolean;
}

export type ChannelKind =
  | 'general' | 'research' | 'engineering' | 'design' | 'art' | 'programming' | 'custom' | 'dm';

export interface Channel {
  id: string;
  categoryId: string | null; // null only for the Widow DM; never changes after creation
  name: string;
  kind: ChannelKind;
  order: number;
  memberIds: string[];
}

export type MessageKind = 'chat' | 'deliverable' | 'review' | 'decision' | 'system' | 'tool';
export type Verdict = 'approve' | 'concerns' | 'reject';

/** A file the user attached to a message. The bytes live outside the database; `thumb` is a tiny preview for images. */
export interface Attachment {
  id: string;
  name: string;
  kind: 'image' | 'text';
  mime: string;
  size: number; // bytes
  thumb?: string; // small data URL (images only)
}

/** What the renderer sends for each attached file. `data` is base64. */
export interface AttachmentInput { name: string; mime: string; data: string; thumb?: string }

export const LIMITS = {
  attachMaxFiles: 6,
  attachImageBytes: 5 * 1024 * 1024, // the Messages API rejects images over 5 MB
  attachTextBytes: 100 * 1024,
  attachThumbBytes: 30 * 1024,
  avatarW: 256, // stored profile pictures are portrait 4:5 (like 1122 x 1402), this many pixels wide
  avatarH: 320, // ... and this many tall
  avatarSourceBytes: 10 * 1024 * 1024, // largest file the editor will open
  avatarStoredBytes: 300 * 1024, // largest stored result
} as const;

export interface Message {
  id: string;
  channelId: string;
  authorId: string; // USER_ID | SYSTEM_ID | agent id
  content: string;
  ts: number;
  kind: MessageKind;
  attachments?: Attachment[];
  reviewOf?: string;
  verdict?: Verdict;
  detail?: string; // kind 'tool': command output / diff, shown collapsed under `content`
}

/** What an agent wants to do, shown to Widow and then to the user before anything runs. */
export interface ActionRequest {
  tool: 'write_file' | 'edit_file' | 'run_command' | 'save_note' | 'git_publish';
  summary: string; // one line, e.g. "Edit src/Player.cs"
  preview: string; // the diff, or the exact command line
}

export type NotifStatus = 'pending-widow' | 'awaiting-user' | 'approved' | 'denied' | 'dismissed';

export interface Notification {
  id: string;
  kind: 'permission' | 'budget' | 'disagreement' | 'info';
  title: string;
  body: string;
  channelId?: string;
  agentId?: string;
  status: NotifStatus;
  auditNote?: string;
  action?: ActionRequest;
  read: boolean;
  ts: number;
}

export interface Note {
  id: string;
  channelId: string;
  text: string;
  sourceMessageId?: string;
  ts: number;
  /** 'highlight' = a key decision or fact; 'note' = a running summary. Absent on older notes (treated as 'note'). */
  kind?: 'note' | 'highlight';
  /** Written automatically by Quill rather than by the user. */
  auto?: boolean;
  /** For auto notes: timestamp of the last message this note covers. */
  until?: number;
}

export interface Price { in: number; out: number } // USD per 1M tokens

export interface Settings {
  models: Record<Tier, string>;
  prices: Record<string, Price>; // keyed by model id (estimates, editable)
  dailyBudgetUsd: number;
  categoryBudgetUsd: number;
  turnCap: number;
  /** Quill automatically writes notes and highlights for each channel. */
  autoNotes: boolean;
  useMock: boolean;
  hasApiKey: boolean;
  /** Which vendors have a key saved (a flag only; the keys never leave the main process). */
  vendorKeys: Partial<Record<VendorId, boolean>>;
  /** Addresses for the vendors whose address the user sets (local, custom). */
  vendorUrls: Partial<Record<VendorId, string>>;
  /** Per model id: may it use tools? Absent = the vendor's default. */
  modelTools: Record<string, boolean>;
}

export interface Spend {
  date: string; // YYYY-MM-DD (local)
  usd: number;
  byCategory: Record<string, number>;
  /** Input tokens today that were served from the prompt cache, were written to it, or were billed in full. Lets you see that caching works. */
  cacheRead?: number;
  cacheWrite?: number;
  inputFresh?: number;
}

export interface Snapshot {
  agents: Agent[];
  categories: Category[];
  channels: Channel[];
  messages: Message[];
  notifications: Notification[];
  notes: Note[];
  settings: Settings;
  spend: Spend;
  busy: Record<string, boolean>; // channelId -> orchestration running
  mode: 'claude' | 'mock';
}

export const MODEL_CHOICES = [
  'claude-haiku-5-5',
  'claude-sonnet-5-5',
  'claude-opus-5-5',
  'claude-fable-5-2',
];
