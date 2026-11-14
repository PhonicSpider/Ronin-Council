import { useCallback, useEffect, useRef, useState } from 'react';
import { formatMemory, formatSize, type Fit, type InstallSource, type OllamaInstall, type OllamaPlan, type OllamaState } from '../../shared/ollama';
import { act, toast } from '../api';

const SOURCE_LABEL: Record<InstallSource, string> = {
  registry: 'listed in Windows Apps', default: 'in the default folder', saved: 'chosen by you',
  process: 'running now', path: 'on your PATH', scan: 'found by the drive scan',
};
const LOCAL_ADDRESS = 'http://localhost:11434/v1';

function FitBadge({ fit }: { fit: Fit }) {
  return <span className={`fit fit-${fit.kind}`} title={fit.detail} data-testid={`fit-${fit.kind}`}>{fit.label}</span>;
}

function Bar({ done, total, label }: { done: number; total: number; label: string }) {
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return (
    <div className="lm-bar-wrap" aria-label={label}>
      <div className="lm-bar"><div className="lm-bar-fill" style={{ width: `${pct}%` }} /></div>
      <span className="muted small">{label}{total > 0 ? ` ${pct}%` : ''}</span>
    </div>
  );
}

/** What was found, and what the user can do with it. */
function Candidate({ c, onUse }: { c: OllamaInstall; onUse: () => void }) {
  return (
    <div className="lm-row" data-testid="lm-candidate">
      <div className="lm-main">
        <strong className="lm-path">{c.dir}</strong>
        <div className="muted small">{c.version ? `Version ${c.version}. ` : ''}Found {c.sources.map((s) => SOURCE_LABEL[s]).join(', ')}. The app runs nothing from here until you choose it.</div>
      </div>
      <button className="btn" onClick={onUse}>Use this one</button>
    </div>
  );
}

