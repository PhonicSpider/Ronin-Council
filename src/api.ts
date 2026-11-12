import { useEffect, useState } from 'react';
import type { Snapshot } from '../shared/types';

const toastListeners = new Set<(m: string) => void>();
export const toast = (m: string) => toastListeners.forEach((l) => l(m));

export function useToast(): [string | null, () => void] {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const l = (m: string) => {
      setMsg(m);
      clearTimeout(timer);
      timer = setTimeout(() => setMsg(null), 5000);
    };
    toastListeners.add(l);
    return () => { toastListeners.delete(l); clearTimeout(timer); };
  }, []);
  return [msg, () => setMsg(null)];
}

/** Call the main process; failures surface as a toast instead of an unhandled rejection. */
export async function act<T = unknown>(method: string, ...args: unknown[]): Promise<T | undefined> {
  try {
    return await window.rc.call<T>(method, ...args);
  } catch (e) {
    toast((e as Error).message);
    return undefined;
  }
}

export function useSnapshot(): Snapshot | null {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  useEffect(() => {
    let alive = true;
    window.rc.call<Snapshot>('getSnapshot').then((s) => { if (alive) setSnap(s); }).catch((e) => toast(String(e)));
    const off = window.rc.onSnapshot((s) => setSnap(s));
    return () => { alive = false; off(); };
  }, []);
  return snap;
}
