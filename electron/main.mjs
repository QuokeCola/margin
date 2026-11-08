// Desktop shell: runs Margin's local server inside the app and shows it in a window.
import {app, BrowserWindow, shell} from 'electron';
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
    webPreferences: {contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true}
  });
  win.once('ready-to-show', () => win.show());
  // Links in answers open in the system browser; the window never leaves the local app.
  win.webContents.setWindowOpenHandler(({url}) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); return {action: 'deny'}; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(origin)) { e.preventDefault(); if (/^https?:\/\//.test(url)) shell.openExternal(url); } });
  await win.loadURL(origin + '/');
}).catch(err => { console.error(err); app.exit(1); });