export function LocalModels({ onClose }: { onClose: () => void }) {
  const [st, setSt] = useState<OllamaState | null>(null);
  const [plan, setPlan] = useState<OllamaPlan | null>(null);
  const [deleteModels, setDeleteModels] = useState(true);
  const [installDir, setInstallDir] = useState('');
  const [addName, setAddName] = useState('');
  const [askDelete, setAskDelete] = useState<string | null>(null);
  const [hideBig, setHideBig] = useState(false);
  const [working, setWorking] = useState(false);
  const planRef = useRef<OllamaPlan | null>(null);
  planRef.current = plan;

  // Only the newest answer is shown: a slower, older reply must not overwrite a newer one.
  const seq = useRef(0);
  const refresh = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const s = await window.rc.call<OllamaState>('ollamaState');
      if (mine === seq.current) setSt(s);
    } catch { /* the next poll tries again */ }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => { void refresh(); }, 1500);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') { if (planRef.current) setPlan(null); else onClose(); } };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  /** Runs one action, then refreshes. Errors reach the user as a toast. */
  const run = async (method: string, ...args: unknown[]) => {
    setWorking(true);
    try { return await act(method, ...args); } finally { setWorking(false); void refresh(); }
  };

  const ask = async (action: 'download' | 'uninstall') => {
    // The folder box only applies to a fresh install; an update goes where Ollama already is.
    const p = await act<OllamaPlan>('ollamaPrepare', action, action === 'download' && !st?.install ? { dir: installDir.trim() } : {});
    if (p) { setDeleteModels(p.deleteModels?.default ?? false); setPlan(p); }
  };
  const confirm = async () => {
    if (!plan) return;
    const p = plan;
    setPlan(null);
    await run('ollamaConfirm', p.token, { deleteModels });
  };

  if (!st) {
    return (
      <div className="overlay" onMouseDown={onClose}>
        <div className="lm" data-testid="local-models" onMouseDown={(e) => e.stopPropagation()}><div className="lm-body muted">Looking…</div></div>
      </div>
    );
  }

  const inst = st.install;
  const running = st.server.running;
  const busy = st.busy !== null || working;
  const latest = st.latest;
  const updateReady = !!latest && latest.installerSize !== null && (inst ? latest.upToDate === false : true);
  const dl = st.download;
  const shownCatalog = st.catalog.filter((c) => !hideBig || c.fit.kind !== 'too-big').sort((a, b) => a.sizeBytes - b.sizeBytes);
  const hw = st.hardware;
  const pull = st.pull;
  const pulling = !!pull && !pull.done;

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="lm" role="dialog" aria-label="Local models" data-testid="local-models" onMouseDown={(e) => e.stopPropagation()}>
        <div className="lm-head">
          <h2>Local models</h2>
          <button className="icon-btn close" onClick={onClose} aria-label="Close local models" data-testid="lm-close">✕</button>
        </div>
        <div className="lm-body">
          {!st.supported && <div className="status-line">Local model management works on Windows only.</div>}
          {st.error && <div className="lm-error" role="alert" data-testid="lm-error">{st.error}</div>}

          {/* ---------- Ollama itself ---------- */}
          <h3>Ollama</h3>
          {!st.scanned && <div className="muted" data-testid="lm-scanning">Looking for Ollama on every drive…</div>}
          {st.scanned && !inst && st.candidates.length === 0 && (
            <div className="lm-row" data-testid="lm-not-found">
              <div className="lm-main">
                <strong>Ollama was not found on any drive.</strong>
                <div className="muted small">Ollama runs the models on this computer, free and private. You can install it from here, or rescan if you installed it somewhere unusual.</div>
              </div>
            </div>
          )}

          {inst && (
            <div className="lm-row" data-testid="lm-install">
              <div className="lm-main">
                <strong className="lm-path">{inst.dir}</strong>
                <div className="muted small">
                  {inst.version ? `Version ${inst.version}` : 'Version unknown'} · {inst.sources.map((s) => SOURCE_LABEL[s]).join(', ')}
                </div>
              </div>
              <span className={`lm-pill ${running ? 'on' : ''}`} data-testid="lm-server-state">
                {st.busy === 'starting' ? 'Starting…' : st.busy === 'stopping' ? 'Stopping…' : running ? `Running${st.server.version ? ` ${st.server.version}` : ''}` : 'Stopped'}
              </span>
            </div>
          )}
          {st.server.foreign && <div className="status-line">Something other than Ollama is using the Ollama port ({st.server.origin}). Close it, then try again.</div>}
          {running && !inst && <div className="status-line">Ollama is running, but from a folder this app has not confirmed. Choose that copy above, or install one.</div>}
          {running && inst && !st.server.ownedByApp && <div className="muted small">Ollama was already running, so it stays running when this app closes.</div>}
          {st.busy === 'installing' && <div className="muted" data-testid="lm-busy">Waiting for the installer to finish…</div>}
          {st.busy === 'uninstalling' && <div className="muted" data-testid="lm-busy">Waiting for the uninstaller to finish…</div>}

          <div className="form-actions wrap">
            {inst && !running && <button className="btn primary" disabled={busy} data-testid="lm-start" onClick={() => void run('ollamaStart')}>Start</button>}
            {inst && running && <button className="btn" disabled={busy} data-testid="lm-stop" onClick={() => void run('ollamaStop')}>Stop</button>}
            <button className="btn" disabled={busy} data-testid="lm-check" onClick={() => void run('ollamaCheckUpdate')}>{inst ? 'Check for update' : 'Check latest version'}</button>
            {inst && inst.uninstallable && <button className="btn danger" disabled={busy} data-testid="lm-uninstall" onClick={() => void ask('uninstall')}>Uninstall…</button>}
            <button className="btn" disabled={busy || !st.scanned} data-testid="lm-rescan" onClick={() => void run('ollamaRescan')}>Rescan drives</button>
            {inst && inst.sources.includes('saved') && <button className="btn" disabled={busy} onClick={() => void run('ollamaForget')}>Forget this choice</button>}
          </div>
          {inst && !inst.uninstallable && <div className="muted small">Ollama has no uninstaller this app can run. Remove it from Windows Settings, Apps.</div>}
          {st.busy === 'uninstalling' && <div className="form-actions"><button className="btn" data-testid="lm-stop-waiting" onClick={() => void run('ollamaCancelWait')}>Stop waiting</button></div>}
          {st.scanned && st.candidates.length > 0 && (
            <>
              {inst && <div className="muted small">Other copies of Ollama were found. Choose one only if you want the app to use that one instead.</div>}
              {st.candidates.map((c) => <Candidate key={c.dir} c={c} onUse={() => void run('ollamaUse', c.dir)} />)}
            </>
          )}

          {latest && (
            <div className="lm-row" data-testid="lm-latest">
              <div className="lm-main">
                <strong>Latest version: {latest.version}</strong>
                <div className="muted small">
                  {!inst ? 'Not installed.' : latest.upToDate === true ? 'You have the latest version.' : latest.upToDate === false ? 'An update is available.' : 'Your version could not be read, so it cannot be compared.'}
                  {' '}Ollama's own tray app also updates itself.
                </div>
              </div>
            </div>
          )}
          {latest && latest.installerSize === null && <div className="muted small">This release has no installer with a fingerprint that can be checked, so it cannot be installed from here. Get it from ollama.com instead.</div>}
          {latest && inst && latest.installerSize !== null && latest.upToDate === null && <div className="muted small">Your version could not be read, so the update is not offered. Use the Uninstall and Install buttons, or get the installer from ollama.com.</div>}
          {updateReady && dl.phase === 'idle' && (
            <div className="field-row lm-install-row">
              {!inst && (
                <label>Install folder (optional)
                  <input value={installDir} placeholder="Default: your user folder. Example: D:\Apps\Ollama" data-testid="lm-install-dir" onChange={(e) => setInstallDir(e.target.value)} />
                </label>
              )}
              <div className="form-actions end">
                <button className="btn primary" disabled={busy} data-testid="lm-download-installer" onClick={() => void ask('download')}>
                  {inst ? `Update to ${latest!.version}…` : `Install Ollama ${latest!.version}…`}
                </button>
              </div>
            </div>
          )}
          {dl.phase === 'downloading' && <Bar done={dl.completed} total={dl.total} label={`Downloading the installer (${formatSize(dl.completed)} of ${formatSize(dl.total)})`} />}
          {dl.phase === 'verifying' && <div className="muted">Checking the installer…</div>}
          {dl.phase === 'ready' && (
            <div className="lm-row" data-testid="lm-installer-ready">
              <div className="lm-main">
                <strong>Installer ready</strong>
                <div className="muted small">
                  Its fingerprint matches the release. Digital signature: {dl.signature?.status === 'Valid' ? `valid (${dl.signature.subject ?? 'unknown publisher'})` : 'the file is not signed, so only the fingerprint was checked'}.
                  The app asks once more before it runs, then the installer opens its own windows. Ollama is stopped first if it is running.
                </div>
              </div>
              <button className="btn primary" disabled={busy} data-testid="lm-run-installer" onClick={() => void run('ollamaRunInstaller')}>Run installer</button>
            </div>
          )}
          {dl.phase === 'failed' && <div className="lm-error" role="alert">The installer was not used: {dl.error}</div>}

          {/* ---------- this computer ---------- */}
          <h3>This computer</h3>
          {hw ? (
            <div className="stat-row" data-testid="lm-hardware">
              <div className="stat"><span className="muted small">Memory (RAM)</span>{formatMemory(hw.ramBytes)} <span className="muted small">({formatMemory(hw.freeRamBytes)} free now)</span></div>
              {hw.gpus.length === 0 && <div className="stat"><span className="muted small">Graphics card</span>none found</div>}
              {hw.gpus.map((g, i) => (
                <div className="stat" key={`${g.name}-${i}`}><span className="muted small">Graphics card</span>{g.name}
                  <span className="muted small">{g.vramBytes ? `${formatMemory(g.vramBytes)} video memory` : 'video memory could not be read'}</span></div>
              ))}
              <div className="stat"><span className="muted small">Models are stored in</span><span className="lm-path">{hw.modelsDir}</span>
                <span className="muted small">{hw.modelsFreeBytes !== null ? `${formatSize(hw.modelsFreeBytes)} free on that drive` : 'free space unknown'}</span></div>
            </div>
          ) : <div className="muted">Reading your hardware…</div>}

          {/* ---------- downloaded models ---------- */}
          <h3>Downloaded models</h3>
          {!running && <div className="muted small">Start Ollama to see the models it has.</div>}
          {running && st.models.length === 0 && <div className="muted small" data-testid="lm-no-models">No models downloaded yet. Pick one below.</div>}
          {st.models.map((m) => (
            <div className="lm-row" key={m.name} data-testid="lm-model">
              <div className="lm-main">
                <strong>{m.name}</strong>
                <div className="muted small">
                  {formatSize(m.sizeBytes)} on disk{m.params ? ` · ${m.params}` : ''}{m.quant ? ` · ${m.quant}` : ''} · needs about {formatMemory(m.estBytes)} to run (estimate)
                  {m.loaded ? ` · loaded now${m.vramBytes ? `, ${formatSize(m.vramBytes)} in video memory` : ''}` : ''}
                </div>
              </div>
              <FitBadge fit={m.fit} />
              {askDelete === m.name ? (
                <span className="lm-confirm">
                  <button className="btn danger sm" disabled={busy} onClick={() => { setAskDelete(null); void run('ollamaDeleteModel', m.name); }}>Delete</button>
                  <button className="btn sm" onClick={() => setAskDelete(null)}>Keep</button>
                </span>
              ) : <button className="btn sm" disabled={busy} onClick={() => setAskDelete(m.name)}>Delete…</button>}
            </div>
          ))}

          {/* ---------- download list ---------- */}
          <h3>Available models</h3>
          {pull && (
            <div className="lm-row" data-testid="lm-pull">
              <div className="lm-main">
                <strong>{pull.model}</strong>
                {!pull.done && <Bar done={pull.completed} total={pull.total} label={pull.status} />}
                {pull.done && !pull.error && !pull.cancelled && <div className="muted small">Downloaded.</div>}
                {pull.done && pull.cancelled && <div className="muted small">Cancelled. Starting it again resumes where it stopped.</div>}
                {pull.error && <div className="lm-error small" role="alert">{pull.error}</div>}
              </div>
              {!pull.done ? <button className="btn sm" onClick={() => void run('ollamaCancelPull')}>Cancel</button> : <button className="btn sm" onClick={() => void run('ollamaClearPull')}>Dismiss</button>}
            </div>
          )}
          <label className="check"><input type="checkbox" checked={hideBig} onChange={(e) => setHideBig(e.target.checked)} /> Hide models that are too big for this computer</label>
          {shownCatalog.map((c) => (
            <div className="lm-row" key={c.name} data-testid="lm-catalog-row">
              <div className="lm-main">
                <strong>{c.label}</strong> <span className="muted small">{c.name}</span>
                <div className="muted small">
                  {formatSize(c.sizeBytes)} download · needs about {formatMemory(c.estBytes)} (estimate) · {c.tools ? 'can use tools' : 'no tool use'}{c.note ? ` · ${c.note}` : ''}
                </div>
              </div>
              <FitBadge fit={c.fit} />
              {c.installed ? <span className="muted small">Installed</span> : (
                <button className="btn sm" disabled={!running || pulling || busy} title={!running ? 'Start Ollama first' : pulling ? 'One download at a time' : ''}
                  data-testid="lm-download" onClick={() => void run('ollamaPull', c.name)}>Download</button>
              )}
            </div>
          ))}
          <div className="field-row lm-add">
            <label>Add by name
              <input value={addName} placeholder="name:tag or namespace/name:tag" data-testid="lm-add-name" onChange={(e) => {
                // Names are lowercase, but a tag may carry capitals (such as q4_K_M), so only the part before ":" is lowercased.
                const v = e.target.value;
                const i = v.indexOf(':');
                setAddName(i < 0 ? v.toLowerCase() : v.slice(0, i).toLowerCase() + v.slice(i));
              }} />
            </label>
            <div className="form-actions end">
              <button className="btn" disabled={!running || pulling || busy || !addName.trim()} onClick={async () => { if (await run('ollamaPull', addName.trim())) setAddName(''); }}>Download</button>
            </div>
          </div>
          <div className="muted small">
            Sizes and tool support were read from Ollama's library on {st.catalogChecked}, and can change. Memory needs are estimates for a short context; longer conversations need more.
            Some large models, such as Kimi, are cloud-only on Ollama, so they are not listed. The list above comes from Ollama's own library; "Add by name" downloads from Ollama's registry, which also holds models uploaded by other people, so only add names you trust.
          </div>

          {/* ---------- agents ---------- */}
          <h3>Use with agents</h3>
          {!st.addressSaved ? (
            <div className="lm-row" data-testid="lm-address">
              <div className="lm-main">
                <strong>The local address is not saved yet</strong>
                <div className="muted small">Until it is, the app stays in Mock mode and agents will not call any model. Saving it turns on live mode, so any agent still on a Claude model also needs its key (Settings → API & Models).</div>
              </div>
              <button className="btn primary" onClick={async () => { if (await act('updateSettings', { vendorUrls: { local: LOCAL_ADDRESS } })) { toast('Local address saved.'); void refresh(); } }}>Save {LOCAL_ADDRESS}</button>
            </div>
          ) : <div className="muted small">The local address is saved. Pick a model for an agent by clicking its portrait, then choosing "Open source (local)". Local models start with tools off; turn them on per model in the agent's profile if the model supports them.</div>}
          {st.localAgents.length > 0 && <div className="muted small">Agents using a local model now: {st.localAgents.map((a) => a.name).join(', ')}.</div>}
          <AutoStart />
        </div>

        {plan && (
          <div className="lm-confirm-wrap" onMouseDown={() => setPlan(null)}>
            <div className="lm-confirm-card" role="alertdialog" aria-label={plan.title} data-testid="lm-plan" onMouseDown={(e) => e.stopPropagation()}>
              <h3>{plan.title}</h3>
              <ul>{plan.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
              {plan.warnings.map((w, i) => <div className="status-line" key={i}>{w}</div>)}
              {plan.deleteModels && (
                <label className="check big">
                  <input type="checkbox" checked={deleteModels} data-testid="lm-delete-models" onChange={(e) => setDeleteModels(e.target.checked)} />
                  Also delete the downloaded models{plan.deleteModels.bytes ? ` (${formatSize(plan.deleteModels.bytes)}${plan.deleteModels.count ? `, ${plan.deleteModels.count} model${plan.deleteModels.count === 1 ? '' : 's'}` : ''})` : ''}. This cannot be undone.
                </label>
              )}
              <div className="form-actions">
                <button className="btn" onClick={() => setPlan(null)} data-testid="lm-plan-cancel">Cancel</button>
                <button className={`btn ${plan.action === 'uninstall' ? 'danger' : 'primary'}`} onClick={() => void confirm()} data-testid="lm-plan-confirm">
                  {plan.action === 'uninstall' ? 'Uninstall' : 'Download installer'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** "Start Ollama when the app opens", kept in the app's own settings. */
function AutoStart() {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    window.rc.call<{ settings: { ollamaAutoStart: boolean } }>('getSnapshot').then((s) => { if (alive) setOn(s.settings.ollamaAutoStart); }).catch(() => undefined);
    return () => { alive = false; };
  }, []);
  if (on === null) return null;
  return (
    <label className="check big">
      <input type="checkbox" checked={on} data-testid="lm-autostart" onChange={async (e) => {
        const v = e.target.checked;
        if (await act('updateSettings', { ollamaAutoStart: v })) setOn(v);
      }} />
      Start Ollama when the app opens (only if an agent uses a local model)
    </label>
  );
}
