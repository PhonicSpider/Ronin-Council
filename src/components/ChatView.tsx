import { useEffect, useMemo, useRef, useState } from 'react';
import type { Agent, Attachment, Channel, Message, Snapshot } from '../../shared/types';
import { LIMITS, SYSTEM_ID, USER_ID, WIDOW_ID } from '../../shared/types';
import { act, toast } from '../api';
import { ACCEPT, Pending, fmtSize, prepareFiles } from '../attach';
import { ViewerItem, escapeRe, parseBlocks, timeStr } from '../util';
import { renderMarkdown } from '../markdown';
import { Avatar } from './Avatar';
import { speakEnabled, useSpeaker } from '../speak';
import { Roster } from './Roster';
import { Spotlight } from './Spotlight';

interface Props {
  snap: Snapshot;
  channel: Channel;
  panelOpen: boolean;
  onTogglePanel: () => void;
  onOpenAgent: (id: string) => void;
  onView: (item: ViewerItem) => void;
  onOpenSettings: () => void;
  /** Scroll to (and briefly highlight) this message; `n` changes on every request so the same message can be asked for twice. */
  jumpTo?: { id: string; n: number } | null;
}

const YOU = { name: 'You', color: '#5a5f69' };

function renderMentions(text: string, names: string[]) {
  if (!names.length) return text;
  const re = new RegExp(`(@(?:${names.map(escapeRe).join('|')})(?![A-Za-z0-9_-]))`, 'gi');
  // split() with one capture group puts every match at an odd index.
  return text.split(re).map((part, i) => (i % 2 === 1 ? <span key={i} className="mention">{part}</span> : part));
}

function Body({ text, names, onView }: { text: string; names: string[]; onView: (i: ViewerItem) => void }) {
  return (
    <div className="msg-body">
      {parseBlocks(text).map((b, i) =>
        b.type === 'code' ? (
          <div className="codeblock" key={i}>
            <div className="code-head">
              <span>{b.lang || 'code'}</span>
              <span>
                <button onClick={() => onView({ kind: 'code', title: b.lang || 'code', content: b.code })}>View in panel</button>
                <button onClick={() => {
                  navigator.clipboard.writeText(b.code).then(() => toast('Copied'), () => toast('Could not copy'));
                }}>Copy</button>
              </span>
            </div>
            <pre>{b.code}</pre>
          </div>
        ) : (
          <div className="md" key={i}>{renderMarkdown(b.text, (t) => renderMentions(t, names))}</div>
        ),
      )}
    </div>
  );
}

function MembersMenu({ snap, channel, onClose }: { snap: Snapshot; channel: Channel; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [onClose]);
  return (
    <div className="popover members-menu" ref={ref} data-testid="members-menu">
      <div className="popover-title">Channel members</div>
      {snap.agents.map((a) => {
        const on = channel.memberIds.includes(a.id);
        return (
          <label key={a.id} className="member-row">
            <input type="checkbox" checked={on} disabled={a.id === WIDOW_ID}
              onChange={(e) => void act('setMember', channel.id, a.id, e.target.checked)} />
            <Avatar agent={a} size={22} />
            <span>{a.name}</span>
            <span className="muted">{a.role}</span>
          </label>
        );
      })}
    </div>
  );
}

