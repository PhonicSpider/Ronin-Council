import { useEffect, useMemo, useRef, useState } from 'react';
import type { Snapshot } from '../../shared/types';
import { searchMessages } from '../search';

const MAGNIFIER = 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-4.3-4.3';

/** A magnifying glass that opens a search bar over the top bar; results are every channel's messages, newest first. */
export function SearchBox({ snap, onJump }: { snap: Snapshot; onJump: (channelId: string, messageId: string) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const hits = useMemo(() => (open ? searchMessages(snap, q) : []), [open, snap, q]);

  const close = () => { setOpen(false); setQ(''); setSel(0); };
  const go = (i: number) => {
    const h = hits[i];
    if (!h) return;
    onJump(h.channel.id, h.message.id);
    close();
  };

  useEffect(() => { if (open) input.current?.focus(); }, [open]);
  // Ctrl+F opens the search from anywhere.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && !e.shiftKey && !e.altKey) { e.preventDefault(); setOpen(true); input.current?.select(); }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);
  useEffect(() => { setSel(0); }, [q]);

  return (
    <>
      <button className="icon-btn" title="Search all chats (Ctrl+F)" data-testid="open-search" onClick={() => setOpen(true)}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
          strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={MAGNIFIER} /></svg>
      </button>
      {open && (
        <div className="search-bar" data-testid="search-bar">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
            strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={MAGNIFIER} /></svg>
          <input ref={input} value={q} data-testid="search-input" placeholder="Search all chats…" aria-label="Search all chats"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') close();
              else if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(hits.length - 1, s + 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
              else if (e.key === 'Enter') go(sel);
            }} />
          <button className="search-x" title="Close search" data-testid="search-close" onClick={close}>×</button>
          {q.trim() && (
            <div className="popover search-results" data-testid="search-results" role="listbox">
              {hits.length === 0 && <div className="muted search-none">No messages match.</div>}
              {hits.map((h, i) => (
                <button key={h.message.id} role="option" aria-selected={i === sel} data-testid="search-hit"
                  className={`search-hit${i === sel ? ' sel' : ''}`} onMouseEnter={() => setSel(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => go(i)}>
                  <span className="search-where">
                    {h.channel.kind === 'dm' ? 'Widow' : `#${h.channel.name}`} · {h.authorName} · {new Date(h.message.ts).toLocaleDateString()}
                  </span>
                  <span className="search-snip">{h.before}<mark>{h.match}</mark>{h.after}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}
