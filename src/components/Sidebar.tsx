import { useRef, useState } from 'react';
import type { Category, Channel, Snapshot } from '../../shared/types';
import { act } from '../api';
import { SearchBox } from './SearchBox';

interface Props {
  snap: Snapshot;
  selectedId: string;
  unread: number;
  onSelect: (id: string) => void;
  onSettings: () => void;
  onCategorySettings: (categoryId: string) => void;
  onJump: (channelId: string, messageId: string) => void;
  onNotifs: () => void;
  onWidow: () => void;
  widowActive: boolean;
}

type Drag = { type: 'cat'; id: string } | { type: 'chan'; id: string; categoryId: string | null };

function Icon({ d }: { d: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
  );
}
const GEAR = 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z';
const BELL = 'M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9zM13.7 21a2 2 0 0 1-3.4 0';
/** Each category gets its own accent, picked by position, so the tree reads at a glance. */
const CAT_COLORS = ['#e5484d', '#4cc9e6', '#e8b04a', '#9a7cf0', '#5fd08f', '#f07ab0'];

const CROWN = 'M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5L3 8z';

function InlineInput({ initial = '', placeholder, onSubmit, onCancel }: {
  initial?: string; placeholder?: string; onSubmit: (v: string) => void; onCancel: () => void;
}) {
  const [v, setV] = useState(initial);
  return (
    <input
      className="inline-input" autoFocus value={v} placeholder={placeholder} data-testid="inline-input"
      onChange={(e) => setV(e.target.value)}
      onBlur={onCancel}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && v.trim()) onSubmit(v.trim());
        if (e.key === 'Escape') onCancel();
      }}
    />
  );
}

