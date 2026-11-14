import { useCallback, useEffect, useMemo, useState } from 'react';
import { WIDOW_DM_ID } from '../shared/types';
import { useSnapshot, useToast } from './api';
import { AgentPopup } from './components/AgentPopup';
import { ChatView } from './components/ChatView';
import { LocalModels } from './components/LocalModels';
import { Notifications } from './components/Notifications';
import { RightPanel, ViewerTab } from './components/RightPanel';
import { CategoryPopup } from './components/CategoryPopup';
import { Settings, type Tab as SettingsTab } from './components/Settings';
import { Sidebar } from './components/Sidebar';
import { TitleBar } from './components/TitleBar';
import { ViewerItem } from './util';

const store = {
  get(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

export default function App() {
  const snap = useSnapshot();
  const [toastMsg, dismissToast] = useToast();
  const [selectedId, setSelectedId] = useState(() => store.get('rc.selected') ?? '');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab | undefined>(undefined);
  const [catSettings, setCatSettings] = useState<string | null>(null);
  const [notifsOpen, setNotifsOpen] = useState(false);
  const [localOpen, setLocalOpen] = useState(false);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(() => store.get('rc.panel') !== '0');
  const [ratio, setRatioState] = useState(() => {
    const r = Number(store.get('rc.ratio'));
    return r >= 0.2 && r <= 0.8 ? r : 0.5;
  });
  const [tab, setTab] = useState<ViewerTab>('view');
  const [item, setItem] = useState<ViewerItem | null>(null);

  const [jumpTo, setJumpTo] = useState<{ id: string; n: number } | null>(null);
  const select = useCallback((id: string) => { setSelectedId(id); store.set('rc.selected', id); }, []);
  const closeNotifs = useCallback(() => setNotifsOpen(false), []);
  const setRatio = useCallback((r: number) => { setRatioState(r); store.set('rc.ratio', String(r)); }, []);

  const channel = useMemo(() => {
    if (!snap) return undefined;
    const found = snap.channels.find((c) => c.id === selectedId);
    if (found) return found;
    const firstCat = [...snap.categories].sort((a, b) => a.order - b.order)[0];
    const inCat = snap.channels.filter((c) => c.categoryId === firstCat?.id).sort((a, b) => a.order - b.order);
    return inCat[0] ?? snap.channels.find((c) => c.id === WIDOW_DM_ID);
  }, [snap, selectedId]);

  useEffect(() => { if (channel && channel.id !== selectedId) setSelectedId(channel.id); }, [channel, selectedId]);

  // A file dropped outside a drop target must do nothing (by default the browser would try to open it).
  useEffect(() => {
    const stop = (e: DragEvent) => { if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault(); };
    window.addEventListener('dragover', stop);
    window.addEventListener('drop', stop);
    return () => { window.removeEventListener('dragover', stop); window.removeEventListener('drop', stop); };
  }, []);

  if (!snap || !channel) return <div className="loading">Loading…</div>;

  const needsYou = snap.notifications.filter((n) => n.status === 'awaiting-user').length;

  return (
    <div className="shell">
    <TitleBar busy={Object.keys(snap.busy).length > 0} />
    <div className={`app${panelOpen ? '' : ' no-panel'}`}>
      <Sidebar
        snap={snap} selectedId={channel.id} unread={needsYou} onSelect={select}
        onSettings={() => { setSettingsTab(undefined); setSettingsOpen(true); }}
        onCategorySettings={setCatSettings}
        onJump={(channelId, messageId) => { select(channelId); setJumpTo((j) => ({ id: messageId, n: (j?.n ?? 0) + 1 })); }}
        onNotifs={() => setNotifsOpen((v) => !v)}
        onLocalModels={() => setLocalOpen(true)}
        onWidow={() => select(WIDOW_DM_ID)}
        widowActive={channel.id === WIDOW_DM_ID}
      />
      <ChatView
        snap={snap} channel={channel} panelOpen={panelOpen} jumpTo={jumpTo}
        onTogglePanel={() => { setPanelOpen((v) => { store.set('rc.panel', v ? '0' : '1'); return !v; }); }}
        onOpenAgent={setAgentId}
        onView={(i) => { setItem(i); setTab('view'); setPanelOpen(true); }}
        onOpenSettings={() => { setSettingsTab(undefined); setSettingsOpen(true); }}
      />
      {panelOpen && (
        <RightPanel snap={snap} channel={channel} tab={tab} setTab={setTab} item={item} setItem={setItem}
          ratio={ratio} setRatio={setRatio} />
      )}

      {notifsOpen && <Notifications snap={snap} onClose={closeNotifs} onGoto={select} />}
      {catSettings && (
        <CategoryPopup snap={snap} categoryId={catSettings} onClose={() => setCatSettings(null)}
          onOpenAll={() => { setCatSettings(null); setSettingsTab('vaults'); setSettingsOpen(true); }} />
      )}
      {settingsOpen && (
        <Settings snap={snap} initialTab={settingsTab} channelId={channel.id === WIDOW_DM_ID ? (snap.channels.find((c) => c.kind === 'general')?.id ?? channel.id) : channel.id}
          onClose={() => setSettingsOpen(false)} onOpenAgent={(id) => setAgentId(id)} />
      )}
      {localOpen && <LocalModels onClose={() => setLocalOpen(false)} />}
      {agentId && <AgentPopup snap={snap} agentId={agentId} onClose={() => setAgentId(null)} />}
      {toastMsg && <div className="toast" role="status" onClick={dismissToast} data-testid="toast">{toastMsg}</div>}
    </div>
    </div>
  );
}
