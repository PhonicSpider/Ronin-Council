// Drives the real UI inside Electron for end-to-end smoke testing. Runs only when RC_SELFTEST is set.
import type { BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import type { AddressInfo } from 'net';
import * as path from 'path';
import type { Store } from './store';

interface Result { step: string; ok: boolean; detail?: unknown }

const HELPERS = `
window.confirm = () => true;
window.__t = {
  tid: (id) => document.querySelector('[data-testid="' + id + '"]'),
  all: (id) => [...document.querySelectorAll('[data-testid="' + id + '"]')],
  setVal(el, v) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype
      : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  },
  key(el, key) { el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); },
  dnd(src, dst) {
    const dt = new DataTransfer();
    const fire = (el, type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    fire(src, 'dragstart'); fire(dst, 'dragover'); fire(dst, 'drop'); fire(src, 'dragend');
  },
  chan(name, cat = 0) {
    const c = document.querySelectorAll('[data-testid="category"]')[cat];
    if (!c) return null;
    return [...c.querySelectorAll('[data-testid="channel"]')].find((e) => e.querySelector('.chan-name')?.textContent === name) || null;
  },
  msgs: () => [...document.querySelectorAll('[data-testid="message"]')].map((e) => ({ kind: e.dataset.kind || 'system', text: e.textContent })),
};
true;
`;

export async function runSelfTest(win: BrowserWindow, store: Store, outDir: string, userData: string): Promise<void> {
  fs.mkdirSync(outDir, { recursive: true });
  const results: Result[] = [];
  const consoleIssues: string[] = [];
  const wc = win.webContents;
  wc.on('console-message', (_e, level, message) => { if (level >= 2) consoleIssues.push(message); });
  wc.on('render-process-gone', (_e, d) => consoleIssues.push(`render-process-gone: ${d.reason}`));

  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const js = <T>(code: string) => wc.executeJavaScript(code, true) as Promise<T>;
  const shot = async (name: string) => {
    await wait(350); // let the frame paint so the capture is not stale
    let img = await wc.capturePage();
    for (let i = 0; i < 3 && img.isEmpty(); i++) { // a hidden or minimised window captures as empty: bring it back and retry
      if (win.isMinimized()) win.restore();
      win.showInactive();
      await wait(500);
      img = await wc.capturePage();
    }
    fs.writeFileSync(path.join(outDir, `${name}.png`), img.toPNG());
  };
  const waitFor = async (code: string, timeout = 8000) => {
    const t = Date.now();
    while (Date.now() - t < timeout) {
      try { if (await js<boolean>(`!!(${code})`)) return true; } catch { /* page not ready */ }
      await wait(120);
    }
    return false;
  };
  const check = (step: string, ok: boolean, detail?: unknown) => results.push({ step, ok, detail });
  const step = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); } catch (e) { check(name, false, `threw: ${(e as Error).message}`); }
  };

  try {
    if (wc.isLoading()) await new Promise<void>((r) => wc.once('did-finish-load', () => r()));
    const rendered = await waitFor(`document.querySelector('[data-testid="sidebar"]')`, 15000);
    check('app renders', rendered);
    if (!rendered) throw new Error('UI did not render');
    await js(HELPERS);
    await js(`localStorage.setItem('rc.speak', '0')`); // replies appear at once, so the other steps need no waiting; the spotlight step turns it on
    await wait(300);

    await step('initial layout', async () => {
      const info = await js<{ cats: number; chans: number; title: string; banner: boolean }>(`({
        cats: __t.all('category').length, chans: __t.all('channel').length,
        title: __t.tid('channel-title')?.textContent, banner: !!__t.tid('mock-banner') })`);
      check('3 categories, 18 channels, #general open, mock banner shown',
        info.cats === 3 && info.chans === 18 && info.title === 'general' && info.banner, info);
      await shot('01-initial');
    });

    await step('collapse', async () => {
      await js(`__t.all('collapse')[0].click()`);
      await wait(250);
      const collapsed = await js<number>(`__t.all('channel').length`);
      await js(`__t.all('collapse')[0].click()`);
      await wait(250);
      const expanded = await js<number>(`__t.all('channel').length`);
      check('category collapses (18→12) and expands (→18)', collapsed === 12 && expanded === 18, { collapsed, expanded });
    });

    await step('drag channel within category', async () => {
      const cat = store.categories().find((c) => c.order === 0)!;
      const before = store.channels().filter((c) => c.categoryId === cat.id).sort((a, b) => a.order - b.order).map((c) => c.name);
      await js(`__t.dnd(__t.chan('general'), __t.chan('art'))`);
      await wait(300);
      const after = store.channels().filter((c) => c.categoryId === cat.id).sort((a, b) => a.order - b.order).map((c) => c.name);
      check('dragging #general onto #art reorders within the category',
        after.join() !== before.join() && after[4] === 'general' && after.length === 6, { before, after });
      const domOrder = await js<string[]>(`[...document.querySelectorAll('[data-testid="category"]')[0].querySelectorAll('.chan-name')].map(e=>e.textContent)`);
      check('sidebar shows the new order', domOrder.join() === after.join(), domOrder);
    });

    await step('channel cannot leave its category', async () => {
      const snapshotOf = () => store.channels().map((c) => `${c.id}:${c.categoryId}:${c.order}`).join('|');
      const before = snapshotOf();
      await js(`__t.dnd(__t.chan('research', 0), __t.chan('research', 1))`);
      await wait(300);
      check('dropping a channel onto another category does nothing', snapshotOf() === before);
    });

    await step('drag category', async () => {
      const before = [...store.categories()].sort((a, b) => a.order - b.order).map((c) => c.name);
      await js(`(() => { const h = document.querySelectorAll('.cat-header'); __t.dnd(h[0], h[2]); })()`);
      await wait(300);
      const after = [...store.categories()].sort((a, b) => a.order - b.order).map((c) => c.name);
      check('category order changes when dragged', after.join() !== before.join() && after[2] === before[0], { before, after });
    });

    await step('send message, Widow routes', async () => {
      await js(`__t.setVal(__t.tid('composer'), 'hello team')`);
      await js(`__t.tid('send').click()`);
      const ok = await waitFor(`__t.msgs().some(m => m.text.includes('[mock]') && m.text.includes('hello team'))`);
      const msgs = await js<{ kind: string; text: string }[]>(`__t.msgs()`);
      check('user message and a routed agent reply appear', ok, msgs.map((m) => m.text.slice(0, 60)));
      await shot('02-chat');
    });

    await step('@mention autocomplete', async () => {
      await js(`__t.setVal(__t.tid('composer'), '@Or')`);
      const shown = await waitFor(`__t.tid('mention-menu') && __t.tid('mention-menu').textContent.includes('Orin')`);
      await js(`__t.key(__t.tid('composer'), 'Enter')`);
      await wait(200);
      const val = await js<string>(`__t.tid('composer').value`);
      check('typing @Or offers Orin; Enter inserts "@Orin "', shown && val === '@Orin ', { val });
      await shot('03-mention');
      await js(`__t.setVal(__t.tid('composer'), '')`);
    });

    await step('deliverable audit in UI', async () => {
      await js(`__t.chan('design', 2).click()`); // category order changed: original first category is now last
      await wait(250);
      const title = await js<string>(`__t.tid('channel-title').textContent`);
      await js(`__t.setVal(__t.tid('composer'), '@Mira make a plan for the layout')`);
      await js(`__t.key(__t.tid('composer'), 'Escape')`);
      await js(`__t.tid('send').click()`);
      const ok = await waitFor(`__t.msgs().some(m => m.kind === 'deliverable') && __t.msgs().some(m => m.kind === 'review')`);
      check('#design: Mira posts a deliverable and Kade reviews it', ok && title === 'design', { title });
      await shot('04-audit');
    });

    await step('code block → viewer, notes, pin', async () => {
      await js(`__t.setVal(__t.tid('composer'), '@Mira here is code\\n\`\`\`js\\nconsole.log(1)\\n\`\`\`')`);
      await js(`__t.key(__t.tid('composer'), 'Escape')`);
      await js(`__t.tid('send').click()`);
      const hasBlock = await waitFor(`document.querySelector('.codeblock')`);
      await js(`[...document.querySelectorAll('.code-head button')].find(b => b.textContent === 'View in panel').click()`);
      const viewed = await waitFor(`__t.tid('viewer-item') && __t.tid('viewer-item').textContent.includes('console.log(1)')`);
      check('"View in panel" shows the code in the viewer', hasBlock && viewed);
      await js(`__t.setVal(__t.tid('note-input'), 'remember this'); __t.tid('note-input').dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true, cancelable:true}))`);
      const noted = await waitFor(`__t.all('note').some(n => n.textContent.includes('remember this'))`);
      await js(`document.querySelector('.msg-tools button').click()`);
      const pinned = await waitFor(`__t.all('note').length >= 2`);
      check('notes: add a note and pin a message', noted && pinned);
      await shot('05-viewer-notes');
    });

    await step('browser tab', async () => {
      await js(`__t.tid('tab-browser').click()`);
      await wait(200);
      // A throwaway local web server stands in for "the page being tested", so this needs no internet.
      const server = http.createServer((_q, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<title>RC-OK</title><h1 style="font-family:sans-serif">Served to the viewer</h1>');
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
      await js(`__t.setVal(__t.tid('browser-url'), ${JSON.stringify(url)}); __t.key(__t.tid('browser-url'), 'Enter')`);
      const hasWebview = await waitFor(`__t.tid('webview')`);
      const loaded = await waitFor(`(() => { try { return __t.tid('webview').getTitle() === 'RC-OK'; } catch { return false; } })()`, 10000);
      check('browser tab loads a real page inside the webview', hasWebview && loaded, { url });
      await shot('06a-browser-loaded');
      server.close();
      await js(`__t.setVal(__t.tid('browser-url'), 'file:///C:/Windows/win.ini'); __t.key(__t.tid('browser-url'), 'Enter')`);
      await wait(300);
      const stillSafe = await js<boolean>(`!__t.tid('webview')`);
      check('non-http addresses are rejected (no webview)', stillSafe);
      await shot('06-browser');
    });

    await step('vault tab + cross-vault index', async () => {
      await js(`__t.tid('tab-vault').click()`);
      await wait(300);
      await js(`__t.tid('refresh-index').click()`);
      await wait(600);
      const files = store.categories().map((c) =>
        fs.existsSync(path.join(userData, 'vaults', c.id, '_Other Vaults.md')));
      check('refresh writes _Other Vaults.md into all three vaults', files.every(Boolean), files);
      const listed = await waitFor(`[...document.querySelectorAll('.file')].some(f => f.textContent === '_Other Vaults.md')`);
      await js(`[...document.querySelectorAll('.file')].find(f => f.textContent === '_Other Vaults.md').click()`);
      const opened = await waitFor(`__t.tid('viewer-item') && __t.tid('viewer-item').textContent.includes('Other Vaults')`);
      check('vault file is listed and opens in the viewer', listed && opened);
      await shot('07-vault');
    });

    await step('permission flow: inline when in the same channel', async () => {
      const openId = await js<string>(`localStorage.getItem('rc.selected')`);
      await js(`window.rc.call('devPermissionRequest', ${JSON.stringify(openId)}, 'prog')`);
      const card = await waitFor(`__t.tid('permission-card') && __t.tid('approve')`);
      await shot('08-permission-inline');
      await js(`__t.tid('approve').click()`);
      await wait(300);
      const n = store.snapshot().notifications.find((x) => x.kind === 'permission');
      check('Widow audits, card appears inline, Approve resolves it', card && n?.status === 'approved', { status: n?.status, openId });
    });

    await step('permission flow: notification centre when elsewhere', async () => {
      // the request originates from a channel that is NOT the one on screen
      const openId = await js<string>(`localStorage.getItem('rc.selected')`);
      const notViewing = store.channels().find((c) => c.categoryId && c.kind === 'engineering' && c.id !== openId)!;
      await js(`window.rc.call('devPermissionRequest', ${JSON.stringify(notViewing.id)}, 'prog')`);
      const badge = await waitFor(`__t.tid('notif-badge')`);
      const noCard = await js<boolean>(`!__t.tid('permission-card')`);
      await js(`__t.tid('open-notifications').click()`);
      const panel = await waitFor(`__t.tid('notif-panel') && __t.tid('notif-approve')`);
      await shot('09-notifications');
      await js(`__t.tid('notif-approve').click()`);
      await wait(300);
      const pending = store.snapshot().notifications.filter((n) => n.status === 'awaiting-user').length;
      check('request from another channel shows a badge (no inline card) and resolves from the notification centre',
        badge && noCard && panel && pending === 0, { badge, noCard, panel, pending });
      await js(`document.body.dispatchEvent(new MouseEvent('mousedown', {bubbles:true}))`);
    });

    await step('Widow DM', async () => {
      await js(`__t.tid('open-widow').click()`);
      await wait(250);
      await js(`__t.setVal(__t.tid('composer'), 'status?')`);
      await js(`__t.tid('send').click()`);
      const ok = await waitFor(`__t.msgs().some(m => m.text.includes('[mock] Widow'))`);
      const title = await js<string>(`__t.tid('channel-title').textContent`);
      check('Widow DM replies as Widow', ok && title === 'Widow');
      await shot('10-widow-dm');
    });

    await step('attachments: drop, + button, send, view', async () => {
      await js(`window.__mk = {
        png: (w, h, name) => new Promise((res) => {
          const c = document.createElement('canvas'); c.width = w; c.height = h;
          const g = c.getContext('2d'); const k = g.createLinearGradient(0, 0, w, h);
          k.addColorStop(0, '#e5484d'); k.addColorStop(1, '#4cc9e6'); g.fillStyle = k; g.fillRect(0, 0, w, h);
          g.fillStyle = '#fff'; g.beginPath(); g.arc(w * 0.3, h * 0.4, Math.min(w, h) * 0.18, 0, 7); g.fill();
          c.toBlob((b) => res(new File([b], name, { type: 'image/png' })));
        }),
        dt: (...files) => { const d = new DataTransfer(); files.forEach((f) => d.items.add(f)); return d; },
        fire: (el, type, dt) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt })),
      }; true`);
      // Drag a picture in from "the file explorer".
      await js(`(async () => { const f = await __mk.png(1800, 1200, 'sketch.png'); const d = __mk.dt(f);
        const chat = __t.tid('chat'); __mk.fire(chat, 'dragenter', d); __mk.fire(chat, 'dragover', d); window.__d = d; })()`);
      const veil = await waitFor(`__t.tid('drop-veil')`, 3000);
      await shot('18-drop-veil');
      await js(`__mk.fire(__t.tid('chat'), 'drop', window.__d)`);
      const staged = await waitFor(`__t.all('pending-file').length === 1 && !__t.tid('drop-veil')`, 6000);
      const chip = await js<{ name: string; hasThumb: boolean }>(`({ name: __t.tid('pending-file').textContent, hasThumb: !!__t.tid('pending-file').querySelector('img') })`);
      check('dragging an image onto the chat shows the drop overlay, then stages it with a thumbnail',
        veil && staged && chip.hasThumb && chip.name.includes('sketch.jpg'), chip); // 1800 px wide, so it is shrunk and re-saved as a JPEG

      // The + button's file input: a text file is accepted, an executable is refused with a readable message.
      await js(`(async () => { const t = new File(['# Plan\\nship it'], 'plan.md', { type: 'text/markdown' });
        const x = new File(['MZ'], 'setup.exe', { type: 'application/x-msdownload' });
        const inp = __t.tid('attach-input'); inp.files = __mk.dt(t, x).files; inp.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      const two = await waitFor(`__t.all('pending-file').length === 2`, 4000);
      const toastText = await js<string>(`document.querySelector('.toast')?.textContent || ''`);
      check('+ button accepts a text file and refuses an .exe with a message', two && /only images/.test(toastText), toastText);
      await shot('19-composer-chips');

      // Remove one, then send with the rest.
      await js(`__t.all('pending-file')[1].querySelector('button').click()`);
      const one = await waitFor(`__t.all('pending-file').length === 1`, 2000);
      await js(`__t.setVal(__t.tid('composer'), 'what is in this picture?')`);
      await js(`__t.tid('send').click()`);
      const sent = await waitFor(`__t.all('attachment').length >= 1 && __t.all('pending-file').length === 0`, 6000);
      const got = await waitFor(`__t.msgs().some(m => m.text.includes('1 image received'))`, 8000);
      const stored = store.snapshot().messages.filter((m) => m.attachments?.length).pop();
      check('sending delivers the image to the agent (mock saw 1 image) and shows it in the message',
        one && sent && got && stored?.attachments?.[0]?.kind === 'image', { one, sent, got, stored: stored?.attachments?.map((a) => a.name) });
      await shot('20-message-with-image');

      await js(`__t.all('attachment')[0].click()`);
      const viewed = await waitFor(`__t.tid('viewer-item')?.querySelector('img')`, 4000);
      check('clicking the attachment opens the full image in the side panel', viewed);

      // Files only, no text.
      await js(`(async () => { const t = new File(['alpha'], 'only.txt', { type: 'text/plain' });
        const inp = __t.tid('attach-input'); inp.files = __mk.dt(t).files; inp.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await waitFor(`__t.all('pending-file').length === 1`, 3000);
      const enabled = await js<boolean>(`!__t.tid('send').disabled`);
      await js(`__t.tid('send').click()`);
      const fileOnly = await waitFor(`__t.msgs().some(m => m.text.includes('only.txt'))`, 4000);
      check('a files-only message can be sent', enabled && fileOnly);
    });

    await step('delegation: teams work in their own channels and report back', async () => {
      await js(`__t.chan('general', 0).click()`);
      await wait(300);
      const text = '@security audit the back end for leaks. @networking, tighten things for dedicated servers. @design, make the front end UI look decent.';
      await js(`__t.setVal(__t.tid('composer'), ${JSON.stringify(text)})`);
      await js(`__t.tid('send').click()`);
      const done = await waitFor(`__t.msgs().filter(m => m.text.includes('Report from #')).length === 2`, 20000);
      await shot('23-delegation-general');
      const sys = await js<string>(`__t.msgs().find(m => m.text.includes('Sending this out'))?.text || ''`);
      check('#general: Widow lists who went where, and each team reports back with a brief',
        done && /#engineering/.test(sys) && /#design/.test(sys) && /Report from #engineering/.test(await js<string>(`__t.msgs().map(m=>m.text).join('|')`)),
        { done, sys: sys.slice(0, 160) });
      const cat = store.categories().find((c) => c.order === 0)!;
      const eng = store.channels().find((c) => c.categoryId === cat.id && c.kind === 'engineering')!;
      const engMsgs = store.snapshot().messages.filter((m) => m.channelId === eng.id);
      check('the engineering channel got the brief and the agents talked there',
        /^Task from #general/.test(engMsgs[0]?.content ?? '') && new Set(engMsgs.map((m) => m.authorId)).size >= 3, engMsgs.length);
      await js(`__t.chan('engineering', 0).click()`);
      await wait(400);
      await shot('24-delegation-engineering');
      await js(`__t.chan('general', 0).click()`);
    });

    await step('roster: portraits and names under the header, lime ring on working agents', async () => {
      const where = await js<{ chips: number; headerAvatars: number; below: boolean }>(`({
        chips: __t.all('roster-chip').length,
        headerAvatars: document.querySelectorAll('.chat-header .avatar').length,
        below: document.querySelector('.roster').getBoundingClientRect().top >= document.querySelector('.chat-header').getBoundingClientRect().bottom - 1,
      })`);
      check('roster lists the members below the header (none left in the header)', where.chips >= 2 && where.headerAvatars === 0 && where.below, where);
      store.setAgentStatus('widow', 'thinking');
      store.setAgentStatus('prog', 'blocked');
      const lit = await waitFor(`document.querySelectorAll('.rchip.working').length === 1 && document.querySelectorAll('.rchip.waiting').length === 1`, 3000);
      const anim = await js<string>(`getComputedStyle(document.querySelector('.rchip.working .ring')).animationName`);
      await shot('26-roster-working');
      check('a working agent gets the spinning lime ring; one waiting on approval gets amber', lit && anim === 'ring-spin', anim);
      store.setAgentStatus('widow', 'idle');
      store.setAgentStatus('prog', 'idle');
      check('rings clear when agents go idle', await waitFor(`document.querySelectorAll('.rchip.working, .rchip.waiting').length === 0`, 3000));
    });

    await step('roster shows portraits only, with the name on hover', async () => {
      const r = await js<{ chips: number; texts: string[]; titled: boolean }>(`({
        chips: __t.all('roster-chip').length,
        texts: __t.all('roster-chip').filter(c => c.querySelector('strong, small, .rtext')).map(c => c.textContent.trim()),
        titled: __t.all('roster-chip').every(c => /—/.test(c.title)),
      })`);
      check('roster chips carry no name text, only a portrait and a hover title', r.chips >= 2 && r.texts.length === 0 && r.titled, r);
    });

    await step('category cog opens a quick settings card for that category', async () => {
      const cats = [...store.categories()].sort((a, b) => a.order - b.order);
      const first = cats[0]!;
      const cogs = await js<number>(`__t.all('category-cog').length`);
      await js(`__t.all('category-cog')[0].click()`);
      const open = await waitFor(`__t.tid('category-settings') && __t.tid('project-path-${first.id}')`, 3000);
      const heading = await js<string>(`__t.tid('category-settings')?.querySelector('h3')?.textContent || ''`);
      await shot('29-category-cog');
      check('each category has a cog; it opens that category\'s vault/project/repo settings', cogs === cats.length && open && heading.includes(first.name), { cogs, heading });
      // The shortcut saves like the full settings do.
      await js(`__t.setVal(__t.tid('repo-url-${first.id}'), 'https://github.com/example/quick')`);
      await js(`__t.tid('repo-save-${first.id}').click()`);
      await wait(300);
      check('saving from the quick card updates the category', store.category(first.id)?.repoUrl === 'https://github.com/example/quick', store.category(first.id)?.repoUrl);
      await js(`__t.tid('category-all-settings').click()`);
      const full = await waitFor(`__t.tid('settings') && __t.tid('settings-tab-vaults').classList.contains('active') && !__t.tid('category-settings')`, 3000);
      check('"All settings…" opens the full settings on Vaults & Projects', full);
      await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
      await waitFor(`!__t.tid('settings')`, 2000);
    });

    await step('speaker spotlight: the speaking agent appears large, then goes away', async () => {
      await js(`localStorage.setItem('rc.speak', '1')`);
      await js(`__t.setVal(__t.tid('composer'), 'a longer question so the answer takes a moment to be spoken out loud in the chat')`);
      await js(`__t.tid('send').click()`);
      const seen = await waitFor(`__t.tid('spotlight')`, 6000);
      const dims = seen ? await js<{ h: number; chip: number; name: string }>(`({
        h: __t.tid('spotlight').querySelector('.avatar').getBoundingClientRect().height,
        chip: document.querySelector('.roster .avatar').getBoundingClientRect().height,
        name: __t.tid('spotlight').textContent })`) : null;
      if (seen) await shot('30-spotlight');
      check('while an agent speaks, their portrait is shown much larger than the roster ones', !!dims && dims.h > dims.chip * 2.5, dims);
      const gone = await waitFor(`!__t.tid('spotlight')`, 8000);
      const replied = await js<boolean>(`__t.msgs().some(m => m.text.includes('a longer question so the answer'))`);
      check('the portrait goes away when they finish, and the reply is in the chat', gone && replied, { gone, replied });
      await js(`localStorage.setItem('rc.speak', '0')`);
    });

    await step('chat search: magnifier opens a bar, finds messages in any channel, and jumps to one', async () => {
      const before = await js<string>(`__t.tid('composer').placeholder`);
      await js(`__t.tid('open-search').click()`);
      const open = await waitFor(`__t.tid('search-input')`, 2000);
      await js(`__t.setVal(__t.tid('search-input'), 'done when')`);
      const found = await waitFor(`__t.all('search-hit').length > 0`, 3000);
      const first = await js<string>(`__t.all('search-hit')[0]?.textContent || ''`);
      await shot('31-search');
      check('searching shows results with channel, author and the matching words', open && found && /#/.test(first) && /done when/i.test(first), first);
      await js(`__t.setVal(__t.tid('search-input'), 'zzzz-no-such-text')`);
      check('no match says so', await waitFor(`__t.tid('search-results').textContent.includes('No messages match')`, 2000));
      await js(`__t.setVal(__t.tid('search-input'), 'done when')`);
      await waitFor(`__t.all('search-hit').length > 0`, 3000);
      await js(`__t.all('search-hit')[0].click()`);
      const jumped = await waitFor(`!__t.tid('search-bar') && document.querySelector('.messages [data-mid].flash')`, 3000);
      const after = await js<string>(`__t.tid('composer').placeholder`);
      check('clicking a result closes the bar, switches to that channel and highlights the message', !!jumped && after !== before, { before, after });
    });

    await step('vendor and model: pick a different vendor per agent, and set up providers', async () => {
      await js(`document.querySelector('.roster .rchip').click()`); // Widow
      await waitFor(`__t.tid('agent-popup')`);
      const startVendor = await js<string>(`__t.tid('agent-vendor').value`);
      await js(`__t.setVal(__t.tid('agent-vendor'), 'openai')`);
      const saved = await waitFor(`__t.tid('agent-model') && __t.tid('agent-model').value === 'gpt-5'`, 3000);
      await wait(200);
      const ref = store.agent('widow')?.model;
      const note = await js<string>(`__t.tid('model-note')?.textContent || ''`);
      await shot('32-vendor-model');
      check('choosing OpenAI shows its models and saves the choice on the agent',
        startVendor === 'anthropic' && saved && ref?.vendor === 'openai' && ref.model === 'gpt-5', { startVendor, ref });
      check('the picker warns that prompts go to that vendor and that no key is saved yet',
        /sent to this vendor/.test(note) && /No key saved for OpenAI/.test(note), note);
      // A local model: the name box appears and the choice is saved once a valid name is typed.
      await js(`__t.setVal(__t.tid('agent-vendor'), 'local')`);
      await waitFor(`__t.tid('agent-model-name')`, 3000);
      await js(`__t.setVal(__t.tid('agent-model-name'), 'llama3.1')`);
      await wait(1000); // the name saves after a short pause
      const local = store.agent('widow')?.model;
      const toolsOff = await js<boolean>(`__t.tid('model-tools').checked === false`);
      check('a local model can be typed in, is saved, and starts with tools off', local?.vendor === 'local' && local.model === 'llama3.1' && toolsOff, { local, toolsOff });
      // Back to Anthropic restores the tier behaviour.
      await js(`__t.setVal(__t.tid('agent-vendor'), 'anthropic')`);
      await wait(300);
      check('switching back to Anthropic clears the explicit model', store.agent('widow')?.model === undefined);
      await js(`__t.tid('agent-popup').querySelector('.close').click()`);
      await waitFor(`!__t.tid('agent-popup')`, 2000);

      // Providers in Settings: every vendor has a row; a local address is validated and saved.
      await js(`__t.tid('open-settings').click()`);
      await waitFor(`__t.tid('settings')`, 3000);
      await js(`__t.tid('settings-tab-api').click()`);
      await waitFor(`__t.tid('vendor-local')`, 3000);
      const rows = await js<number>(`document.querySelectorAll('[data-testid^="vendor-"][data-testid$="anthropic"], [data-testid="vendor-openai"], [data-testid="vendor-google"], [data-testid="vendor-xai"], [data-testid="vendor-deepseek"], [data-testid="vendor-local"], [data-testid="vendor-custom"]').length`);
      check('API & Models lists Anthropic, OpenAI, Google, xAI, DeepSeek, local and custom', rows === 7, rows);
      await js(`__t.setVal(__t.tid('vendor-url-local'), 'http://example.com/v1')`);
      await js(`__t.tid('vendor-url-save-local').click()`);
      await wait(400);
      check('an insecure address is refused and nothing is saved', store.settings.vendorUrls.local === undefined, store.settings.vendorUrls);
      await js(`__t.setVal(__t.tid('vendor-url-local'), 'http://localhost:11434/v1')`);
      await js(`__t.tid('vendor-url-save-local').click()`);
      await wait(400);
      check('a localhost address is saved', store.settings.vendorUrls.local === 'http://localhost:11434/v1', store.settings.vendorUrls);
      await shot('33-providers');
      await js(`__t.setVal(__t.tid('vendor-url-local'), '')`);
      await js(`__t.tid('vendor-url-save-local').click()`); // leave the test data as it was (and mock mode on)
      await wait(300);
      await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
      await waitFor(`!__t.tid('settings')`, 2000);
      check('clearing the address returns to mock mode', store.settings.vendorUrls.local === undefined && store.mode === 'mock');
    });

    await step('agent profile popup', async () => {
      await js(`document.querySelector('.roster .rchip').click()`);
      const open = await waitFor(`__t.tid('agent-popup')`);
      await js(`__t.setVal(__t.tid('agent-personality'), 'Short and sharp.')`);
      await waitFor(`!__t.tid('agent-save').disabled`);
      await js(`__t.tid('agent-save').click()`);
      await wait(300);
      check('popup opens; personality edit saves', open && store.agent('widow')?.personality === 'Short and sharp.');
      const clear = await js<boolean>(`(() => {
        const name = document.querySelector('.agent-name').getBoundingClientRect();
        const banner = document.querySelector('.agent-banner').getBoundingClientRect();
        return name.top >= banner.bottom - 1;
      })()`);
      check('popup: agent name sits below the colour banner (readable)', clear);
      await shot('11-agent-popup');

      // Profile picture editor: pick a wide (non-square) image, zoom, drag, save.
      await js(`__t.tid('change-picture').click()`);
      const editor = await waitFor(`__t.tid('avatar-editor')`, 3000);
      await js(`(async () => { const bad = new File(['hello'], 'notes.txt', { type: 'text/plain' });
        const inp = __t.tid('avatar-file'); inp.files = __mk.dt(bad).files; inp.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      const refused = await waitFor(`__t.tid('avatar-error')?.textContent.includes('PNG, JPG')`, 3000);
      await js(`(async () => { const f = await __mk.png(900, 500, 'wide.png');
        const inp = __t.tid('avatar-file'); inp.files = __mk.dt(f).files; inp.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      const loaded = await waitFor(`__t.tid('crop-canvas')`, 4000);
      await js(`__t.setVal(__t.tid('crop-zoom'), '1.8')`);
      await js(`(() => { const s = document.querySelector('.crop-stage'); const r = s.getBoundingClientRect();
        const ev = (t, x) => s.dispatchEvent(new PointerEvent(t, { bubbles: true, pointerId: 1, clientX: x, clientY: r.top + 100 }));
        ev('pointerdown', r.left + 150); ev('pointermove', r.left + 110); ev('pointerup', r.left + 110); })()`);
      await js(`__t.tid('crop-fit').click()`);
      await wait(200);
      const fitted = await js<number>(`Number(__t.tid('crop-zoom').value)`);
      check('avatar editor: "Fit whole image" zooms out below fill for a wide picture (900x500 -> about 0.44)', fitted > 0.4 && fitted < 0.5, fitted);
      await shot('21b-avatar-fit');
      await js(`__t.setVal(__t.tid('crop-zoom'), '1.8')`);
      await shot('21-avatar-editor');
      // Escape closes only the editor, not the profile card underneath.
      await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`);
      await wait(250);
      const escOk = !(await js<boolean>(`!!__t.tid('avatar-editor')`)) && (await js<boolean>(`!!__t.tid('agent-popup')`));
      await js(`__t.tid('change-picture').click()`);
      await waitFor(`__t.tid('avatar-editor')`, 3000);
      await js(`(async () => { const f = await __mk.png(900, 500, 'wide.png');
        const inp = __t.tid('avatar-file'); inp.files = __mk.dt(f).files; inp.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await waitFor(`__t.tid('crop-canvas')`, 4000);
      await js(`__t.setVal(__t.tid('crop-zoom'), '1.8')`);
      await js(`__t.tid('avatar-save').click()`);
      const savedOk = await waitFor(`!__t.tid('avatar-editor')`, 3000);
      await wait(300);
      const img = store.agent('widow')?.image ?? '';
      const bytes = Math.floor(((img.split(',')[1] ?? '').length * 3) / 4);
      check('picture editor: rejects a text file, opens an image, Escape closes only the editor, Save stores a small portrait picture',
        editor && refused && loaded && escOk && savedOk && /^data:image\/(webp|png);base64,/.test(img) && bytes > 0 && bytes <= 300 * 1024,
        { editor, refused, loaded, escOk, savedOk, bytes, type: img.slice(0, 22) });
      const dims = await js<{ w: number; h: number } | null>(`new Promise((res) => { const i = new Image(); i.onload = () => res({ w: i.naturalWidth, h: i.naturalHeight }); i.onerror = () => res(null); i.src = ${JSON.stringify(img)}; })`);
      check('stored picture is portrait 256 × 320', dims?.w === 256 && dims?.h === 320, dims);
      const shown = await js<boolean>(`!!document.querySelector('.agent-head .avatar img')`);
      check('the profile card and member strip now show the picture', shown && (await js<boolean>(`!!document.querySelector('.roster .avatar img')`)));
      await shot('22-avatar-set');
      await js(`document.querySelector('.agent-card .close').click()`);
    });

    await step('phase 6: agents working in a project folder', async () => {
      // Outside the app's own data folder (a project folder may not overlap it).
      const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-selftest-proj-'));
      fs.writeFileSync(path.join(projectDir, 'hello.txt'), 'from disk');

      // 1. set the project folder through Settings → Vaults & Projects
      await js(`__t.tid('open-settings').click()`);
      await waitFor(`__t.tid('settings')`);
      await js(`__t.tid('settings-tab-vaults').click()`);
      await waitFor(`__t.tid('project-path-cat_1')`);
      await js(`__t.setVal(__t.tid('project-path-cat_1'), ${JSON.stringify(projectDir)})`);
      await js(`__t.tid('project-save-cat_1').click()`);
      await wait(400);
      check('project folder saved from Settings',
        path.resolve(store.categories().find((c) => c.id === 'cat_1')!.projectPath) === path.resolve(projectDir));
      await shot('15-settings-projects');
      await js(`document.querySelector('.settings-body .close').click()`);
      await wait(200);

      // a bad path is refused with a message and not saved
      await js(`__t.tid('open-settings').click()`);
      await waitFor(`__t.tid('settings')`);
      await js(`__t.tid('settings-tab-vaults').click()`);
      await waitFor(`__t.tid('project-path-cat_2')`);
      await js(`__t.setVal(__t.tid('project-path-cat_2'), 'relative/nowhere'); __t.tid('project-save-cat_2').click()`);
      const refused = await waitFor(`__t.tid('toast') && __t.tid('toast').textContent.includes('absolute')`);
      check('a relative project path is refused with a message', refused && store.categories().find((c) => c.id === 'cat_2')!.projectPath === '');
      await js(`document.querySelector('.settings-body .close').click()`);
      await wait(200);

      // 2. open that project's #general
      await js(`__t.chan('general', 2).click()`);
      const pill = await waitFor(`__t.tid('project-pill')`);
      check('chat header shows the project is linked', pill);
      const send = async (text: string) => {
        await js(`__t.setVal(__t.tid('composer'), ${JSON.stringify(text)})`);
        await js(`__t.tid('send').click()`);
      };

      // 3. a read needs no approval
      await send('@Hex !tool read hello.txt');
      const read = await waitFor(`__t.msgs().some(m => m.kind === 'tool' && m.text.includes('Hex read hello.txt')) && __t.msgs().some(m => m.text.includes('from disk'))`);
      check('read_file runs with no approval and the agent reports the content', read && !store.snapshot().notifications.some((n) => n.action));

      // 4. a write waits for approval: card with the exact diff, nothing on disk yet
      await send('@Hex !tool write made.txt written via ui');
      const card = await waitFor(`__t.tid('approve') && __t.tid('action-preview') && __t.tid('action-preview').textContent.includes('+written via ui')`);
      const notYet = !fs.existsSync(path.join(projectDir, 'made.txt'));
      await shot('16-approval-card');
      await js(`__t.tid('approve').click()`);
      const wrote = await waitFor(`__t.msgs().some(m => m.kind === 'tool' && m.text.includes('create made.txt'))`);
      check('write_file: card shows the diff, file absent until Approve, then written',
        card && notYet && wrote && fs.readFileSync(path.join(projectDir, 'made.txt'), 'utf8') === 'written via ui');

      // 5. a command the user denies never runs
      await send('@Hex !tool run echo should-not-run > denied.txt');
      const cmdCard = await waitFor(`__t.tid('deny') && __t.tid('action-preview') && __t.tid('action-preview').textContent.includes('echo should-not-run')`);
      await js(`__t.tid('deny').click()`);
      const told = await waitFor(`__t.msgs().some(m => m.text.includes('NOT APPROVED'))`);
      check('run_command: exact command shown; Deny means it never runs',
        cmdCard && told && !fs.existsSync(path.join(projectDir, 'denied.txt')));
      await shot('17-tool-rows');

      // 6. approving from the notification centre while looking at a different channel
      await send('@Hex !tool write second.txt via panel');
      const pendingId = async () => store.snapshot().notifications.find((n) => n.action && n.status === 'awaiting-user')?.id;
      const t0 = Date.now();
      while (!(await pendingId()) && Date.now() - t0 < 8000) await wait(100);
      await js(`__t.chan('design', 2).click()`);
      await wait(300);
      const badge = await waitFor(`__t.tid('notif-badge')`);
      const noInline = await js<boolean>(`!__t.tid('permission-card')`);
      await js(`__t.tid('open-notifications').click()`);
      const panel = await waitFor(`__t.tid('notif-approve')`);
      await js(`__t.tid('notif-approve').click()`);
      const wrote2 = await waitFor(`true`) && await (async () => {
        const t1 = Date.now();
        while (!fs.existsSync(path.join(projectDir, 'second.txt')) && Date.now() - t1 < 8000) await wait(100);
        return fs.existsSync(path.join(projectDir, 'second.txt'));
      })();
      check('approval from the notification centre (while in another channel) lets the agent finish',
        badge && noInline && panel && wrote2 && fs.readFileSync(path.join(projectDir, 'second.txt'), 'utf8') === 'via panel');
      await js(`document.body.dispatchEvent(new MouseEvent('mousedown', {bubbles:true}))`);

      // 7. the agent is no longer stuck waiting
      const idle = store.agent('prog')?.status === 'idle';
      check('agent returns to idle after the work', idle, store.agent('prog')?.status);
    });

    await step('settings: add/remove agents', async () => {
      await js(`__t.tid('open-settings').click()`);
      await waitFor(`__t.tid('settings')`);
      const rows = await js<number>(`__t.all('agent-row').length`);
      await js(`__t.setVal(__t.tid('new-agent-name'), 'Nova'); __t.setVal(__t.tid('new-agent-role'), 'Tester')`);
      await js(`__t.tid('add-agent').click()`);
      const added = await waitFor(`__t.all('agent-row').length === ${rows + 1}`);
      await shot('12-settings-agents');
      const widowRemoveDisabled = await js<boolean>(`[...__t.all('agent-row')].find(r => r.textContent.includes('Widow')).querySelector('button.danger').disabled`);
      await js(`[...__t.all('agent-row')].find(r => r.textContent.includes('Nova')).querySelector('button.danger').click()`);
      const removed = await waitFor(`__t.all('agent-row').length === ${rows}`);
      check('14 agents listed (Nimbus included); add one (15); Widow remove disabled; remove it (14)',
        rows === 14 && added && widowRemoveDisabled && removed, { rows, added, widowRemoveDisabled, removed });
    });

    await step('settings: other tabs render', async () => {
      const seen: Record<string, boolean> = {};
      for (const [tab, probe] of [
        ['api', `__t.tid('mode-status')`], ['budgets', `__t.tid('daily-budget')`],
        ['vaults', `__t.tid('settings-refresh-index')`], ['testing', `__t.tid('dev-permission')`],
      ]) {
        await js(`__t.tid('settings-tab-${tab}').click()`);
        seen[tab] = await waitFor(probe, 3000);
        if (tab === 'api') {
          const aligned = await js<boolean>(`(() => {
            const kids = [...document.querySelector('.price-row.head').children];
            return kids.length === 3 && new Set(kids.map((k) => Math.round(k.getBoundingClientRect().top))).size === 1;
          })()`);
          check('API tab: price table header is a single row', aligned);
          await shot('13-settings-api');
        }
      }
      check('API, Budgets, Vaults, Testing tabs render', Object.values(seen).every(Boolean), seen);
      await js(`__t.tid('settings-tab-budgets').click()`);
      await waitFor(`__t.tid('daily-budget')`);
      await js(`__t.setVal(__t.tid('daily-budget'), '7'); __t.key(__t.tid('daily-budget'), 'Enter')`);
      await wait(300);
      check('editing the daily budget saves it', store.settings.dailyBudgetUsd === 7, store.settings.dailyBudgetUsd);
      await shot('14-settings-budgets');
    });
    await step('backup: back up now, then restore an earlier state', async () => {
      await js(`__t.tid('settings-tab-backup').click()`);
      await waitFor(`__t.tid('backup-now')`);
      const before = await js<number>(`__t.all('backup-row').length`);
      await js(`__t.tid('backup-now').click()`);
      const made = await waitFor(`__t.all('backup-row').length === ${before + 1}`, 6000);
      await shot('28-settings-backup');
      const cat = store.createCategory('Temp after backup');
      await waitFor(`document.body.textContent.includes('Backup') `);
      await js(`[...__t.all('backup-row')].find(r => r.textContent.includes('Manual')).querySelector('[data-testid=backup-restore]').click()`);
      const restored = await waitFor(`__t.all('backup-row').some(r => r.textContent.includes('Before a restore'))`, 8000);
      await wait(200);
      check('Back up now adds a backup; restoring puts back the earlier state and keeps a safety copy',
        made && restored && !store.categories().some((c) => c.id === cat.id) && store.agents().length === 14,
        { made, restored, stillThere: store.categories().some((c) => c.id === cat.id), agents: store.agents().length });
    });

    await step('Stop all button appears only while something runs', async () => {
      const ch = store.channels().find((c) => c.kind === 'research')!;
      const hiddenAtRest = !(await js<boolean>(`!!__t.tid('stop-all')`));
      store.setBusy(ch.id, true);
      const shown = await waitFor(`__t.tid('stop-all')`, 3000);
      await js(`__t.tid('stop-all').click()`);
      const said = await waitFor(`__t.tid('toast') && /Nothing was running|Stopped everything/.test(__t.tid('toast').textContent)`, 3000);
      store.setBusy(ch.id, false);
      const gone = await waitFor(`!__t.tid('stop-all')`, 3000);
      check('Stop all is hidden at rest, shown while busy, answers when clicked', hiddenAtRest && shown && said && gone, { hiddenAtRest, shown, said, gone });
    });

    await step('approval requests from other channels show up in #general', async () => {
      const cat = store.categories().find((c) => c.order === 0)!;
      const eng = store.channels().find((c) => c.categoryId === cat.id && c.kind === 'engineering')!;
      const n = store.addNotification({
        kind: 'permission', title: 'Atlas: Edit src/Player.cs', body: 'Atlas wants to edit src/Player.cs (in #engineering).', channelId: eng.id,
        agentId: 'eng-a', status: 'awaiting-user', action: { tool: 'edit_file', summary: 'Edit src/Player.cs', preview: '-a\n+b' },
      });
      await js(`__t.chan('general', 0).click()`);
      const seen = await waitFor(`__t.all('permission-card').some(c => c.textContent.includes('in #engineering'))`, 4000);
      await shot('27-approval-in-general');
      await js(`__t.tid('approve').click()`);
      await wait(300);
      const resolved = store.notification(n.id)?.status === 'approved';
      store.updateNotification(n.id, { status: 'dismissed', read: true });
      check('a request from #engineering is shown (and can be answered) in #general', seen && resolved, { seen, resolved });
    });

    await step('settings: GitHub repository link', async () => {
      await js(`__t.tid('settings-tab-vaults').click()`);
      await waitFor(`document.querySelector('[data-testid^="repo-url-"]')`, 3000);
      const id = store.categories().find((c) => c.order === 0)!.id;
      await js(`__t.setVal(__t.tid('repo-url-${id}'), 'git@github.com:ronin/game.git')`);
      await js(`__t.tid('repo-save-${id}').click()`);
      await wait(300);
      const saved = store.category(id)?.repoUrl;
      await js(`__t.setVal(__t.tid('repo-url-${id}'), 'https://example.com/x/y')`);
      await js(`__t.tid('repo-save-${id}').click()`);
      await wait(300);
      check('repo link is normalised on save and a non-GitHub address is refused',
        saved === 'https://github.com/ronin/game' && store.category(id)?.repoUrl === saved, saved);
      await shot('25-settings-repo');
    });
  } catch (e) {
    check('self-test aborted', false, (e as Error).message);
  }

  const failed = results.filter((r) => !r.ok);
  fs.writeFileSync(
    path.join(outDir, 'results.json'),
    JSON.stringify({ passed: results.length - failed.length, failed: failed.length, results, consoleIssues }, null, 2),
  );
}