export function ChatView({ snap, channel, panelOpen, onTogglePanel, onOpenAgent, onView, onOpenSettings, jumpTo }: Props) {
  const agentMap = useMemo(() => new Map(snap.agents.map((a) => [a.id, a])), [snap.agents]);
  const members = channel.memberIds.map((id) => agentMap.get(id)).filter((a): a is Agent => !!a);
  const names = members.map((a) => a.name);
  const allMsgs = useMemo(() => snap.messages.filter((m) => m.channelId === channel.id), [snap.messages, channel.id]);
  const agentIds = useMemo(() => new Set(snap.agents.map((a) => a.id)), [snap.agents]);
  const speaker = useSpeaker(channel.id, allMsgs, agentIds, speakEnabled());
  const msgs = speaker.shown;
  const speaking = speaker.speakerId ? agentMap.get(speaker.speakerId) : undefined;
  const category = snap.categories.find((c) => c.id === channel.categoryId);
  const busy = !!snap.busy[channel.id];
  const working = members.filter((a) => a.status === 'thinking' || a.status === 'reviewing');
  // A category's #general also shows the approval requests of the teams working in its other channels, so none waits unseen.
  const scope = new Set(channel.kind === 'general' && channel.categoryId
    ? snap.channels.filter((c) => c.categoryId === channel.categoryId).map((c) => c.id)
    : [channel.id]);
  const cards = snap.notifications.filter(
    (n) => !!n.channelId && scope.has(n.channelId) && (n.status === 'awaiting-user' || n.status === 'pending-widow'),
  );

  const listRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => { stick.current = true; }, [channel.id]);
  useEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [msgs.length, msgs[msgs.length - 1]?.content.length, channel.id, cards.length, working.length]);

  // Jump from a search result: wait a moment so a channel switch has drawn its messages, then scroll and flash the row.
  useEffect(() => {
    if (!jumpTo) return;
    const t = window.setTimeout(() => {
      const el = listRef.current?.querySelector<HTMLElement>(`[data-mid="${CSS.escape(jumpTo.id)}"]`);
      if (!el) return;
      stick.current = false;
      el.scrollIntoView({ block: 'center' });
      el.classList.remove('flash');
      void el.offsetWidth; // restart the animation if it is already running
      el.classList.add('flash');
      window.setTimeout(() => el.classList.remove('flash'), 2200);
    }, 80);
    return () => window.clearTimeout(t);
  }, [jumpTo]);

  const [text, setText] = useState('');
  const [menu, setMenu] = useState(false);
  const [mq, setMq] = useState<string | null>(null);
  const [sel, setSel] = useState(0);
  const ta = useRef<HTMLTextAreaElement>(null);
  const candidates = mq === null ? [] : members.filter((a) => a.name.toLowerCase().startsWith(mq.toLowerCase()));

  // Keep an unsent draft per channel so switching channels does not lose what was typed.
  const drafts = useRef(new Map<string, string>());
  const textRef = useRef('');
  textRef.current = text;
  const [pending, setPending] = useState<Pending[]>([]);
  const pendingRef = useRef<Pending[]>([]);
  pendingRef.current = pending;
  const pendingDrafts = useRef(new Map<string, Pending[]>());
  const channelRef = useRef(channel.id);
  channelRef.current = channel.id;
  useEffect(() => {
    setText(drafts.current.get(channel.id) ?? '');
    setPending(pendingDrafts.current.get(channel.id) ?? []);
    setMq(null);
    setMenu(false);
    const id = channel.id;
    return () => {
      drafts.current.set(id, textRef.current);
      pendingDrafts.current.set(id, pendingRef.current);
    };
  }, [channel.id]);

  // ----- attachments: the + button, drag and drop from the file explorer, and pasted images -----
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const addFiles = async (files: File[]) => {
    if (!files.length) return;
    const forChannel = channel.id;
    const room = LIMITS.attachMaxFiles - pendingRef.current.length;
    if (room <= 0) { toast(`Up to ${LIMITS.attachMaxFiles} files per message`); return; }
    const { ok, errors } = await prepareFiles(files, room);
    if (channelRef.current !== forChannel) return; // switched channels while the files were being read
    if (ok.length) setPending((p) => [...p, ...ok]);
    if (errors.length) toast(errors[0]! + (errors.length > 1 ? ` (+${errors.length - 1} more)` : ''));
  };
  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes('Files');

  const updateMention = (value: string, caret: number) => {
    const m = /@([\w-]*)$/.exec(value.slice(0, caret));
    setMq(m ? m[1] : null);
    setSel(0);
  };

  const insertMention = (a: Agent) => {
    const el = ta.current;
    if (!el) return;
    const caret = el.selectionStart;
    const before = text.slice(0, caret).replace(/@([\w-]*)$/, `@${a.name} `);
    const next = before + text.slice(caret);
    setText(next);
    setMq(null);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(before.length, before.length); });
  };

  const send = async () => {
    const t = text.trim();
    const staged = pending;
    if (!t && !staged.length) return;
    setText('');
    setPending([]);
    setMq(null);
    stick.current = true;
    speaker.flush(); // show anything still being spoken, so your message lands after it
    const files = staged.map(({ name, mime, data, thumb }) => ({ name, mime, data, thumb }));
    const ok = await act('sendMessage', channel.id, t, files);
    // A rejected send (e.g. a file failed validation) puts the draft back instead of losing it.
    if (ok === undefined && channelRef.current === channel.id) {
      if (!textRef.current) setText(t);
      if (!pendingRef.current.length) setPending(staged);
    }
  };

  const authorOf = (id: string) =>
    id === USER_ID ? YOU : agentMap.get(id) ?? { name: 'Removed agent', color: '#444', image: undefined };

  const title = channel.kind === 'dm' ? 'Widow' : channel.name;

  return (
    <main className="chat" data-testid="chat"
      onDragEnter={(e) => { if (hasFiles(e)) { e.preventDefault(); dragDepth.current++; setDragging(true); } }}
      onDragOver={(e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }}
      onDragLeave={(e) => { if (hasFiles(e) && --dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false); } }}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        dragDepth.current = 0; setDragging(false);
        void addFiles(Array.from(e.dataTransfer.files));
        ta.current?.focus();
      }}>
      {dragging && (
        <div className="drop-veil" data-testid="drop-veil">
          <div className="drop-card">
            <strong>Drop to attach</strong>
            <span>Images and text files · up to {LIMITS.attachMaxFiles} per message</span>
          </div>
        </div>
      )}
      <header className="chat-header">
        <div className="chat-title">
          <span className="hash">{channel.kind === 'dm' ? '♛' : '#'}</span>
          <strong data-testid="channel-title">{title}</strong>
          {category && <span className="muted">{category.name}</span>}
          {category && (category.projectPath
            ? <span className="pill deliverable" title={category.projectPath} data-testid="project-pill">Project linked</span>
            : <span className="muted small" title="Set a project folder in Settings → Vaults &amp; Projects to let agents work on files">talk-only</span>)}
        </div>
        <div className="chat-tools">
          {channel.kind !== 'dm' && (
            <div className="menu-anchor">
              <button className="btn" data-testid="members-btn" onClick={() => setMenu((v) => !v)}>
                Members ({members.length})
              </button>
              {menu && <MembersMenu snap={snap} channel={channel} onClose={() => setMenu(false)} />}
            </div>
          )}
          <button className="btn" onClick={onTogglePanel} title="Show or hide the side panel">
            {panelOpen ? 'Hide panel' : 'Show panel'}
          </button>
        </div>
      </header>

      <Roster members={members} speakerId={speaker.phase === 'speaking' ? speaker.speakerId : null} onOpenAgent={onOpenAgent} />

      {snap.mode === 'mock' && (
        <div className="banner" data-testid="mock-banner">
          Mock mode: agents give simulated replies and nothing is billed.
          <button className="link" onClick={onOpenSettings}>Add an API key</button> to talk to the real agents.
          {category?.projectPath && <> Try “@Hex !tool write hello.txt hi there” to see the approval flow.</>}
        </div>
      )}

      <div className="messages" ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}>
        {msgs.length === 0 && (
          <div className="empty">
            <h3>{channel.kind === 'dm' ? 'Your private line to Widow' : `Welcome to #${channel.name}`}</h3>
            <p>
              {channel.kind === 'dm'
                ? 'Ask her anything about the team, the standards, or the vaults.'
                : 'Say something and Widow will route it to the right specialist, or @mention an agent to talk to them directly.'}
            </p>
          </div>
        )}
        {msgs.map((m, i) => (
          <MessageRow key={m.id} m={m} prev={msgs[i - 1]} all={msgs} author={authorOf(m.authorId)}
            agentMap={agentMap} names={names} snap={snap} channel={channel}
            onOpenAgent={onOpenAgent} onView={onView} />
        ))}
      </div>

      <div className="below">
        {speaking && speaker.phase && <Spotlight key={speaking.id} agent={speaking} phase={speaker.phase} onSkip={speaker.skip} />}
        {cards.map((n) => (
          <div className={`card ${n.status}`} key={n.id} data-testid="permission-card">
            <div className="card-title">{n.title}{n.channelId !== channel.id && <span className="muted card-where"> · in #{snap.channels.find((c) => c.id === n.channelId)?.name}</span>}</div>
            <div className="card-body">{n.body}</div>
            {n.action && <pre className="preview" data-testid="action-preview">{n.action.preview}</pre>}
            {n.status === 'pending-widow' ? (
              <div className="card-note">Widow is auditing this request…</div>
            ) : (
              <>
                {n.auditNote && <div className="card-note"><strong>Widow:</strong> {n.auditNote}</div>}
                <div className="card-actions">
                  {n.kind === 'permission' ? (
                    <>
                      <button className="btn primary" data-testid="approve" onClick={() => void act('resolveNotification', n.id, true)}>Approve</button>
                      <button className="btn danger" data-testid="deny" onClick={() => void act('resolveNotification', n.id, false)}>Deny</button>
                    </>
                  ) : (
                    <button className="btn" onClick={() => void act('dismissNotification', n.id)}>Dismiss</button>
                  )}
                </div>
              </>
            )}
          </div>
        ))}

        <div className="typing" data-testid="typing">
          {working.length > 0
            ? `${working.map((a) => a.name).join(', ')} ${working.length > 1 ? 'are' : 'is'} ${working.some((a) => a.status === 'reviewing') ? 'reviewing' : 'thinking'}…`
            : busy ? 'Working…' : ''}
        </div>

        <div className="composer">
          {pending.length > 0 && (
            <div className="chips" data-testid="pending-files">
              {pending.map((p) => (
                <div className="chip" key={p.id} data-testid="pending-file" title={`${p.name} · ${fmtSize(p.size)}`}>
                  {p.kind === 'image' && p.thumb ? <img src={p.thumb} alt="" /> : <span className="chip-badge">{p.kind === 'image' ? 'IMG' : (/\.([A-Za-z0-9]+)$/.exec(p.name)?.[1] ?? 'TXT').slice(0, 4).toUpperCase()}</span>}
                  <span className="chip-name">{p.name}</span>
                  <span className="muted chip-size">{fmtSize(p.size)}</span>
                  <button aria-label={`Remove ${p.name}`} onClick={() => setPending((l) => l.filter((x) => x.id !== p.id))}>✕</button>
                </div>
              ))}
            </div>
          )}
          <input ref={fileInput} type="file" hidden multiple accept={ACCEPT} data-testid="attach-input"
            onChange={(e) => { void addFiles(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
          <button className="attach-btn" data-testid="attach-btn" title="Attach images or text files" aria-label="Attach files"
            onClick={() => fileInput.current?.click()}>+</button>
          {candidates.length > 0 && (
            <div className="popover mention-menu" data-testid="mention-menu">
              {candidates.map((a, i) => (
                <div key={a.id} className={`mention-row${i === sel ? ' sel' : ''}`}
                  onMouseDown={(e) => { e.preventDefault(); insertMention(a); }}>
                  <Avatar agent={a} size={20} /> <strong>{a.name}</strong> <span className="muted">{a.role}</span>
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={ta} rows={1} value={text} data-testid="composer"
            placeholder={channel.kind === 'dm' ? 'Message Widow' : `Message #${channel.name} — @mention an agent, or let Widow route`}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.files);
              if (files.length) { e.preventDefault(); void addFiles(files); }
            }}
            onChange={(e) => { setText(e.target.value); updateMention(e.target.value, e.target.selectionStart); }}
            onKeyDown={(e) => {
              if (candidates.length) {
                if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => (s + 1) % candidates.length); return; }
                if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => (s - 1 + candidates.length) % candidates.length); return; }
                if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); insertMention(candidates[sel]); return; }
                if (e.key === 'Escape') { setMq(null); return; }
              }
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); }
            }}
          />
          {busy && <button className="btn danger" data-testid="stop" onClick={() => void act('stop', channel.id)}>Stop</button>}
          <button className="btn primary" data-testid="send" onClick={() => void send()} disabled={!text.trim() && pending.length === 0}>Send</button>
        </div>
      </div>
    </main>
  );
}

