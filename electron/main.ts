import { app, BrowserWindow, dialog, ipcMain, safeStorage, session, shell } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createApi } from './api';
import { autoBackupIfDue } from './backup';
import { Orchestrator } from './orchestrator';
import { ClaudeProvider, MockProvider, Provider } from './providers';
import { KeyVault } from './keys';
import { OllamaManager } from './ollama';
import { createOllamaSystem } from './ollamaSystem';
import { OLLAMA_DEFAULT_ORIGIN } from '../shared/ollama';
import { scrubbedEnv } from './project';
import { HttpMeshyClient, MeshyClient, MockMeshyClient } from './meshy';
import { OpenAIProvider } from './openai';
import { RouterProvider } from './router';
import { vendorInfo, VendorId } from '../shared/vendors';
import { runSelfTest } from './selftest';
import { Store } from './store';
import { WIDOW_ID } from '../shared/types';
import { digestFor, INDEX_FILE, listFiles, readVaultFile, resolveVaultPath, writeVaultNote } from './vault';

// Test hooks exist only in unpackaged (development) runs.
if (process.env.RC_USERDATA && !app.isPackaged) app.setPath('userData', process.env.RC_USERDATA);
app.setName('Ronin Council');

const isHttp = (u: string) => /^https?:\/\//i.test(u);
let win: BrowserWindow | null = null;

