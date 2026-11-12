import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { Message } from '../shared/types';

/** Whether the "agent speaks" effect is on. The user can turn it off in Settings; it is also off for reduced-motion users. */
export function speakEnabled(): boolean {
  try {
    if (localStorage.getItem('rc.speak') === '0') return false;
  } catch { /* storage unavailable: leave it on */ }
  try {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return false;
  } catch { /* no matchMedia */ }
  return true;
}

export function setSpeakEnabled(on: boolean) {
  try { localStorage.setItem('rc.speak', on ? '1' : '0'); } catch { /* storage unavailable */ }
}

/** How long one message takes to "say": about 14 ms a character, between 0.6 s and 3.2 s; faster when many are waiting. */
export function speakDuration(chars: number, backlog = 0): number {
  const base = Math.min(3200, Math.max(600, chars * 14));
  return Math.round(backlog >= 3 ? base * 0.4 : backlog === 2 ? base * 0.6 : base);
}

/**
 * The first `fraction` of a message, cut at a word boundary so half-words do not flash up.
 * An unfinished code fence is closed so the partial text still renders as code.
 */
export function revealText(text: string, fraction: number): string {
  if (fraction >= 1) return text;
  let n = Math.max(0, Math.floor(text.length * fraction));
  if (n <= 0) return '';
  const space = text.lastIndexOf(' ', n);
  if (space > n - 14 && space > 0) n = space;
  let out = text.slice(0, n);
  if ((out.match(/```/g)?.length ?? 0) % 2 === 1) out += '\n```';
  return out;
}

/** Only an agent's own words are "spoken"; the user's messages, tool rows and system notes appear at once. */
export function isSpoken(m: Message, agentIds: ReadonlySet<string>): boolean {
  return agentIds.has(m.authorId) && m.kind !== 'tool' && m.kind !== 'system' && m.content.trim().length > 0;
}

export type SpeakPhase = 'speaking' | 'leaving' | null;

interface Cur { id: string; authorId: string; start: number; dur: number }

const LEAVE_MS = 450;

/**
 * Paces the agents' new messages. Messages already in the channel when it opens show at once. A message that
 * arrives afterwards is held back, then typed out while its author's portrait is shown; the next one waits its turn.
 */
export function useSpeaker(channelId: string, msgs: Message[], agentIds: ReadonlySet<string>, enabled: boolean) {
  const released = useRef(new Set<string>());
  const cur = useRef<Cur | null>(null);
  const leaveUntil = useRef(0);
  const lastAuthor = useRef<string | null>(null);
  const chan = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const [, bump] = useReducer((n: number) => n + 1, 0);

  const msgsRef = useRef(msgs); msgsRef.current = msgs;
  const idsRef = useRef(agentIds); idsRef.current = agentIds;
  const enabledRef = useRef(enabled); enabledRef.current = enabled;

  if (chan.current !== channelId) {
    chan.current = channelId;
    released.current = new Set(msgs.map((m) => m.id));
    cur.current = null;
    leaveUntil.current = 0;
    lastAuthor.current = null;
  }

  const pending = () => msgsRef.current.filter((m) => !released.current.has(m.id) && isSpoken(m, idsRef.current));

  const step = useCallback(() => {
    const now = performance.now();
    if (!enabledRef.current) {
      for (const m of msgsRef.current) released.current.add(m.id);
      cur.current = null;
      leaveUntil.current = 0;
    }
    if (cur.current && now >= cur.current.start + cur.current.dur) {
      released.current.add(cur.current.id);
      cur.current = null;
      leaveUntil.current = now + LEAVE_MS;
    }
    if (!cur.current) {
      const next = pending();
      if (next.length) {
        const m = next[0]!;
        cur.current = { id: m.id, authorId: m.authorId, start: now, dur: speakDuration(m.content.length, next.length - 1) };
        lastAuthor.current = m.authorId;
        leaveUntil.current = 0;
      }
    }
    const active = !!cur.current || now < leaveUntil.current;
    if (active && !timer.current) timer.current = setInterval(step, 50);
    if (!active && timer.current) { clearInterval(timer.current); timer.current = null; }
    bump();
  }, []);

  useEffect(() => { step(); }, [msgs, enabled, channelId, step]);
  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);

  /** Finish the line being spoken right now. */
  const skip = useCallback(() => { if (cur.current) { cur.current.start = -1e9; step(); } }, [step]);
  /** Show everything waiting at once (used when the user sends a message). */
  const flush = useCallback(() => {
    for (const m of msgsRef.current) released.current.add(m.id);
    cur.current = null;
    step();
  }, [step]);

  // What to draw this render: everything released, then the message being spoken (part of it), then nothing more.
  const now = performance.now();
  const shown: Message[] = [];
  for (const m of msgs) {
    if (released.current.has(m.id)) { shown.push(m); continue; }
    const c = cur.current;
    if (c && c.id === m.id) {
      shown.push({ ...m, content: revealText(m.content, (now - c.start) / c.dur) });
      break;
    }
    if (enabled && isSpoken(m, agentIds)) break;
    shown.push(m);
  }
  const phase: SpeakPhase = cur.current ? 'speaking' : now < leaveUntil.current ? 'leaving' : null;
  return { shown, speakerId: phase ? (cur.current?.authorId ?? lastAuthor.current) : null, phase, skip, flush };
}
