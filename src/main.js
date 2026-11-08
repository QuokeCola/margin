import * as pdfjs from 'pdfjs-dist';
import worker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {marked} from 'marked';
import DOMPurify from 'dompurify';
import renderMath from 'katex/contrib/auto-render';
import 'katex/dist/katex.min.css';
import './style.css';
import {parseReferences, resolveReference, TOKEN, tokenRef, findMentions, tagOf, QUOTE, ANCHOR} from './references.js';
import {findQuote, textBoxes, detectEquations} from './layout.js';
import {parseBibliography, findMarkers, matchEntries} from './bib.js';
import {createMap} from './map.js';
import {clampZoom, wheelZoomFactor} from './zoom.js';
pdfjs.GlobalWorkerOptions.workerSrc = worker;
const $ = s => document.querySelector(s);
const h = (tag, props = {}, ...kids) => { const el = Object.assign(document.createElement(tag), props); el.append(...kids); return el; };

$('#app').innerHTML = `<header><button id="toggle-library" class="icon" title="Show or hide the library" aria-label="Toggle library">☰</button><a class="brand" href="/">m<span>Margin</span></a><span class="subtitle">A little closer to the paper.</span>
<div class="header-tools"><label class="model-picker" title="Model used for new answers">Model <select id="model" disabled><option>…</option></select></label><span id="connection">Connecting…</span><button id="open-settings">Settings</button></div></header>
<main><aside class="library"><div class="project-bar"><small>PROJECT</small><div class="project-row"><select id="project" aria-label="Project"></select><button id="project-rename" class="icon" title="Rename project" aria-label="Rename project">✎</button><button id="project-delete" class="icon del" title="Delete project" aria-label="Delete project">×</button></div><button id="open-map" class="map-button" title="How the papers in this project cite each other">◎ Citation map</button></div>
<div class="lib-section"><div class="lib-head"><small>PAPERS</small><label class="file-button small">+ Add PDF<input id="file" type="file" accept="application/pdf"></label></div><ul id="papers" aria-label="Papers"></ul></div>
<div class="lib-section"><div class="lib-head"><small>CHATS</small><button id="new-chat-side" class="small" title="New chat about the open paper">+ New</button></div><ul id="chats" aria-label="Chats"></ul></div></aside>
<section class="chat"><div class="section-head"><div><small id="chat-paper">YOUR STUDY DESK</small><h1 id="chat-title">Read. Question. Understand.</h1></div><button id="new-chat" disabled>New chat</button></div><div id="messages" tabindex="0" aria-label="Conversation"></div><form id="ask"><div id="context" hidden></div><textarea id="question" aria-label="Question about the paper" placeholder="What would you like to understand?" rows="3" maxlength="8000"></textarea><div class="compose-bottom"><span>Enter to send · Ctrl+Enter for a new line. Paper text + this chat are sent to OpenAI.</span><button id="send" type="submit">Ask ↗</button></div></form><p id="notice" role="status">Add a PDF, or pick one from the library.</p></section>
<section class="reader"><div class="section-head"><div><small>SOURCE DOCUMENT</small><h2 id="filename">Your paper, in context</h2><p id="paper-byline"></p></div><button id="paper-info" class="small" disabled title="Paper details: authors, venue, DOI, abstract">ⓘ Info</button></div><div class="toolbar"><label><input id="follow" type="checkbox" checked> Follow chat</label><div><label>Page <input id="page" type="number" min="1" value="1"></label><span id="total">/ —</span><button id="go">Go</button></div><button id="marker" title="Marker: drag a box over any part of the page to ask about it (Esc to cancel)" aria-pressed="false">✎ Mark</button><div class="zoom" title="Pinch the trackpad (or Ctrl + scroll) over the page to zoom"><button id="zoom-out" aria-label="Zoom out">−</button><button id="zoom-reset" title="Reset to 100%">100%</button><button id="zoom-in" aria-label="Zoom in">+</button></div></div><div id="pdf"><div class="empty"><div class="paper-icon">∑</div><h2>Make room for the original.</h2><p>Add a PDF from your laptop, or pick a paper from the library.<br>Pinch the trackpad over a page to zoom.</p></div></div><details id="manual"><summary>Find a reference / correct an equation location</summary><div class="manual-grid"><label>Equation <input id="equation" placeholder="61"></label><label>PDF page <input id="map-page" type="number" min="1" value="1"></label><label>Position from top (%) <input id="map-y" type="number" min="0" max="100" value="50"></label><button id="find">Find equation</button><button id="save">Save correction</button><button id="remove">Remove correction</button></div><p>Corrections are saved with this paper in your library. Click the PDF while this panel is open to pick a position. Pages use PDF order, not printed journal numbers.</p></details></section>
<section id="map-view" hidden aria-label="Citation map"><div class="map-bar"><button id="map-back">← Back to reading</button><div class="map-title"><small>CITATION MAP</small><h2 id="map-project"></h2></div>
<div class="map-filters"><label><input type="checkbox" id="mf-refs" checked> <i class="dot k-reference"></i>References</label><label><input type="checkbox" id="mf-citing" checked> <i class="dot k-citing"></i>Citing papers</label><label title="Only papers linked to two or more of your papers"><input type="checkbox" id="mf-shared"> Only shared</label><label><input type="checkbox" id="mf-year"> Arrange by year</label><button id="map-fit" class="small" title="Fit the map to the window">Fit</button><button id="map-refresh" class="small" title="Fetch references and citations again">↻</button></div></div>
<div class="map-body"><svg id="map-svg" role="img" aria-label="Citation graph"></svg><div class="map-legend"><span><i class="dot k-library"></i>In this project</span><span><i class="dot k-reference"></i>Cited by your papers</span><span><i class="dot k-citing"></i>Cites your papers</span><span><i class="dot k-both"></i>Both</span><span class="hint">Arrows point to the cited paper · size = citations · drag to move, scroll to zoom</span></div><p id="map-status" role="status"></p><aside id="map-card" hidden></aside></div></section></main>
<div id="toast" role="status" aria-live="polite" hidden></div>
<div id="ref-card" hidden role="dialog" aria-label="Reference"></div>
<div id="drop-zone" hidden><div>Drop the PDF to add it to the project</div></div>
<div id="pdf-pop" hidden><button type="button" id="pop-ask">Ask AI ↗</button></div>
<dialog id="ask-text"><form id="ask-text-form"><h2 id="ask-text-title"></h2><label><input id="ask-text-input" autocomplete="off" maxlength="200"></label><div class="dialog-buttons"><button type="button" id="ask-text-cancel">Cancel</button><button type="submit" class="primary">Save</button></div></form></dialog>
<dialog id="info"><div class="info-body"><div id="info-content"></div><div class="info-lookup"><label>DOI<input id="info-doi" placeholder="10.1109/…" autocomplete="off" spellcheck="false"></label><button type="button" id="info-lookup">Look up</button></div><p id="info-msg" role="status"></p><div class="dialog-buttons"><button type="button" id="info-close" class="primary">Close</button></div></div></dialog>
<dialog id="settings"><form id="settings-form"><h2>Settings</h2>
<label>OpenAI API key<input id="key" type="password" autocomplete="off" spellcheck="false" placeholder="sk-…"></label><p id="key-hint" class="hint"></p><ol class="setup-steps"><li>Sign in at <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer">platform.openai.com/api-keys</a> and click <b>Create new secret key</b>.</li><li>Add credit under Billing if your account has none; answers are billed per use.</li><li>Paste the key above and click <b>Save</b>.</li></ol><nav class="openai-links" aria-label="OpenAI account pages"><a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer">Create an API key ↗</a><a href="https://platform.openai.com/usage" target="_blank" rel="noopener noreferrer">Usage ↗</a><a href="https://platform.openai.com/settings/organization/billing/overview" target="_blank" rel="noopener noreferrer">Billing ↗</a></nav>
<label>Library proxy prefix (optional)<input id="proxy-prefix" autocomplete="off" spellcheck="false" placeholder="https://proxy.lib.your-university.edu/login?url="></label><p class="hint">Used by “Get PDF” in the desktop app to open papers through your library’s sign-in. Ask your library for its proxy link prefix (EZproxy “login?url=” style).</p>
<label>Model<select id="settings-model"></select></label><label>…or type a model ID<input id="custom-model" autocomplete="off" spellcheck="false" placeholder="e.g. gpt-5.2"></label>
<p class="hint">Stored only on this computer, in a file readable only by you, and applied immediately. A new key is checked with OpenAI before it is saved; it is sent only to OpenAI.</p>
<p id="settings-msg" role="status"></p><div class="dialog-buttons"><button type="button" id="settings-cancel">Cancel</button><button type="submit" id="settings-save" class="primary">Save</button></div></form></dialog>`;

