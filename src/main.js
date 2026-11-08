import * as pdfjs from 'pdfjs-dist';
import worker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {marked} from 'marked';
import DOMPurify from 'dompurify';
import renderMath from 'katex/contrib/auto-render';
import 'katex/dist/katex.min.css';
import './style.css';
import {parseReferences, resolveReference, TOKEN, tokenRef, findMentions, tagOf, QUOTE} from './references.js';
import {equationBox, findQuote, isEquationLabel} from './layout.js';
import {clampZoom, wheelZoomFactor} from './zoom.js';
pdfjs.GlobalWorkerOptions.workerSrc = worker;
const $ = s => document.querySelector(s);
const h = (tag, props = {}, ...kids) => { const el = Object.assign(document.createElement(tag), props); el.append(...kids); return el; };

$('#app').innerHTML = `<header><button id="toggle-library" class="icon" title="Show or hide the library" aria-label="Toggle library">☰</button><a class="brand" href="/">m<span>Margin</span></a><span class="subtitle">A little closer to the paper.</span>
<div class="header-tools"><label class="model-picker" title="Model used for new answers">Model <select id="model" disabled><option>…</option></select></label><span id="connection">Connecting…</span><button id="open-settings">Settings</button></div></header>
<main><aside class="library"><div class="section-head"><div><small>LIBRARY</small><h2>Papers &amp; chats</h2></div><label class="file-button">+ Add PDF<input id="file" type="file" accept="application/pdf"></label></div><ul id="papers" aria-label="Papers"></ul></aside>
<section class="chat"><div class="section-head"><div><small id="chat-paper">YOUR STUDY DESK</small><h1 id="chat-title">Read. Question. Understand.</h1></div><button id="new-chat" disabled>New chat</button></div><div id="messages" tabindex="0" aria-label="Conversation"></div><form id="ask"><div id="context" hidden></div><textarea id="question" aria-label="Question about the paper" placeholder="What would you like to understand?" rows="3" maxlength="8000"></textarea><div class="compose-bottom"><span>Enter to send · Ctrl+Enter for a new line. Paper text + this chat are sent to OpenAI.</span><button id="send" type="submit">Ask ↗</button></div></form><p id="notice" role="status">Add a PDF, or pick one from the library.</p></section>
<section class="reader"><div class="section-head"><div><small>SOURCE DOCUMENT</small><h2 id="filename">Your paper, in context</h2></div></div><div class="toolbar"><label><input id="follow" type="checkbox" checked> Follow chat</label><div><label>Page <input id="page" type="number" min="1" value="1"></label><span id="total">/ —</span><button id="go">Go</button></div><div class="zoom" title="Pinch the trackpad (or Ctrl + scroll) over the page to zoom"><button id="zoom-out" aria-label="Zoom out">−</button><button id="zoom-reset" title="Reset to 100%">100%</button><button id="zoom-in" aria-label="Zoom in">+</button></div></div><div id="pdf"><div class="empty"><div class="paper-icon">∑</div><h2>Make room for the original.</h2><p>Add a PDF from your laptop, or pick a paper from the library.<br>Pinch the trackpad over a page to zoom.</p></div></div><details id="manual"><summary>Find a reference / correct an equation location</summary><div class="manual-grid"><label>Equation <input id="equation" placeholder="61"></label><label>PDF page <input id="map-page" type="number" min="1" value="1"></label><label>Position from top (%) <input id="map-y" type="number" min="0" max="100" value="50"></label><button id="find">Find equation</button><button id="save">Save correction</button><button id="remove">Remove correction</button></div><p>Corrections are saved with this paper in your library. Click the PDF while this panel is open to pick a position. Pages use PDF order, not printed journal numbers.</p></details></section></main>
<div id="pdf-pop" hidden><button type="button" id="pop-ask">Ask AI ↗</button></div>
<dialog id="settings"><form id="settings-form"><h2>Settings</h2>
<label>OpenAI API key<input id="key" type="password" autocomplete="off" spellcheck="false" placeholder="sk-…"></label><p id="key-hint" class="hint"></p>
<label>Model<select id="settings-model"></select></label><label>…or type a model ID<input id="custom-model" autocomplete="off" spellcheck="false" placeholder="e.g. gpt-5.2"></label>
<p class="hint">Saved to <code>.env</code> next to the app (readable only by you) and applied immediately, without a restart. A new key is checked with OpenAI before it is saved.</p>
<p id="settings-msg" role="status"></p><div class="dialog-buttons"><button type="button" id="settings-cancel">Cancel</button><button type="submit" id="settings-save" class="primary">Save</button></div></form></dialog>`;

let session = null, models = [], papers = [], paper = null, chat = null;
let doc = null, pages = [], index = {}, overrides = {};
let pageBoxes = {}, eqByPage = {}, context = null; // text-item geometry and detected equations per page; pending attachment
let working = false, loading = false, generation = 0, activeRef = null, renderQueue = Promise.resolve();
let zoom = 1;
try { zoom = clampZoom(Number(localStorage.getItem('margin-zoom')) || 1); } catch {}
const notice = t => { const el = $('#notice'); if (el.textContent === t) return; el.textContent = t; el.style.animation = 'none'; void el.offsetWidth; el.style.animation = ''; };

