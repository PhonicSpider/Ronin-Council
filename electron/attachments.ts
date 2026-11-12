import { randomUUID } from 'crypto';
import * as path from 'path';
import { Attachment, AttachmentInput, LIMITS } from '../shared/types';

/** An attachment that passed validation: its metadata plus the raw bytes. */
export interface IncomingFile { meta: Attachment; buf: Buffer }

const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** Identify an image by its first bytes (the claimed type is never trusted). */
export function sniffImage(buf: Buffer): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && (buf.subarray(0, 6).toString('latin1') === 'GIF87a' || buf.subarray(0, 6).toString('latin1') === 'GIF89a')) return 'image/gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

function decode(data: unknown, limit: number, what: string): Buffer {
  if (typeof data !== 'string' || !B64_RE.test(data)) throw new Error(`${what}: invalid data`);
  // Reject before decoding: base64 is 4 characters per 3 bytes.
  if (Math.floor((data.length * 3) / 4) > limit + 3) throw new Error(`${what} is too large`);
  const buf = Buffer.from(data, 'base64');
  if (buf.length > limit) throw new Error(`${what} is too large`);
  return buf;
}

function cleanName(raw: unknown): string {
  const base = path.basename(typeof raw === 'string' ? raw.replace(/\\/g, '/') : '');
  // eslint-disable-next-line no-control-regex
  const n = base.replace(/[\u0000-\u001f<>"]/g, '').trim().slice(0, 120);
  return n || 'file';
}

function cleanThumb(t: unknown): string | undefined {
  if (typeof t !== 'string' || t.length > LIMITS.attachThumbBytes) return undefined;
  return /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(t) ? t : undefined;
}

/**
 * Validate what the renderer sent: a bounded number of images (checked by content) and plain-text files.
 * Throws a readable message on the first problem, so nothing is half-accepted.
 */
export function ingestAttachments(raw: unknown): IncomingFile[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error('Invalid attachments');
  if (raw.length > LIMITS.attachMaxFiles) throw new Error(`You can attach up to ${LIMITS.attachMaxFiles} files at a time`);
  const out: IncomingFile[] = [];
  for (const item of raw as Partial<AttachmentInput>[]) {
    if (!item || typeof item !== 'object') throw new Error('Invalid attachments');
    const name = cleanName(item.name);
    const claimed = typeof item.mime === 'string' ? item.mime : '';
    if (claimed.startsWith('image/')) {
      const buf = decode(item.data, LIMITS.attachImageBytes, name);
      const mime = sniffImage(buf);
      if (!mime) throw new Error(`${name} is not a PNG, JPEG, GIF or WebP image`);
      out.push({ meta: { id: `att_${randomUUID().slice(0, 12)}`, name, kind: 'image', mime, size: buf.length, thumb: cleanThumb(item.thumb) }, buf });
    } else {
      const buf = decode(item.data, LIMITS.attachTextBytes, name);
      if (buf.subarray(0, 8192).includes(0)) throw new Error(`${name} looks like a binary file; only images and text files can be attached`);
      try { new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { throw new Error(`${name} is not valid UTF-8 text`); }
      out.push({ meta: { id: `att_${randomUUID().slice(0, 12)}`, name, kind: 'text', mime: 'text/plain', size: buf.length }, buf });
    }
  }
  return out;
}

/**
 * A project's GitHub repository. Accepts the https and ssh forms people paste, returns https://github.com/owner/repo,
 * and refuses everything else (other hosts, extra path, credentials in the URL).
 */
export function normalizeRepoUrl(raw: string): string {
  const v = raw.trim();
  if (!v) return '';
  const m = /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100}?)(?:\.git)?\/?$/.exec(v);
  if (!m || m[1] === '.' || m[1] === '..' || m[2] === '.' || m[2] === '..') {
    throw new Error('Enter a GitHub repository like https://github.com/owner/repo');
  }
  return `https://github.com/${m[1]}/${m[2]}`;
}

/** '' clears a profile picture. Anything else must be a small PNG/JPEG/WebP data URL whose bytes really are that image. */
export function validateAvatar(value: string): string {
  if (value === '') return '';
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!m) throw new Error('Profile pictures must be PNG, JPEG or WebP');
  const buf = decode(m[2], LIMITS.avatarStoredBytes, 'The profile picture');
  const real = sniffImage(buf);
  const want = m[1] === 'jpeg' ? 'image/jpeg' : `image/${m[1]}`;
  if (real !== want) throw new Error('That file is not the image type it claims to be');
  return value;
}
