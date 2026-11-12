import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { LIMITS } from '../../shared/types';
import { fmtSize } from '../attach';

const VW = 240; // crop window, in CSS pixels: portrait 4:5, the shape avatars are shown in
const VH = 300;
const MAX_ZOOM = 5;
const TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const EXT_TYPE: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

interface Props {
  onSave: (dataUrl: string) => void;
  onCancel: () => void;
}

/** Pick an image, move and zoom it inside a portrait 4:5 frame, and save a 256 x 320 picture. */
export function AvatarEditor({ onSave, onCancel }: Props) {
  const [bm, setBm] = useState<ImageBitmap | null>(null);
  const [name, setName] = useState('');
  const [zoom, setZoom] = useState(1); // 1 = just fills the frame
  const [off, setOff] = useState({ x: 0, y: 0 }); // image centre relative to the frame centre, in CSS px
  const [error, setError] = useState('');
  const [over, setOver] = useState(false);
  const stage = useRef<HTMLCanvasElement>(null);
  const prevs = useRef<(HTMLCanvasElement | null)[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);

  const cover = bm ? Math.max(VW / bm.width, VH / bm.height) : 1; // smallest scale that fills the frame
  // Zooming out past 'fill' until the whole image fits (leaving empty bars, saved as transparent).
  const minZoom = bm ? Math.min(VW / bm.width, VH / bm.height) / cover : 1;
  const scale = cover * zoom;

  /** Keep the frame filled by the image (unless zoomed out past fill). */
  const clamp = useCallback((o: { x: number; y: number }, s: number) => {
    if (!bm) return o;
    const mx = Math.max(0, (bm.width * s - VW) / 2);
    const my = Math.max(0, (bm.height * s - VH) / 2);
    return { x: Math.min(mx, Math.max(-mx, o.x)), y: Math.min(my, Math.max(-my, o.y)) };
  }, [bm]);

  /** Paint the current framing onto a canvas of any size. */
  const paint = useCallback((cv: HTMLCanvasElement, pw: number) => {
    if (!bm) return;
    const ph = Math.round(pw * VH / VW);
    cv.width = pw; cv.height = ph;
    const g = cv.getContext('2d')!;
    g.imageSmoothingQuality = 'high';
    g.clearRect(0, 0, pw, ph);
    const f = pw / VW;
    const w = bm.width * scale * f;
    const h = bm.height * scale * f;
    g.drawImage(bm, pw / 2 + off.x * f - w / 2, ph / 2 + off.y * f - h / 2, w, h);
  }, [bm, scale, off]);

  useEffect(() => {
    if (stage.current) paint(stage.current, VW * 2);
    prevs.current.forEach((c, i) => { if (c) paint(c, [64, 38, 22][i]! * 2); });
  }, [paint]);

  useEffect(() => {
    // Captured on the document and stopped there, so Escape closes only this editor and not the dialog beneath it.
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } };
    document.addEventListener('keydown', h, true);
    return () => document.removeEventListener('keydown', h, true);
  }, [onCancel]);

  const load = async (file: File | undefined) => {
    if (!file) return;
    setError('');
    const type = TYPES.includes(file.type) ? file.type : EXT_TYPE[/\.([A-Za-z0-9]+)$/.exec(file.name)?.[1]?.toLowerCase() ?? ''];
    if (!type) { setError('Use a PNG, JPG, WebP or GIF image.'); return; }
    if (file.size > LIMITS.avatarSourceBytes) { setError(`That file is ${fmtSize(file.size)}; the limit is ${fmtSize(LIMITS.avatarSourceBytes)}.`); return; }
    try {
      const next = await createImageBitmap(file);
      if (next.width < 32 || next.height < 32) { setError('That image is too small (at least 32 × 32 pixels).'); next.close(); return; }
      bm?.close();
      setBm(next); setName(file.name); setZoom(1); setOff({ x: 0, y: 0 });
    } catch {
      setError('That file could not be read as an image.');
    }
  };

  const save = () => {
    if (!bm) return;
    const out = document.createElement('canvas');
    paint(out, LIMITS.avatarW);
    let url = '';
    for (const q of [0.92, 0.82, 0.7]) {
      url = out.toDataURL('image/webp', q);
      if (url.startsWith('data:image/webp') && url.length * 0.75 <= LIMITS.avatarStoredBytes) { onSave(url); return; }
    }
    url = out.toDataURL('image/png');
    if (url.length * 0.75 > LIMITS.avatarStoredBytes) { setError('The result is still too large. Try a simpler image.'); return; }
    onSave(url);
  };

  // Portalled to <body>: the dialogs beneath use backdrop-filter, which would otherwise trap a fixed overlay inside them.
  return createPortal(
    <div className="overlay top" onMouseDown={(e) => { e.stopPropagation(); onCancel(); }} data-testid="avatar-editor-overlay">
      <div className="avatar-editor" data-testid="avatar-editor" onMouseDown={(e) => e.stopPropagation()}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); void load(e.dataTransfer.files[0]); }}>
        <h3>Profile picture</h3>
        <input ref={input} type="file" hidden accept={TYPES.join(',')} data-testid="avatar-file"
          onChange={(e) => { void load(e.target.files?.[0]); e.target.value = ''; }} />

        {!bm ? (
          <div className={`drop-zone${over ? ' over' : ''}`}>
            <div className="drop-title">Drop an image here</div>
            <button className="btn" onClick={() => input.current?.click()}>Choose a file…</button>
            <div className="muted small">PNG, JPG, WebP or GIF · up to {fmtSize(LIMITS.avatarSourceBytes)} · saved as {LIMITS.avatarW} × {LIMITS.avatarH} (portrait)</div>
            <div className="muted small">Portrait images fit best. You can move and zoom it next.</div>
          </div>
        ) : (
          <>
            <div className="crop-body">
              <div className="crop-stage" style={{ width: VW, height: VH }}
                onPointerDown={(e) => {
                  try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* no active pointer (synthetic event) */ }
                  drag.current = { x: e.clientX, y: e.clientY };
                }}
                onPointerMove={(e) => {
                  const d = drag.current;
                  if (!d) return;
                  const dx = e.clientX - d.x, dy = e.clientY - d.y;
                  drag.current = { x: e.clientX, y: e.clientY };
                  setOff((o) => clamp({ x: o.x + dx, y: o.y + dy }, scale));
                }}
                onPointerUp={() => { drag.current = null; }}
                onPointerCancel={() => { drag.current = null; }}
                onWheel={(e) => {
                  const z = Math.min(MAX_ZOOM, Math.max(minZoom, zoom * Math.exp(-e.deltaY * 0.0015)));
                  setZoom(z); setOff((o) => clamp(o, cover * z));
                }}>
                <canvas ref={stage} style={{ width: VW, height: VH }} data-testid="crop-canvas" />
                <div className="crop-mask" />
              </div>
              <div className="crop-side">
                <div className="previews">
                  {[64, 38, 22].map((s, i) => (
                    <canvas key={s} ref={(el) => { prevs.current[i] = el; }} style={{ width: s, height: Math.round(s * 1.25) }} className="prev" />
                  ))}
                </div>
                <div className="muted small">How it will look</div>
              </div>
            </div>
            <label className="zoom-row">Zoom
              <input type="range" min={minZoom} max={MAX_ZOOM} step={0.01} value={zoom} data-testid="crop-zoom"
                onChange={(e) => { const z = Number(e.target.value); setZoom(z); setOff((o) => clamp(o, cover * z)); }} />
            </label>
            <div className="zoom-presets">
              <button className="btn sm" data-testid="crop-fit" onClick={() => { setZoom(minZoom); setOff({ x: 0, y: 0 }); }}>Fit whole image</button>
              <button className="btn sm" onClick={() => { setZoom(1); setOff({ x: 0, y: 0 }); }}>Fill frame</button>
            </div>
            <div className="muted small crop-hint" title={name}>Drag to move · scroll or use the slider to zoom · {name}</div>
          </>
        )}

        {error && <div className="form-error" role="alert" data-testid="avatar-error">{error}</div>}
        <div className="form-actions end editor-actions">
          {bm && <button className="btn" onClick={() => input.current?.click()}>Choose another…</button>}
          <button className="btn" onClick={onCancel}>Cancel</button>
          <button className="btn primary" disabled={!bm} onClick={save} data-testid="avatar-save">Use this picture</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