let session = null, models = [], projects = [], project = null, paper = null, chat = null; // project: {id, name, papers, chats}
let doc = null, pages = [], index = {}, overrides = {};
let pageBoxes = {}, eqByPage = {}, context = null;
let bib = {start: null, entries: new Map()}, refHits = {}, refRecords = [], refByNum = new Map(), refsState = 'idle'; // references of the open paper // text-item geometry and detected equations per page; pending attachment
let working = false, loading = false, generation = 0, activeRef = null, renderQueue = Promise.resolve();
let zoom = 1;
try { zoom = clampZoom(Number(localStorage.getItem('margin-zoom')) || 1); } catch {}
// Short message that stays visible in every view (the status line is hidden while the map is open).
let toastTimer;
function toast(t, ms = 6000) {
  const el = $('#toast'); el.textContent = t; el.hidden = false; el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}
const say = t => { notice(t); toast(t); };
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
  for (const id of ['#papers', '#chats']) $(id).classList.toggle('locked', working || loading);
  $('#project').disabled = working || loading; $('#new-chat-side').disabled = !paper || working || loading;
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
  $('#key').value = ''; $('#custom-model').value = ''; $('#settings-msg').textContent = ''; $('#proxy-prefix').value = session?.proxyPrefix || '';
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
  const proxy = $('#proxy-prefix').value.trim(); if (proxy !== (session?.proxyPrefix || '')) body.proxyPrefix = proxy;
  const m = custom || picked; if (m && m !== session?.model) body.model = m;
  if (!Object.keys(body).length) { $('#settings').close(); return; }
  $('#settings-save').disabled = true; $('#settings-msg').textContent = key ? 'Checking the key with OpenAI…' : 'Saving…';
  try {
    const hadKey = session?.configured;
    await saveSettings(body);
    $('#key').value = '';
    $('#settings').close();
    notice(key ? 'API key saved.' : body.model ? `Model set to ${session.model}.` : 'Settings saved.');
    if (key || !hadKey) await loadModels();
  } catch (err) { $('#settings-msg').textContent = err.message; }
  finally { $('#settings-save').disabled = false; }
};

// In-app text prompt (window.prompt is unavailable in the desktop app).
function askText(title, value) {
  const d = $('#ask-text'), input = $('#ask-text-input');
  $('#ask-text-title').textContent = title; input.value = value;
  d.showModal(); input.select();
  return new Promise(resolve => {
    const done = v => { d.close(); $('#ask-text-form').onsubmit = $('#ask-text-cancel').onclick = d.oncancel = null; resolve(v); };
    $('#ask-text-form').onsubmit = e => { e.preventDefault(); done(input.value); };
    $('#ask-text-cancel').onclick = () => done(null);
    d.oncancel = () => done(null);
  });
}

// ---------- library: projects, papers, chats ----------
const fmtDate = iso => { const d = new Date(iso), t = new Date(); return d.toDateString() === t.toDateString() ? d.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}) : d.toLocaleDateString([], {month: 'short', day: 'numeric'}); };
const paperTitle = p => p?.meta?.title && !p.renamed ? p.meta.title : p?.name || 'Untitled paper';
const byline = m => !m ? '' : [m.authors?.length ? m.authors[0].split(' ').pop() + ((m.authorCount ?? m.authors.length) > 1 ? ' et al.' : '') : null, m.year, m.venue].filter(Boolean).join(' · ');
const pathP = (...parts) => `/api/projects/${project.id}` + parts.map(x => '/' + x).join('');

async function refreshProjects() {
  projects = await api('/api/projects');
  let want = null; try { want = localStorage.getItem('margin-project'); } catch {}
  const pick = projects.find(x => x.id === (project?.id ?? want)) || projects[0];
  if (pick && pick.id !== project?.id) await loadProject(pick.id, false);
  renderProjects();
}
function renderProjects() {
  const sel = $('#project');
  sel.replaceChildren(...projects.map(x => h('option', {value: x.id, textContent: `${x.name} (${x.papers})`, selected: x.id === project?.id})), h('option', {value: '__new', textContent: '+ New project…'}));
  $('#project-delete').disabled = projects.length <= 1;
}
async function loadProject(pid, render = true) {
  project = await api(`/api/projects/${pid}`);
  try { localStorage.setItem('margin-project', pid); } catch {}
  if (render) renderLibrary();
}
async function refreshProject() { if (project) { project = await api(pathP()); renderLibrary(); } }
$('#project').onchange = async e => {
  const v = e.target.value;
  if (v === '__new') {
    renderProjects();
    const name = await askText('New project', ''); if (!name?.trim()) return;
    try { const p = await api('/api/projects', {body: {name}}); await closePaper(); await loadProject(p.id); await refreshProjects(); notice(`Project "${p.name}" created. Add PDFs to it.`); } catch (err) { notice(err.message); }
    return;
  }
  if (working) { renderProjects(); return; }
  closeMap(); await closePaper(); await loadProject(v); renderProjects();
  notice(`Project "${project.name}": ${project.papers.length ? 'pick a paper in the sidebar, or add a PDF.' : 'add a PDF to start.'}`);
};
$('#project-rename').onclick = async () => {
  const name = await askText('Rename project', project.name); if (!name?.trim()) return;
  try { await api(pathP(), {method: 'PATCH', body: {name}}); await refreshProjects(); await refreshProject(); } catch (e) { notice(e.message); }
};
$('#project-delete').onclick = async () => {
  if (!confirm(`Delete the project "${project.name}" and its ${project.chats.length} chats? Papers that are in no other project are removed from the library too.`)) return;
  try { await api(pathP(), {method: 'DELETE'}); await closePaper(); project = null; await refreshProjects(); renderLibrary(); notice('Project deleted.'); } catch (e) { notice(e.message); }
};

