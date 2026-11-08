// Publisher test for the Margin connector extension (development tool).
// Drives a headless Chrome over DevTools: opens each paper page, runs the extension's content.js to
// collect PDF candidates, then loads each candidate through Chrome's own network stack (with the
// page's cookies), as the extension's background worker does, and reports which one gave a PDF.
// Usage: google-chrome --headless=new --remote-debugging-port=9500 --user-data-dir=/tmp/x about:blank &
//        node scripts/ext-sites.mjs 9500 cases.json [filter]
import {readFileSync} from 'node:fs';
const [,, port, casesFile, filter] = process.argv;
const cases = JSON.parse(readFileSync(casesFile, 'utf8')).filter(c => !filter || new RegExp(filter, 'i').test(c.publisher + c.url));
const contentJs = readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const CHALLENGE = /just a moment|attention required|access denied|are you a robot|verify you are human|captcha|radware|request unsuccessful|bot protection|unusual traffic/i;

const t = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const ws = new WebSocket(t.find(x => x.type === 'page').webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
let id = 0; const pending = new Map(), events = [];
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else if (m.method) events.push(m); };
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({id: i, method, params})); });
const ev = async x => (await send('Runtime.evaluate', {expression: x, awaitPromise: true, returnByValue: true})).result?.result?.value;
await send('Page.enable'); await send('Network.enable'); await send('Runtime.enable');
// Headless Chrome announces itself as "HeadlessChrome"; replace that unless a visible browser is used.
if (!process.env.KEEP_UA) await send('Network.setUserAgentOverride', {userAgent: UA, acceptLanguage: 'en-US,en;q=0.9', platform: 'Linux'});

async function loadResource(frameId, url) {
  const r = (await send('Network.loadNetworkResource', {frameId, url, options: {disableCache: true, includeCredentials: true}})).result?.resource;
  if (!r) return {ok: false, status: 'error'};
  let head = '';
  if (r.stream) {
    const chunk = (await send('IO.read', {handle: r.stream, size: 1024})).result;
    head = chunk?.base64Encoded ? Buffer.from(chunk.data, 'base64').toString('latin1').slice(0, 5) : (chunk?.data || '').slice(0, 5);
    await send('IO.close', {handle: r.stream});
  }
  const type = Object.entries(r.headers || {}).find(([k]) => k.toLowerCase() === 'content-type')?.[1] || '';
  return {ok: head === '%PDF-', status: r.httpStatusCode, type: type.split(';')[0]};
}

const rows = [];
for (const c of cases) {
  const t0 = Date.now();
  events.length = 0;
  await send('Page.navigate', {url: c.url});
  for (let i = 0; i < 50 && !events.some(e => e.method === 'Page.loadEventFired'); i++) await sleep(500);
  await sleep(3500); // late-rendered links (IEEE, ScienceDirect)
  const page = await ev(`({url: location.href, title: document.title, text: document.body?.innerText?.slice(0, 400) || ''})`) || {};
  const challenged = CHALLENGE.test(page.title + ' ' + page.text);
  const info = await ev(`new Promise(res => { window.__m = null; window.chrome = window.chrome || {}; const real = window.chrome.runtime;
    window.chrome.runtime = {sendMessage: m => { window.__m = m.info; return Promise.resolve(); }, onMessage: {addListener() {}}};
    try { ${contentJs} } catch (e) { window.__m = {error: e.message}; }
    window.chrome.runtime = real; res(window.__m); })`) || {};
  const frameId = (await send('Page.getFrameTree')).result.frameTree.frame.id;
  let winner = null; const tries = [];
  for (const url of (info.candidates || []).slice(0, 6)) {
    const r = await loadResource(frameId, url);
    tries.push(`${r.status} ${r.type || '-'}${r.ok ? ' PDF' : ''}`);
    if (r.ok) { winner = url; break; }
  }
  const row = {kind: c.kind, publisher: c.publisher.slice(0, 22), host: (() => { try { return new URL(page.url).hostname.replace(/^www\./, ''); } catch { return '?'; } })(),
    result: winner ? 'PDF' : challenged ? 'BLOCKED (bot check)' : (info.candidates || []).length ? 'no PDF' : 'no link found',
    doi: info.doi ? 'doi' : '-', cands: (info.candidates || []).length, winner: winner ? winner.replace(/^https?:\/\/(www\.)?/, '').slice(0, 60) : '', tries: tries.join(' | ').slice(0, 90), s: ((Date.now() - t0) / 1000).toFixed(0)};
  rows.push(row);
  console.log(`${row.kind.padEnd(9)} ${row.publisher.padEnd(23)} ${row.host.slice(0, 26).padEnd(27)} ${row.result.padEnd(20)} ${row.doi.padEnd(4)} c=${String(row.cands).padEnd(3)} ${row.winner || row.tries}`);
}
const open = rows.filter(r => r.kind === 'open');
console.log(`\nopen access: ${open.filter(r => r.result === 'PDF').length}/${open.length} PDF, ${open.filter(r => r.result.startsWith('BLOCKED')).length} blocked by bot checks in headless mode`);
console.log(`paywalled: ${rows.filter(r => r.kind === 'paywalled' && r.cands).length}/${rows.filter(r => r.kind === 'paywalled').length} with a PDF link found (downloading needs a login)`);
ws.close(); process.exit(0);
