import { app, BrowserWindow, dialog, ipcMain, safeStorage, session, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { createApi } from './api';
import { autoBackupIfDue } from './backup';
import { Orchestrator } from './orchestrator';
import { ClaudeProvider, MockProvider, Provider } from './providers';
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
  const secretFile = path.join(userData, 'api-key.bin');
  const defaultVaultRoot = path.join(userData, 'vaults');
  const store = new Store(dbFile);
  store.expireStaleApprovals(); // nothing is waiting on requests from a previous run

  // ---- API key: encrypted with the OS keychain via safeStorage; never sent to the renderer ----
  let apiKey: string | null = null;
  let claude: ClaudeProvider | null = null;
  const mock = new MockProvider();
  try {
    if (fs.existsSync(secretFile) && safeStorage.isEncryptionAvailable()) {
      apiKey = safeStorage.decryptString(fs.readFileSync(secretFile));
    }
  } catch { apiKey = null; }

  const refreshMode = () => {
    const live = !!apiKey && !store.settings.useMock;
    store.setHasApiKey(!!apiKey);
    store.setMode(live ? 'claude' : 'mock');
  };
  refreshMode();

  const getProvider = (): Provider => {
    refreshMode();
    if (store.mode === 'claude' && apiKey) {
      claude ??= new ClaudeProvider(apiKey);
      return claude;
    }
    return mock;
  };

  const resolver = (cat: Parameters<typeof resolveVaultPath>[0]) => resolveVaultPath(cat, defaultVaultRoot);
  const orch = new Orchestrator(store, {
    getProvider,
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

  const api = createApi({
    store, orch, defaultVaultRoot, refreshMode, devTools: !app.isPackaged, backupRoot,
    protectedRoots: [
      userData, app.getPath('appData'), path.dirname(process.execPath), process.env.windir, process.env.ProgramFiles,
      process.env['ProgramFiles(x86)'], process.env.ProgramData,
    ],
    setApiKey: (key) => {
      if (!key) throw new Error('Enter an API key');
      const weak = (safeStorage as { getSelectedStorageBackend?: () => string }).getSelectedStorageBackend?.() === 'basic_text';
      if (!safeStorage.isEncryptionAvailable() || weak) throw new Error('Secure storage is not available on this system, so the key was not saved');
      fs.mkdirSync(userData, { recursive: true });
      fs.writeFileSync(secretFile, safeStorage.encryptString(key));
      apiKey = key; claude = null;
    },
    clearApiKey: () => {
      try { fs.rmSync(secretFile, { force: true }); } catch { /* ignore */ }
      apiKey = null; claude = null;
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

  app.on('before-quit', () => store.flush());
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId('com.ronin.council'); // groups the taskbar icon under this app, not Electron
  app.whenReady().then(start);
  app.on('window-all-closed', () => app.quit());
}