// ---------- server ----------
async function api(path, opts = {}) {
  const headers = {'X-Session-Token': session?.token || '', ...opts.headers};
  let body = opts.body;
  if (body !== undefined && !(body instanceof Uint8Array)) { body = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
  const r = await fetch(path, {method: opts.method || (body ? 'POST' : 'GET'), headers, body});
  if (opts.binary) { if (!r.ok) throw Error(`Could not load the PDF (${r.status}).`); return new Uint8Array(await r.arrayBuffer()); }
  const data = r.status === 204 ? null : await r.json().catch(() => ({}));
  if (!r.ok) throw Error(data?.error || `Request failed (${r.status}).`);
  return data;
}

function controls() {
  $('#send').disabled = !doc || !chat || working || loading;
  $('#file').disabled = working || loading;
  $('#new-chat').disabled = !paper || working || loading;
  $('#papers').classList.toggle('locked', working || loading);
}

// ---------- settings & models ----------
function showStatus() {
  $('#connection').textContent = !session ? '○ Server offline' : session.configured ? '● Connected' : '○ API key needed';
  $('#connection').className = session?.configured ? 'ok' : 'warn';
  const sel = $('#model');
  const ids = [...new Set([session?.model, ...models].filter(Boolean))];
  sel.replaceChildren(...ids.map(id => h('option', {value: id, textContent: id, selected: id === session?.model})));
  sel.disabled = !session?.configured || working;
}
async function loadModels() {
  models = [];
  if (session?.configured) try { models = (await api('/api/models')).models; } catch (e) { notice(e.message + ' You can still type a model ID in Settings.'); }
  showStatus();
}
async function saveSettings(body) {
  const s = await api('/api/settings', {body});
  Object.assign(session, s);
  showStatus();
  return s;
}
$('#model').onchange = async e => {
  try { await saveSettings({model: e.target.value}); notice(`New answers will use ${session.model}.`); }
  catch (err) { notice(err.message); showStatus(); }
};
$('#open-settings').onclick = () => {
  $('#key').value = ''; $('#custom-model').value = ''; $('#settings-msg').textContent = '';
  $('#key-hint').textContent = session?.configured ? `A key is saved (${session.keyHint}). Leave blank to keep it.` : 'No key saved yet.';
  const ids = [...new Set([session?.model, ...models].filter(Boolean))];
  $('#settings-model').replaceChildren(...ids.map(id => h('option', {value: id, textContent: id, selected: id === session?.model})));
  $('#settings').showModal(); $('#key').focus();
};
$('#settings-cancel').onclick = () => $('#settings').close();
$('#settings-form').onsubmit = async e => {
  e.preventDefault();
  const key = $('#key').value.trim(), custom = $('#custom-model').value.trim(), picked = $('#settings-model').value;
  const body = {}; if (key) body.apiKey = key;
  const m = custom || picked; if (m && m !== session?.model) body.model = m;
  if (!Object.keys(body).length) { $('#settings').close(); return; }
  $('#settings-save').disabled = true; $('#settings-msg').textContent = key ? 'Checking the key with OpenAI…' : 'Saving…';
  try {
    const hadKey = session?.configured;
    await saveSettings(body);
    $('#key').value = '';
    $('#settings').close();
    notice(key ? 'API key saved.' : `Model set to ${session.model}.`);
    if (key || !hadKey) await loadModels();
  } catch (err) { $('#settings-msg').textContent = err.message; }
  finally { $('#settings-save').disabled = false; }
};

// ---------- library ----------
const fmtDate = iso => { const d = new Date(iso), t = new Date(); return d.toDateString() === t.toDateString() ? d.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}) : d.toLocaleDateString([], {month: 'short', day: 'numeric'}); };
async function refreshLibrary() { try { papers = await api('/api/papers'); } catch (e) { notice(e.message); } renderLibrary(); }
let expandedId = null, expandedAt = 0;
function renderLibrary() {
  const list = $('#papers');
  // The list is redrawn a few times while a paper opens; keep the slide-open for those redraws.
  if (paper && paper.id !== expandedId) expandedAt = Date.now();
  expandedId = paper?.id ?? null;
  const opening = Date.now() - expandedAt < 400;
  if (!papers.length) { list.replaceChildren(h('li', {className: 'library-empty', textContent: 'No papers yet. Add a PDF to start; it is kept here with its chats.'})); return; }
  list.replaceChildren(...papers.map(p => {
    const current = paper?.id === p.id;
    const open = h('button', {className: 'paper-name', textContent: p.name, title: `${p.name}\nDouble-click to rename`, onclick: () => !current && openPaper(p.id), ondblclick: () => renamePaper(p)});
    const del = h('button', {className: 'icon del', textContent: '×', title: 'Remove this paper and all its chats', onclick: () => deletePaper(p)});
    const li = h('li', {className: 'paper' + (current ? ' current' : '')}, h('div', {className: 'paper-row'}, open, del));
    if (!current) { li.append(h('small', {className: 'paper-meta', textContent: `${p.chats} chat${p.chats === 1 ? '' : 's'} · ${fmtDate(p.openedAt)}`})); return li; }
    const chats = h('ul', {className: 'chats' + (opening ? ' opening' : '')}, ...paper.chats.map(c => h('li', {className: c.id === chat?.id ? 'active' : ''},
      h('button', {className: 'chat-name', title: 'Double-click to rename', onclick: () => c.id !== chat?.id && selectChat(c.id), ondblclick: () => renameChat(c)}, h('span', {textContent: c.title}), h('small', {textContent: fmtDate(c.updatedAt)})),
      h('button', {className: 'icon del', textContent: '×', title: 'Delete this chat', onclick: () => deleteChat(c)}))));
    chats.append(h('li', {}, h('button', {className: 'add-chat', textContent: '+ New chat', onclick: newChat})));
    li.append(chats);
    return li;
  }));
}
async function renamePaper(p) {
  const name = prompt('Rename paper', p.name); if (!name?.trim()) return;
  try { const r = await api(`/api/papers/${p.id}`, {method: 'PATCH', body: {name}}); p.name = r.name; if (paper?.id === p.id) { paper.name = r.name; $('#filename').textContent = r.name; $('#chat-paper').textContent = r.name.toUpperCase(); } renderLibrary(); } catch (e) { notice(e.message); }
}
async function deletePaper(p) {
  if (!confirm(`Remove "${p.name}" and all ${p.chats} of its chats from the library? The PDF copy in the library is deleted too.`)) return;
  try { await api(`/api/papers/${p.id}`, {method: 'DELETE'}); if (paper?.id === p.id) await closePaper(); await refreshLibrary(); notice('Paper removed.'); } catch (e) { notice(e.message); }
}
async function renameChat(c) {
  const title = prompt('Rename chat', c.title); if (!title?.trim()) return;
  try { Object.assign(c, await api(`/api/papers/${paper.id}/chats/${c.id}`, {method: 'PATCH', body: {title}})); if (chat?.id === c.id) { chat.title = c.title; $('#chat-title').textContent = c.title; } renderLibrary(); } catch (e) { notice(e.message); }
}
async function deleteChat(c) {
  if (!confirm(`Delete the chat "${c.title}"?`)) return;
  try {
    await api(`/api/papers/${paper.id}/chats/${c.id}`, {method: 'DELETE'});
    paper.chats = paper.chats.filter(x => x.id !== c.id);
    if (chat?.id === c.id) { if (paper.chats.length) await selectChat(paper.chats[0].id); else await newChat(); }
    renderLibrary(); refreshLibrary();
  } catch (e) { notice(e.message); }
}
async function newChat() {
  if (!paper || working) return;
  try { const c = await api(`/api/papers/${paper.id}/chats`, {method: 'POST'}); paper.chats.unshift({id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt, count: 0}); showChat(c); refreshLibrary(); $('#question').focus(); } catch (e) { notice(e.message); }
}
async function selectChat(cid) {
  if (working) return;
  try { showChat(await api(`/api/papers/${paper.id}/chats/${cid}`)); } catch (e) { notice(e.message); }
}
function showChat(c) {
  chat = c; activeRef = null;
  $('#chat-title').textContent = c.title;
  $('#messages').replaceChildren();
  if (!c.messages.length) $('#messages').append(h('div', {className: 'chat-empty'}, h('p', {textContent: 'Ask anything about this paper. Answers cite PDF pages and equations; select a citation to bring the source into view.'}), h('button', {className: 'suggestion', textContent: 'Summarize the main contributions of this paper.', onclick: e => { $('#question').value = e.target.textContent; $('#question').focus(); }})));
  for (const m of c.messages) addMessage(m.role, m.content, m, false);
  $('#messages').scrollTop = $('#messages').scrollHeight;
  renderLibrary(); controls();
}
function showWelcome() {
  $('#messages').replaceChildren(h('div', {className: 'welcome', innerHTML: `<span class="eyebrow">ROBOTICS / PAPER COMPANION</span><h2>Follow the reasoning.<br>Keep the source in sight.</h2><p>Study a paper with the original equations beside every explanation. Each PDF you add is kept in the library with all of its chats.</p><div class="steps"><p><b>01</b> Add a PDF, or pick one from the library.</p><p><b>02</b> Ask a question; start more chats any time.</p><p><b>03</b> Select a citation, or scroll the chat to follow it.</p></div>`}));
  $('#chat-title').textContent = 'Read. Question. Understand.'; $('#chat-paper').textContent = 'YOUR STUDY DESK';
}