function AttachmentChip({ a, onView }: { a: Attachment; onView: (i: ViewerItem) => void }) {
  const open = async () => {
    const r = await act<{ name: string; kind: 'image' | 'text'; content: string }>('attachmentRead', a.id);
    if (r) onView({ kind: r.kind === 'image' ? 'image' : 'text', title: r.name, content: r.content });
  };
  return (
    <button className={`att ${a.kind}`} onClick={() => void open()} title={`${a.name} · ${fmtSize(a.size)} — open in the side panel`} data-testid="attachment">
      {a.kind === 'image' && a.thumb
        ? <img src={a.thumb} alt={a.name} />
        : <span className="chip-badge">{a.kind === 'image' ? 'IMG' : (/\.([A-Za-z0-9]+)$/.exec(a.name)?.[1] ?? 'TXT').slice(0, 4).toUpperCase()}</span>}
      <span className="att-name">{a.name}</span>
    </button>
  );
}

interface RowProps {
  m: Message; prev?: Message; all: Message[];
  author: { name: string; color: string; image?: string };
  agentMap: Map<string, Agent>; names: string[]; snap: Snapshot; channel: Channel;
  onOpenAgent: (id: string) => void; onView: (i: ViewerItem) => void;
}

function MessageRow({ m, prev, all, author, agentMap, names, channel, onOpenAgent, onView }: RowProps) {
  if (m.authorId === SYSTEM_ID) {
    return <div className="sys-msg" data-testid="message" data-mid={m.id}>{m.content}</div>;
  }
  if (m.kind === 'tool') {
    return (
      <div className="tool-row" data-testid="message" data-kind="tool" data-mid={m.id}>
        <span className="tool-dot" style={{ background: author.color }} />
        <details>
          <summary>{m.content}</summary>
          {m.detail && <pre>{m.detail}</pre>}
        </details>
      </div>
    );
  }
  const head = !prev || prev.authorId !== m.authorId || m.ts - prev.ts > 5 * 60_000 || prev.kind === 'system' || m.kind !== 'chat' || prev.kind !== 'chat';
  const reviewed = m.reviewOf ? all.find((x) => x.id === m.reviewOf) : undefined;
  const isAgent = m.authorId !== USER_ID && agentMap.has(m.authorId);
  return (
    <div className={`msg${head ? ' head' : ''}${m.authorId === USER_ID ? ' mine' : ''}`} data-testid="message" data-kind={m.kind} data-mid={m.id}
      style={{ '--agent': author.color } as React.CSSProperties}>
      <div className="msg-gutter">
        {head ? (
          <Avatar agent={author} size={38} onClick={isAgent ? () => onOpenAgent(m.authorId) : undefined} />
        ) : (
          <span className="msg-time">{timeStr(m.ts)}</span>
        )}
      </div>
      <div className="msg-main">
        {head && (
          <div className="msg-meta">
            <strong style={{ color: author.color }}>{author.name}</strong>
            {m.kind === 'deliverable' && <span className="pill deliverable">Deliverable</span>}
            {m.kind === 'review' && (
              <>
                <span className={`pill ${m.verdict}`}>{m.verdict}</span>
                <span className="muted">reviewing {reviewed ? `${agentMap.get(reviewed.authorId)?.name ?? 'a'}'s` : 'a'} deliverable</span>
              </>
            )}
            {m.kind === 'decision' && <span className="pill decision">Widow's decision</span>}
            <span className="muted">{timeStr(m.ts)}</span>
          </div>
        )}
        {!(m.attachments?.length && /^\(attached .*\)$/.test(m.content)) && <Body text={m.content} names={names} onView={onView} />}
        {m.attachments && m.attachments.length > 0 && (
          <div className="msg-files" data-testid="msg-files">
            {m.attachments.map((a) => <AttachmentChip key={a.id} a={a} onView={onView} />)}
          </div>
        )}
        <div className="msg-tools">
          <button title="Pin to notes" onClick={() => {
            void act('addNote', channel.id, m.content.slice(0, 600), m.id).then(() => toast('Pinned to notes'));
          }}>Pin</button>
        </div>
      </div>
    </div>
  );
}
