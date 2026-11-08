// The only desktop features the page may use: fetching a PDF through a sign-in window.
const {contextBridge, ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('marginDesktop', {
  // Opens `url` in a sign-in window; resolves {ok, bytes, filename} when a PDF downloads, or {ok: false, reason}.
  fetchWithLogin: (url, title) => ipcRenderer.invoke('margin:fetch-with-login', String(url), String(title || '')),
});