// ---------- PDF ----------
// pdf.js 6 frees a document through its loading task; never let cleanup block opening the next paper.
async function destroyDoc() {
  const d = doc; doc = null;
  try { await d?.loadingTask?.destroy(); } catch (e) { console.warn('PDF cleanup failed', e); }
}
async function closePaper() {
  generation++;
  await renderQueue.catch(() => {});
  await destroyDoc();
  doc = null; paper = null; chat = null; pages = []; index = {}; overrides = {}; activeRef = null; pageBoxes = {}; eqByPage = {}; setContext(null); hidePop();
  $('#pdf').replaceChildren(h('div', {className: 'empty', innerHTML: '<div class="paper-icon">∑</div><h2>Make room for the original.</h2><p>Add a PDF from your laptop, or pick a paper from the library.</p>'}));
  $('#filename').textContent = 'Your paper, in context'; $('#total').textContent = '/ —';
  showWelcome(); controls();
}

$('#file').onchange = async e => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  if (file.size > 60 * 1024 * 1024) { notice('Choose a PDF smaller than 60 MB.'); return; }
  loading = true; controls(); notice('Adding to the library…');
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const p = await api('/api/papers', {body: bytes, headers: {'Content-Type': 'application/pdf', 'X-Filename': encodeURIComponent(file.name)}});
    loading = false;
    await openPaper(p.id, bytes);
  } catch (err) { notice('Could not add PDF: ' + err.message); }
  finally { loading = false; controls(); refreshLibrary(); }
};

