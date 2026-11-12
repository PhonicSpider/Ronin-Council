import { useEffect, useRef, useState } from 'react';
import type { Channel, Snapshot } from '../../shared/types';
import { act, toast } from '../api';
import { ViewerItem, normalizeUrl, timeStr } from '../util';

export type ViewerTab = 'view' | 'browser' | 'vault';

interface Props {
  snap: Snapshot;
  channel: Channel;
  tab: ViewerTab;
  setTab: (t: ViewerTab) => void;
  item: ViewerItem | null;
  setItem: (i: ViewerItem | null) => void;
  ratio: number;
  setRatio: (r: number) => void;
}

interface WebviewEl extends HTMLElement {
  goBack(): void; goForward(): void; reload(): void; loadURL(u: string): Promise<void>;
}

function Browser() {
  const [url, setUrl] = useState('');
  const [src, setSrc] = useState('');
  const ref = useRef<WebviewEl | null>(null);
  const go = () => {
    const u = normalizeUrl(url);
    if (!u) { setSrc(''); return; }
    setUrl(u);
    setSrc(u);
  };
  const safe = (fn: (w: WebviewEl) => void) => { try { if (ref.current) fn(ref.current); } catch { /* not ready yet */ } };
  return (
    <div className="browser">
      <div className="browser-bar">
        <button className="btn sm" onClick={() => safe((w) => w.goBack())} title="Back">‹</button>
        <button className="btn sm" onClick={() => safe((w) => w.goForward())} title="Forward">›</button>
        <button className="btn sm" onClick={() => safe((w) => w.reload())} title="Reload">⟳</button>
        <input value={url} placeholder="Enter a web address (http/https)" data-testid="browser-url"
          onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') go(); }} />
        <button className="btn sm primary" onClick={go}>Go</button>
      </div>
      {src ? (
        <webview ref={ref as never} src={src} className="webview" data-testid="webview" />
      ) : (
        <div className="empty small">Open a page to test it here. Only http and https addresses are allowed.</div>
      )}
    </div>
  );
}

