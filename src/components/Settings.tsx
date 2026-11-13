import { useEffect, useState } from 'react';
import type { Category, Snapshot, Tier } from '../../shared/types';
import { MODEL_CHOICES, WIDOW_ID } from '../../shared/types';
import { LOCAL_PRESETS, VENDORS, type VendorInfo } from '../../shared/vendors';
import { act, toast } from '../api';
import { fmtSize } from '../attach';
import { setSpeakEnabled } from '../speak';
import { usd } from '../util';
import { Avatar } from './Avatar';
import { AvatarEditor } from './AvatarEditor';
import { TIER_LABEL, modelLabel, ModelPicker, type PickerValue } from './ModelPicker';

export type Tab = 'agents' | 'api' | 'budgets' | 'vaults' | 'backup' | 'testing';
const TABS: [Tab, string][] = [
  ['agents', 'Agents'], ['api', 'API & Models'], ['budgets', 'Budgets'], ['vaults', 'Vaults & Projects'], ['backup', 'Backup'], ['testing', 'Testing'],
];

function NumberField({ value, onCommit, step = 1, prefix, testid }: {
  value: number; onCommit: (n: number) => void; step?: number; prefix?: string; testid?: string;
}) {
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(value)), [value]);
  const commit = () => {
    const n = Number(v);
    if (v.trim() !== '' && Number.isFinite(n)) onCommit(n); else setV(String(value));
  };
  return (
    <span className="num">
      {prefix}<input type="number" step={step} value={v} data-testid={testid}
        onChange={(e) => setV(e.target.value)} onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') commit(); }} />
    </span>
  );
}

