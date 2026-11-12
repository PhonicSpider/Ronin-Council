import { contextBridge, ipcRenderer } from 'electron';

// Narrow, explicit surface exposed to the renderer. All real work happens in the main process.
contextBridge.exposeInMainWorld('rc', {
  call: async (method: string, ...args: unknown[]) => {
    const r = await ipcRenderer.invoke('rc:call', method, args);
    if (!r.ok) throw new Error(r.error);
    return r.value;
  },
  onSnapshot: (cb: (snapshot: unknown) => void) => {
    const handler = (_e: unknown, snapshot: unknown) => cb(snapshot);
    ipcRenderer.on('rc:snapshot', handler);
    return () => { ipcRenderer.removeListener('rc:snapshot', handler); };
  },
});