function start() {
  const userData = app.getPath('userData');
  const dbFile = path.join(userData, 'council.json');
  const defaultVaultRoot = path.join(userData, 'vaults');
  const store = new Store(dbFile);
  store.expireStaleApprovals(); // nothing is waiting on requests from a previous run

  // ---- API keys: one encrypted file per vendor via the OS keychain (safeStorage); never sent to the renderer ----
  const keys = new KeyVault(userData, safeStorage);
  const mock = new MockProvider();
  const built = new Map<string, Provider>();

  /** Live = at least one vendor is set up: a saved key, or an address for a local/custom server. */
  const refreshMode = () => {
    const urls = store.settings.vendorUrls;
    const configured = Object.keys(keys.flags()).length > 0 || !!urls.local || !!urls.custom;
    store.setHasApiKey(keys.has("anthropic"));
    store.setHasMeshyKey(keys.has("meshy"));
    store.setVendorKeys(keys.flags());
    store.setMode(configured && !store.settings.useMock ? 'claude' : 'mock');
  };
  refreshMode();

  /** The provider for one vendor. Throws a readable error when it is not set up, which reaches the chat as that agent's failure. */
  const providerFor = (vendor: VendorId): Provider => {
    const info = vendorInfo(vendor);
    const key = keys.get(vendor);
    if (info.needsKey && !key) throw new Error(`No API key for ${info.label}. Add one in Settings → API & Models, or pick another model for this agent.`);
    const base = info.editableUrl ? store.settings.vendorUrls[vendor] || info.baseUrl : info.baseUrl;
    if (info.api === 'openai' && !base) throw new Error(`No address set for ${info.label} (Settings → API & Models).`);
    const id = `${vendor}|${base}|${key ?? ''}`;
    let p = built.get(id);
    if (!p) {
      p = info.api === 'anthropic' ? new ClaudeProvider(key!) : new OpenAIProvider({ vendor, baseUrl: base, apiKey: key });
      built.set(id, p);
    }
    return p;
  };
  const router = new RouterProvider(providerFor);

  // Meshy: a free placeholder while the agents are in Mock mode (so nothing is ever billed by accident), the real service when live
  // and a key is saved, otherwise not offered at all.
  const mockMeshy = new MockMeshyClient();
  let liveMeshy: { key: string; client: MeshyClient } | null = null;
  const getMeshy = (): MeshyClient | null => {
    refreshMode();
    if (store.mode === 'mock') return mockMeshy;
    const key = keys.get('meshy');
    if (!key) return null;
    if (liveMeshy?.key !== key) liveMeshy = { key, client: new HttpMeshyClient(key) };
    return liveMeshy.client;
  };

  const getProvider = (): Provider => {
    refreshMode();
    return store.mode === 'claude' ? router : mock;
  };

  const resolver = (cat: Parameters<typeof resolveVaultPath>[0]) => resolveVaultPath(cat, defaultVaultRoot);
  const orch = new Orchestrator(store, {
    getProvider,
    meshy: getMeshy,
    vaultDigest: (categoryId) => {
      try { return digestFor(store.categories(), categoryId, resolver); } catch { return '(vault unavailable)'; }
    },
    vaults: {
      hasNotes: () => store.categories().some((c) => {
        try { return listFiles(resolver(c), 20).some((f) => f !== INDEX_FILE); } catch { return false; }
      }),
      list: (categoryId) => {
        const cat = store.category(categoryId);
        return cat ? listFiles(resolver(cat), 300).filter((f) => f !== INDEX_FILE) : [];
      },
      read: (categoryId, rel) => {
        const cat = store.category(categoryId);
        if (!cat) throw new Error('Unknown project');
        const f = readVaultFile(resolver(cat), rel);
        if (f.kind !== 'text') throw new Error('Only text notes can be read');
        return f.content;
      },
      // Reached only after Widow's audit and the user's approval, so the write is made in Widow's name.
      write: (categoryId, rel, content) => {
        const cat = store.category(categoryId);
        if (!cat) throw new Error('Unknown project');
        writeVaultNote(resolver(cat), rel, content, WIDOW_ID);
      },
    },
  });

  const backupRoot = path.join(userData, 'backups');
  autoBackupIfDue(store, backupRoot); // at most one a day; keeps the newest few

  // Local models: finds, starts, stops, updates and removes Ollama, and manages its models. Used only from the Local models popup.
  const ollama = new OllamaManager({
    sys: createOllamaSystem(),
    downloadDir: path.join(userData, 'downloads'),
    origin: () => OLLAMA_DEFAULT_ORIGIN.replace('localhost', '127.0.0.1'),
    getSavedDir: () => store.settings.ollamaPath,
    setSavedDir: (d) => store.setOllamaPath(d),
    addressSaved: () => !!store.settings.vendorUrls.local,
    localAgents: () => store.agents().filter((a) => a.model?.vendor === 'local').map((a) => ({ id: a.id, name: a.name })),
    resetAgent: (id) => { store.updateAgent(id, { model: null }); },
    protectedDirs: [userData, app.getPath('appData'), path.dirname(process.execPath)],
    home: os.homedir(),
    childEnv: () => scrubbedEnv(),
    // Shown by the main process itself, so the page cannot change what the user is agreeing to.
    confirmNative: async (o) => {
      if (!win) return false;
      const r = await dialog.showMessageBox(win, { type: 'warning', title: o.title, message: o.message, detail: o.detail, buttons: ['Cancel', o.ok], defaultId: 0, cancelId: 0, noLink: true });
      return r.response === 1;
    },
    localAppData: process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
  });
  if (store.settings.ollamaAutoStart && store.agents().some((a) => a.model?.vendor === 'local')) {
    void ollama.detect().then(() => ollama.start()).catch((e) => console.error('ollama auto-start:', (e as Error).message));
  }

  const api = createApi({
    store, orch, ollama, defaultVaultRoot, refreshMode, devTools: !app.isPackaged, backupRoot,
    protectedRoots: [
      userData, app.getPath('appData'), path.dirname(process.execPath), process.env.windir, process.env.ProgramFiles,
      process.env['ProgramFiles(x86)'], process.env.ProgramData,
    ],
    setApiKey: (key, vendor) => keys.set(vendor, key),
    clearApiKey: (vendor) => keys.clear(vendor),
    listModels: async (vendor) => {
      const p = providerFor(vendor);
      if (!(p instanceof OpenAIProvider)) throw new Error('Model detection works for OpenAI-compatible vendors and local servers.');
      return p.listModels();
    },
    pickFolder: async () => {
      if (!win) return null;
      const r = await dialog.showOpenDialog(win, { title: 'Choose a vault folder', properties: ['openDirectory', 'createDirectory'] });
      return r.canceled ? null : r.filePaths[0] ?? null;
    },
  });

  ipcMain.handle('rc:call', async (e, method: unknown, args: unknown) => {
    if (!win || e.sender !== win.webContents) return { ok: false, error: 'Unauthorized' };
    try {
      if (typeof method !== 'string' || !Object.prototype.hasOwnProperty.call(api, method)) throw new Error('Unknown method');
      const fn = (api as Record<string, (...a: unknown[]) => unknown>)[method];
      return { ok: true, value: await fn(...(Array.isArray(args) ? args : [])) };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));

  win = new BrowserWindow({
    width: 1480, height: 920, minWidth: 980, minHeight: 600, backgroundColor: '#0b0d14', title: 'Ronin Council',
    icon: path.join(__dirname, '..', '..', 'assets', 'Logo', 'Logo.ico'),
    autoHideMenuBar: true,
    // The app draws its own title bar (logo + name); Windows still supplies the minimise/maximise/close buttons.
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0b0d14', symbolColor: '#c9ccd6', height: 38 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: true,
    },
  });
  const w = win;

  // Keep the app window on the app; send external links to the OS browser.
  w.webContents.setWindowOpenHandler(({ url }) => { if (isHttp(url)) void shell.openExternal(url); return { action: 'deny' }; });
  w.webContents.on('will-navigate', (ev) => ev.preventDefault());
  // The viewer's <webview> may only show plain web pages, with no Node access and no preload.
  w.webContents.on('will-attach-webview', (ev, prefs, params) => {
    delete prefs.preload;
    prefs.nodeIntegration = false;
    prefs.nodeIntegrationInSubFrames = false;
    prefs.contextIsolation = true;
    prefs.sandbox = true;
    prefs.webSecurity = true;
    prefs.allowRunningInsecureContent = false;
    params.partition = 'browser-guest'; // in-memory session: no cookies or cache shared with the app or kept on disk
    if (!isHttp(params.src) && params.src !== 'about:blank') ev.preventDefault();
  });
  // Guest pages get the same navigation rules as the app window: http(s) only, no popups.
  w.webContents.on('did-attach-webview', (_e, guest) => {
    guest.setWindowOpenHandler(({ url }) => { if (isHttp(url)) void shell.openExternal(url); return { action: 'deny' }; });
    guest.on('will-navigate', (ev, url) => { if (!isHttp(url)) ev.preventDefault(); });
    guest.on('will-redirect', (ev, url) => { if (!isHttp(url)) ev.preventDefault(); });
    guest.session.on('will-download', (ev) => ev.preventDefault());
  });

  let pending: NodeJS.Timeout | null = null;
  store.onChange(() => {
    if (pending || w.isDestroyed()) return;
    pending = setTimeout(() => {
      pending = null;
      if (!w.isDestroyed()) w.webContents.send('rc:snapshot', store.snapshot());
    }, 40);
  });

  void w.loadFile(path.join(__dirname, '..', '..', 'dist', 'index.html'));
  w.on('closed', () => { win = null; });

  const outDir = app.isPackaged ? undefined : process.env.RC_SELFTEST;
  if (outDir) void runSelfTest(w, store, outDir, userData).finally(() => app.quit());

  // A server this app started is stopped when it quits; one that was already running is left alone.
  let quitting = false;
  app.on('before-quit', (e) => {
    store.flush();
    if (!quitting && ollama.ownsServer) {
      e.preventDefault();
      quitting = true;
      void ollama.shutdown().finally(() => app.quit());
    }
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId('com.ronin.council'); // groups the taskbar icon under this app, not Electron
  app.whenReady().then(start);
  app.on('window-all-closed', () => app.quit());
}