async function openPaper(id, bytes) {
  if (working || loading) return;
  loading = true; controls();
  try {
    await closePaper();
    loading = true; controls();
    const gen = generation;
    notice('Opening paper…');
    const meta = await api(`/api/papers/${id}`);
    bytes ??= await api(`/api/papers/${id}/pdf`, {binary: true});
    paper = meta; overrides = meta.overrides || {};
    // One-time move of corrections that older versions kept in browser storage.
    if (!Object.keys(overrides).length) try {
      const old = JSON.parse(localStorage.getItem('margin-' + id) || '{}');
      if (Object.keys(old).length) { overrides = (await api(`/api/papers/${id}`, {method: 'PATCH', body: {overrides: old}})).overrides; localStorage.removeItem('margin-' + id); }
    } catch {}
    $('#filename').textContent = meta.name; $('#filename').title = meta.name; $('#chat-paper').textContent = meta.name.toUpperCase();
    $('#pdf').replaceChildren();
    doc = await pdfjs.getDocument({data: bytes}).promise;
    if (doc.numPages > 300) throw Error('This reader supports up to 300 pages.');
    $('#total').textContent = '/ ' + doc.numPages; $('#page').max = doc.numPages; $('#map-page').max = doc.numPages;
    for (let n = 1; n <= doc.numPages; n++) {
      if (gen !== generation) return;
      notice(`Indexing page ${n} of ${doc.numPages}…`);
      const page = await doc.getPage(n), vp = page.getViewport({scale: 1}), content = await page.getTextContent();
      const items = content.items.filter(t => typeof t.str === 'string');
      pages.push({page: n, text: items.map(t => t.str + (t.hasEOL ? '\n' : ' ')).join('')});
      // Text-item boxes in page pixels (scale 1, top-left origin), used for equation frames and quotes.
      const boxes = items.filter(t => t.str.length).map(t => { const m = pdfjs.Util.transform(vp.transform, t.transform), fh = Math.hypot(m[2], m[3]); return {s: t.str, x0: m[4], x1: m[4] + t.width, y0: m[5] - fh * 0.82, y1: m[5] + fh * 0.22}; });
      pageBoxes[n] = boxes;
      // Equation numbers like "(12)" at the right edge of a column ("(", "12", ")" split items are joined).
      for (let i = 0; i < boxes.length; i++) {
        let b = boxes[i], label = b.s.trim();
        if (label === '(' && boxes[i + 2]) { const g = boxes.slice(i, i + 3); label = g.map(v => v.s).join('').trim(); b = {s: label, x0: g[0].x0, x1: g[2].x1, y0: Math.min(...g.map(v => v.y0)), y1: Math.max(...g.map(v => v.y1))}; }
        const match = label.match(/^\(\s*(\d+[a-z]?)\s*\)$/i);
        if (!match || !isEquationLabel(boxes, b, vp.width)) continue;
        const box = equationBox(boxes, b, vp.width, vp.height);
        const entry = {page: n, y: box.y0, x: b.x0 / vp.width, box, label: match[1]};
        (index[match[1]] ??= []).push(entry); (eqByPage[n] ??= []).push(entry);
      }
      const el = h('div', {className: 'pdf-page'}, h('span', {className: 'page-badge', textContent: n}));
      el.dataset.page = n; el.dataset.width = vp.width; el.dataset.height = vp.height; sizePage(el);
      $('#pdf').append(el); pageObserver.observe(el);
    }
    if (meta.chats.length) await selectChat(meta.chats[0].id); else { loading = false; await newChat(); }
    notice(`Ready · ${pages.length} pages · ${Object.keys(index).length} detected equations. ${pages.every(p => !p.text.trim()) ? 'No text detected: OCR this PDF before asking questions.' : ''}`);
    refreshLibrary();
  } catch (err) { await destroyDoc(); notice('Could not open PDF: ' + err.message); }
  finally { loading = false; controls(); renderLibrary(); }
}

// ---------- rendering & zoom ----------
function sizePage(el) { el.style.width = Number(el.dataset.width) * zoom + 'px'; el.style.height = Number(el.dataset.height) * zoom + 'px'; el.style.setProperty('--total-scale-factor', zoom); }
const MAX_CANVAS_PIXELS = 12e6; // keeps a single page bitmap under ~48 MB at high zoom
const pageObserver = new IntersectionObserver(entries => entries.forEach(e => {
  if (e.isIntersecting) queueRender(e.target);
  else { e.target.querySelector('canvas')?.remove(); e.target.querySelector('.textLayer')?.remove(); delete e.target.dataset.rendered; } // free far-away pages
}), {root: $('#pdf'), rootMargin: '800px'});
function queueRender(el) {
  const gen = generation;
  renderQueue = renderQueue.catch(() => {}).then(async () => {
    if (gen !== generation || !doc || Number(el.dataset.rendered) === zoom) return;
    const z = zoom, page = await doc.getPage(Number(el.dataset.page)), base = page.getViewport({scale: 1});
    const ratio = Math.min(devicePixelRatio || 1, 2, Math.sqrt(MAX_CANVAS_PIXELS / (base.width * base.height * z * z)));
    const vp = page.getViewport({scale: z * ratio});
    const canvas = h('canvas', {width: Math.floor(vp.width), height: Math.floor(vp.height)});
    await page.render({canvasContext: canvas.getContext('2d'), viewport: vp}).promise;
    if (gen !== generation) return;
    const old = el.querySelector('canvas'); if (!old) canvas.className = 'fade-in';
    old?.remove(); el.prepend(canvas); el.dataset.rendered = z;
    if (!el.querySelector('.textLayer')) {
      const layer = h('div', {className: 'textLayer'}); canvas.after(layer);
      // endOfContent + .selecting (as in pdf.js's viewer) stop a drag through gaps from selecting the rest of the page.
      layer.addEventListener('mousedown', () => layer.classList.add('selecting'));
      new pdfjs.TextLayer({textContentSource: page.streamTextContent({includeMarkedContent: true, disableNormalization: true}), container: layer, viewport: base}).render()
        .then(() => layer.append(h('div', {className: 'endOfContent'}))).catch(() => layer.remove());
    }
  }).catch(() => notice('A PDF page could not render. Reopen the paper to retry.'));
  return renderQueue;
}
function visiblePages() {
  const v = $('#pdf').getBoundingClientRect();
  return [...document.querySelectorAll('.pdf-page')].filter(el => { const r = el.getBoundingClientRect(); return r.bottom > v.top - 800 && r.top < v.bottom + 800; });
}
let rerenderTimer;
// Resize pages around a fixed point (cursor or viewport centre) so the spot under it stays put.
function setZoom(next, clientX, clientY) {
  next = clampZoom(next); if (next === zoom) return;
  const pdf = $('#pdf'), box = pdf.getBoundingClientRect();
  const ax = (clientX ?? box.left + box.width / 2) - box.left, ay = (clientY ?? box.top + box.height / 2) - box.top;
  const els = [...document.querySelectorAll('.pdf-page')];
  const anchor = els.find(el => el.offsetTop + el.offsetHeight >= pdf.scrollTop + ay) || els[els.length - 1];
  let fx = 0, fy = 0;
  if (anchor) { fx = (pdf.scrollLeft + ax - anchor.offsetLeft) / anchor.offsetWidth; fy = (pdf.scrollTop + ay - anchor.offsetTop) / anchor.offsetHeight; }
  zoom = next;
  els.forEach(sizePage);
  if (anchor) pdf.scrollTo({left: anchor.offsetLeft + fx * anchor.offsetWidth - ax, top: anchor.offsetTop + fy * anchor.offsetHeight - ay, behavior: 'instant'});
  $('#zoom-reset').textContent = Math.round(zoom * 100) + '%';
  try { localStorage.setItem('margin-zoom', zoom); } catch {}
  clearTimeout(rerenderTimer);
  rerenderTimer = setTimeout(() => visiblePages().forEach(queueRender), 180); // sharpen after the gesture settles
}
// Chromium reports a trackpad pinch as a wheel event with ctrlKey set.
$('#pdf').addEventListener('wheel', e => { if (!e.ctrlKey) return; e.preventDefault(); setZoom(zoom * wheelZoomFactor(e.deltaY, e.deltaMode), e.clientX, e.clientY); }, {passive: false});
$('#zoom-in').onclick = () => setZoom(zoom * 1.2);
$('#zoom-out').onclick = () => setZoom(zoom / 1.2);
$('#zoom-reset').onclick = () => setZoom(1);
$('#zoom-reset').textContent = Math.round(zoom * 100) + '%';

