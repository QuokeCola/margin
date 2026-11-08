// Desktop shell: runs Margin's local server inside the app and shows it in a window.
import {app, BrowserWindow, shell, ipcMain, session} from 'electron';
import {readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {randomBytes} from 'node:crypto';
import {createServer} from 'node:net';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PREFERRED_PORT = 47317; // fixed when free, so window settings (zoom, sidebar) persist between launches

const tryPort = port => new Promise(resolve => {
  const s = createServer().once('error', () => resolve(null)).listen(port, '127.0.0.1', () => s.close(() => resolve(s.address()?.port ?? port)));
});
async function freePort() {
  if (await tryPort(PREFERRED_PORT)) return PREFERRED_PORT;
  return new Promise(resolve => { const s = createServer().listen(0, '127.0.0.1', () => { const {port} = s.address(); s.close(() => resolve(port)); }); });
}
async function waitFor(url, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if ((await fetch(url)).ok) return; } catch {} await new Promise(r => setTimeout(r, 100)); }
  throw new Error('Margin server did not start');
}

if (!app.requestSingleInstanceLock()) app.quit();
let win = null;
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('window-all-closed', () => app.quit());

app.whenReady().then(async () => {
  const port = await freePort();
  process.env.PORT = String(port);
  process.env.MARGIN_PRODUCTION = '1';
  // Key and model live in the app's config folder (~/.config/Margin, %APPDATA%\Margin, ~/Library/Application Support/Margin).
  process.env.MARGIN_ENV_FILE ??= join(app.getPath('userData'), 'settings.env');
  // On Linux keep the shared XDG library (~/.local/share/margin); elsewhere use the app folder.
  if (process.platform !== 'linux') process.env.MARGIN_DATA_DIR ??= join(app.getPath('userData'), 'library');
  await import(pathToFileURL(join(root, 'server.mjs')).href);
  const origin = `http://127.0.0.1:${port}`;
  await waitFor(origin + '/api/status');

  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 960, minHeight: 600, title: 'Margin', backgroundColor: '#f8f8f3',
    icon: join(root, 'assets', 'margin-512.png'), autoHideMenuBar: true, show: false,
    webPreferences: {contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true, preload: join(root, 'electron', 'preload.cjs')}
  });
  win.once('ready-to-show', () => win.show());
  // Links in answers open in the system browser; the window never leaves the local app.
  win.webContents.setWindowOpenHandler(({url}) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); return {action: 'deny'}; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(origin)) { e.preventDefault(); if (/^https?:\/\//.test(url)) shell.openExternal(url); } });
  await win.loadURL(origin + '/');
}).catch(err => { console.error(err); app.exit(1); });

// ---------- sign-in window for publisher PDFs ----------
// Publisher pages open in their own persistent session (so library/SSO logins are remembered),
// separate from Margin's window. The first PDF that downloads there is handed back to Margin.
ipcMain.handle('margin:open-external', (_e, url) => /^https?:\/\//i.test(url) ? shell.openExternal(url).then(() => true) : false);
let signIn = null;
ipcMain.handle('margin:fetch-with-login', async (event, url, title) => {
  if (!/^https?:\/\//i.test(url)) return {ok: false, reason: 'Not a web address.'};
  if (signIn) { signIn.win.focus(); return {ok: false, reason: 'A sign-in window is already open.'}; }
  const ses = session.fromPartition('persist:library');
  return new Promise(resolve => {
    const win = new BrowserWindow({width: 1100, height: 860, parent: BrowserWindow.fromWebContents(event.sender) ?? undefined, autoHideMenuBar: true,
      title: `Sign in if asked — Margin downloads the PDF automatically${title ? ' — ' + title.slice(0, 60) : ''}`,
      webPreferences: {session: ses, contextIsolation: true, sandbox: true, nodeIntegration: false}});
    let done = false;
    const finish = result => {
      if (done) return; done = true; ses.removeListener('will-download', onDownload); ses.webRequest.onHeadersReceived(null); signIn = null;
      if (!win.isDestroyed()) win.close();
      resolve(result);
    };
    const onDownload = (_e, item) => {
      const file = join(tmpdir(), `margin-${randomBytes(6).toString('hex')}.pdf`);
      item.setSavePath(file);
      item.once('done', async (_e2, state) => {
        if (state !== 'completed') return; // cancelled: keep the window open for another try
        const bytes = await readFile(file).catch(() => null); await rm(file, {force: true});
        if (!bytes || bytes.subarray(0, 5).toString() !== '%PDF-') { if (!win.isDestroyed()) win.setTitle('Sign in if asked — Margin will download the PDF once you have access'); return; }
        finish({ok: true, bytes: new Uint8Array(bytes), filename: item.getFilename()});
      });
    };
    ses.on('will-download', onDownload);
    // Electron shows PDFs in its built-in viewer instead of downloading them. When a page or frame in
    // this window receives a PDF, request the same URL as a download (same session, so the sign-in applies).
    const asked = new Set();
    ses.webRequest.onHeadersReceived((details, callback) => {
      callback({});
      const type = Object.entries(details.responseHeaders || {}).find(([k]) => k.toLowerCase() === 'content-type')?.[1]?.[0] || '';
      if (!done && /pdf/i.test(type) && /^(mainFrame|subFrame)$/.test(details.resourceType) && !asked.has(details.url) && !win.isDestroyed()) {
        asked.add(details.url); win.webContents.downloadURL(details.url);
      }
    });
    // Pop-ups from login flows stay in the same session; downloads from them are caught too.
    win.webContents.setWindowOpenHandler(() => ({action: 'allow', overrideBrowserWindowOptions: {autoHideMenuBar: true, webPreferences: {session: ses, contextIsolation: true, sandbox: true}}}));
    // After each page load, look for the paper's PDF link and download it without waiting for a click:
    // the citation_pdf_url tag most publishers set for indexers, or an embedded PDF viewer frame (IEEE,
    // ScienceDirect). Before sign-in this usually yields a login page; that is ignored and retried after
    // the next navigation.
    const FIND_PDF = `(() => {
      const meta = document.querySelector('meta[name="citation_pdf_url"]')?.content;
      if (meta) return meta;
      const frame = [...document.querySelectorAll('iframe, embed, object')].map(e => e.src || e.data || '').find(u => /\\.pdf\\b|getPDF|stamp\\.jsp|pdfft|\\/pdf\\//i.test(u));
      return frame || null;
    })()`;
    const tryPage = async wc => {
      if (done || wc.isDestroyed()) return;
      const url = await wc.executeJavaScript(FIND_PDF, true).catch(() => null);
      if (url && /^https?:/i.test(url) && !asked.has(url)) { asked.add(url); wc.downloadURL(url); }
    };
    const watch = wc => {
      wc.on('did-navigate', () => asked.clear());          // a new page (e.g. after sign-in) may now give the real PDF
      wc.on('did-finish-load', () => tryPage(wc));
    };
    watch(win.webContents);
    win.webContents.on('did-create-window', child => watch(child.webContents));
    win.on('closed', () => finish({ok: false, reason: 'closed'}));
    win.on('page-title-updated', e => e.preventDefault()); // keep the instruction in the title bar
    signIn = {win};
    win.loadURL(url).catch(() => {});
  });
});
