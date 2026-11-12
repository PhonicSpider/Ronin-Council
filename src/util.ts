export const initials = (name: string) => name.slice(0, 2).toUpperCase();

export const timeStr = (ts: number) =>
  new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export type Block = { type: 'text'; text: string } | { type: 'code'; lang: string; code: string };

/** Split message text into prose and fenced code blocks. */
export function parseBlocks(s: string): Block[] {
  const out: Block[] = [];
  const re = /```([\w+-]*)\n([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push({ type: 'text', text: s.slice(last, m.index) });
    out.push({ type: 'code', lang: m[1], code: m[2].replace(/\n$/, '') });
    last = re.lastIndex;
  }
  if (last < s.length) out.push({ type: 'text', text: s.slice(last) });
  return out;
}

/** Only plain web addresses are allowed in the viewer's browser. */
export function normalizeUrl(input: string): string | null {
  let u = input.trim();
  if (!u) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = `https://${u}`;
  try {
    const p = new URL(u);
    return p.protocol === 'http:' || p.protocol === 'https:' ? p.toString() : null;
  } catch {
    return null;
  }
}

/** Something shown in the right-hand viewer. */
export interface ViewerItem {
  kind: 'code' | 'text' | 'image';
  title: string;
  content: string;
}

export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const usd =(n: number) => `$${n.toFixed(n < 1 ? 3 : 2)}`;
