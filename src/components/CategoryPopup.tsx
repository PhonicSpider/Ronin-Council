import { useEffect } from 'react';
import type { Snapshot } from '../../shared/types';
import { usd } from '../util';
import { VaultRow } from './Settings';

/** A quick version of the Vaults & Projects settings for one category, opened from the cog beside its name. */
export function CategoryPopup({ snap, categoryId, onClose, onOpenAll }: {
  snap: Snapshot; categoryId: string; onClose: () => void; onOpenAll: () => void;
}) {
  const cat = snap.categories.find((c) => c.id === categoryId);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  if (!cat) return null;
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="cat-settings" data-testid="category-settings" onMouseDown={(e) => e.stopPropagation()}>
        <button className="icon-btn close" onClick={onClose} aria-label="Close">✕</button>
        <h3>{cat.name} <span className="muted small">settings</span></h3>
        <div className="muted small">Spent today in this category: <strong>{usd(snap.spend.byCategory[cat.id] ?? 0)}</strong></div>
        <VaultRow cat={cat} />
        <div className="form-actions">
          <button className="btn" data-testid="category-all-settings" onClick={onOpenAll}>All settings…</button>
          <button className="btn primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