// ---------- citations ----------
async function navigate(ref) {
  if (!doc) return;
  if (ref.quote) return navigateQuote(ref);
  const target = resolveReference(ref, index, overrides, doc.numPages);
  if (!target) { notice('Equation location is missing or ambiguous. Use the correction panel to choose its page and position.'); $('#manual').open = true; $('#equation').value = ref.equation || ''; return; }
  activeRef = ref;
  const el = $(`.pdf-page[data-page="${target.page}"]`);
  await queueRender(el);
  const box = target.manual ? null : target.box;
  const mark = h('div', {className: 'highlight' + (box ? ' eq' : target.y == null ? ' whole' : ''), title: target.manual ? 'Manually corrected location' : target.y == null ? 'Page citation' : 'Detected equation; verify against source'});
  if (box) placeBox(mark, box); else mark.style.top = target.y == null ? '0' : Math.max(0, target.y * 100 - 3) + '%';
  showMarks(el, [mark], box?.y0 ?? target.y ?? 0, target.page);
  notice(`${ref.equation ? 'Equation ' + ref.equation + ' · ' : ''}PDF page ${target.page}${target.manual ? ' · manual correction' : target.fallback ? ' · exact equation not located; showing page' : box ? ' · detected equation (verify visually)' : ''}`);
}
function placeBox(div, b) { Object.assign(div.style, {left: b.x0 * 100 + '%', top: b.y0 * 100 + '%', width: (b.x1 - b.x0) * 100 + '%', height: (b.y1 - b.y0) * 100 + '%'}); }
function showMarks(el, marks, y, page) {
  document.querySelectorAll('.pdf-page .highlight').forEach(x => x.remove());
  el.append(...marks);
  $('#pdf').scrollTo({top: el.offsetTop + y * el.clientHeight - 100, behavior: 'smooth'});
  $('#page').value = page;
}
// Highlight the quoted words; search the cited page first, then the rest of the paper.
async function navigateQuote(ref) {
  const order = [ref.page, ...Object.keys(pageBoxes).map(Number).filter(n => n !== ref.page)].filter(n => pageBoxes[n]);
  for (const n of order) {
    const el = $(`.pdf-page[data-page="${n}"]`);
    const rects = findQuote(pageBoxes[n], ref.quote, Number(el.dataset.width), Number(el.dataset.height));
    if (!rects) continue;
    activeRef = ref;
    await queueRender(el);
    showMarks(el, rects.map(r => { const d = h('div', {className: 'highlight text', title: 'Quoted text'}); placeBox(d, r); return d; }), rects[0].y0, n);
    notice(`Quoted text · PDF page ${n}${n !== ref.page ? ` (cited as page ${ref.page})` : ''}`);
    return;
  }
  await navigate({page: ref.page});
  notice(`The quoted words were not found in the extracted text; showing PDF page ${ref.page}.`);
}

const refLabel = ref => ref.quote ? `“${ref.quote.split(/\s+/).slice(0, 5).join(' ')}…” · p. ${ref.page}` : ref.equation ? `Eq. (${ref.equation})${ref.page ? ' · p. ' + ref.page : ''}` : `Page ${ref.page}`;
const MATH = /\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|\$\$[\s\S]*?\$\$/g;