function Vault({ snap, channel, onOpen }: { snap: Snapshot; channel: Channel; onOpen: (i: ViewerItem) => void }) {
  const cats = [...snap.categories].sort((a, b) => a.order - b.order);
  const [catId, setCatId] = useState(channel.categoryId ?? cats[0]?.id ?? '');
  const [files, setFiles] = useState<string[]>([]);
  const [path, setPath] = useState('');
  useEffect(() => { if (channel.categoryId) setCatId(channel.categoryId); }, [channel.categoryId]);
  const load = () => {
    if (!catId) return;
    void act<string[]>('vaultList', catId).then((f) => setFiles(f ?? []));
    void act<string>('vaultPath', catId).then((p) => setPath(p ?? ''));
  };
  useEffect(load, [catId]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="vault">
      <div className="vault-bar">
        <select value={catId} onChange={(e) => setCatId(e.target.value)} data-testid="vault-select">
          {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <button className="btn sm" onClick={load}>Reload</button>
        <button className="btn sm" data-testid="refresh-index" title="Librarian rewrites _Other Vaults.md in every vault"
          onClick={async () => {
            const n = await act<number>('refreshVaultIndex');
            if (n !== undefined) { load(); }
          }}>Refresh index</button>
      </div>
      <div className="muted path" title={path}>{path}</div>
      <div className="file-list">
        {files.length === 0 && <div className="empty small">No notes in this vault yet.</div>}
        {files.map((f) => (
          <button key={f} className="file" onClick={async () => {
            const r = await act<{ name: string; kind: 'text' | 'image'; content: string }>('vaultRead', catId, f);
            if (r) onOpen({ kind: r.kind === 'image' ? 'image' : 'text', title: f, content: r.content });
          }}>{f}</button>
        ))}
      </div>
    </div>
  );
}

function Notes({ snap, channel }: { snap: Snapshot; channel: Channel }) {
  const [text, setText] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const notes = snap.notes.filter((n) => n.channelId === channel.id).sort((a, b) => b.ts - a.ts);
  const add = async () => {
    if (!text.trim()) return;
    const t = text;
    setText('');
    await act('addNote', channel.id, t);
  };
  return (
    <div className="notes">
      <div className="panel-title">
        <span>Notes &amp; highlights <span className="muted">#{channel.name}</span></span>
        <button className="btn sm" data-testid="refresh-notes" disabled={refreshing} title="Ask Quill to write notes for what has happened since her last ones"
          onClick={() => {
            setRefreshing(true);
            void act<number>('refreshNotes', channel.id)
              .then((n) => toast(n ? 'Quill added notes' : 'Nothing new to note'))
              .finally(() => setRefreshing(false));
          }}>{refreshing ? 'Quill is writing…' : 'Ask Quill'}</button>
      </div>
      <div className="note-list" data-testid="note-list">
        {notes.length === 0 && <div className="empty small">Quill writes notes and highlights here as the channel gets going. You can also pin a message or jot your own.</div>}
        {notes.map((n) => (
          <div className={`note${n.kind === 'highlight' ? ' highlight' : ''}`} key={n.id} data-testid="note">
            <div className="note-text">{n.text}</div>
            <div className="note-meta">
              <span className="muted">
                {n.auto ? <b className="by-quill">Quill</b> : 'You'} · {n.kind === 'highlight' ? 'highlight' : 'note'} · {timeStr(n.ts)}
              </span>
              <button title="Delete note" onClick={() => void act('deleteNote', n.id)}>✕</button>
            </div>
          </div>
        ))}
      </div>
      <div className="note-add">
        <textarea rows={2} value={text} placeholder="Add a note…" data-testid="note-input"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void add(); } }} />
        <button className="btn sm" onClick={() => void add()}>Add</button>
      </div>
    </div>
  );
}

export function RightPanel({ snap, channel, tab, setTab, item, setItem, ratio, setRatio }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const move = (ev: MouseEvent) => {
      const r = wrap.current?.getBoundingClientRect();
      if (!r) return;
      setRatio(Math.min(0.8, Math.max(0.2, (ev.clientY - r.top) / r.height)));
    };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  return (
    <aside className="right" ref={wrap} data-testid="right-panel">
      <section className="viewer" style={{ flexBasis: `${ratio * 100}%` }}>
        <div className="tabs">
          {(['view', 'browser', 'vault'] as ViewerTab[]).map((t) => (
            <button key={t} className={`tab${tab === t ? ' active' : ''}`} data-testid={`tab-${t}`} onClick={() => setTab(t)}>
              {t === 'view' ? 'Viewer' : t === 'browser' ? 'Browser' : 'Vault'}
            </button>
          ))}
          {item && tab === 'view' && <button className="tab-clear" title="Clear" onClick={() => setItem(null)}>✕</button>}
        </div>
        <div className="viewer-body">
          {tab === 'view' && (
            !item ? (
              <div className="empty small" data-testid="viewer-empty">
                Code, images and files appear here. Use “View in panel” on a code block, or open a note from the Vault tab.
              </div>
            ) : (
              <div className="viewer-item" data-testid="viewer-item">
                <div className="viewer-title">{item.title}</div>
                {item.kind === 'image' ? <img src={item.content} alt={item.title} /> : <pre>{item.content}</pre>}
              </div>
            )
          )}
          {tab === 'browser' && <Browser />}
          {tab === 'vault' && <Vault snap={snap} channel={channel} onOpen={(i) => { setItem(i); setTab('view'); }} />}
        </div>
      </section>
      <div className="divider" onMouseDown={startDrag} role="separator" aria-orientation="horizontal" />
      <section className="notes-wrap" style={{ flexBasis: `${(1 - ratio) * 100}%` }}>
        <Notes snap={snap} channel={channel} />
      </section>
    </aside>
  );
}
