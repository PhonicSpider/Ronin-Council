// Renders assets/Logo/Logo.webp (1024 px master) to PNGs via Electron (no extra dependencies), builds the multi-size assets/Logo/Logo.ico,
// and a small assets/Logo/logo-title.png for the title bar.
// Usage: node_modules/electron/dist/electron.exe scripts/make-icons.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'assets', 'Logo', 'Logo.webp')).toString('base64');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

app.whenReady().then(async () => {
  const out = [];
  // Render once at 256 px, then downscale for the smaller sizes.
  const win = new BrowserWindow({ show: false, width: 256, height: 256, useContentSize: true, transparent: true, frame: false });
  const html = `<html><body style="margin:0;background:transparent;overflow:hidden"><img src="data:image/webp;base64,${src}" width="256" height="256"></body></html>`;
  fs.writeFileSync(path.join(root, 'assets', 'Logo', '_render.html'), html);
  await win.loadFile(path.join(root, 'assets', 'Logo', '_render.html'));
  await new Promise((r) => setTimeout(r, 500));
  const big = await win.webContents.capturePage();
  win.destroy();
  fs.unlinkSync(path.join(root, 'assets', 'Logo', '_render.html'));
  fs.writeFileSync(path.join(root, 'assets', 'Logo', 'logo-title.png'), big.resize({ width: 96, height: 96, quality: 'best' }).toPNG());
  for (const size of SIZES) {
    const png = (size === 256 ? big : big.resize({ width: size, height: size, quality: 'best' })).toPNG();
    fs.writeFileSync(path.join(root, 'assets', 'Logo', `icon-${size}.png`), png);
    out.push({ size, png });
  }
  // ICO container with embedded PNG images.
  const head = Buffer.alloc(6); head.writeUInt16LE(1, 2); head.writeUInt16LE(out.length, 4);
  let offset = 6 + 16 * out.length;
  const dirs = out.map(({ size, png }) => {
    const d = Buffer.alloc(16);
    d[0] = size >= 256 ? 0 : size; d[1] = size >= 256 ? 0 : size; d.writeUInt16LE(1, 4); d.writeUInt16LE(32, 6);
    d.writeUInt32LE(png.length, 8); d.writeUInt32LE(offset, 12); offset += png.length;
    return d;
  });
  fs.writeFileSync(path.join(root, 'assets', 'Logo', 'Logo.ico'), Buffer.concat([head, ...dirs, ...out.map((o) => o.png)]));
  console.log('icons written', out.map((o) => o.size).join(','));
  app.quit();
});