export function Sidebar({ snap, selectedId, unread, onSelect, onSettings, onCategorySettings, onJump, onNotifs, onWidow, widowActive }: Props) {
  const cats = [...snap.categories].sort((a, b) => a.order - b.order);
  const drag = useRef<Drag | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null); // 'cat:<id>' | 'chan:<id>'
  const [adding, setAdding] = useState<string | null>(null); // 'cat' | 'chan:<categoryId>'

  const channelsOf = (c: Category) =>
    snap.channels.filter((ch) => ch.categoryId === c.id).sort((a, b) => a.order - b.order);

  const endDrag = () => { drag.current = null; setOver(null); };

  const catHandlers = (c: Category, index: number) => ({
    draggable: editing !== `cat:${c.id}`,
    onDragStart: (e: React.DragEvent) => {
      drag.current = { type: 'cat', id: c.id };
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', c.id);
    },
    onDragOver: (e: React.DragEvent) => {
      if (drag.current?.type === 'cat' && drag.current.id !== c.id) { e.preventDefault(); setOver(`cat:${c.id}`); }
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      const d = drag.current;
      endDrag();
      if (d?.type === 'cat' && d.id !== c.id) void act('moveCategory', d.id, index);
    },
    onDragEnd: endDrag,
  });

  // A channel only accepts drops from siblings in the same category; elsewhere the cursor shows "not allowed".
  const chanHandlers = (ch: Channel, index: number) => ({
    draggable: editing !== `chan:${ch.id}`,
    onDragStart: (e: React.DragEvent) => {
      drag.current = { type: 'chan', id: ch.id, categoryId: ch.categoryId };
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', ch.id);
    },
    onDragOver: (e: React.DragEvent) => {
      const d = drag.current;
      if (d?.type === 'chan' && d.id !== ch.id && d.categoryId === ch.categoryId) {
        e.preventDefault();
        setOver(`chan:${ch.id}`);
      }
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      const d = drag.current;
      endDrag();
      if (d?.type === 'chan' && d.id !== ch.id && d.categoryId === ch.categoryId) void act('moveChannel', d.id, index);
    },
    onDragEnd: endDrag,
  });

  return (
    <aside className="sidebar" data-testid="sidebar">
      <div className="topbar">
        <button className="icon-btn" title="Settings" data-testid="open-settings" onClick={onSettings}>
          <Icon d={GEAR} />
        </button>
        <button className="icon-btn" title="Notifications" data-testid="open-notifications" onClick={onNotifs}>
          <Icon d={BELL} />
          {unread > 0 && <span className="badge" data-testid="notif-badge">{unread > 9 ? '9+' : unread}</span>}
        </button>
        <SearchBox snap={snap} onJump={onJump} />
        <button className={`icon-btn${widowActive ? ' active' : ''}`} title="Chat with Widow"
          data-testid="open-widow" onClick={onWidow}>
          <Icon d={CROWN} />
        </button>
      </div>

      <div className="tree">
        {cats.map((c, ci) => {
          const chans = channelsOf(c);
          return (
            <div key={c.id} className="category" data-testid="category"
              style={{ '--cat': CAT_COLORS[ci % CAT_COLORS.length] } as React.CSSProperties}>
              <div
                className={`cat-header${over === `cat:${c.id}` ? ' drop' : ''}`}
                {...catHandlers(c, ci)}
              >
                <button className="chev" onClick={() => void act('toggleCollapse', c.id)}
                  aria-label={c.collapsed ? 'Expand' : 'Collapse'} data-testid="collapse">
                  <svg className={`chev-icon${c.collapsed ? '' : ' open'}`} width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M3 1.5l4 3.5-4 3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>
                <span className="seal" aria-hidden="true">{c.name.trim().charAt(0).toUpperCase()}</span>
                {editing === `cat:${c.id}` ? (
                  <InlineInput initial={c.name}
                    onSubmit={(v) => { setEditing(null); void act('renameCategory', c.id, v); }}
                    onCancel={() => setEditing(null)} />
                ) : (
                  <span className="cat-name" onClick={() => void act('toggleCollapse', c.id)}>{c.name}</span>
                )}
                <span className="count">{chans.length}</span>
                <span className="row-actions">
                  <button title="Add channel" data-testid="add-channel" onClick={() => {
                    if (c.collapsed) void act('toggleCollapse', c.id);
                    setAdding(`chan:${c.id}`);
                  }}>+</button>
                  <button title="Rename" onClick={() => setEditing(`cat:${c.id}`)}>✎</button>
                  <button title="Delete category" onClick={() => {
                    if (window.confirm(`Delete "${c.name}" and all its channels and messages? This cannot be undone.`)) {
                      void act('deleteCategory', c.id);
                    }
                  }}>✕</button>
                </span>
                <button className="cat-cog" data-testid="category-cog" title={`${c.name} settings`} aria-label={`${c.name} settings`}
                  onClick={(e) => { e.stopPropagation(); onCategorySettings(c.id); }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={GEAR} /></svg>
                </button>
              </div>

              {!c.collapsed && (
                <div className="channels">
                  {chans.map((ch, i) => (
                    <div
                      key={ch.id}
                      className={`channel${ch.id === selectedId ? ' selected' : ''}${over === `chan:${ch.id}` ? ' drop' : ''}`}
                      data-testid="channel"
                      onClick={() => onSelect(ch.id)}
                      {...chanHandlers(ch, i)}
                    >
                      <span className="hash">#</span>
                      {editing === `chan:${ch.id}` ? (
                        <InlineInput initial={ch.name}
                          onSubmit={(v) => { setEditing(null); void act('renameChannel', ch.id, v); }}
                          onCancel={() => setEditing(null)} />
                      ) : (
                        <span className="chan-name">{ch.name}</span>
                      )}
                      {snap.busy[ch.id] && <span className="pulse" title="Agents are working" />}
                      <span className="row-actions">
                        <button title="Rename" onClick={(e) => { e.stopPropagation(); setEditing(`chan:${ch.id}`); }}>✎</button>
                        <button title="Delete channel" onClick={(e) => {
                          e.stopPropagation();
                          if (window.confirm(`Delete #${ch.name} and its messages?`)) void act('deleteChannel', ch.id);
                        }}>✕</button>
                      </span>
                    </div>
                  ))}
                  {adding === `chan:${c.id}` && (
                    <div className="channel adding">
                      <span className="hash">#</span>
                      <InlineInput placeholder="new-channel"
                        onSubmit={async (v) => {
                          setAdding(null);
                          const ch = await act<Channel>('createChannel', c.id, v);
                          if (ch) onSelect(ch.id);
                        }}
                        onCancel={() => setAdding(null)} />
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {adding === 'cat' ? (
          <div className="category-add">
            <InlineInput placeholder="New category name"
              onSubmit={(v) => { setAdding(null); void act('createCategory', v); }}
              onCancel={() => setAdding(null)} />
          </div>
        ) : (
          <button className="add-category" data-testid="add-category" onClick={() => setAdding('cat')}>+ New category</button>
        )}
      </div>
    </aside>
  );
}
