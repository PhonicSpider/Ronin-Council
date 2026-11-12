import { useEffect, useRef } from 'react';
import type { Notification, Snapshot } from '../../shared/types';
import { act } from '../api';
import { timeStr } from '../util';

interface Props {
  snap: Snapshot;
  onClose: () => void; // must be stable (useCallback) so the listener below is not re-attached every render
  onGoto: (channelId: string) => void;
}

function Item({ n, onGoto, onClose }: { n: Notification; onGoto: (id: string) => void; onClose: () => void }) {
  return (
    <div className={`notif ${n.status}`} data-testid="notification">
      <div className="notif-title">{n.title}</div>
      <div className="notif-body">{n.body}</div>
      {n.action && <pre className="preview">{n.action.preview}</pre>}
      {n.auditNote && <div className="card-note"><strong>Widow:</strong> {n.auditNote}</div>}
      <div className="notif-foot">
        <span className="muted">{timeStr(n.ts)} · {n.status.replace('-', ' ')}</span>
        {n.channelId && <button className="link" onClick={() => { onGoto(n.channelId!); onClose(); }}>Go to channel</button>}
      </div>
      {n.status === 'awaiting-user' && (
        <div className="card-actions">
          {n.kind === 'permission' ? (
            <>
              <button className="btn primary" data-testid="notif-approve" onClick={() => void act('resolveNotification', n.id, true)}>Approve</button>
              <button className="btn danger" data-testid="notif-deny" onClick={() => void act('resolveNotification', n.id, false)}>Deny</button>
            </>
          ) : (
            <button className="btn" onClick={() => void act('dismissNotification', n.id)}>Dismiss</button>
          )}
        </div>
      )}
    </div>
  );
}

export function Notifications({ snap, onClose, onGoto }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  // Opening the panel marks what is currently there as read (once, not on every update).
  useEffect(() => { void act('markNotificationsRead'); }, []);

  useEffect(() => {
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    // Defer so the click that opened the panel does not immediately close it.
    const t = setTimeout(() => document.addEventListener('mousedown', h), 0);
    return () => { clearTimeout(t); document.removeEventListener('mousedown', h); };
  }, [onClose]);

  const all = [...snap.notifications].sort((a, b) => b.ts - a.ts);
  const needsYou = all.filter((n) => n.status === 'awaiting-user');
  const auditing = all.filter((n) => n.status === 'pending-widow');
  const history = all.filter((n) => !['awaiting-user', 'pending-widow'].includes(n.status));

  return (
    <div className="popover notif-panel" ref={ref} data-testid="notif-panel">
      <div className="popover-title">Notifications</div>
      {all.length === 0 && <div className="empty small">Nothing yet. Permission requests that Widow has audited will land here.</div>}
      {needsYou.length > 0 && <div className="group-label">Needs you</div>}
      {needsYou.map((n) => <Item key={n.id} n={n} onGoto={onGoto} onClose={onClose} />)}
      {auditing.length > 0 && <div className="group-label">Widow is auditing</div>}
      {auditing.map((n) => <Item key={n.id} n={n} onGoto={onGoto} onClose={onClose} />)}
      {history.length > 0 && <div className="group-label">History</div>}
      {history.slice(0, 20).map((n) => <Item key={n.id} n={n} onGoto={onGoto} onClose={onClose} />)}
    </div>
  );
}
