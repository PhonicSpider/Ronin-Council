import { Fragment, type ReactNode } from 'react';

/**
 * Small, safe Markdown renderer for chat text. It builds React elements only (never HTML strings),
 * so message text can't inject markup. Links are limited to http/https. Fenced code blocks are
 * handled by the caller (parseBlocks); this covers everything else.
 */

type Mentions = (text: string) => ReactNode;

const SAFE_URL = /^https?:\/\/[^\s<>"]+$/i;

// Inline: `code`, **bold**, *italic* or _italic_, ~~strike~~, [text](url), bare URLs.
export function renderInline(src: string, mentions: Mentions, keyBase = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\*\*([^\s*](?:[\s\S]*?[^\s*])?)\*\*|~~([^\s~](?:[\s\S]*?[^\s~])?)~~|(?<![\w*])\*([^\s*](?:[^*]*?[^\s*])?)\*(?![\w*])|(?<![\w])_([^\s_](?:[^_]*?[^\s_])?)_(?![\w])|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]])/g;
  let last = 0;
  let n = 0;
  let m: RegExpExecArray | null;
  const key = () => `${keyBase}${n++}`;
  while ((m = re.exec(src))) {
    if (m.index > last) out.push(<Fragment key={key()}>{mentions(src.slice(last, m.index))}</Fragment>);
    if (m[2] !== undefined) out.push(<code key={key()} className="md-code">{m[2].trim()}</code>);
    else if (m[3] !== undefined) out.push(<strong key={key()}>{renderInline(m[3], mentions, key())}</strong>);
    else if (m[4] !== undefined) out.push(<del key={key()}>{renderInline(m[4], mentions, key())}</del>);
    else if (m[5] !== undefined) out.push(<em key={key()}>{renderInline(m[5], mentions, key())}</em>);
    else if (m[6] !== undefined) out.push(<em key={key()}>{renderInline(m[6], mentions, key())}</em>);
    else if (m[7] !== undefined && SAFE_URL.test(m[8]!)) {
      out.push(<a key={key()} href={m[8]} target="_blank" rel="noreferrer noopener" title={m[8]}>{m[7]}</a>);
    } else if (m[9] !== undefined) {
      out.push(<a key={key()} href={m[9]} target="_blank" rel="noreferrer noopener">{m[9]}</a>);
    } else out.push(<Fragment key={key()}>{m[0]}</Fragment>);
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push(<Fragment key={key()}>{mentions(src.slice(last))}</Fragment>);
  return out;
}

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const HR = /^\s*([-*_])(\s*\1){2,}\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

export function renderMarkdown(text: string, mentions: Mentions): ReactNode[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  let k = 0;
  const inl = (s: string) => renderInline(s, mentions, `b${k}-`);

  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) { i++; continue; }
    k++;

    const h = HEADING.exec(line);
    if (h) {
      const level = h[1]!.length;
      const Tag = `h${level}` as 'h1';
      out.push(<Tag key={k} className={`md-h md-h${level}`}>{inl(h[2]!)}</Tag>);
      i++; continue;
    }
    if (HR.test(line)) { out.push(<hr key={k} className="md-hr" />); i++; continue; }

    if (QUOTE.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) { buf.push(QUOTE.exec(lines[i]!)![1]!); i++; }
      out.push(<blockquote key={k} className="md-quote">{renderMarkdown(buf.join('\n'), mentions)}</blockquote>);
      continue;
    }

    // Table: header row, separator row, then body rows.
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!) && lines[i + 1]!.includes('-')) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trim() && lines[i]!.includes('|')) { rows.push(cells(lines[i]!)); i++; }
      out.push(
        <div key={k} className="md-table-wrap">
          <table className="md-table">
            <thead><tr>{head.map((c, x) => <th key={x}>{inl(c)}</th>)}</tr></thead>
            <tbody>{rows.map((r, y) => <tr key={y}>{head.map((_, x) => <td key={x}>{inl(r[x] ?? '')}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    }

    const b = BULLET.exec(line);
    const o = ORDERED.exec(line);
    if (b || o) {
      const ordered = !b;
      const items: string[] = [];
      const start = ordered ? Number(o![2]) : 1;
      while (i < lines.length) {
        const l = lines[i]!;
        const lb = BULLET.exec(l);
        const lo = ORDERED.exec(l);
        if (ordered ? lo : lb) { items.push((ordered ? lo![3] : lb![3])!); i++; }
        else if (l.trim() && /^\s{2,}\S/.test(l) && items.length && !BULLET.test(l) && !ORDERED.test(l)) {
          items[items.length - 1] += ' ' + l.trim(); i++; // wrapped continuation line
        } else break;
      }
      const li = items.map((t, x) => <li key={x}>{renderInline(t, mentions, `b${k}-${x}-`)}</li>);
      out.push(ordered
        ? <ol key={k} className="md-list" start={start}>{li}</ol>
        : <ul key={k} className="md-list">{li}</ul>);
      continue;
    }

    // Paragraph: consecutive plain lines; a single newline stays a line break.
    const buf: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !HEADING.test(lines[i]!) && !HR.test(lines[i]!)
      && !QUOTE.test(lines[i]!) && !BULLET.test(lines[i]!) && !ORDERED.test(lines[i]!)) {
      buf.push(lines[i]!); i++;
    }
    const parts: ReactNode[] = [];
    buf.forEach((l, x) => {
      if (x) parts.push(<br key={`br${x}`} />);
      parts.push(...renderInline(l, mentions, `b${k}-${x}-`));
    });
    out.push(<p key={k}>{parts}</p>);
  }
  return out;
}
