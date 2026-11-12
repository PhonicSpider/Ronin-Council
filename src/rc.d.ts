import 'react';
import type { Snapshot } from '../shared/types';

declare global {
  interface Window {
    rc: {
      call<T = unknown>(method: string, ...args: unknown[]): Promise<T>;
      onSnapshot(cb: (s: Snapshot) => void): () => void;
    };
  }
}

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string;
        allowpopups?: string;
      };
    }
  }
}