// Markdown + KaTeX, with citations made clickable where they appear:
// [[eq:..]] tokens become inline chips, a chip (or \tag{n}) right after a display
// equation makes the whole equation a link, and plain "Eq. (61)" / "p. 4" text is linked.
function renderBody(text, linkRefs) {
  const body = h('div', {className: 'message-body'});
  const math = [], cites = [], quotes = [];
  let t = linkRefs ? text.replace(QUOTE, (_, p, q) => { quotes.push({page: Number(p), quote: q.replace(/\s+/g, ' ').trim()}); return `QUOTEPH${quotes.length - 1}END`; }) : text;
  t = t.replace(MATH, m => { math.push(m); return `MATHPH${math.length - 1}END`; });
  if (linkRefs) t = t.replace(TOKEN, (_, eq, p1, p2) => { cites.push(tokenRef(eq, p1, p2)); return `CITEPH${cites.length - 1}END`; });
  body.innerHTML = DOMPurify.sanitize(marked.parse(t));
  body.querySelectorAll('img').forEach(img => img.remove());
  body.querySelectorAll('a').forEach(a => { a.rel = 'noopener noreferrer'; a.target = '_blank'; });
  const escape = s => { const span = document.createElement('span'); span.textContent = s; return span.innerHTML; };
  body.innerHTML = body.innerHTML.replace(/MATHPH(\d+)END/g, (_, i) => escape(math[Number(i)])).replace(/CITEPH(\d+)END/g, (_, i) => `<button type="button" class="cite" data-i="${i}"></button>`).replace(/QUOTEPH(\d+)END/g, (_, i) => `<button type="button" class="quote-link" data-q="${i}"></button>`);
  body.querySelectorAll('button.quote-link').forEach(b => { b.ref = quotes[Number(b.dataset.q)]; b.append(h('span', {textContent: `“${b.ref.quote}”`}), h('small', {textContent: ` p. ${b.ref.page} ↗`})); b.title = 'Highlight this passage in the paper'; });
  body.querySelectorAll('button.cite').forEach(b => { b.ref = cites[Number(b.dataset.i)]; b.textContent = refLabel(b.ref); b.title = 'Show in the paper'; });
  renderMath(body, {delimiters: [{left: '$$', right: '$$', display: true}, {left: '\\[', right: '\\]', display: true}, {left: '\\(', right: '\\)', display: false}], throwOnError: false});
  if (!linkRefs) return body;
  for (const display of body.querySelectorAll('.katex-display')) {
    let host = display; // auto-render wraps each equation in an extra <span>
    while (host.parentElement !== body && host.parentElement.tagName === 'SPAN' && host.parentElement.childNodes.length === 1) host = host.parentElement;
    let next = host.nextSibling;
    while (next && next.nodeType === Node.TEXT_NODE && !next.textContent.trim()) next = next.nextSibling;
    let ref = null;
    if (next?.classList?.contains('cite')) { ref = next.ref; next.remove(); }
    else { const tag = tagOf(display.querySelector('annotation')?.textContent); if (tag) ref = {equation: tag, page: null}; }
    if (!ref) continue;
    const link = h('span', {className: 'eq-link', tabIndex: 0, title: 'Show this equation in the paper'});
    link.setAttribute('role', 'button'); link.ref = ref;
    host.replaceWith(link);
    link.append(host, h('span', {className: 'eq-badge', textContent: refLabel(ref) + ' ↗'}));
  }
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {acceptNode: n => n.parentElement.closest('.katex,code,pre,button,a,.eq-link') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT});
  const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const found = findMentions(node.textContent); if (!found.length) continue;
    const frag = document.createDocumentFragment(); let at = 0;
    for (const {index, length, ref} of found) {
      frag.append(node.textContent.slice(at, index));
      const b = h('button', {type: 'button', className: 'ref-link', textContent: node.textContent.slice(index, index + length), title: 'Show in the paper'}); b.ref = ref;
      frag.append(b); at = index + length;
    }
    frag.append(node.textContent.slice(at)); node.replaceWith(frag);
  }
  body.addEventListener('click', e => { const el = e.target.closest('.cite,.ref-link,.eq-link,.quote-link'); if (el?.ref) { e.stopPropagation(); navigate(el.ref); } });
  body.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('eq-link')) { e.preventDefault(); navigate(e.target.ref); } });
  return body;
}