function AgentsTab({ snap, onOpenAgent }: { snap: Snapshot; onOpenAgent: (id: string) => void }) {
  const empty = { name: '', role: '', tier: 'standard' as Tier, model: null as PickerValue['model'], partnerId: '', specialty: '', personality: '', image: '' };
  const [form, setForm] = useState(empty);
  const [editing, setEditing] = useState(false);
  const [speak, setSpeak] = useState(() => { try { return localStorage.getItem('rc.speak') !== '0'; } catch { return true; } });
  const set = <K extends keyof typeof empty>(k: K, v: (typeof empty)[K]) => setForm((f) => ({ ...f, [k]: v }));
  return (
    <div>
      <h3>Agents <span className="muted">({snap.agents.length})</span></h3>
      <label className="check big">
        <input type="checkbox" data-testid="speak-toggle" checked={speak}
          onChange={(e) => { setSpeakEnabled(e.target.checked); setSpeak(e.target.checked); }} />
        Show the speaker's portrait and type each reply out as it arrives (off = replies appear at once)
      </label>
      <div className="agent-list" data-testid="agent-list">
        {snap.agents.map((a) => {
          const partner = snap.agents.find((p) => p.id === a.partnerId);
          return (
            <div className="agent-row" key={a.id} data-testid="agent-row">
              <Avatar agent={a} size={34} status={a.status} />
              <div className="agent-row-main">
                <strong>{a.name}</strong> <span className="muted">{a.role}</span>
                <div className="muted small">{modelLabel(a, snap.settings)} · partner: {partner?.name ?? 'Widow reviews'}</div>
              </div>
              <button className="btn sm" onClick={() => onOpenAgent(a.id)}>Profile</button>
              <button className="btn sm danger" disabled={a.id === WIDOW_ID} title={a.id === WIDOW_ID ? 'Widow cannot be removed' : 'Remove'}
                onClick={() => {
                  if (window.confirm(`Remove ${a.name}? Their past messages stay in the channels.`)) void act('removeAgent', a.id);
                }}>Remove</button>
            </div>
          );
        })}
      </div>

      <h3>Add an agent</h3>
      <div className="form" data-testid="add-agent-form">
        <div className="field-row">
          <label>Name (one word)<input value={form.name} onChange={(e) => set('name', e.target.value)} data-testid="new-agent-name" /></label>
          <label>Role<input value={form.role} onChange={(e) => set('role', e.target.value)} data-testid="new-agent-role" /></label>
        </div>
        <div className="field-row">
          <label>Audit partner
            <select value={form.partnerId} onChange={(e) => set('partnerId', e.target.value)}>
              <option value="">None (Widow reviews)</option>
              {snap.agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </label>
        </div>
        <ModelPicker settings={snap.settings} value={{ tier: form.tier, model: form.model }}
          onChange={(v) => setForm((f) => ({ ...f, tier: v.tier, model: v.model }))} />
        <label>Specialty<textarea rows={2} value={form.specialty} onChange={(e) => set('specialty', e.target.value)} /></label>
        <label>Personality<textarea rows={3} value={form.personality} onChange={(e) => set('personality', e.target.value)} /></label>
        <div className="form-actions">
          {form.image && <Avatar agent={{ name: form.name || 'New', color: '#5a5f69', image: form.image }} size={34} />}
          <button className="btn" data-testid="new-agent-picture" onClick={() => setEditing(true)}>
            {form.image ? 'Change picture…' : 'Add picture…'}
          </button>
          {form.image && <button className="btn" onClick={() => set('image', '')}>Remove</button>}
          <button className="btn primary" data-testid="add-agent" disabled={!!form.model && !form.model.model} onClick={async () => {
            const a = await act('addAgent', form);
            if (a) { setForm(empty); toast('Agent added. Add them to channels from their profile or a channel’s Members menu.'); }
          }}>Add agent</button>
        </div>
      </div>
      {editing && (
        <AvatarEditor onCancel={() => setEditing(false)} onSave={(img) => { set('image', img); setEditing(false); }} />
      )}
    </div>
  );
}

function VendorRow({ snap, v }: { snap: Snapshot; v: VendorInfo }) {
  const s = snap.settings;
  const [key, setKey] = useState('');
  const saved = !!s.vendorKeys[v.id];
  const stored = s.vendorUrls[v.id] ?? '';
  const [url, setUrl] = useState(stored || v.baseUrl);
  useEffect(() => setUrl(stored || v.baseUrl), [stored, v.baseUrl]);
  const id = v.id === 'anthropic' ? 'api-key' : `api-key-${v.id}`;
  return (
    <div className="vendor-row" data-testid={`vendor-${v.id}`}>
      <div className="vendor-head">
        <strong>{v.label}</strong>
        <span className={`vendor-state ${saved || (v.editableUrl && stored) ? 'on' : ''}`}>
          {v.needsKey ? (saved ? 'key saved' : 'no key') : stored ? 'address set' : 'not set up'}
        </span>
      </div>
      <div className="muted small">{v.note}</div>
      {v.needsKey && (
        <div className="field-row">
          <label>API key
            <input type="password" value={key} data-testid={id} autoComplete="off"
              placeholder={saved ? '•••••••• (saved, enter a new one to replace)' : v.id === 'anthropic' ? 'sk-ant-…' : 'paste key'}
              onChange={(e) => setKey(e.target.value)} />
          </label>
          <div className="form-actions end">
            <button className="btn primary" disabled={!key.trim()} data-testid={`${id}-save`} onClick={async () => {
              if (await act('setApiKey', key, v.id)) { setKey(''); toast(`${v.label} key saved.`); }
            }}>Save key</button>
            <button className="btn danger" disabled={!saved} onClick={() => void act('clearApiKey', v.id)}>Remove key</button>
          </div>
        </div>
      )}
      {v.editableUrl && (
        <div className="field-row">
          <label>Address
            <input value={url} data-testid={`vendor-url-${v.id}`} placeholder="https://…/v1" onChange={(e) => setUrl(e.target.value)} />
          </label>
          <div className="form-actions end">
            {v.id === 'local' && LOCAL_PRESETS.map((p) => <button key={p.label} className="btn sm" type="button" onClick={() => setUrl(p.url)}>{p.label}</button>)}
            <button className="btn primary" data-testid={`vendor-url-save-${v.id}`} onClick={async () => {
              if (await act('updateSettings', { vendorUrls: { [v.id]: url.trim() } })) toast(url.trim() ? 'Address saved.' : 'Address cleared.');
            }}>Save address</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Meshy is not a model vendor: it makes 3D models and images for agents that have the ability, so it has its own key row. */
function MeshyRow({ snap }: { snap: Snapshot }) {
  const [key, setKey] = useState('');
  const saved = snap.settings.hasMeshyKey;
  return (
    <div className="vendor-row" data-testid="vendor-meshy">
      <div className="vendor-head">
        <strong>Meshy (3D models and images)</strong>
        <span className={`vendor-state ${saved ? 'on' : ''}`}>{saved ? 'key saved' : 'no key'}</span>
      </div>
      <div className="muted small">For agents you give the Meshy ability in their profile. Needs a Meshy plan with API access. Every generation costs credits and needs your approval; set the daily cap in Budgets.</div>
      <div className="field-row">
        <label>API key
          <input type="password" value={key} data-testid="api-key-meshy" autoComplete="off"
            placeholder={saved ? '•••••••• (saved, enter a new one to replace)' : 'msy_…'} onChange={(e) => setKey(e.target.value)} />
        </label>
        <div className="form-actions end">
          <button className="btn primary" disabled={!key.trim()} data-testid="api-key-meshy-save" onClick={async () => {
            if (await act('setApiKey', key, 'meshy')) { setKey(''); toast('Meshy key saved.'); }
          }}>Save key</button>
          <button className="btn danger" disabled={!saved} onClick={() => void act('clearApiKey', 'meshy')}>Remove key</button>
        </div>
      </div>
    </div>
  );
}

function ApiTab({ snap }: { snap: Snapshot }) {
  const s = snap.settings;
  const agentModels = snap.agents.filter((a) => a.model && a.model.vendor !== 'local').map((a) => a.model!.model);
  const models = Array.from(new Set([...MODEL_CHOICES, ...Object.values(s.models), ...Object.keys(s.prices), ...agentModels]));
  return (
    <div>
      <h3>Providers</h3>
      <div className={`status-line ${snap.mode}`} data-testid="mode-status">
        {snap.mode === 'claude'
          ? 'Live: agents call the vendors set up below. Each agent\'s vendor and model is chosen in its profile.'
          : Object.keys(s.vendorKeys).length ? 'Mock mode: a key is saved but "use mock agents" is on.' : 'Mock mode: no key saved yet. Replies are simulated and free.'}
      </div>
      {VENDORS.map((v) => <VendorRow key={v.id} snap={snap} v={v} />)}
      <MeshyRow snap={snap} />
      <div className="muted small">Keys are encrypted with your operating system's secure storage and stay in the main process; the interface never receives them. Each agent's prompts go only to the vendor you pick for that agent.</div>
      <label className="check big">
        <input type="checkbox" checked={s.useMock} onChange={(e) => void act('updateSettings', { useMock: e.target.checked })} />
        Use mock agents even if a key is saved (for testing the interface for free)
      </label>

      <h3>Models by tier</h3>
      {(['fast', 'standard', 'top'] as Tier[]).map((t) => (
        <div className="field-row tier-row" key={t}>
          <span className="tier-name">{TIER_LABEL[t]}</span>
          <select value={s.models[t]} onChange={(e) => void act('updateSettings', { models: { [t]: e.target.value } })}>
            {models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
      ))}

      <h3>Prices <span className="muted small">USD per 1M tokens, estimates used only for the budget meter. Local models are free and need no price.</span></h3>
      <div className="price-grid">
        <div className="price-row head"><span className="muted">Model</span><span className="muted">Input</span><span className="muted">Output</span></div>
        {models.map((m) => (
          <div className="price-row" key={m}>
            <code>{m}</code>
            <NumberField value={s.prices[m]?.in ?? 0} step={0.1} prefix="$"
              onCommit={(n) => void act('updateSettings', { prices: { [m]: { in: n, out: s.prices[m]?.out ?? 0 } } })} />
            <NumberField value={s.prices[m]?.out ?? 0} step={0.1} prefix="$"
              onCommit={(n) => void act('updateSettings', { prices: { [m]: { in: s.prices[m]?.in ?? 0, out: n } } })} />
          </div>
        ))}
      </div>
      <div className="muted small">Check each vendor's pricing page before relying on these. A hosted model with no price is refused, so spend cannot go untracked. Cached input is billed at its own lower rate, using the multipliers for each model family.</div>
    </div>
  );
}

function BudgetsTab({ snap }: { snap: Snapshot }) {
  const s = snap.settings;
  return (
    <div>
      <h3>Spend today</h3>
      <div className="stat-row">
        <div className="stat"><span className="muted">All categories</span><strong data-testid="spend-today">{usd(snap.spend.usd)}</strong></div>
        {snap.categories.map((c) => (
          <div className="stat" key={c.id}><span className="muted">{c.name}</span><strong>{usd(snap.spend.byCategory[c.id] ?? 0)}</strong></div>
        ))}
      </div>
      {snap.mode === 'mock' && <div className="muted small">Mock mode costs nothing, so no spend is recorded.</div>}
      <div className="stat-row">
        <div className="stat"><span className="muted">Meshy credits used today</span><strong data-testid="meshy-credits-today">{snap.spend.meshyCredits ?? 0} of {s.meshyDailyCredits}</strong></div>
      </div>
      {((snap.spend.cacheRead ?? 0) + (snap.spend.cacheWrite ?? 0) + (snap.spend.inputFresh ?? 0)) > 0 && (
        <div className="muted small" data-testid="cache-stats">
          Input today: {(snap.spend.cacheRead ?? 0).toLocaleString()} tokens read from the cache (cheap), {(snap.spend.cacheWrite ?? 0).toLocaleString()} written to it, {(snap.spend.inputFresh ?? 0).toLocaleString()} billed in full.
          If “read from the cache” stays at 0 while you chat, the shared prompt is too short to cache or the key's workspace changed.
        </div>
      )}
      <h3>Limits</h3>
      <div className="form">
        <label className="inline">Daily budget (all categories) <NumberField value={s.dailyBudgetUsd} step={0.5} prefix="$" testid="daily-budget"
          onCommit={(n) => void act('updateSettings', { dailyBudgetUsd: n })} /></label>
        <label className="inline">Per-category daily budget <NumberField value={s.categoryBudgetUsd} step={0.5} prefix="$"
          onCommit={(n) => void act('updateSettings', { categoryBudgetUsd: n })} /></label>
        <label className="inline">Meshy credits per day (all agents) <NumberField value={s.meshyDailyCredits} step={10} testid="meshy-daily-cap"
          onCommit={(n) => void act('updateSettings', { meshyDailyCredits: n })} /></label>
        <label className="check big">
          <input type="checkbox" checked={s.autoNotes} onChange={(e) => void act('updateSettings', { autoNotes: e.target.checked })} />
          Quill writes notes and highlights automatically (uses a small amount of the fast model)
        </label>
        <label className="inline">Agent replies per message (turn cap) <NumberField value={s.turnCap} step={1}
          onCommit={(n) => void act('updateSettings', { turnCap: n })} /></label>
      </div>
      <div className="muted small">When a daily or category budget is reached, agents pause and you get a notification. A turn cap stops runaway agent-to-agent threads.</div>
    </div>
  );
}

export function VaultRow({ cat }: { cat: Category }) {
  const [p, setP] = useState(cat.vaultPath);
  const [proj, setProj] = useState(cat.projectPath);
  const [def, setDef] = useState('');
  const [repo, setRepo] = useState(cat.repoUrl);
  useEffect(() => setRepo(cat.repoUrl), [cat.repoUrl]);
  useEffect(() => setP(cat.vaultPath), [cat.vaultPath]);
  useEffect(() => setProj(cat.projectPath), [cat.projectPath]);
  useEffect(() => { void act<string>('vaultPath', cat.id).then((d) => setDef(d ?? '')); }, [cat.id, cat.vaultPath]);
  return (
    <div className="vault-row">
      <strong>{cat.name}</strong>
      <div className="muted small">Notes vault (Obsidian). Leave blank for the default folder.</div>
      <div className="field-row path-row">
        <input value={p} placeholder={`Default: ${def}`} onChange={(e) => setP(e.target.value)} />
        <button className="btn" onClick={async () => { const f = await act<string | null>('pickFolder'); if (f) { setP(f); await act('setVaultPath', cat.id, f); } }}>Browse…</button>
        <button className="btn primary" disabled={p === cat.vaultPath} onClick={() => void act('setVaultPath', cat.id, p)}>Save</button>
      </div>
      <div className="muted small">Project folder. Agents can read files here freely; changes and commands need Widow's audit and your approval. Blank = talk-only.</div>
      <div className="field-row path-row">
        <input value={proj} placeholder="Project folder: blank = agents are talk-only" data-testid={`project-path-${cat.id}`}
          onChange={(e) => setProj(e.target.value)} />
        <button className="btn" onClick={async () => {
          const f = await act<string | null>('pickFolder');
          if (f && await act('setProjectPath', cat.id, f)) setProj(f);
        }}>Browse…</button>
        <button className="btn primary" disabled={proj === cat.projectPath} data-testid={`project-save-${cat.id}`}
          onClick={async () => { if (await act('setProjectPath', cat.id, proj)) toast(proj ? 'Project folder set. Agents here can now work in it (with approval).' : 'Agents here are talk-only again.'); }}>Save</button>
      </div>
      <div className="muted small">GitHub repository. Tells Widow and the team which remote this project updates. Nothing is pushed without your approval.</div>
      <div className="field-row path-row">
        <input value={repo} placeholder="https://github.com/owner/repo (optional)" data-testid={`repo-url-${cat.id}`}
          onChange={(e) => setRepo(e.target.value)} />
        <button className="btn primary" disabled={repo.trim() === cat.repoUrl} data-testid={`repo-save-${cat.id}`}
          onClick={async () => { if (await act('setRepoUrl', cat.id, repo)) toast(repo.trim() ? 'Repository saved.' : 'Repository link removed.'); }}>Save</button>
      </div>
    </div>
  );
}

function VaultsTab({ snap }: { snap: Snapshot }) {
  return (
    <div>
      <h3>Vault and project folders</h3>
      <div className="muted small">Point each category at its existing Obsidian vault. Leave blank to use a folder inside the app's data directory. Every agent can read every vault; only the Librarian and Widow write to them.</div>
      {[...snap.categories].sort((a, b) => a.order - b.order).map((c) => <VaultRow key={c.id} cat={c} />)}
      <div className="form-actions">
        <button className="btn primary" data-testid="settings-refresh-index" onClick={async () => {
          const n = await act<number>('refreshVaultIndex');
          if (n !== undefined) toast(`Updated “_Other Vaults.md” in ${n} vault${n === 1 ? '' : 's'}.`);
        }}>Refresh cross-vault index</button>
      </div>
    </div>
  );
}

interface BackupRow { name: string; kind: 'manual' | 'auto' | 'before-restore'; ts: number; bytes: number }
const KIND_LABEL: Record<BackupRow['kind'], string> = { manual: 'Manual', auto: 'Automatic', 'before-restore': 'Before a restore' };

function BackupTab() {
  const [data, setData] = useState<{ folder: string; backups: BackupRow[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = async () => { const d = await act<{ folder: string; backups: BackupRow[] }>('backupList'); if (d) setData(d); };
  useEffect(() => { void refresh(); }, []);
  return (
    <div>
      <h3>Backups</h3>
      <div className="muted small">
        A backup holds your agents, channels, chats, notes, settings and attached files. It does not hold your vault or project folders
        (those are ordinary folders you already have) or your API key. A backup is also made automatically once a day, keeping the last 7.
      </div>
      <div className="form-actions">
        <button className="btn primary" data-testid="backup-now" disabled={busy} onClick={async () => {
          setBusy(true);
          const b = await act<BackupRow>('backupCreate');
          setBusy(false);
          if (b) { toast('Backup saved.'); void refresh(); }
        }}>Back up now</button>
      </div>
      <div className="backup-list" data-testid="backup-list">
        {data && data.backups.length === 0 && <div className="muted">No backups yet.</div>}
        {data?.backups.map((b) => (
          <div className="backup-row" key={b.name} data-testid="backup-row">
            <div className="backup-main">
              <strong>{new Date(b.ts).toLocaleString()}</strong>
              <span className="muted small"> · {KIND_LABEL[b.kind]} · {fmtSize(b.bytes)}</span>
            </div>
            <button className="btn sm" data-testid="backup-restore" disabled={busy} onClick={async () => {
              if (!window.confirm(`Restore the backup from ${new Date(b.ts).toLocaleString()}?\n\nEverything running is stopped, and the current state is saved first as a “Before a restore” backup, so you can undo this.`)) return;
              setBusy(true);
              const r = await act('backupRestore', b.name);
              setBusy(false);
              if (r) toast('Restored. The state from before is kept as a backup.');
              void refresh();
            }}>Restore</button>
          </div>
        ))}
      </div>
      {data && <div className="muted small">Saved in: <code>{data.folder}</code></div>}
    </div>
  );
}

function TestingTab({ channelId }: { channelId: string }) {
  return (
    <div>
      <h3>Testing tools</h3>
      <p className="muted">Agents cannot perform real actions yet (that arrives in phase 6). This sends a fake permission request from Hex in the channel you have open, so you can see the full flow: Widow audits it, then it reaches you inline here, or in the notifications centre if you are in a different channel.</p>
      <div className="form-actions">
        <button className="btn primary" data-testid="dev-permission" onClick={async () => {
          await act('devPermissionRequest', channelId, 'prog');
          toast('Test request sent. Close settings to watch it.');
        }}>Send test permission request</button>
      </div>
    </div>
  );
}

export function Settings({ snap, channelId, onClose, onOpenAgent, initialTab }: {
  snap: Snapshot; channelId: string; onClose: () => void; onOpenAgent: (id: string) => void; initialTab?: Tab;
}) {
  const [tab, setTab] = useState<Tab>(initialTab ?? 'agents');
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="settings" onMouseDown={(e) => e.stopPropagation()} data-testid="settings">
        <nav className="settings-nav">
          <div className="nav-title">Settings</div>
          {TABS.map(([id, label]) => (
            <button key={id} className={`nav-item${tab === id ? ' active' : ''}`} data-testid={`settings-tab-${id}`} onClick={() => setTab(id)}>{label}</button>
          ))}
        </nav>
        <div className="settings-body">
          <button className="icon-btn close" onClick={onClose} aria-label="Close settings">✕</button>
          {tab === 'agents' && <AgentsTab snap={snap} onOpenAgent={onOpenAgent} />}
          {tab === 'api' && <ApiTab snap={snap} />}
          {tab === 'budgets' && <BudgetsTab snap={snap} />}
          {tab === 'vaults' && <VaultsTab snap={snap} />}
          {tab === 'backup' && <BackupTab />}
          {tab === 'testing' && <TestingTab channelId={channelId} />}
        </div>
      </div>
    </div>
  );
}
