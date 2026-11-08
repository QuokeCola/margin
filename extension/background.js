// Margin connector — background worker. Finds the local Margin app, matches publisher pages to the
// papers Margin asked for, downloads the PDF with the browser's own logins and sends it to Margin.
const PORTS = [47317, 4317];            // desktop app, browser version
const tabRequests = new Map();          // tabId -> request id (tabs Margin opened, or matched pages)
const finished = new Set();             // request ids already delivered
const tried = new Map();                // request id -> Set of URLs already tried

const getCode = async () => (await chrome.storage.local.get('code')).code || '';

// Locate Margin and check the pairing code. Cached briefly; the worker may be restarted at any time.
let found = null;
async function margin() {
  if (found && Date.now() - found.at < 60e3) return found;
  const code = await getCode();
  let unpaired = null; // a Margin that does not accept this code; keep looking for one that does
  for (const port of PORTS) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/ext/hello`, {headers: {'X-Margin-Ext': code}, signal: AbortSignal.timeout(1500)});
      if (r.ok) return (found = {port, base: `http://127.0.0.1:${port}`, paired: true, at: Date.now(), ...(await r.json())});
      if (r.status === 401) unpaired ??= {port, base: `http://127.0.0.1:${port}`, paired: false, at: Date.now()};
    } catch {}
  }
  return (found = unpaired);
}
async function call(path, opts = {}) {
  const m = await margin();
  if (!m?.paired) throw new Error(m ? 'not-paired' : 'no-margin');
  return fetch(m.base + path, {...opts, headers: {'X-Margin-Ext': await getCode(), ...opts.headers}});
}
async function pending() {
  try { return (await (await call('/api/ext/requests')).json()).requests || []; } catch { return []; }
}
const note = (rid, info) => call(`/api/ext/requests/${rid}/note`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(info)}).catch(() => {});

const words = s => new Set(String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 2));
function similar(a, b) { const A = words(a), B = words(b); if (!A.size || !B.size) return 0; let n = 0; for (const w of A) if (B.has(w)) n++; return 2 * n / (A.size + B.size); }

// Which request does this page belong to? The tab Margin opened, or a matching DOI or title.
async function requestFor(tabId, info) {
  const reqs = await pending();
  const known = tabRequests.get(tabId);
  if (known && reqs.some(r => r.id === known)) return reqs.find(r => r.id === known);
  const hit = reqs.find(r => r.doi && info.doi && r.doi === info.doi) || reqs.find(r => r.title && info.title && similar(r.title, info.title) >= 0.85);
  if (hit) tabRequests.set(tabId, hit.id);
  return hit || null;
}

// Download a candidate with the browser's cookies; only real PDFs count.
async function fetchPdf(url, referrer) {
  const r = await fetch(url, {credentials: 'include', redirect: 'follow', referrer: referrer || undefined, referrerPolicy: 'no-referrer-when-downgrade', headers: {Accept: 'application/pdf,*/*;q=0.8'}});
  const type = r.headers.get('content-type') || '';
  const buf = new Uint8Array(await r.arrayBuffer());
  const isPdf = buf.length > 5 && String.fromCharCode(...buf.slice(0, 5)) === '%PDF-';
  return {ok: r.ok && isPdf, status: r.status, type, finalUrl: r.url, buf, size: buf.length};
}
async function deliver(req, buf) {
  const r = await call(`/api/ext/requests/${req.id}/pdf`, {method: 'POST', headers: {'Content-Type': 'application/pdf'}, body: buf});
  if (r.ok) { finished.add(req.id); return true; }
  return false;
}
async function tryCandidates(req, urls, referrer) {
  if (finished.has(req.id)) return true;
  const done = tried.get(req.id) || new Set(); tried.set(req.id, done);
  for (const url of urls) {
    if (done.has(url)) continue;
    done.add(url);
    try {
      const r = await fetchPdf(url, referrer);
      note(req.id, {stage: 'fetch', url, status: r.status, type: r.type, size: r.size, pdf: r.ok, final: r.finalUrl});
      if (r.ok && await deliver(req, r.buf)) { note(req.id, {stage: 'delivered', url}); return true; }
    } catch (e) { note(req.id, {stage: 'error', url, error: e.message}); }
  }
  return false;
}

// Pages report their DOI, title and PDF candidates.
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type === 'page' && sender.tab) {
    (async () => {
      const req = await requestFor(sender.tab.id, msg.info);
      if (!req) return;
      note(req.id, {stage: 'page', url: msg.info.url, doi: msg.info.doi, title: msg.info.title, candidates: msg.info.candidates.length});
      await tryCandidates(req, msg.info.candidates, msg.info.url);
    })();
  }
  if (msg?.type === 'status') { margin().then(m => reply({margin: m})); return true; }
  if (msg?.type === 'pair') { found = null; chrome.storage.local.set({code: msg.code}).then(() => margin()).then(m => reply({margin: m})); return true; }
  if (msg?.type === 'send-tab') { sendTab(msg.tabId).then(reply); return true; }
});

// Margin opens papers with #margin-request=<id>; remember that tab for the pages that follow (sign-in, redirects).
chrome.tabs.onUpdated.addListener((tabId, change) => {
  const m = change.url && change.url.match(/[#&]margin-request=([0-9a-f]{16})/);
  if (m) tabRequests.set(tabId, m[1]);
});
chrome.tabs.onRemoved.addListener(tabId => tabRequests.delete(tabId));

// PDFs that open in the browser's viewer (content scripts do not run there).
chrome.webRequest.onHeadersReceived.addListener(details => {
  if (details.tabId < 0 || !tabRequests.has(details.tabId)) return;
  const type = (details.responseHeaders || []).find(h => h.name.toLowerCase() === 'content-type')?.value || '';
  if (!/pdf/i.test(type)) return;
  (async () => {
    const req = (await pending()).find(r => r.id === tabRequests.get(details.tabId));
    if (req) await tryCandidates(req, [details.url], details.initiator);
  })();
}, {urls: ['<all_urls>'], types: ['main_frame', 'sub_frame']}, ['responseHeaders']);

// Popup button: send the current tab's paper even if Margin did not ask for it.
async function sendTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  let info = null;
  try { info = await new Promise(res => { const t = setTimeout(() => res(null), 1500); chrome.tabs.sendMessage(tabId, {type: 'collect'}, r => { clearTimeout(t); res(r || null); }); }); } catch {}
  const urls = [...(info?.candidates || []), tab.url];
  for (const url of urls) {
    try {
      const r = await fetchPdf(url, tab.url);
      if (!r.ok) continue;
      const res = await call('/api/ext/pdf', {method: 'POST', headers: {'Content-Type': 'application/pdf', 'X-Filename': encodeURIComponent((tab.title || 'paper').slice(0, 100)), 'X-Doi': info?.doi || ''}, body: r.buf});
      const body = await res.json().catch(() => ({}));
      return res.ok ? {ok: true, project: body.project} : {ok: false, error: body.error || `Margin answered ${res.status}`};
    } catch (e) { if (e.message === 'no-margin' || e.message === 'not-paired') return {ok: false, error: e.message}; }
  }
  return {ok: false, error: 'No PDF found on this page (you may need to sign in first).'};
}