let expandedAt = 0;
function renderLibrary() {
  const papersEl = $('#papers'), chatsEl = $('#chats');
  if (!project) { papersEl.replaceChildren(); chatsEl.replaceChildren(); return; }
  papersEl.replaceChildren(...(project.papers.length ? project.papers.map(p => {
    const current = paper?.id === p.id;
    const open = h('button', {className: 'paper-name', title: `${paperTitle(p)}\nDouble-click to rename`, onclick: () => !current && openPaper(p.id), ondblclick: () => renamePaper(p)},
      h('span', {textContent: paperTitle(p)}), h('small', {textContent: byline(p.meta) || 'No details yet'}));
    return h('li', {className: 'paper' + (current ? ' current' : '')}, h('div', {className: 'paper-row'}, open,
      h('button', {className: 'icon del', textContent: '×', title: 'Remove from this project (and its chats here)', onclick: () => removePaper(p)})));
  }) : [h('li', {className: 'library-empty', textContent: 'No papers in this project yet. Add a PDF.'})]));
  const titles = Object.fromEntries(project.papers.map(p => [p.id, paperTitle(p)]));
  chatsEl.replaceChildren(...(project.chats.length ? project.chats.map(c => h('li', {className: c.id === chat?.id ? 'active' : ''},
    h('button', {className: 'chat-name', title: 'Double-click to rename', onclick: () => c.id !== chat?.id && selectChat(c), ondblclick: () => renameChat(c)},
      h('span', {textContent: c.title}), h('small', {textContent: `${(titles[c.paperId] || 'Removed paper').slice(0, 28)} · ${fmtDate(c.updatedAt)}`})),
    h('button', {className: 'icon del', textContent: '×', title: 'Delete this chat', onclick: () => deleteChat(c)}))) : [h('li', {className: 'library-empty', textContent: 'No chats yet.'})]));
  $('#new-chat-side').disabled = !paper || working || loading;
}
async function renamePaper(p) {
  const name = await askText('Rename paper', paperTitle(p)); if (!name?.trim()) return;
  try { const r = await api(`/api/papers/${p.id}`, {method: 'PATCH', body: {name}}); if (paper?.id === p.id) Object.assign(paper, {name: r.name, renamed: true}); await refreshProject(); showPaperHeader(); } catch (e) { notice(e.message); }
}
async function removePaper(p) {
  const n = project.chats.filter(c => c.paperId === p.id).length;
  if (!confirm(`Remove "${paperTitle(p)}" from "${project.name}"${n ? ` and delete its ${n} chat${n === 1 ? '' : 's'} here` : ''}? If no other project uses it, the stored PDF is deleted too.`)) return;
  try { await api(pathP('papers', p.id), {method: 'DELETE'}); if (paper?.id === p.id) await closePaper(); await refreshProject(); refreshProjects(); notice('Paper removed from the project.'); } catch (e) { notice(e.message); }
}
async function renameChat(c) {
  const title = await askText('Rename chat', c.title); if (!title?.trim()) return;
  try { Object.assign(c, await api(pathP('chats', c.id), {method: 'PATCH', body: {title}})); if (chat?.id === c.id) { chat.title = c.title; $('#chat-title').textContent = c.title; } renderLibrary(); } catch (e) { notice(e.message); }
}
async function deleteChat(c) {
  if (!confirm(`Delete the chat "${c.title}"?`)) return;
  try {
    await api(pathP('chats', c.id), {method: 'DELETE'});
    project.chats = project.chats.filter(x => x.id !== c.id);
    if (chat?.id === c.id) { const next = project.chats.find(x => x.paperId === paper?.id); if (next) await selectChat(next); else await newChat(); }
    renderLibrary();
  } catch (e) { notice(e.message); }
}
async function newChat() {
  if (!paper || working) return;
  try { const c = await api(pathP('chats'), {body: {paperId: paper.id}}); project.chats.unshift({id: c.id, title: c.title, paperId: c.paperId, createdAt: c.createdAt, updatedAt: c.updatedAt, count: 0}); showChat(c); $('#question').focus(); } catch (e) { notice(e.message); }
}
// A chat is about one paper for now; selecting a chat of another paper opens that paper.
async function selectChat(c) {
  if (working) return;
  if (c.paperId && c.paperId !== paper?.id) { await openPaper(c.paperId, null, c.id); return; }
  try { showChat(await api(pathP('chats', c.id))); } catch (e) { notice(e.message); }
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
$('#new-chat-side').onclick = () => newChat();

// ---------- paper details (OpenAlex / Crossref) ----------
function showPaperHeader() {
  const t = paper ? paperTitle(paper) : 'Your paper, in context';
  $('#filename').textContent = t; $('#filename').title = t;
  $('#paper-byline').textContent = paper?.meta ? byline(paper.meta) : '';
  $('#chat-paper').textContent = paper ? t.toUpperCase() : 'YOUR STUDY DESK';
  $('#paper-info').disabled = !paper;
}
// DOI candidates and a title guess (the largest text near the top of page 1) for the lookup.
function lookupHints() {
  const text = pages.slice(0, 2).map(p => p.text).join('\n');
  const dois = [...new Set((text.replace(/\s*\n\s*/g, ' ').match(/\b10\.\d{4,9}\/[^\s"<>,;]+/gi) || []).map(d => d.replace(/[.)\]]+$/, '')))].slice(0, 5);
  const el = $('.pdf-page[data-page="1"]'), H = Number(el?.dataset.height || 792);
  const top = (pageBoxes[1] || []).filter(b => b.s.trim() && b.y0 < H * 0.45);
  const maxH = Math.max(0, ...top.map(b => b.y1 - b.y0));
  const title = top.filter(b => b.y1 - b.y0 >= 0.85 * maxH).sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0).map(b => b.s).join(' ').replace(/\s+/g, ' ').trim();
  return {dois, title: title.length > 200 ? title.slice(0, 200) : title};
}
async function lookupMetadata({doi, quiet = false} = {}) {
  if (!paper) return;
  const id = paper.id;
  try {
    const r = await api(`/api/papers/${id}/metadata`, {body: doi ? {doi} : lookupHints()});
    if (paper?.id !== id) return;
    Object.assign(paper, {meta: r.meta, metaLookup: r.metaLookup, name: r.name});
    showPaperHeader(); await refreshProject(); loadReferences();
    if (!quiet) notice(`Details found: ${byline(r.meta) || r.meta.title}.`);
    return true;
  } catch (e) { if (!quiet) notice(e.message); return false; }
}
// Look up automatically once per paper (a miss is retried after a week).
function maybeLookup() {
  const l = paper?.metaLookup;
  if (paper && !paper.meta && (!l || Date.now() - new Date(l.at) > 7 * 864e5)) lookupMetadata({quiet: true});
}
function renderInfo() {
  const m = paper?.meta, box = $('#info-content');
  $('#info-doi').value = m?.doi || '';
  if (!m) { box.replaceChildren(h('h2', {textContent: paperTitle(paper)}), h('p', {className: 'hint', textContent: 'No details found yet. Enter the paper\'s DOI below (it usually appears on the first page) and click Look up.'})); return; }
  const link = (href, text) => h('a', {href, target: '_blank', rel: 'noopener noreferrer', textContent: text});
  const rows = [['Authors', m.authors?.join(', ')], ['Published', [m.venue, m.date || m.year].filter(Boolean).join(' · ')], ['Type', m.type], ['Cited by', m.citedBy != null ? `${m.citedBy} works` : null], ['References', m.references?.length ? `${m.references.length} works` : null]].filter(([, v]) => v);
  box.replaceChildren(h('h2', {textContent: m.title || paperTitle(paper)}),
    h('dl', {}, ...rows.flatMap(([k, v]) => [h('dt', {textContent: k}), h('dd', {textContent: v})])),
    h('nav', {className: 'info-links'}, ...[m.doi && link(`https://doi.org/${m.doi}`, `doi.org/${m.doi} ↗`), m.openalexId && link(`https://openalex.org/${m.openalexId}`, 'OpenAlex ↗'), (m.pdfUrl || m.oaUrl) && link(m.pdfUrl || m.oaUrl, 'Open-access copy ↗')].filter(Boolean)),
    ...(m.abstract ? [h('h3', {textContent: 'Abstract'}), h('p', {className: 'abstract', textContent: m.abstract})] : []),
    h('p', {className: 'hint', textContent: `Source: ${m.source === 'crossref' ? 'Crossref' : 'OpenAlex'}, retrieved ${fmtDate(m.fetchedAt)}.`}),
    refList());
}
// References of the open paper, in bibliography order when the entries could be matched.
function refList() {
  const wrap = h('div', {className: 'ref-list'}, h('h3', {textContent: `References${refRecords.length ? ` (${refRecords.length})` : ''}`}));
  if (refsState !== 'ready') { wrap.append(h('p', {className: 'hint', textContent: refsState === 'loading' ? 'Loading…' : 'Not loaded yet.'})); return wrap; }
  const numbered = [...refByNum].sort((a, b) => a[0] - b[0]), seen = new Set(numbered.map(([, r]) => r));
  const rows = [...numbered.map(([n, r]) => [n, r]), ...refRecords.filter(r => !seen.has(r)).map(r => [null, r])];
  wrap.append(h('ol', {className: 'ref-rows'}, ...rows.map(([n, r]) => {
    const have = inProject(r);
    return h('li', {}, h('span', {className: 'ref-num', textContent: n ? `[${n}]` : '·'}), h('div', {}, h('div', {className: 'ref-title', textContent: r.title || '(untitled)'}), h('div', {className: 'ref-meta', textContent: [authorsShort(r), r.year].filter(Boolean).join(' · ')})),
      have ? h('button', {className: 'small', textContent: 'Open', onclick: () => { $('#info').close(); openPaper(have.id); }}) : addButton(r, null, true));
  })));
  return wrap;
}
$('#paper-info').onclick = () => { $('#info-msg').textContent = ''; renderInfo(); $('#info').showModal(); };
$('#info-close').onclick = () => $('#info').close();
$('#info-lookup').onclick = async () => {
  const doi = $('#info-doi').value.trim();
  $('#info-msg').textContent = 'Looking up…'; $('#info-lookup').disabled = true;
  const ok = await lookupMetadata(doi ? {doi, quiet: true} : {quiet: true});
  $('#info-lookup').disabled = false;
  $('#info-msg').textContent = ok ? 'Updated.' : 'Nothing found for that. Check the DOI (it starts with 10.).';
  renderInfo();
};
function showWelcome() {
  $('#messages').replaceChildren(h('div', {className: 'welcome', innerHTML: `<span class="eyebrow">ROBOTICS / PAPER COMPANION</span><h2>Follow the reasoning.<br>Keep the source in sight.</h2><p>Study papers with the original equations beside every explanation. Papers are grouped into projects, each with its own chats.</p><div class="steps"><p><b>01</b> Add a PDF to the project, or pick one in the sidebar.</p><p><b>02</b> Ask a question; start more chats any time.</p><p><b>03</b> Select a citation, or scroll the chat to follow it.</p></div>`}));
  $('#chat-title').textContent = 'Read. Question. Understand.'; showPaperHeader();
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
  doc = null; paper = null; chat = null; pages = []; index = {}; overrides = {}; activeRef = null; pageBoxes = {}; eqByPage = {}; setContext(null); hidePop(); setMarking(false); hideRefCard();
  bib = {start: null, entries: new Map()}; refHits = {}; refRecords = []; refByNum = new Map(); refsState = 'idle';
  $('#pdf').replaceChildren(h('div', {className: 'empty', innerHTML: '<div class="paper-icon">∑</div><h2>Make room for the original.</h2><p>Add a PDF from your laptop, or pick a paper from the library.</p>'}));
  $('#total').textContent = '/ —';
  showWelcome(); controls(); renderLibrary();
}

$('#file').onchange = async e => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  if (file.size > 60 * 1024 * 1024) { notice('Choose a PDF smaller than 60 MB.'); return; }
  if (!project) return;
  loading = true; controls(); notice(`Adding to "${project.name}"…`);
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const p = await api(pathP('papers'), {body: bytes, headers: {'Content-Type': 'application/pdf', 'X-Filename': encodeURIComponent(file.name)}});
    loading = false;
    await refreshProject(); refreshProjects();
    await openPaper(p.id, bytes);
  } catch (err) { notice('Could not add PDF: ' + err.message); }
  finally { loading = false; controls(); }
};

async function openPaper(id, bytes, chatId) {
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
    showPaperHeader(); renderLibrary();
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
      const boxes = textBoxes(items, vp, pdfjs.Util); // used for equation frames and quotes
      pageBoxes[n] = boxes;
      for (const e of detectEquations(boxes, vp.width, vp.height)) {
        const entry = {page: n, y: e.box.y0, x: e.labelBox.x0, box: e.box, label: e.label};
        (index[e.label] ??= []).push(entry); (eqByPage[n] ??= []).push(entry);
      }
      const el = h('div', {className: 'pdf-page'}, h('span', {className: 'page-badge', textContent: n}));
      el.dataset.page = n; el.dataset.width = vp.width; el.dataset.height = vp.height; sizePage(el);
      $('#pdf').append(el); pageObserver.observe(el);
    }
    const mine = project.chats.filter(c => c.paperId === id), pick = mine.find(c => c.id === chatId) || mine[0];
    if (pick) showChat(await api(pathP('chats', pick.id))); else { loading = false; await newChat(); }
    notice(`Ready · ${pages.length} pages · ${Object.keys(index).length} detected equations. ${pages.every(p => !p.text.trim()) ? 'No text detected: OCR this PDF before asking questions.' : ''}`);
    indexReferences(); if (paper.meta) loadReferences(); else maybeLookup();
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
// Highlight the cited or quoted words. The cited page wins if it matches well; otherwise the
// closest match anywhere in the paper is used (models sometimes cite a neighbouring page).
async function navigateQuote(ref) {
  const what = ref.anchor ? 'Cited text' : 'Quoted text';
  const find = n => { const el = $(`.pdf-page[data-page="${n}"]`); return pageBoxes[n] && el ? findQuote(pageBoxes[n], ref.quote, Number(el.dataset.width), Number(el.dataset.height)) : null; };
  let best = null, bestPage = null;
  const own = find(ref.page);
  if (own && own.dist <= 0.1) { best = own; bestPage = ref.page; }
  else {
    if (own) { best = own; bestPage = ref.page; }
    for (const n of Object.keys(pageBoxes).map(Number)) {
      if (n === ref.page) continue;
      const r = find(n);
      if (r && (!best || r.dist < best.dist - 0.02)) { best = r; bestPage = n; }
    }
  }
  if (!best) {
    await navigate({page: ref.page});
    notice(`The cited words were not found in the extracted text; showing PDF page ${ref.page}.`);
    return;
  }
  activeRef = ref;
  const el = $(`.pdf-page[data-page="${bestPage}"]`);
  await queueRender(el);
  showMarks(el, best.map(r => { const d = h('div', {className: 'highlight text', title: what}); placeBox(d, r); return d; }), best[0].y0, bestPage);
  notice(`${what} · PDF page ${bestPage}${bestPage !== ref.page ? ` (cited as page ${ref.page})` : ''}${best.dist > 0 ? ' · close match' : ''}`);
}

const words4 = q => { const w = q.split(/\s+/); return w.slice(0, 4).join(' ') + (w.length > 4 ? '…' : ''); };
const refLabel = ref => ref.anchor ? `p. ${ref.page} · “${words4(ref.quote)}”` : ref.quote ? `“${ref.quote.split(/\s+/).slice(0, 5).join(' ')}…” · p. ${ref.page}` : ref.equation ? `Eq. (${ref.equation})${ref.page ? ' · p. ' + ref.page : ''}` : `Page ${ref.page}`;
const MATH = /\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|\$\$[\s\S]*?\$\$/g;

// Markdown + KaTeX, with citations made clickable where they appear:
// [[eq:..]] tokens become inline chips, a chip (or \tag{n}) right after a display
// equation makes the whole equation a link, and plain "Eq. (61)" / "p. 4" text is linked.
function renderBody(text, linkRefs) {
  const body = h('div', {className: 'message-body'});
  const math = [], cites = [], quotes = [];
  const anchors = [];
  let t = linkRefs ? text.replace(QUOTE, (_, p, q) => { quotes.push({page: Number(p), quote: q.replace(/\s+/g, ' ').trim()}); return `QUOTEPH${quotes.length - 1}END`; })
    .replace(ANCHOR, (_, p, q) => { anchors.push({page: Number(p), quote: q.replace(/\s+/g, ' ').trim(), anchor: true}); return `ANCHPH${anchors.length - 1}END`; }) : text;
  t = t.replace(MATH, m => { math.push(m); return `MATHPH${math.length - 1}END`; });
  if (linkRefs) t = t.replace(TOKEN, (_, eq, p1, p2) => { cites.push(tokenRef(eq, p1, p2)); return `CITEPH${cites.length - 1}END`; });
  body.innerHTML = DOMPurify.sanitize(marked.parse(t));
  body.querySelectorAll('img').forEach(img => img.remove());
  body.querySelectorAll('a').forEach(a => { a.rel = 'noopener noreferrer'; a.target = '_blank'; });
  const escape = s => { const span = document.createElement('span'); span.textContent = s; return span.innerHTML; };
  body.innerHTML = body.innerHTML.replace(/MATHPH(\d+)END/g, (_, i) => escape(math[Number(i)])).replace(/CITEPH(\d+)END/g, (_, i) => `<button type="button" class="cite" data-i="${i}"></button>`).replace(/QUOTEPH(\d+)END/g, (_, i) => `<button type="button" class="quote-link" data-q="${i}"></button>`).replace(/ANCHPH(\d+)END/g, (_, i) => `<button type="button" class="cite anchor" data-a="${i}"></button>`);
  body.querySelectorAll('button.cite.anchor').forEach(b => { b.ref = anchors[Number(b.dataset.a)]; b.textContent = refLabel(b.ref); b.title = `Highlight in the paper: “${b.ref.quote}”`; });
  body.querySelectorAll('button.quote-link').forEach(b => { b.ref = quotes[Number(b.dataset.q)]; b.append(h('span', {textContent: `“${b.ref.quote}”`}), h('small', {textContent: ` p. ${b.ref.page} ↗`})); b.title = 'Highlight this passage in the paper'; });
  body.querySelectorAll('button.cite:not(.anchor)').forEach(b => { b.ref = cites[Number(b.dataset.i)]; b.textContent = refLabel(b.ref); b.title = 'Show in the paper'; });
  renderMath(body, {delimiters: [{left: '$$', right: '$$', display: true}, {left: '\\[', right: '\\]', display: true}, {left: '\\(', right: '\\)', display: false}], throwOnError: false});
  if (!linkRefs) return body;
  for (const display of body.querySelectorAll('.katex-display')) {
    let host = display; // auto-render wraps each equation in an extra <span>
    while (host.parentElement !== body && host.parentElement.tagName === 'SPAN' && host.parentElement.childNodes.length === 1) host = host.parentElement;
    let next = host.nextSibling;
    while (next && next.nodeType === Node.TEXT_NODE && !next.textContent.trim()) next = next.nextSibling;
    let ref = null;
    if (next?.classList?.contains('cite') && !next.classList.contains('anchor')) { ref = next.ref; next.remove(); }
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
    const anchorRefs = [...text.matchAll(ANCHOR)].map(m => ({page: Number(m[1]), quote: m[2].replace(/\s+/g, ' ').trim(), anchor: true}));
    const seen = new Set(), uniq = r => { const k = JSON.stringify(r); if (seen.has(k)) return false; seen.add(k); return true; };
    // Precise anchors first, so "follow chat" jumps to the exact passage.
    const refs = [...anchorRefs, ...quoteRefs, ...parseReferences(text.replace(QUOTE, '').replace(ANCHOR, ''))].filter(uniq); article.refs = refs;
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
    ? `> ${ctx.text}\n>\n> — PDF page ${ctx.page}${ctx.image ? ' (image of the selected lines attached, for symbols the text drops)' : ''}\n\n${typed || 'Explain this passage.'}`
    : ctx.kind === 'region'
      ? `**About a marked area on PDF page ${ctx.page}** (${ctx.where}; image attached)${ctx.text ? `\n\n> ${ctx.text}` : ''}\n\n${typed || 'Explain what is in this marked area.'}`
      : `**About Eq. (${ctx.label}), PDF page ${ctx.page}** (image of the equation attached)\n\n${typed || 'Explain this equation: what each term means and how the paper uses it.'}`;
  const image = ctx?.image;
  if (!pages.some(p => p.text.trim())) { notice('This PDF has no extractable text. Use OCR first.'); return; }
  if (!session?.configured) { notice('Add your OpenAI API key in Settings first.'); $('#open-settings').click(); return; }
  working = true; controls(); showStatus();
  const target = chat, projectId = project.id;
  const pending = addMessage('user', question, {at: new Date().toISOString(), image}); $('#question').value = ''; setContext(null);
  notice(`Reading the paper and asking ${session.model}…`);
  const thinking = h('article', {className: 'message assistant thinking', ariaLabel: 'Margin is thinking'}, h('small', {textContent: 'MARGIN · ' + session.model}), h('div', {className: 'dots'}, h('span'), h('span'), h('span')));
  $('#messages').append(thinking); thinking.scrollIntoView({behavior: 'smooth', block: 'end'});
  try {
    const r = await api(`/api/projects/${projectId}/chats/${target.id}/messages`, {body: {question, pages, ...(image ? {image} : {})}});
    target.messages.push(...r.messages); target.title = r.chat.title;
    if (project?.id === projectId) { const summary = project.chats.find(c => c.id === r.chat.id); if (summary) Object.assign(summary, r.chat); project.chats.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
    if (chat === target) {
      pending.remove(); // replace the optimistic copy with the stored one
      addMessage('user', r.messages[0].content, r.messages[0], false);
      const card = addMessage('assistant', r.messages[1].content, r.messages[1]);
      $('#chat-title').textContent = target.title;
      notice('Answer ready. Select a citation to inspect its source.');
      if ($('#follow').checked && card.refs?.length) navigate(card.refs[0]);
    }
    renderLibrary();
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
  const inside = b => u >= b.x0 && u <= b.x1 && v >= b.y0 && v <= b.y1;
  const ref = (refHits[el.dataset.page] || []).find(q => inside(q.box));
  const eq = ref ? null : (eqByPage[el.dataset.page] || []).find(q => inside(q.box));
  return {el, u, v, eq, ref};
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
  if ($('#manual').open || e.button !== 0 || marking || Date.now() - markedAt < 400) return;
  setTimeout(() => {
    const sel = getSelection(), text = sel.toString().replace(/\s+/g, ' ').trim();
    const el = sel.anchorNode?.parentElement?.closest('.pdf-page');
    if (sel.isCollapsed || text.length < 2 || !el) {
      const hit = pageHit(e);
      if (hit?.ref) { showRefCard(hit.ref.nums, e.clientX, e.clientY); return; }
      if (hit?.eq) showPop(e.clientX, e.clientY, `Ask AI about Eq. (${hit.eq.label}) ↗`, () => attachEquation(hit.eq));
      return;
    }
    const range = sel.getRangeAt(0), r = range.getBoundingClientRect();
    const page = Number(el.dataset.page), box = selectionBox(range, el);
    showPop(r.left + r.width / 2, r.bottom, 'Ask AI about this ↗', async () => {
      sel.removeAllRanges();
      setContext({kind: 'passage', page, text: text.slice(0, 3000), box, image: box ? await cropRegion(page, box) : null});
    });
  }, 0);
});
// Outline an equation under the pointer so it reads as clickable.
let hoverFrame = 0;
$('#pdf').addEventListener('mousemove', e => {
  if (hoverFrame) return;
  hoverFrame = requestAnimationFrame(() => {
    hoverFrame = 0;
    const hit = $('#manual').open || marking || e.buttons ? null : pageHit(e);
    const old = document.querySelector('.eq-hover'), target = hit?.ref || hit?.eq;
    if (!target) { old?.remove(); document.querySelectorAll('.eq-hot').forEach(x => x.classList.remove('eq-hot')); return; }
    if (old?.eq === target) return;
    old?.remove();
    const d = h('div', {className: 'eq-hover' + (hit.ref ? ' ref' : ''), title: hit.ref ? `Reference ${hit.ref.nums.map(n => `[${n}]`).join(' ')} · click for details` : `Eq. (${hit.eq.label}) · click to ask about it`}); d.eq = target; placeBox(d, target.box);
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
// Crop part of a page from a fresh high-resolution render: extracted text drops overbars, hats,
// fraction layout and other symbols, so attachments carry an image of the area as well.
async function cropRegion(pageNum, box, pad = 6) {
  const page = await doc.getPage(pageNum), base = page.getViewport({scale: 1});
  const wPts = (box.x1 - box.x0) * base.width, scale = Math.min(3, Math.max(1.5, 1600 / Math.max(1, wPts)));
  const vp = page.getViewport({scale});
  const full = h('canvas', {width: Math.floor(vp.width), height: Math.floor(vp.height)});
  await page.render({canvasContext: full.getContext('2d'), viewport: vp}).promise;
  const x = Math.max(0, box.x0 * vp.width - pad), y = Math.max(0, box.y0 * vp.height - pad);
  const w = Math.min(vp.width - x, (box.x1 - box.x0) * vp.width + 2 * pad), hh = Math.min(vp.height - y, (box.y1 - box.y0) * vp.height + 2 * pad);
  const k = Math.min(1, 1600 / w, 2000 / hh), out = h('canvas', {width: Math.round(w * k), height: Math.round(hh * k)}), c = out.getContext('2d');
  c.fillStyle = '#fff'; c.fillRect(0, 0, out.width, out.height); c.drawImage(full, x, y, w, hh, 0, 0, out.width, out.height);
  const png = out.toDataURL('image/png');
  return png.length <= 1_500_000 ? png : out.toDataURL('image/jpeg', 0.9); // stay under the server's 2 MB limit
}
async function attachEquation(eq) {
  setContext({kind: 'equation', page: eq.page, label: eq.label, box: eq.box, image: await cropRegion(eq.page, eq.box)});
}
// Normalised box of a text selection on one page (selections spanning pages are clipped to the first).
function selectionBox(range, el) {
  const pr = el.getBoundingClientRect();
  const rects = [...range.getClientRects()].filter(r => r.width > 1 && r.height > 1 && r.bottom > pr.top && r.top < pr.bottom);
  if (!rects.length) return null;
  const c = v => Math.min(1, Math.max(0, v));
  return {x0: c((Math.min(...rects.map(r => r.left)) - pr.left) / pr.width), y0: c((Math.min(...rects.map(r => r.top)) - pr.top) / pr.height),
    x1: c((Math.max(...rects.map(r => r.right)) - pr.left) / pr.width), y1: c((Math.max(...rects.map(r => r.bottom)) - pr.top) / pr.height)};
}
// Where on the page a box is, in words the model can use ("upper right of the page, x 52–94%, y 12–20%").
function describeBox(b) {
  const cx = (b.x0 + b.x1) / 2, cyy = (b.y0 + b.y1) / 2, pct = v => Math.round(v * 100);
  const v = cyy < 0.34 ? 'upper' : cyy > 0.66 ? 'lower' : 'middle', hz = b.x1 - b.x0 > 0.6 ? 'full width' : cx < 0.42 ? 'left' : cx > 0.58 ? 'right' : 'centre';
  return `${v} ${hz} of the page, x ${pct(b.x0)}–${pct(b.x1)}%, y ${pct(b.y0)}–${pct(b.y1)}%`;
}
// Text of the items inside a box, in reading order (it helps the model, but the image is authoritative).
function textInBox(pageNum, b) {
  const el = $(`.pdf-page[data-page="${pageNum}"]`), W = Number(el.dataset.width), H = Number(el.dataset.height);
  const inside = (pageBoxes[pageNum] || []).filter(t => { const x = (t.x0 + t.x1) / 2 / W, y = (t.y0 + t.y1) / 2 / H; return t.s.trim() && x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1; });
  inside.sort((a, c) => Math.abs(a.y0 - c.y0) > 3 ? a.y0 - c.y0 : a.x0 - c.x0);
  return inside.map(t => t.s).join(' ').replace(/\s+/g, ' ').trim().slice(0, 1500);
}

// ---------- references: [n] markers, cards, getting cited papers ----------
// Bibliography and in-text markers from the extracted text (works offline); OpenAlex records are
// matched in later, when the paper's details are known.
function indexReferences() {
  bib = parseBibliography(pages); refHits = {};
  if (!bib.entries.size) return;
  for (const n of Object.keys(pageBoxes).map(Number)) {
    if (bib.start && n > bib.start.page) break;
    const el = $(`.pdf-page[data-page="${n}"]`), W = Number(el.dataset.width), H = Number(el.dataset.height);
    // On the page where the list starts, ignore everything from the heading down.
    const stopY = bib.start && n === bib.start.page ? (pageBoxes[n].find(b => /^\s*(references|bibliography)\s*$/i.test(b.s))?.y0 ?? Infinity) : Infinity;
    for (const b of pageBoxes[n]) {
      if (b.y0 >= stopY) continue;
      for (const m of findMarkers(b.s)) {
        const nums = m.nums.filter(k => bib.entries.has(k)); if (!nums.length) continue;
        const w = b.x1 - b.x0, len = Math.max(1, b.s.length);
        (refHits[n] ??= []).push({nums, box: {x0: (b.x0 + w * m.index / len) / W, x1: (b.x0 + w * (m.index + m.length) / len) / W, y0: b.y0 / H, y1: b.y1 / H}});
      }
    }
  }
}
async function loadReferences() {
  if (!paper?.meta || refsState === 'loading') return;
  const id = paper.id; refsState = 'loading';
  try {
    const r = await api(`/api/papers/${id}/references`);
    if (paper?.id !== id) return;
    refRecords = r.items || []; refByNum = matchEntries(bib.entries, refRecords); refsState = 'ready';
  } catch { if (paper?.id === id) refsState = 'failed'; }
}
const inProject = rec => project?.papers.find(p => p.meta && ((rec.openalexId && p.meta.openalexId === rec.openalexId) || (rec.doi && p.meta.doi === rec.doi)));
const authorsShort = rec => !rec.authors?.length ? '' : rec.authors.slice(0, 3).join(', ') + ((rec.authorCount ?? rec.authors.length) > 3 ? ' et al.' : '');

function hideRefCard() { const c = $('#ref-card'); if (c) { c.hidden = true; c.replaceChildren(); } }
document.addEventListener('mousedown', e => { if (!e.target.closest('#ref-card')) hideRefCard(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') hideRefCard(); });
$('#pdf').addEventListener('scroll', hideRefCard, {passive: true});

function showRefCard(nums, x, y) {
  const card = $('#ref-card');
  card.replaceChildren(...nums.slice(0, 6).map(n => refItem(n, nums.length === 1)));
  if (nums.length > 6) card.append(h('p', {className: 'hint', textContent: `…and ${nums.length - 6} more.`}));
  card.hidden = false;
  const w = card.offsetWidth, ht = card.offsetHeight;
  card.style.left = Math.min(innerWidth - w - 12, Math.max(12, x - w / 2)) + 'px';
  card.style.top = (y + ht + 16 > innerHeight ? Math.max(12, y - ht - 12) : y + 14) + 'px';
}
// One reference: the matched OpenAlex record if there is one, otherwise the bibliography text.
function refItem(n, open) {
  const rec = refByNum.get(n), raw = bib.entries.get(n) || '';
  const item = h('div', {className: 'ref-item'});
  const head = h('div', {className: 'ref-head'}, h('span', {className: 'ref-num', textContent: `[${n}]`}));
  if (!rec) {
    head.append(h('span', {className: 'ref-raw', textContent: raw.slice(0, 260) + (raw.length > 260 ? '…' : '')}));
    item.append(head);
    const status = refsState === 'loading' ? 'Looking up details…' : !paper?.meta ? 'Paper details not found yet (ⓘ Info), so references are not linked.' : 'Not linked to a record automatically.';
    const find = h('button', {className: 'small', textContent: 'Find this paper', onclick: async () => {
      find.disabled = true; find.textContent = 'Searching…';
      try {
        const {items} = await api('/api/works/search', {body: {q: raw.slice(0, 300)}});
        if (!items.length) { find.textContent = 'Nothing found'; return; }
        refByNum.set(n, items[0]); item.replaceWith(refItem(n, true));
      } catch (e) { find.textContent = 'Search failed'; notice(e.message); }
    }});
    item.append(h('div', {className: 'ref-actions'}, h('small', {className: 'hint', textContent: status}), raw.length > 20 ? find : ''));
    return item;
  }
  head.append(h('span', {className: 'ref-title', textContent: rec.title || raw.slice(0, 120)}));
  item.append(head, h('div', {className: 'ref-meta', textContent: [authorsShort(rec), rec.year, rec.venue].filter(Boolean).join(' · ')}));
  if (rec.citedBy != null) item.append(h('div', {className: 'ref-meta', textContent: `Cited by ${rec.citedBy}`}));
  if (open && rec.abstract) item.append(h('p', {className: 'ref-abstract', textContent: rec.abstract.slice(0, 420) + (rec.abstract.length > 420 ? '…' : '')}));
  const have = inProject(rec), actions = h('div', {className: 'ref-actions'});
  if (have) actions.append(h('button', {className: 'small primary', textContent: 'Open in Margin', onclick: () => { hideRefCard(); openPaper(have.id); }}));
  else actions.append(addButton(rec));
  if (rec.doi) actions.append(h('a', {className: 'small-link', href: `https://doi.org/${rec.doi}`, target: '_blank', rel: 'noopener noreferrer', textContent: 'DOI ↗'}));
  item.append(actions);
  return item;
}

// Get a cited paper into the project: open-access copy, then (desktop) the sign-in window,
// then (browser) the publisher page plus drag-and-drop.
// The add button says what will happen: a direct add (open-access copy, or the desktop sign-in window),
// or, in a browser without an open-access copy, opening the publisher page for a manual download.
function addButton(rec, after, compact = false) {
  const direct = !!(rec.pdfUrl || rec.oaUrl || window.marginDesktop);
  return h('button', {className: 'small' + (compact ? '' : ' primary'), textContent: direct ? (compact ? 'Add' : 'Add to project') : (compact ? 'Publisher ↗' : 'Open publisher page ↗'),
    title: rec.pdfUrl || rec.oaUrl ? 'Downloads the open-access copy into this project' : window.marginDesktop ? 'Opens the publisher page in a sign-in window; the PDF is added when it downloads' : 'No open-access copy: opens the publisher page in your browser. Download the PDF there and drag it onto Margin.',
    onclick: async e => { await getPdf(rec, e.target); after?.(); }});
}
let pendingRef = null;
async function getPdf(rec, button) {
  const label = button?.textContent; const busy = t => { if (button) { button.disabled = true; button.textContent = t; } };
  const done = () => { if (button) { button.disabled = false; button.textContent = label; } };
  const added = async (summary, how) => {
    await refreshProject(); refreshProjects(); hideRefCard();
    say(`Added “${(summary.meta?.title || summary.name).slice(0, 80)}” to ${project.name} (${how}). It is in the sidebar.`);
  };
  for (const url of [rec.pdfUrl, rec.oaUrl].filter(Boolean)) {
    busy('Downloading…');
    try { await added(await api(pathP('papers', 'from-url'), {body: {url, openalexId: rec.openalexId, doi: rec.doi}}), 'open-access copy'); return; } catch {}
  }
  const landing = rec.doi ? `https://doi.org/${rec.doi}` : rec.oaUrl || (rec.openalexId ? `https://openalex.org/${rec.openalexId}` : null);
  if (!landing) { done(); say('No link is known for this paper.'); return; }
  if (window.marginDesktop) {
    const url = (session?.proxyPrefix || '') + landing;
    busy('Waiting for sign-in…');
    say('Sign in in the window that opened and download the PDF there; Margin adds it automatically. Close the window to cancel.');
    const r = await window.marginDesktop.fetchWithLogin(url, rec.title || '');
    done();
    if (!r?.ok) { say(r?.reason === 'closed' ? 'Sign-in window closed; nothing was added.' : r?.reason || 'No PDF was downloaded.'); return; }
    try {
      const summary = await api(pathP('papers'), {body: r.bytes, headers: {'Content-Type': 'application/pdf', 'X-Filename': encodeURIComponent(r.filename || 'paper.pdf')}});
      if (!summary.meta) await api(`/api/papers/${summary.id}/metadata`, {body: rec.openalexId ? {openalexId: rec.openalexId} : {doi: rec.doi}}).catch(() => {});
      await added(summary, 'signed-in download');
    } catch (e) { say('Could not add the downloaded PDF: ' + e.message); }
    return;
  }
  done();
  pendingRef = {rec, at: Date.now()};
  window.open(landing, '_blank', 'noopener');
  say('No open-access copy. The publisher page opened in a new tab: download the PDF there, then drag it onto Margin.');
}

// Drag a PDF anywhere onto Margin to add it to the current project.
let dragDepth = 0;
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', e => { if (!hasFiles(e) || !project) return; dragDepth++; $('#drop-zone').hidden = false; });
window.addEventListener('dragleave', e => { if (!hasFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; $('#drop-zone').hidden = true; } });
window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', async e => {
  if (!hasFiles(e)) return;
  e.preventDefault(); dragDepth = 0; $('#drop-zone').hidden = true;
  const file = [...e.dataTransfer.files].find(f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  if (!file || !project || working || loading) { if (!file) say('Only PDF files can be added.'); return; }
  if (file.size > 60 * 1024 * 1024) { say('Choose a PDF smaller than 60 MB.'); return; }
  try {
    const summary = await api(pathP('papers'), {body: new Uint8Array(await file.arrayBuffer()), headers: {'Content-Type': 'application/pdf', 'X-Filename': encodeURIComponent(file.name)}});
    // A PDF dropped soon after "Add to project" is taken to be that reference.
    const ref = pendingRef && Date.now() - pendingRef.at < 30 * 60e3 ? pendingRef.rec : null; pendingRef = null;
    // Only a PDF new to the library takes the reference's details; one already stored keeps its own.
    if (ref && !summary.meta) await api(`/api/papers/${summary.id}/metadata`, {body: ref.openalexId ? {openalexId: ref.openalexId} : {doi: ref.doi}}).catch(() => {});
    await refreshProject(); refreshProjects();
    say(`Added “${file.name}” to ${project.name}. Open it from the sidebar.`);
  } catch (err) { say('Could not add PDF: ' + err.message); }
});

// ---------- citation map ----------
let map = null, mapProject = null;
async function openMap(refresh = false) {
  if (!project) return;
  document.body.classList.add('map-mode'); $('#map-view').hidden = false; hideRefCard(); hidePop();
  $('#map-project').textContent = project.name; $('#map-card').hidden = true;
  if (map && mapProject === project.id && !refresh) { map.fit(0); return; }
  map?.destroy(); map = createMap($('#map-svg'), {onSelect: n => showMapCard(n)}); mapProject = project.id;
  const n = project.papers.length;
  $('#map-status').textContent = n ? `Building the map: fetching references and citing papers for ${n} paper${n === 1 ? '' : 's'}…` : 'Add papers to this project to see how they cite each other.';
  if (!n) return;
  try {
    const g = await api(pathP('graph') + (refresh ? '?refresh=1' : ''));
    if (mapProject !== project.id) return;
    map.setData(g); map.setFilters(readFilters());
    const missing = project.papers.filter(p => !p.meta?.openalexId).length;
    mapCounts(missing ? `${missing} paper${missing === 1 ? ' has' : 's have'} no OpenAlex record yet (set the DOI in ⓘ Info), so ${missing === 1 ? 'it is' : 'they are'} shown unconnected.` : g.failed.length ? `Could not fetch links for: ${g.failed.join(', ')}.` : '');
  } catch (e) { $('#map-status').textContent = e.message; }
}
function closeMap() { document.body.classList.remove('map-mode'); $('#map-view').hidden = true; }
const readFilters = () => ({refs: $('#mf-refs').checked, citing: $('#mf-citing').checked, shared: $('#mf-shared').checked, byYear: $('#mf-year').checked});
function mapCounts(extra = '') {
  const c = map.counts();
  $('#map-status').textContent = `${c.library} in project · ${c.reference + c.both} cited · ${c.citing + c.both} citing · ${c.shared} shared · ${c.edges} links${extra ? ' — ' + extra : ''}`;
}
for (const id of ['#mf-refs', '#mf-citing', '#mf-shared', '#mf-year']) $(id).onchange = () => { if (map) { map.setFilters(readFilters()); mapCounts(); } };
$('#open-map').onclick = () => openMap();
$('#map-back').onclick = closeMap;
$('#map-fit').onclick = () => map?.fit();
$('#map-refresh').onclick = () => openMap(true);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#map-view').hidden && $('#map-card').hidden) closeMap(); else if (e.key === 'Escape') $('#map-card').hidden = true; });

function showMapCard(n) {
  const card = $('#map-card');
  if (!n) { card.hidden = true; return; }
  const have = n.paperId ? project.papers.find(p => p.id === n.paperId) : inProject(n);
  const kindText = {library: 'In this project', reference: 'Cited by your papers', citing: 'Cites your papers', both: 'Cited by and citing your papers'}[n.kind] + (n.degree >= 2 && n.kind !== 'library' ? ` · linked to ${n.degree} of your papers` : '');
  const actions = h('div', {className: 'ref-actions'});
  if (have) actions.append(h('button', {className: 'small primary', textContent: 'Open in Margin', onclick: () => { closeMap(); openPaper(have.id); }}));
  else actions.append(addButton(n, () => { if (inProject(n)) openMap(true); }));
  if (n.id && !n.id.startsWith('local:') && !n.expanded) actions.append(h('button', {className: 'small', textContent: 'Expand', title: 'Show this paper’s own references and citing papers', onclick: async e => {
    e.target.disabled = true; e.target.textContent = 'Loading…';
    try { map.expand(n.id, await api(`/api/works/${n.id}/neighbours`)); mapCounts(); e.target.remove(); } catch (err) { e.target.textContent = 'Failed'; notice(err.message); }
  }}));
  if (n.doi) actions.append(h('a', {className: 'small-link', href: `https://doi.org/${n.doi}`, target: '_blank', rel: 'noopener noreferrer', textContent: 'DOI ↗'}));
  card.replaceChildren(h('button', {className: 'icon map-card-close', textContent: '×', title: 'Close', onclick: () => { card.hidden = true; }}),
    h('small', {className: `map-kind ${n.kind}`, textContent: kindText}),
    h('h3', {textContent: n.title || 'Untitled'}),
    h('div', {className: 'ref-meta', textContent: [authorsShort(n), n.year, n.venue].filter(Boolean).join(' · ')}),
    ...(n.citedBy != null ? [h('div', {className: 'ref-meta', textContent: `Cited by ${n.citedBy}`})] : []),
    ...(n.abstract ? [h('p', {className: 'ref-abstract', textContent: n.abstract.slice(0, 700) + (n.abstract.length > 700 ? '…' : '')})] : n.noRecord ? [h('p', {className: 'hint', textContent: 'No OpenAlex record yet: open the paper and set its DOI in ⓘ Info to connect it.'})] : []),
    actions);
  card.hidden = false;
}

// ---------- marker: drag a box over any area of the page ----------
let marking = false, draft = null, markedAt = 0;
function setMarking(on) {
  marking = on; $('#pdf').classList.toggle('marking', on); $('#marker').classList.toggle('active', on); $('#marker').setAttribute('aria-pressed', on);
  if (on) { hidePop(); notice('Marker: drag a box over the part of the page you want to ask about. Esc cancels.'); }
  if (!on && draft) { draft.div.remove(); draft = null; }
}
$('#marker').onclick = () => setMarking(!marking);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && marking) setMarking(false); });
$('#pdf').addEventListener('pointerdown', e => {
  if (!marking || e.button !== 0) return;
  const el = e.target.closest('.pdf-page'); if (!el) return;
  e.preventDefault();
  const r = el.getBoundingClientRect(), u = (e.clientX - r.left) / r.width, v = (e.clientY - r.top) / r.height;
  draft = {el, u, v, div: h('div', {className: 'marker-box draft'})};
  placeBox(draft.div, {x0: u, y0: v, x1: u, y1: v}); el.append(draft.div);
  $('#pdf').setPointerCapture(e.pointerId);
});
$('#pdf').addEventListener('pointermove', e => {
  if (!draft) return;
  const r = draft.el.getBoundingClientRect(), c = v => Math.min(1, Math.max(0, v));
  const u = c((e.clientX - r.left) / r.width), v = c((e.clientY - r.top) / r.height);
  draft.box = {x0: Math.min(draft.u, u), y0: Math.min(draft.v, v), x1: Math.max(draft.u, u), y1: Math.max(draft.v, v)};
  placeBox(draft.div, draft.box);
});
$('#pdf').addEventListener('pointerup', e => {
  if (!draft) return;
  const {el, box, div} = draft; draft = null; markedAt = Date.now();
  const r = el.getBoundingClientRect();
  if (!box || (box.x1 - box.x0) * r.width < 12 || (box.y1 - box.y0) * r.height < 8) { div.remove(); return; } // a click, not a box
  setMarking(false); div.classList.remove('draft');
  const page = Number(el.dataset.page);
  showPop(e.clientX, e.clientY, 'Ask AI about this area ↗', async () => {
    div.remove();
    setContext({kind: 'region', page, box, where: describeBox(box), text: textInBox(page, box), image: await cropRegion(page, box)});
    notice(`Marked area on PDF page ${page} attached. Ask your question, or press Enter to have it explained.`);
  });
  // If the pop is dismissed without asking, drop the outline too.
  const drop = ev => { if (!ev.target.closest('#pdf-pop')) { div.remove(); document.removeEventListener('mousedown', drop, true); } };
  setTimeout(() => document.addEventListener('mousedown', drop, true), 0);
});
// Keep the attached area outlined on the page while composing.
function showContextMark(c) {
  document.querySelectorAll('.marker-box.attached').forEach(x => x.remove());
  if (!c?.box) return;
  const el = $(`.pdf-page[data-page="${c.page}"]`); if (!el) return;
  const d = h('div', {className: 'marker-box attached', title: 'Attached to your next question'}); placeBox(d, c.box); el.append(d);
}
function setContext(c) {
  context = c;
  const box = $('#context'); box.hidden = !c; box.replaceChildren();
  $('#question').placeholder = !c ? 'What would you like to understand?' : `Ask about this ${c.kind === 'passage' ? 'passage' : c.kind === 'region' ? 'area' : 'equation'}… (or press Enter to have it explained)`;
  showContextMark(c);
  if (!c) return;
  if (c.image) box.append(h('img', {src: c.image, alt: c.kind === 'equation' ? `Eq. (${c.label})` : 'Attached area of the page'}));
  box.append(h('div', {className: 'ctx-info'}, h('small', {textContent: c.kind === 'passage' ? `PASSAGE · PDF PAGE ${c.page}` : c.kind === 'region' ? `MARKED AREA · PDF PAGE ${c.page}` : `EQ. (${c.label}) · PDF PAGE ${c.page}`}), ...(c.text ? [h('span', {textContent: `“${c.text.length > 220 ? c.text.slice(0, 220) + '…' : c.text}”`})] : [])),
    h('button', {type: 'button', className: 'icon del', textContent: '×', title: 'Remove attachment', onclick: () => setContext(null)}));
  controls();
}


// ---------- start ----------
showWelcome(); controls();
try { session = await fetch('/api/status').then(r => r.json()); } catch { notice('Local server unavailable. Restart the app.'); }
showStatus();
if (session) {
  if (!session.configured) notice('Welcome! Open Settings to add your OpenAI API key.');
  await Promise.all([loadModels(), refreshProjects().then(() => renderLibrary()).catch(e => notice(e.message))]);
  if (project?.papers.length && !paper) notice(session.configured ? `Project "${project.name}": pick a paper in the sidebar, or add a PDF.` : 'Open Settings to add your OpenAI API key.');
}