function addMessage(role, text, meta = {}, scroll = true) {
  $('#messages .chat-empty')?.remove();
  const article = h('article', {className: 'message ' + role + (scroll ? '' : ' instant')});
  const when = meta.at ? ' · ' + new Date(meta.at).toLocaleString([], {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'}) : '';
  article.append(h('small', {textContent: (role === 'user' ? 'YOU' : 'MARGIN' + (meta.model ? ' · ' + meta.model : '')) + when}));
  if (meta.image && /^data:image\/(png|jpeg);base64,/.test(meta.image)) article.append(h('img', {className: 'msg-image', src: meta.image, alt: 'Attached equation image'}));
  const body = renderBody(text, role === 'assistant');
  article.append(body);
  if (role === 'assistant') {
    const quoteRefs = [...text.matchAll(QUOTE)].map(m => ({page: Number(m[1]), quote: m[2].replace(/\s+/g, ' ').trim()}));
    const refs = [...parseReferences(text.replace(QUOTE, '')), ...quoteRefs]; article.refs = refs;
    if (refs.length) {
      article.append(h('div', {className: 'citations'}, ...refs.map(ref => h('button', {textContent: refLabel(ref), onclick: () => navigate(ref)}))));
      article.tabIndex = 0;
      article.addEventListener('focus', () => navigate(refs[0]));
      article.addEventListener('click', e => { if (!e.target.closest('button,a,.eq-link') && !getSelection().toString()) navigate(refs[0]); });
    }
  }
  $('#messages').append(article);
  if (scroll) article.scrollIntoView({behavior: 'smooth', block: 'end'});
  return article;
}
let scrollTimer;
$('#messages').addEventListener('scroll', () => {
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => {
    if (!$('#follow').checked) return;
    const root = $('#messages').getBoundingClientRect();
    const cards = [...document.querySelectorAll('.message')].filter(a => a.refs?.length).filter(a => { const r = a.getBoundingClientRect(); return r.bottom > root.top && r.top < root.bottom; });
    cards.sort((a, b) => Math.abs(a.getBoundingClientRect().top - root.top - 50) - Math.abs(b.getBoundingClientRect().top - root.top - 50));
    if (cards[0] && activeRef !== cards[0].refs[0]) navigate(cards[0].refs[0]);
  }, 180);
});

// ---------- asking ----------
$('#ask').onsubmit = async e => {
  e.preventDefault();
  const typed = $('#question').value.trim(), ctx = context;
  if ((!typed && !ctx) || !doc || !chat || working || loading) return;
  const question = !ctx ? typed : ctx.kind === 'passage'
    ? `> ${ctx.text}\n>\n> — PDF page ${ctx.page}\n\n${typed || 'Explain this passage.'}`
    : `**About Eq. (${ctx.label}), PDF page ${ctx.page}** (image of the equation attached)\n\n${typed || 'Explain this equation: what each term means and how the paper uses it.'}`;
  const image = ctx?.image;
  if (!pages.some(p => p.text.trim())) { notice('This PDF has no extractable text. Use OCR first.'); return; }
  if (!session?.configured) { notice('Add your OpenAI API key in Settings first.'); $('#open-settings').click(); return; }
  working = true; controls(); showStatus();
  const target = chat, paperId = paper.id;
  const pending = addMessage('user', question, {at: new Date().toISOString(), image}); $('#question').value = ''; setContext(null);
  notice(`Reading the paper and asking ${session.model}…`);
  const thinking = h('article', {className: 'message assistant thinking', ariaLabel: 'Margin is thinking'}, h('small', {textContent: 'MARGIN · ' + session.model}), h('div', {className: 'dots'}, h('span'), h('span'), h('span')));
  $('#messages').append(thinking); thinking.scrollIntoView({behavior: 'smooth', block: 'end'});
  try {
    const r = await api(`/api/papers/${paperId}/chats/${target.id}/messages`, {body: {question, pages, ...(image ? {image} : {})}});
    target.messages.push(...r.messages); target.title = r.chat.title;
    const summary = paper?.chats.find(c => c.id === r.chat.id); if (summary) Object.assign(summary, r.chat);
    paper?.chats.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (chat === target) {
      pending.remove(); // replace the optimistic copy with the stored one
      addMessage('user', r.messages[0].content, r.messages[0], false);
      const card = addMessage('assistant', r.messages[1].content, r.messages[1]);
      $('#chat-title').textContent = target.title;
      notice('Answer ready. Select a citation to inspect its source.');
      if ($('#follow').checked && card.refs?.length) navigate(card.refs[0]);
    }
    renderLibrary(); refreshLibrary();
  } catch (err) {
    notice(err.message);
    if (chat === target) { pending.remove(); $('#question').value = typed; setContext(ctx); }
  } finally { thinking.remove(); working = false; controls(); showStatus(); }
};
// Enter sends; Ctrl+Enter (or Shift+Enter) inserts a line break. Ignore Enter while an IME is composing.
$('#question').onkeydown = e => {
  if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
  e.preventDefault();
  if (e.ctrlKey || e.metaKey || e.shiftKey) { e.target.setRangeText('\n', e.target.selectionStart, e.target.selectionEnd, 'end'); e.target.dispatchEvent(new Event('input')); return; }
  if (!e.altKey) $('#ask').requestSubmit();
};
$('#new-chat').onclick = newChat;
$('#toggle-library').onclick = () => { const hidden = document.body.classList.toggle('no-library'); try { localStorage.setItem('margin-library-hidden', hidden ? '1' : ''); } catch {} };
try { if (localStorage.getItem('margin-library-hidden')) document.body.classList.add('no-library'); } catch {}

// ---------- corrections ----------
$('#go').onclick = () => navigate({page: Number($('#page').value)});
$('#find').onclick = () => navigate({equation: $('#equation').value.trim()});
async function persist() {
  try { overrides = (await api(`/api/papers/${paper.id}`, {method: 'PATCH', body: {overrides}})).overrides; return true; }
  catch (e) { notice('Could not save the correction: ' + e.message); return false; }
}
$('#save').onclick = async () => {
  const eq = $('#equation').value.trim(), page = Number($('#map-page').value), pct = Number($('#map-y').value);
  if (!doc || !/^\d+[a-z]?$/i.test(eq) || !Number.isInteger(page) || page < 1 || page > doc.numPages || !Number.isFinite(pct) || pct < 0 || pct > 100) { notice('Enter an equation number, valid PDF page, and position from 0–100%.'); return; }
  overrides[eq] = {page, y: pct / 100};
  if (await persist()) navigate({equation: eq});
};
$('#remove').onclick = async () => { if (!paper) return; delete overrides[$('#equation').value.trim()]; if (await persist()) notice('Correction removed. Automatic detection will be used.'); };
// ---------- PDF interaction: corrections, text selection, equations ----------
function pageHit(e) {
  const el = e.target.closest?.('.pdf-page'); if (!el) return null;
  const r = el.getBoundingClientRect(), u = (e.clientX - r.left) / r.width, v = (e.clientY - r.top) / r.height;
  const eq = (eqByPage[el.dataset.page] || []).find(q => u >= q.box.x0 && u <= q.box.x1 && v >= q.box.y0 && v <= q.box.y1);
  return {el, u, v, eq};
}
let popAction = null;
function showPop(x, y, label, action) {
  const pop = $('#pdf-pop'); $('#pop-ask').textContent = label; popAction = action;
  pop.hidden = false;
  const w = pop.offsetWidth, hgt = pop.offsetHeight;
  pop.style.left = Math.min(innerWidth - w - 8, Math.max(8, x - w / 2)) + 'px';
  pop.style.top = (y + hgt + 12 > innerHeight ? y - hgt - 12 : y + 10) + 'px';
}
function hidePop() { $('#pdf-pop').hidden = true; popAction = null; }
$('#pop-ask').onclick = async () => { const a = popAction; hidePop(); await a?.(); $('#question').focus(); };
$('#pdf').addEventListener('scroll', hidePop, {passive: true});
document.addEventListener('mousedown', e => { if (!e.target.closest('#pdf-pop')) hidePop(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') hidePop(); });

for (const ev of ['pointerup', 'blur']) (ev === 'blur' ? window : document).addEventListener(ev, () => document.querySelectorAll('.textLayer.selecting').forEach(l => l.classList.remove('selecting')));
$('#pdf').addEventListener('mouseup', e => {
  if ($('#manual').open || e.button !== 0) return;
  setTimeout(() => {
    const sel = getSelection(), text = sel.toString().replace(/\s+/g, ' ').trim();
    const el = sel.anchorNode?.parentElement?.closest('.pdf-page');
    if (sel.isCollapsed || text.length < 2 || !el) {
      const hit = pageHit(e);
      if (hit?.eq) showPop(e.clientX, e.clientY, `Ask AI about Eq. (${hit.eq.label}) ↗`, () => attachEquation(hit.eq));
      return;
    }
    const r = sel.getRangeAt(0).getBoundingClientRect();
    const page = Number(el.dataset.page);
    showPop(r.left + r.width / 2, r.bottom, 'Ask AI about this ↗', () => { setContext({kind: 'passage', page, text: text.slice(0, 3000)}); sel.removeAllRanges(); });
  }, 0);
});
// Outline an equation under the pointer so it reads as clickable.
let hoverFrame = 0;
$('#pdf').addEventListener('mousemove', e => {
  if (hoverFrame) return;
  hoverFrame = requestAnimationFrame(() => {
    hoverFrame = 0;
    const hit = $('#manual').open || e.buttons ? null : pageHit(e);
    const old = document.querySelector('.eq-hover');
    if (!hit?.eq) { old?.remove(); document.querySelectorAll('.eq-hot').forEach(x => x.classList.remove('eq-hot')); return; }
    if (old?.eq === hit.eq) return;
    old?.remove();
    const d = h('div', {className: 'eq-hover', title: `Eq. (${hit.eq.label}) · click to ask about it`}); d.eq = hit.eq; placeBox(d, hit.eq.box);
    hit.el.append(d); hit.el.classList.add('eq-hot');
  });
});
$('#pdf').addEventListener('mouseleave', () => { document.querySelector('.eq-hover')?.remove(); });
$('#pdf').onclick = e => {
  if (!$('#manual').open) return;
  const el = e.target.closest('.pdf-page'); if (!el) return;
  $('#map-page').value = el.dataset.page;
  $('#map-y').value = Math.round((e.clientY - el.getBoundingClientRect().top) / el.clientHeight * 100);
};
// Crop the equation from a fresh high-resolution render, since extracted text garbles math.
async function attachEquation(eq) {
  const page = await doc.getPage(eq.page), scale = 3, vp = page.getViewport({scale});
  const full = h('canvas', {width: Math.floor(vp.width), height: Math.floor(vp.height)});
  await page.render({canvasContext: full.getContext('2d'), viewport: vp}).promise;
  const pad = 6, x = Math.max(0, eq.box.x0 * vp.width - pad), y = Math.max(0, eq.box.y0 * vp.height - pad);
  const w = Math.min(vp.width - x, (eq.box.x1 - eq.box.x0) * vp.width + 2 * pad), hh = Math.min(vp.height - y, (eq.box.y1 - eq.box.y0) * vp.height + 2 * pad);
  const k = Math.min(1, 1600 / w), out = h('canvas', {width: Math.round(w * k), height: Math.round(hh * k)}), c = out.getContext('2d');
  c.fillStyle = '#fff'; c.fillRect(0, 0, out.width, out.height); c.drawImage(full, x, y, w, hh, 0, 0, out.width, out.height);
  setContext({kind: 'equation', page: eq.page, label: eq.label, image: out.toDataURL('image/png')});
}
function setContext(c) {
  context = c;
  const box = $('#context'); box.hidden = !c; box.replaceChildren();
  $('#question').placeholder = !c ? 'What would you like to understand?' : c.kind === 'passage' ? 'Ask about this passage… (or press Enter to have it explained)' : 'Ask about this equation… (or press Enter to have it explained)';
  if (!c) return;
  if (c.image) box.append(h('img', {src: c.image, alt: `Eq. (${c.label})`}));
  box.append(h('div', {className: 'ctx-info'}, h('small', {textContent: c.kind === 'passage' ? `PASSAGE · PDF PAGE ${c.page}` : `EQ. (${c.label}) · PDF PAGE ${c.page}`}), ...(c.text ? [h('span', {textContent: `“${c.text.length > 220 ? c.text.slice(0, 220) + '…' : c.text}”`})] : [])),
    h('button', {type: 'button', className: 'icon del', textContent: '×', title: 'Remove attachment', onclick: () => setContext(null)}));
  controls();
}


// ---------- start ----------
showWelcome(); controls();
try { session = await fetch('/api/status').then(r => r.json()); } catch { notice('Local server unavailable. Restart the app.'); }
showStatus();
if (session) {
  if (!session.configured) notice('Welcome! Open Settings to add your OpenAI API key.');
  await Promise.all([loadModels(), refreshLibrary()]);
  if (papers.length && !paper) notice(session.configured ? 'Pick a paper from the library, or add a PDF.' : 'Open Settings to add your OpenAI API key.');
}
