import { AttachmentInput, LIMITS } from '../shared/types';

/** A file staged in the composer, not yet sent. */
export interface Pending extends AttachmentInput {
  id: string;
  kind: 'image' | 'text';
  size: number;
}

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'json', 'jsonc', 'csv', 'tsv', 'log', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'xml', 'html', 'htm',
  'css', 'scss', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'cs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'rs', 'go', 'rb', 'php', 'lua',
  'sh', 'bat', 'cmd', 'ps1', 'sql', 'svg', 'gd', 'shader', 'hlsl', 'glsl', 'unity', 'asmdef', 'csproj', 'sln', 'gradle', 'properties',
]);
const IMAGE_EXT: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

/** For the file picker's filter. */
export const ACCEPT = [...IMAGE_TYPES, ...[...TEXT_EXT].map((e) => `.${e}`)].join(',');

/** The longest side sent to the model; larger images are scaled down first (the API downsizes anything bigger anyway). */
const MAX_EDGE = 1568;
const KEEP_ORIGINAL_BYTES = 4.5 * 1024 * 1024;

export const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1048576).toFixed(1)} MB`);

const extOf = (name: string) => /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase() ?? '';

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Draw the bitmap scaled so its longest side is at most `edge`, on white (JPEG has no transparency). Returns a data URL. */
export function renderScaled(bm: ImageBitmap, edge: number, quality: number): { url: string; w: number; h: number } {
  const k = Math.min(1, edge / Math.max(bm.width, bm.height));
  const w = Math.max(1, Math.round(bm.width * k));
  const h = Math.max(1, Math.round(bm.height * k));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, w, h);
  g.imageSmoothingQuality = 'high';
  g.drawImage(bm, 0, 0, w, h);
  return { url: c.toDataURL('image/jpeg', quality), w, h };
}

const stripPrefix = (url: string) => url.slice(url.indexOf(',') + 1);

/** Check and convert one dropped/picked file. Throws a message fit to show the user. */
export async function prepareFile(file: File): Promise<Pending> {
  const name = file.name || 'file';
  const ext = extOf(name);
  const imageType = IMAGE_TYPES.includes(file.type) ? file.type : IMAGE_EXT[ext];
  const id = `p_${Math.random().toString(36).slice(2, 10)}`;

  if (imageType) {
    if (file.size > LIMITS.avatarSourceBytes * 3) throw new Error(`${name} is too large to attach (${fmtSize(file.size)})`);
    let bm: ImageBitmap;
    try { bm = await createImageBitmap(file); } catch { throw new Error(`${name} could not be read as an image`); }
    try {
      const thumb = renderScaled(bm, 96, 0.7).url;
      if (file.size <= KEEP_ORIGINAL_BYTES && Math.max(bm.width, bm.height) <= MAX_EDGE) {
        return { id, kind: 'image', name, mime: imageType, size: file.size, data: toBase64(await file.arrayBuffer()), thumb };
      }
      const big = renderScaled(bm, MAX_EDGE, 0.88);
      const data = stripPrefix(big.url);
      const size = Math.floor((data.length * 3) / 4);
      if (size > LIMITS.attachImageBytes) throw new Error(`${name} is still too large after shrinking it`);
      return { id, kind: 'image', name: name.replace(/\.[^.]+$/, '') + '.jpg', mime: 'image/jpeg', size, data, thumb };
    } finally {
      bm.close();
    }
  }

  const textLike = TEXT_EXT.has(ext) || file.type.startsWith('text/') || /json|xml|javascript/.test(file.type);
  if (!textLike) {
    throw new Error(`${name}: only images (PNG, JPG, WebP, GIF) and text or code files can be attached`);
  }
  if (file.size > LIMITS.attachTextBytes) {
    throw new Error(`${name} is ${fmtSize(file.size)}; text files must be under ${fmtSize(LIMITS.attachTextBytes)}. Put big files in a project folder or vault instead.`);
  }
  let buf: ArrayBuffer;
  try { buf = await file.arrayBuffer(); } catch { throw new Error(`${name} could not be read (folders cannot be attached)`); }
  return { id, kind: 'text', name, mime: 'text/plain', size: buf.byteLength, data: toBase64(buf) };
}

/** Convert a batch, collecting readable problems instead of stopping at the first one. */
export async function prepareFiles(files: File[], room: number): Promise<{ ok: Pending[]; errors: string[] }> {
  const ok: Pending[] = [];
  const errors: string[] = [];
  for (const f of files) {
    if (ok.length >= room) { errors.push(`Only ${LIMITS.attachMaxFiles} files can be attached to one message`); break; }
    try { ok.push(await prepareFile(f)); } catch (e) { errors.push((e as Error).message); }
  }
  return { ok, errors };
}
