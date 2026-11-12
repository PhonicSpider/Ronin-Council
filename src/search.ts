import type { Channel, Message, Snapshot } from '../shared/types';
import { SYSTEM_ID, USER_ID } from '../shared/types';

export interface SearchHit {
  message: Message;
  channel: Channel;
  authorName: string;
  /** The text around the first match, split so the match can be highlighted without injecting any markup. */
  before: string;
  match: string;
  after: string;
}

/** Words the user typed; a message must contain every one of them (any case, any order). */
export function searchTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
}

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Cut a readable window around `at`, on word edges where possible. */
export function snippetAround(text: string, at: number, len: number, before = 36, after = 84) {
  let start = Math.max(0, at - before);
  let end = Math.min(text.length, at + len + after);
  if (start > 0) { const sp = text.indexOf(' ', start); if (sp !== -1 && sp < at) start = sp + 1; }
  if (end < text.length) { const sp = text.lastIndexOf(' ', end); if (sp > at + len) end = sp; }
  return {
    before: (start > 0 ? '…' : '') + text.slice(start, at),
    match: text.slice(at, at + len),
    after: text.slice(at + len, end) + (end < text.length ? '…' : ''),
  };
}

/**
 * Search every channel's messages (newest first). System notes are skipped; tool rows are included so
 * "what did the agent run" can be found. Pure and free: it runs on the history already in the interface.
 */
export function searchMessages(snap: Pick<Snapshot, 'messages' | 'channels' | 'agents'>, query: string, limit = 40): SearchHit[] {
  const terms = searchTerms(query);
  if (!terms.length) return [];
  const channels = new Map(snap.channels.map((c) => [c.id, c]));
  const agents = new Map(snap.agents.map((a) => [a.id, a.name]));
  const hits: SearchHit[] = [];
  for (let i = snap.messages.length - 1; i >= 0 && hits.length < limit; i--) {
    const m = snap.messages[i]!;
    if (m.authorId === SYSTEM_ID || m.kind === 'system') continue;
    const channel = channels.get(m.channelId);
    if (!channel) continue;
    const text = flat(m.content);
    const low = text.toLowerCase();
    if (!terms.every((t) => low.includes(t))) continue;
    const first = terms.map((t) => low.indexOf(t)).reduce((a, b) => Math.min(a, b));
    const term = terms.find((t) => low.indexOf(t) === first)!;
    hits.push({
      message: m, channel,
      authorName: m.authorId === USER_ID ? 'You' : agents.get(m.authorId) ?? 'Unknown',
      ...snippetAround(text, first, term.length),
    });
  }
  // Messages are stored oldest-first, but sorting by time keeps this right if that ever changes.
  return hits.sort((a, b) => b.message.ts - a.message.ts);
}
