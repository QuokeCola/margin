import * as pdfjs from 'pdfjs-dist';
import worker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
// KaTeX's stylesheet stays in the main bundle (before style.css, which overrides parts of it);
// its fonts load only when an equation is shown. The Markdown/maths code loads with the first chat.
import 'katex/dist/katex.min.css';
import './style.css';
import './guides.css';
import {parseReferences, resolveReference, TOKEN, tokenRef, findMentions, tagOf, QUOTE, ANCHOR, quoteRef, structuredRefs} from './references.js';
import {paperLabels, resolvePaper, shortId} from '../lib/labels.mjs';
import {textBoxes, detectEquations} from './layout.js';
import {preparePage, locateQuote} from './quote.js';
import {parseBibliography, findMarkers, matchEntries} from './bib.js';
import {clampZoom, wheelZoomFactor, zoomAnchor, pinchStep} from './zoom.js';
import {applyTheme, getThemePref, setThemePref} from './theme.js';
import {KEY_ART, CLAUDE_KEY_ART, EXT_ART} from './guides.js';
import {LABEL, COMPANY, providerOf, connectionText, composeHint, webTitle, searchNote, keyHint, settingsBody, savingText} from './providers.js';
pdfjs.GlobalWorkerOptions.workerSrc = worker;
applyTheme();
let marked, DOMPurify, renderMath, markdownLoading = null;
const loadMarkdown = () => markdownLoading ??= Promise.all([import('marked'), import('dompurify'), import('katex/contrib/auto-render')])
  .then(([m, d, k]) => { marked = m.marked; DOMPurify = d.default; renderMath = k.default; })
  .catch(e => { markdownLoading = null; throw e; });
const idle = (f, timeout = 300) => window.requestIdleCallback ? requestIdleCallback(f, {timeout}) : setTimeout(f, 16);
const $ = s => document.querySelector(s);
const h = (tag, props = {}, ...kids) => { const el = Object.assign(document.createElement(tag), props); el.append(...kids); return el; };

$('#app').innerHTML = `<header><button id="toggle-library" class="icon" title="Show or hide the library" aria-label="Toggle library">☰</button><a class="brand" href="/">m<span>Margin</span></a><span class="subtitle">A little closer to the paper.</span>
<div class="header-tools"><label class="model-picker" title="Model used for new answers">Model <select id="model" disabled><option>…</option></select></label><span id="connection">Connecting…</span><button id="open-settings">Settings</button></div></header>
<main><aside class="library"><div class="project-bar"><div class="project-head"><small>PROJECT</small><button id="manage-projects" class="small" title="All projects: open, rename, delete or create one" aria-haspopup="dialog">Manage</button></div><div class="project-row"><select id="project" aria-label="Project"></select><button id="project-rename" class="icon" title="Rename project" aria-label="Rename project">✎</button><button id="project-delete" class="icon del" title="Delete project" aria-label="Delete project">×</button></div><button id="open-map" class="map-button" title="How the papers in this project cite each other">◎ Citation map</button></div>
<div class="lib-section"><div class="lib-head"><small>PAPERS</small><label class="file-button small">+ Add PDF<input id="file" type="file" accept="application/pdf"></label></div><ul id="papers" aria-label="Papers"></ul></div>
<div class="lib-section"><div class="lib-head"><small>CHATS</small><button id="new-chat-side" class="small" title="New chat: about the open paper, or the whole project">+ New</button></div><ul id="chats" aria-label="Chats"></ul></div></aside>
<section class="chat"><div class="section-head"><div><small id="chat-paper">YOUR STUDY DESK</small><h1 id="chat-title">Read. Question. Understand.</h1></div><button id="new-chat" disabled>New chat</button></div><div id="messages" tabindex="0" aria-label="Conversation"></div><form id="ask"><div id="context" hidden></div><textarea id="question" aria-label="Question about the paper" placeholder="What would you like to understand?" rows="3" maxlength="8000"></textarea><div class="compose-bottom"><span id="compose-hint">Enter to send · Ctrl+Enter for a new line.</span><div class="compose-actions"><button type="button" id="web-toggle" class="web-toggle" aria-pressed="false" title="Let the answer search the web (billed per search). Off by default.">⌕ Web</button><button id="send" type="submit">Ask ↗</button></div></div></form><p id="notice" role="status">Add a PDF, or pick one from the library.</p></section>
<section class="reader"><div class="section-head"><div><small>SOURCE DOCUMENT</small><h2 id="filename">Your paper, in context</h2><p id="paper-byline"></p></div><button id="paper-info" class="small" disabled title="Paper details: authors, venue, DOI, abstract">ⓘ Info</button></div><div class="toolbar"><label><input id="follow" type="checkbox" checked> Follow chat</label><div><label>Page <input id="page" type="number" min="1" value="1"></label><span id="total">/ —</span><button id="go">Go</button></div><button id="marker" title="Marker: drag a box over any part of the page to ask about it (Esc to cancel)" aria-pressed="false">✎ Mark</button><div class="zoom" title="Pinch the trackpad (or Ctrl + scroll) over the page to zoom"><button id="zoom-out" aria-label="Zoom out">−</button><button id="zoom-reset" title="Reset to 100%">100%</button><button id="zoom-in" aria-label="Zoom in">+</button></div></div><div id="pdf"><div class="empty"><div class="paper-icon">∑</div><h2>Make room for the original.</h2><p>Add a PDF from your laptop, or pick a paper from the library.<br>Pinch the trackpad over a page to zoom.</p></div></div><details id="manual"><summary>Find a reference / correct an equation location</summary><div class="manual-grid"><label>Equation <input id="equation" placeholder="61"></label><label>PDF page <input id="map-page" type="number" min="1" value="1"></label><label>Position from top (%) <input id="map-y" type="number" min="0" max="100" value="50"></label><button id="find">Find equation</button><button id="save">Save correction</button><button id="remove">Remove correction</button></div><p>Corrections are saved with this paper in your library. Click the PDF while this panel is open to pick a position. Pages use PDF order, not printed journal numbers.</p></details></section>
<section id="map-view" hidden aria-label="Citation map"><div class="map-bar"><button id="map-back">← Back to reading</button><div class="map-title"><small>CITATION MAP</small><h2 id="map-project"></h2></div>
<div class="map-filters"><label><input type="checkbox" id="mf-refs" checked> <i class="dot k-reference"></i>References</label><label><input type="checkbox" id="mf-citing" checked> <i class="dot k-citing"></i>Citing papers</label><label title="Only papers linked to two or more of your papers"><input type="checkbox" id="mf-shared"> Only shared</label><label><input type="checkbox" id="mf-year"> Arrange by year</label><button id="map-fit" class="small" title="Fit the map to the window">Fit</button><button id="map-refresh" class="small" title="Fetch references and citations again">↻</button></div></div>
<div class="map-body"><svg id="map-svg" role="img" aria-label="Citation graph"></svg><div class="map-legend"><span><i class="dot k-library"></i>In this project</span><span><i class="dot k-reference"></i>Cited by your papers</span><span><i class="dot k-citing"></i>Cites your papers</span><span><i class="dot k-both"></i>Both</span><span class="hint">Arrows point to the cited paper · size = citations · drag to move, scroll to zoom</span></div><p id="map-status" role="status"></p><aside id="map-card" hidden></aside></div></section></main>
<div id="toast" role="status" aria-live="polite" hidden></div>
<div id="ref-card" hidden role="dialog" aria-label="Reference"></div>
<div id="drop-zone" hidden><div>Drop the PDF to add it to the project</div></div>
<div id="pdf-pop" hidden><button type="button" id="pop-ask">Ask AI ↗</button></div>
<div id="new-chat-menu" hidden role="menu" aria-label="New chat"><button type="button" role="menuitem" data-scope="paper"><b>This paper</b><small></small></button><button type="button" role="menuitem" data-scope="project"><b>Whole project</b><small>Searches all papers in this project; answers cite each paper</small></button></div>
<dialog id="ask-text"><form id="ask-text-form"><h2 id="ask-text-title"></h2><label><input id="ask-text-input" autocomplete="off" maxlength="200"></label><div class="dialog-buttons"><button type="button" id="ask-text-cancel">Cancel</button><button type="submit" class="primary">Save</button></div></form></dialog>
<dialog id="info" aria-label="Paper details"><div class="dialog-x-bar"><button type="button" class="dialog-x" data-close aria-label="Close" title="Close (Esc)">×</button></div><div class="info-body"><div id="info-content"></div><div class="info-lookup"><label>DOI<input id="info-doi" placeholder="10.1109/…" autocomplete="off" spellcheck="false"></label><button type="button" id="info-lookup">Look up</button></div><p id="info-msg" role="status"></p><div class="dialog-buttons"><button type="button" id="info-close" class="primary">Close</button></div></div></dialog>
<dialog id="settings" aria-labelledby="settings-title"><form id="settings-form"><div class="dialog-x-bar"><button type="button" class="dialog-x" data-close aria-label="Close" title="Close (Esc)">×</button></div><h2 id="settings-title">Settings</h2>
<div class="provider-choice"><span class="field-label" id="provider-label">AI provider</span><div class="segmented" role="radiogroup" aria-labelledby="provider-label"><label><input type="radio" name="provider" value="openai"><span><b>OpenAI</b><small data-key-status="openai"></small></span></label><label><input type="radio" name="provider" value="anthropic"><span><b>Claude</b><small data-key-status="anthropic"></small></span></label></div>
<p id="search-note" class="hint search-note" hidden><span></span> <button type="button" class="small" id="embed-key-show">Add OpenAI key</button></p><label id="embed-key-row" hidden>OpenAI API key for project search (optional)<input id="embed-key" type="password" autocomplete="off" spellcheck="false" placeholder="sk-…"></label></div>
<div class="provider-pane" data-provider="openai"><label>OpenAI API key<input id="key" type="password" autocomplete="off" spellcheck="false" placeholder="sk-…"></label><p id="key-hint" class="hint"></p><div class="guide">${KEY_ART}<ol class="setup-steps"><li>Sign in at <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer">platform.openai.com/api-keys</a> and click <b>Create new secret key</b>.</li><li>Add credit under Billing if your account has none; answers are billed per use.</li><li>Paste the key above and click <b>Save</b>.</li></ol></div><nav class="openai-links" aria-label="OpenAI account pages"><a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer">Create an API key ↗</a><a href="https://platform.openai.com/usage" target="_blank" rel="noopener noreferrer">Usage ↗</a><a href="https://platform.openai.com/settings/organization/billing/overview" target="_blank" rel="noopener noreferrer">Billing ↗</a></nav></div>
<div class="provider-pane" data-provider="anthropic" hidden><label>Anthropic API key<input id="anthropic-key" type="password" autocomplete="off" spellcheck="false" placeholder="sk-ant-…"></label><p id="anthropic-key-hint" class="hint"></p><div class="guide">${CLAUDE_KEY_ART}<ol class="setup-steps"><li>Sign in at <a href="https://platform.claude.com/settings/keys" target="_blank" rel="noopener noreferrer">platform.claude.com</a> (the Claude Console), open <b>Settings → API keys</b> and click <b>Create Key</b>; copy the key.</li><li>Add credits under <b>Billing</b> if your account has none; answers are billed per use.</li><li>Paste the key above and click <b>Save</b>.</li></ol></div><nav class="openai-links" aria-label="Anthropic account pages"><a href="https://platform.claude.com/settings/keys" target="_blank" rel="noopener noreferrer">Create an API key ↗</a><a href="https://platform.claude.com/usage" target="_blank" rel="noopener noreferrer">Usage ↗</a><a href="https://platform.claude.com/settings/billing" target="_blank" rel="noopener noreferrer">Billing ↗</a></nav></div>
<label>Library proxy prefix (optional)<input id="proxy-prefix" autocomplete="off" spellcheck="false" placeholder="https://proxy.lib.your-university.edu/login?url="></label><p class="hint">Used by “Get PDF” in the desktop app to open papers through your library’s sign-in. Ask your library for its proxy link prefix (EZproxy “login?url=” style).</p>
<div class="ext-box"><b>Browser extension</b><p class="hint" id="ext-status">Lets “Add to project” use your own browser and its logins: the paper opens there and the PDF comes back automatically.</p>
<div class="guide">${EXT_ART}<ol class="setup-steps"><li>In Chrome (or Edge/Brave), open <code>chrome://extensions</code> and turn on <b>Developer mode</b>.</li><li>Click <b>Load unpacked</b> and choose this folder: <code id="ext-folder">…</code> <button type="button" class="small" id="ext-copy-folder">Copy</button></li><li>Click the Margin icon in the toolbar and paste the pairing code: <code id="ext-code">••••••</code> <button type="button" class="small" id="ext-show">Show code</button></li></ol></div></div>
<label><span>Model <span id="settings-provider-name"></span></span><select id="settings-model"></select></label><p id="models-note" class="hint" hidden></p><label>…or type a model ID<input id="custom-model" autocomplete="off" spellcheck="false" placeholder="e.g. gpt-5.2"></label>
<p class="hint">Keys are stored only on this computer, in a file readable only by you, and applied immediately. A new key is checked with its provider before it is saved, and is sent only to that provider.</p>
<label>Theme<select id="theme" title="Applied right away; kept in this app's browser storage"><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
<div class="dialog-buttons"><p id="settings-msg" role="status"></p><button type="button" id="settings-cancel">Cancel</button><button type="submit" id="settings-save" class="primary">Save</button></div></form></dialog>
<dialog id="projects" aria-labelledby="projects-title"><div class="dialog-x-bar"><button type="button" class="dialog-x" data-close aria-label="Close" title="Close (Esc)">×</button></div><h2 id="projects-title">Projects</h2><p class="hint">Each project has its own papers and chats; a paper can be in several projects.</p><ul id="project-list" aria-label="Projects"></ul><p id="projects-msg" role="status"></p><form id="project-new" class="project-new"><input id="project-new-name" maxlength="100" autocomplete="off" placeholder="New project name" aria-label="New project name"><button type="submit" class="primary">+ New project</button></form></dialog>
<dialog id="confirm" aria-labelledby="confirm-title" aria-describedby="confirm-body"><form id="confirm-form" method="dialog"><h2 id="confirm-title"></h2><div id="confirm-body"></div><div class="dialog-buttons"><button type="button" id="confirm-cancel">Cancel</button><button type="submit" id="confirm-ok" class="danger"></button></div></form></dialog>`;

let session = null, models = [], projects = [], project = null, paper = null, chat = null; // project: {id, name, papers, chats}
let doc = null, pages = [], index = {}, overrides = {};
let pageBoxes = {}, eqByPage = {}, quotePages = {}, context = null; // quotePages: pages prepared for quote search
let bib = {start: null, entries: new Map()}, refHits = {}, refRecords = [], refByNum = new Map(), refsState = 'idle'; // references of the open paper // text-item geometry and detected equations per page; pending attachment
let working = false, loading = false, generation = 0, activeRef = null, renderQueue = Promise.resolve();
let chatShown = 0; // which showChat/showWelcome is current (older messages are added in the background)
let webSearch = false; // per launch: answers may use the provider's web search when switched on
const isProjectChat = c => c?.scope === 'project';
let zoom = 1;
try { zoom = clampZoom(Number(localStorage.getItem('margin-zoom')) || 1); } catch {}
// Short message that stays visible in every view (the status line is hidden while the map is open).
// An optional action ({label, run}) adds a button to the toast; clicking it runs the action and hides the toast.
let toastTimer;
function toast(t, ms = 6000, action = null) {
  const el = $('#toast'); el.textContent = t; el.hidden = false; el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
  if (action) el.append(h('button', {type: 'button', className: 'toast-action', textContent: action.label, onclick: () => { el.hidden = true; clearTimeout(toastTimer); action.run(); }}));
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}
const say = t => { notice(t); toast(t); };
const notice = t => { const el = $('#notice'); if (el.textContent === t) return; el.textContent = t; el.style.animation = 'none'; void el.offsetWidth; el.style.animation = ''; };

// ---------- server ----------
// This window's id, sent with every request: the server names it in change events (GET /api/events) it causes,
// so the window leaves events about its own changes to the code that made them.
const CLIENT_ID = (() => { try { return crypto.randomUUID().replace(/-/g, ''); } catch { return Math.random().toString(36).slice(2) + Date.now().toString(36); } })();
async function api(path, opts = {}) {
  const headers = {'X-Session-Token': session?.token || '', 'X-Margin-Client': CLIENT_ID, ...opts.headers};
  let body = opts.body;
  if (body !== undefined && !(body instanceof Uint8Array)) { body = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
  const r = await fetch(path, {method: opts.method || (body ? 'POST' : 'GET'), headers, body});
  if (opts.binary) { if (!r.ok) throw Error(`Could not load the PDF (${r.status}).`); return new Uint8Array(await r.arrayBuffer()); }
  const data = r.status === 204 ? null : await r.json().catch(() => ({}));
  if (!r.ok) throw Error(data?.error || `Request failed (${r.status}).`);
  return data;
}

function controls() {
  $('#send').disabled = !chat || (!doc && !isProjectChat(chat)) || working || loading;
  $('#file').disabled = working || loading;
  $('#new-chat').disabled = !project || working || loading;
  for (const id of ['#papers', '#chats']) $(id).classList.toggle('locked', working || loading);
  $('#project').disabled = working || loading; $('#new-chat-side').disabled = !project || working || loading;
}

// ---------- settings & models ----------
// Model lists per provider: {models, fallback?, error?}. fallback: the server could not load Anthropic's
// list and sent Margin's suggested Claude models instead.
const modelLists = {};
function modelOptions(p, current) {
  const list = modelLists[p], ids = [...new Set([current, ...(list?.models || [])].filter(Boolean))];
  const opts = ids.map(id => h('option', {value: id, textContent: id, selected: id === current}));
  return list?.fallback ? [h('optgroup', {label: 'Suggested (list unavailable)'}, ...opts)] : opts;
}
const keyWanted = () => session?.providers && !Object.values(session.providers).some(x => x.configured) ? 'an OpenAI or Anthropic API key' : `your ${COMPANY[providerOf(session)]} API key`;
function showStatus() {
  const p = providerOf(session), el = $('#connection');
  el.textContent = connectionText(session);
  el.className = session?.configured ? 'ok' : 'warn';
  el.title = session ? `Answers come from ${COMPANY[p]}. Choose the provider in Settings.` : '';
  const sel = $('#model');
  sel.replaceChildren(...modelOptions(p, session?.model));
  sel.title = modelLists[p]?.fallback ? `Model used for new answers. ${COMPANY[p]}'s model list could not be loaded; these are suggested models.` : 'Model used for new answers';
  sel.disabled = !session?.configured || working;
  $('#web-toggle').title = webTitle(session);
  $('#compose-hint').textContent = composeHint(session, isProjectChat(chat));
}
async function fetchModels(p) {
  delete modelLists[p];
  if (!session?.providers?.[p]?.configured && !(p === providerOf(session) && session?.configured)) return;
  const r = await api(`/api/models?provider=${p}`);
  modelLists[p] = {models: r.models, fallback: !!r.fallback};
}
async function loadModels() {
  try { await fetchModels(providerOf(session)); } catch (e) { notice(e.message + ' You can still type a model ID in Settings.'); }
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
// Settings shows the key field, guide and models of the provider chosen there; it becomes the
// app's provider on Save.
let settingsProvider = 'openai';
function showSettingsProvider(p) {
  settingsProvider = p;
  for (const r of document.querySelectorAll('#settings input[name=provider]')) r.checked = r.value === p;
  for (const pane of document.querySelectorAll('#settings .provider-pane')) pane.hidden = pane.dataset.provider !== p;
  for (const el of document.querySelectorAll('#settings [data-key-status]')) {
    const s = session?.providers?.[el.dataset.keyStatus];
    el.textContent = s?.configured ? `key saved · ${s.keyHint}` : 'no key';
    el.classList.toggle('saved', !!s?.configured);
  }
  const note = searchNote(p, session), noteEl = $('#search-note');
  noteEl.hidden = !note;
  if (note) { noteEl.querySelector('span').textContent = note.text; noteEl.className = 'hint search-note ' + note.kind; }
  if (note?.kind !== 'keywords') $('#embed-key-row').hidden = true; // a typed key stays in the field
  $('#embed-key-show').hidden = note?.kind !== 'keywords' || !$('#embed-key-row').hidden;
  $('#settings-provider-name').textContent = `(${LABEL[p]})`;
  $('#custom-model').placeholder = p === 'anthropic' ? 'e.g. claude-sonnet-5-5' : 'e.g. gpt-5.2';
  renderSettingsModels();
  if (!modelLists[p] && session?.providers?.[p]?.configured)
    fetchModels(p).catch(e => { modelLists[p] = {models: [], error: e.message}; }).then(() => { if (settingsProvider === p) renderSettingsModels(); });
}
function renderSettingsModels() {
  const p = settingsProvider, list = modelLists[p], has = !!session?.providers?.[p]?.configured;
  $('#settings-model').replaceChildren(...modelOptions(p, session?.providers?.[p]?.model));
  const note = $('#models-note');
  note.textContent = !has ? `Save ${p === 'anthropic' ? 'an Anthropic' : 'an OpenAI'} key to list its models.`
    : list?.error ? `${list.error} You can still type a model ID.`
    : list?.fallback ? `${COMPANY[p]}'s model list could not be loaded; these are suggested models. You can also type a model ID.` : '';
  note.hidden = !note.textContent;
}
$('#open-settings').onclick = () => {
  for (const id of ['#key', '#anthropic-key', '#embed-key', '#custom-model']) $(id).value = '';
  $('#embed-key-row').hidden = true;
  $('#settings-msg').textContent = ''; $('#proxy-prefix').value = session?.proxyPrefix || '';
  $('#key-hint').textContent = keyHint(session, 'openai');
  $('#anthropic-key-hint').textContent = keyHint(session, 'anthropic');
  showSettingsProvider(providerOf(session));
  $('#theme').value = getThemePref();
  $('#settings').showModal(); $(settingsProvider === 'anthropic' ? '#anthropic-key' : '#key').focus();
  api('/api/extension').then(x => {
    $('#ext-folder').textContent = x.folder; $('#ext-code').textContent = x.paired ? '••••••' : '(not created yet)';
    $('#ext-status').textContent = x.lastSeen ? `Extension connected (last contact ${fmtDate(x.lastSeen)}). “Add to project” opens papers in your browser.` : x.paired ? 'Paired, but the extension has not contacted Margin since it started. Open any web page in your browser to wake it.' : 'Lets “Add to project” use your own browser and its logins: the paper opens there and the PDF comes back automatically.';
  }).catch(() => {});
};
for (const r of document.querySelectorAll('#settings input[name=provider]')) r.onchange = () => { $('#settings-msg').textContent = ''; $('#custom-model').value = ''; showSettingsProvider(r.value); };
$('#embed-key-show').onclick = e => { $('#embed-key-row').hidden = false; e.currentTarget.hidden = true; $('#embed-key').focus(); };
$('#settings-cancel').onclick = () => $('#settings').close();
$('#theme').onchange = e => setThemePref(e.target.value);
$('#ext-show').onclick = async () => { try { const {code} = await api('/api/extension/pairing', {body: {}}); $('#ext-code').textContent = code; navigator.clipboard?.writeText(code).then(() => toast('Pairing code copied.')).catch(() => {}); } catch (e) { toast(e.message); } };
$('#ext-copy-folder').onclick = () => navigator.clipboard?.writeText($('#ext-folder').textContent).then(() => toast('Folder path copied.')).catch(() => {});
$('#settings-form').onsubmit = async e => {
  e.preventDefault();
  const p = settingsProvider;
  // The OpenAI key comes from its own field, or from the optional project-search field shown with Claude.
  const keys = {openai: $('#key').value.trim() || $('#embed-key').value.trim(), anthropic: $('#anthropic-key').value.trim()};
  const body = settingsBody({status: session, selected: p, keys, model: $('#custom-model').value.trim() || $('#settings-model').value, proxyPrefix: $('#proxy-prefix').value.trim()});
  if (!body) { $('#settings').close(); return; }
  $('#settings-save').disabled = true; $('#settings-msg').textContent = savingText(body);
  try {
    const hadKey = session?.configured;
    await saveSettings(body);
    for (const id of ['#key', '#anthropic-key', '#embed-key']) $(id).value = '';
    $('#settings').close();
    const saved = [body.apiKey && 'OpenAI', body.anthropicKey && 'Anthropic'].filter(Boolean);
    notice(body.provider ? `Answers now come from ${LABEL[p]} (${session.model}).` : saved.length ? `${saved.join(' and ')} API key${saved.length > 1 ? 's' : ''} saved.` : body.openaiModel || body.anthropicModel ? `Model set to ${session.model}.` : 'Settings saved.');
    if (body.apiKey) delete modelLists.openai;
    if (body.anthropicKey) delete modelLists.anthropic;
    if (body.apiKey || body.anthropicKey || body.provider || !hadKey) await loadModels();
  } catch (err) {
    $('#settings-msg').textContent = err.message;
    // A rejected key, or a provider chosen without one: put the cursor where the key goes.
    if (/key/i.test(err.message)) $(/OpenAI/.test(err.message) && p === 'anthropic' ? '#embed-key' : p === 'anthropic' ? '#anthropic-key' : '#key').focus();
  } finally { $('#settings-save').disabled = false; }
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
  if ($('#projects').open) renderProjectPanel();
}
async function loadProject(pid, render = true) {
  project = await api(`/api/projects/${pid}`);
  try { localStorage.setItem('margin-project', pid); } catch {}
  announceProject();
  if (render) renderLibrary();
}
// Tell the server which project this window shows: the extension's "Send this page's PDF" adds to it.
function announceProject() { if (project && session) api('/api/active-project', {body: {projectId: project.id}}).catch(() => {}); }
window.addEventListener('focus', announceProject);
// Reload the open project; when its papers changed, the citation map is rebuilt (now if it is open).
async function refreshProject() {
  if (!project) return;
  const before = project.papers.map(p => p.id).sort().join(',');
  project = await api(pathP()); renderLibrary();
  if (project.papers.map(p => p.id).sort().join(',') !== before && mapProject === project.id) {
    mapStale = true;
    if (!$('#map-view').hidden) openMap();
  }
}
$('#project').onchange = async e => {
  const v = e.target.value;
  if (v === '__new') {
    renderProjects();
    const name = await askText('New project', ''); if (!name?.trim()) return;
    try { const p = await api('/api/projects', {body: {name}}); await closePaper(); await loadProject(p.id); await refreshProjects(); notice(`Project "${p.name}" created. Add PDFs to it.`); } catch (err) { notice(err.message); }
    return;
  }
  if (working) { renderProjects(); return; }
  await switchProject(v);
};
async function switchProject(pid) {
  closeMap(); await closePaper(); await loadProject(pid); renderProjects();
  notice(`Project "${project.name}": ${project.papers.length ? 'pick a paper in the sidebar, or add a PDF.' : 'add a PDF to start.'}`);
}
$('#project-rename').onclick = async () => {
  const name = await askText('Rename project', project.name); if (!name?.trim()) return;
  try { await api(pathP(), {method: 'PATCH', body: {name}}); await refreshProjects(); await refreshProject(); } catch (e) { notice(e.message); }
};
$('#project-delete').onclick = () => project && deleteProject(project.id);

// In-app confirmation (window.confirm is not used in the app); resolves true when confirmed.
// body: paragraphs, each a string or element props; Cancel has the focus, Esc cancels.
function confirmBox({title, body, ok}) {
  const d = $('#confirm');
  $('#confirm-title').textContent = title;
  $('#confirm-body').replaceChildren(...body.filter(Boolean).map(t => h('p', typeof t === 'string' ? {textContent: t} : t)));
  $('#confirm-ok').textContent = ok;
  d.showModal(); $('#confirm-cancel').focus();
  return new Promise(resolve => {
    const done = v => { if (d.open) d.close(); $('#confirm-form').onsubmit = $('#confirm-cancel').onclick = d.oncancel = null; resolve(v); };
    $('#confirm-form').onsubmit = e => { e.preventDefault(); done(true); };
    $('#confirm-cancel').onclick = () => done(false);
    d.oncancel = () => done(false);
  });
}
const plural = (k, word) => `${k} ${word}${k === 1 ? '' : 's'}`;
// Deleting a project (server: DELETE /api/projects/:pid) removes its chats; each of its papers stays
// in the other projects that contain it, and papers in no other project are deleted from the store
// (store.dropOrphans: the paper folder with its PDF, details and corrections). The last project cannot be deleted.
async function deleteProject(id) {
  if (projects.length <= 1) { notice('Keep at least one project: create another one before deleting this one.'); return false; }
  const isOpen = id === project?.id;
  if (isOpen && (working || loading)) { notice('Wait for the current answer to finish before deleting the open project.'); return false; }
  let target, others;
  try { [target, ...others] = await Promise.all([id, ...projects.filter(x => x.id !== id).map(x => x.id)].map(pid => api(`/api/projects/${pid}`))); }
  catch (e) { notice(e.message); return false; }
  const elsewhere = new Set(others.flatMap(x => x.papers.map(p => p.id)));
  const shared = target.papers.filter(p => elsewhere.has(p.id)).length, only = target.papers.length - shared;
  const ok = await confirmBox({title: `Delete “${target.name}”?`, ok: 'Delete project', body: [
    target.chats.length ? `Its ${plural(target.chats.length, 'chat')} will be deleted.` : 'It has no chats.',
    !target.papers.length ? 'It has no papers.' : null,
    only ? `${plural(only, 'paper')} ${only === 1 ? 'is' : 'are'} in no other project and will be removed from your library (stored PDF, paper details and equation corrections).` : null,
    shared ? `${plural(shared, 'paper')} ${shared === 1 ? 'is' : 'are'} also in other projects and stay${shared === 1 ? 's' : ''} there, with ${shared === 1 ? 'its' : 'their'} chats in those projects.` : null,
    {className: 'hint', textContent: (isOpen ? 'This is the open project; Margin will switch to another one. ' : '') + 'This cannot be undone.'}]});
  if (!ok) return false;
  try {
    await api(`/api/projects/${id}`, {method: 'DELETE'});
    if (isOpen) { closeMap(); await closePaper(); project = null; }
    await refreshProjects(); if (isOpen) renderLibrary();
    notice(`Project “${target.name}” deleted.${isOpen && project ? ` Now showing “${project.name}”.` : ''}`);
    return true;
  } catch (e) { notice(e.message); return false; }
}

// ---------- projects panel (sidebar → Manage) ----------
let renamingProject = null;
const labelled = (el, label) => { el.setAttribute('aria-label', label); return el; };
function renderProjectPanel() {
  const last = projects.length <= 1;
  $('#project-list').replaceChildren(...projects.map(x => {
    const current = x.id === project?.id;
    const li = h('li', {className: 'pj' + (current ? ' current' : '')});
    li.dataset.id = x.id;
    if (renamingProject === x.id) {
      const input = labelled(h('input', {value: x.name, maxLength: 100, autocomplete: 'off'}), `New name for project ${x.name}`);
      const cancel = () => { renamingProject = null; renderProjectPanel(); focusProjectRow(x.id, '.pj-rename-btn'); };
      const save = async () => {
        const name = input.value.trim(); if (!name || name === x.name) return cancel();
        try { await api(`/api/projects/${x.id}`, {method: 'PATCH', body: {name}}); renamingProject = null; await refreshProjects(); if (current) await refreshProject(); $('#projects-msg').textContent = ''; focusProjectRow(x.id, '.pj-rename-btn'); }
        catch (e) { $('#projects-msg').textContent = e.message; }
      };
      input.onkeydown = e => {
        if (e.key === 'Enter') { e.preventDefault(); save(); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); } // keep the panel open
      };
      li.append(h('div', {className: 'pj-main pj-rename'}, input), h('div', {className: 'pj-actions'},
        h('button', {type: 'button', className: 'small primary', textContent: 'Save', onclick: save}),
        h('button', {type: 'button', className: 'small', textContent: 'Cancel', onclick: cancel})));
      queueMicrotask(() => { input.focus(); input.select(); });
      return li;
    }
    const name = h('span', {className: 'pj-name', title: x.name}, x.name);
    if (current) name.append(h('span', {className: 'pj-badge', textContent: 'OPEN'}));
    li.append(h('div', {className: 'pj-main'}, name, h('span', {className: 'pj-meta', textContent: `${plural(x.papers, 'paper')} · ${plural(x.chats, 'chat')} · updated ${fmtDate(x.updatedAt)}`})),
      h('div', {className: 'pj-actions'},
        labelled(h('button', {type: 'button', className: 'small pj-open', textContent: current ? 'Open now' : 'Open', disabled: current, onclick: () => openFromPanel(x.id)}), current ? `${x.name} is open` : `Open project ${x.name}`),
        labelled(h('button', {type: 'button', className: 'small pj-rename-btn', textContent: 'Rename', onclick: () => { renamingProject = x.id; $('#projects-msg').textContent = ''; renderProjectPanel(); }}), `Rename project ${x.name}`),
        labelled(h('button', {type: 'button', className: 'small del-btn', textContent: 'Delete', disabled: last, title: last ? 'The last project cannot be deleted; create another one first.' : '', onclick: () => deleteFromPanel(x.id)}), `Delete project ${x.name}`)));
    return li;
  }));
}
function focusProjectRow(id, sel) { (document.querySelector(`#project-list li[data-id="${id}"] ${sel}`) || $('#project-new-name')).focus(); }
async function openFromPanel(id) {
  if (working) { $('#projects-msg').textContent = 'Wait for the current answer to finish before switching projects.'; return; }
  $('#projects').close(); await switchProject(id);
}
async function deleteFromPanel(id) {
  const i = projects.findIndex(x => x.id === id);
  if (await deleteProject(id)) { renderProjectPanel(); const next = projects[Math.min(i, projects.length - 1)]; if (next) focusProjectRow(next.id, '.pj-rename-btn'); }
}
$('#manage-projects').onclick = async () => {
  renamingProject = null; $('#projects-msg').textContent = ''; $('#project-new-name').value = '';
  try { projects = await api('/api/projects'); } catch {}
  renderProjectPanel(); $('#projects').showModal();
};
$('#project-new').onsubmit = async e => {
  e.preventDefault();
  const name = $('#project-new-name').value.trim();
  if (!name) { $('#projects-msg').textContent = 'Type a name for the new project.'; $('#project-new-name').focus(); return; }
  try {
    const p = await api('/api/projects', {body: {name}});
    $('#project-new-name').value = '';
    if (working) { await refreshProjects(); $('#projects-msg').textContent = `Created “${p.name}”; open it when the current answer has finished.`; return; }
    $('#projects').close(); closeMap(); await closePaper(); await loadProject(p.id); await refreshProjects();
    notice(`Project "${p.name}" created. Add PDFs to it.`);
  } catch (err) { $('#projects-msg').textContent = err.message; }
};
// The × in the corner of a dialog closes it (like its Close/Cancel button; Esc does the same).
document.addEventListener('click', e => { const x = e.target.closest?.('.dialog-x'); if (x) x.closest('dialog')?.close(); });

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
  chatsEl.replaceChildren(...(project.chats.length ? project.chats.map(c => h('li', {className: (c.id === chat?.id ? 'active' : '') + (isProjectChat(c) ? ' project-chat' : '')},
    h('button', {className: 'chat-name', title: (isProjectChat(c) ? 'About all papers of this project' : `About “${titles[c.paperId] || 'a removed paper'}”`) + '\nDouble-click to rename', onclick: () => c.id !== chat?.id && selectChat(c), ondblclick: () => renameChat(c)},
      h('span', {textContent: c.title}), h('small', {textContent: `${isProjectChat(c) ? '◎ Whole project' : (titles[c.paperId] || 'Removed paper').slice(0, 28)} · ${fmtDate(c.updatedAt)}`})),
    h('button', {className: 'icon del', textContent: '×', title: 'Delete this chat', onclick: () => deleteChat(c)}))) : [h('li', {className: 'library-empty', textContent: 'No chats yet.'})]));
  $('#new-chat-side').disabled = !project || working || loading;
}
async function renamePaper(p) {
  const name = await askText('Rename paper', paperTitle(p)); if (!name?.trim()) return;
  try { const r = await api(`/api/papers/${p.id}`, {method: 'PATCH', body: {name}}); if (paper?.id === p.id) Object.assign(paper, {name: r.name, renamed: true}); await refreshProject(); showPaperHeader(); } catch (e) { notice(e.message); }
}
async function removePaper(p) {
  const n = project.chats.filter(c => c.paperId === p.id).length;
  if (!confirm(`Remove "${paperTitle(p)}" from "${project.name}"${n ? ` and delete its ${n} chat${n === 1 ? '' : 's'} here` : ''}? If no other project uses it, the stored PDF is deleted too.`)) return;
  try { await api(pathP('papers', p.id), {method: 'DELETE'}); if (paper?.id === p.id) await closePaper({keepChat: isProjectChat(chat)}); await refreshProject(); refreshProjects(); notice('Paper removed from the project.'); } catch (e) { notice(e.message); }
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
    if (chat?.id === c.id) {
      const next = paper && project.chats.find(x => !isProjectChat(x) && x.paperId === paper.id);
      if (next) await selectChat(next); else if (paper) await newChat(); else { chat = null; showWelcome(); controls(); }
    }
    renderLibrary();
  } catch (e) { notice(e.message); }
}
// A new chat about the open paper (scope 'paper') or about all papers of the project (scope 'project').
async function newChat(scope = 'paper') {
  if (!project || working || (scope === 'paper' && !paper)) return;
  try {
    const c = await api(pathP('chats'), {body: scope === 'project' ? {scope} : {paperId: paper.id}});
    project.chats.unshift({id: c.id, title: c.title, scope: c.scope, paperId: c.paperId, createdAt: c.createdAt, updatedAt: c.updatedAt, count: 0});
    showChat(c); $('#question').focus();
  } catch (e) { notice(e.message); }
}
// Selecting a chat about another paper opens that paper; a project chat keeps whatever paper is open.
async function selectChat(c) {
  if (working) return;
  if (!isProjectChat(c) && c.paperId && c.paperId !== paper?.id) { await openPaper(c.paperId, null, c.id); return; }
  try { showChat(await api(pathP('chats', c.id))); } catch (e) { notice(e.message); }
}
function showChat(c) {
  chat = c; activeRef = null;
  $('#chat-title').textContent = c.title;
  $('#messages').replaceChildren();
  const whole = isProjectChat(c);
  $('#compose-hint').textContent = composeHint(session, whole);
  showPaperHeader();
  if (!c.messages.length) $('#messages').append(h('div', {className: 'chat-empty'},
    h('p', {textContent: whole ? `Ask across all ${project.papers.length} paper${project.papers.length === 1 ? '' : 's'} of “${project.name}”. Margin searches them for the passages that matter; each citation names its paper, and selecting it opens that paper at the passage.` : 'Ask anything about this paper. Answers cite PDF pages and equations; select a citation to bring the source into view.'}),
    h('button', {className: 'suggestion', textContent: whole ? 'Compare the main contributions and assumptions of these papers.' : 'Summarize the main contributions of this paper.', onclick: e => { $('#question').value = e.target.textContent; $('#question').focus(); }})));
  const token = ++chatShown;
  if (c.messages.length) showMessages(c, token);
  renderLibrary(); controls();
}
// Long chats: the newest messages are rendered first and the chat scrolled to the end as before;
// older ones are added above in idle time, keeping the visible part in place.
const FIRST_MESSAGES = 6, FIRST_CHARS = 8000;
async function showMessages(c, token) {
  if (!marked) {
    try { await loadMarkdown(); } catch (e) { notice('Could not load the chat view: ' + e.message); return; }
    if (token !== chatShown) return;
  }
  const box = $('#messages'), msgs = c.messages, first = [];
  let i = msgs.length, chars = 0;
  while (i > 0 && (first.length < 2 || (first.length < FIRST_MESSAGES && chars < FIRST_CHARS))) { const m = msgs[--i]; chars += m.content.length; first.unshift(buildMessage(m.role, m.content, m, false)); }
  box.append(...first);
  box.scrollTop = box.scrollHeight;
  if (!i) return;
  // Start once the scroll to the end has finished (scroll-behavior is smooth).
  await new Promise(res => { const t = setTimeout(res, 1000); box.addEventListener('scrollend', () => { clearTimeout(t); res(); }, {once: true}); if (box.scrollTop + box.clientHeight >= box.scrollHeight - 1) { clearTimeout(t); res(); } });
  const step = deadline => {
    if (token !== chatShown) return;
    const items = [], t0 = performance.now();
    do { const m = msgs[--i], el = buildMessage(m.role, m.content, m, false); el.classList.add('lazy'); items.unshift(el); }
    while (i > 0 && (deadline && !deadline.didTimeout ? deadline.timeRemaining() > 4 : performance.now() - t0 < 8));
    const fromEnd = box.scrollHeight - box.scrollTop; // the content below the top edge stays where it is
    box.style.overflowAnchor = 'none';
    box.prepend(...items);
    box.scrollTo({top: box.scrollHeight - fromEnd, behavior: 'instant'});
    box.style.overflowAnchor = '';
    if (i > 0) idle(step);
  };
  idle(step);
}
$('#new-chat-side').onclick = e => openChatMenu(e.currentTarget);

// ---------- paper details (OpenAlex / Crossref) ----------
function showPaperHeader() {
  const t = paper ? paperTitle(paper) : 'Your paper, in context';
  $('#filename').textContent = t; $('#filename').title = t;
  $('#paper-byline').textContent = paper?.meta ? byline(paper.meta) : '';
  $('#chat-paper').textContent = isProjectChat(chat) && project ? `WHOLE PROJECT · ${project.name.toUpperCase()}` : paper ? t.toUpperCase() : 'YOUR STUDY DESK';
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
  chatShown++; // stop adding older messages of a chat that was on screen
  $('#messages').replaceChildren(h('div', {className: 'welcome', innerHTML: `<span class="eyebrow">ROBOTICS / PAPER COMPANION</span><h2>Follow the reasoning.<br>Keep the source in sight.</h2><p>Study papers with the original equations beside every explanation. Papers are grouped into projects, each with its own chats.</p><div class="steps"><p><b>01</b> Add a PDF to the project, or pick one in the sidebar.</p><p><b>02</b> Ask a question; start more chats any time.</p><p><b>03</b> Select a citation, or scroll the chat to follow it.</p></div>`}));
  $('#chat-title').textContent = 'Read. Question. Understand.'; showPaperHeader();
}

// ---------- PDF ----------
// pdf.js 6 frees a document through its loading task; never let cleanup block opening the next paper.
async function destroyDoc() {
  const d = doc; doc = null;
  try { await d?.loadingTask?.destroy(); } catch (e) { console.warn('PDF cleanup failed', e); }
}
// keepChat: a project chat stays on screen while another paper opens (e.g. from one of its citations).
async function closePaper({keepChat = false} = {}) {
  generation++;
  await renderQueue.catch(() => {});
  await destroyDoc();
  if (!keepChat) chat = null;
  doc = null; paper = null; pages = []; index = {}; overrides = {}; activeRef = null; pageBoxes = {}; eqByPage = {}; quotePages = {}; setContext(null); hidePop(); setMarking(false); hideRefCard();
  bib = {start: null, entries: new Map()}; refHits = {}; refRecords = []; refByNum = new Map(); refsState = 'idle';
  endPinch(false); pageObserver.disconnect(); nearPages.clear();
  $('#pdf').replaceChildren(h('div', {className: 'empty', innerHTML: '<div class="paper-icon">∑</div><h2>Make room for the original.</h2><p>Add a PDF from your laptop, or pick a paper from the library.</p>'}));
  $('#total').textContent = '/ —';
  if (keepChat && chat) showPaperHeader(); else showWelcome();
  controls(); renderLibrary();
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

async function openPaper(id, bytes, chatId, {keepChat = isProjectChat(chat) && !chatId} = {}) {
  if (working || loading) return;
  loading = true; controls();
  try {
    await closePaper({keepChat});
    loading = true; controls();
    const gen = generation;
    notice('Opening paper…');
    loadMarkdown().catch(() => {}); // its chat follows; have the Markdown/maths code ready
    const meta = await api(`/api/papers/${id}`);
    bytes ??= await api(`/api/papers/${id}/pdf`, {binary: true});
    paper = meta; overrides = meta.overrides || {};
    // One-time move of corrections that older versions kept in browser storage.
    if (!Object.keys(overrides).length) try {
      const old = JSON.parse(localStorage.getItem('margin-' + id) || '{}');
      if (Object.keys(old).length) { overrides = (await api(`/api/papers/${id}`, {method: 'PATCH', body: {overrides: old}})).overrides; localStorage.removeItem('margin-' + id); }
    } catch {}
    showPaperHeader(); renderLibrary();
    $('#pdf').replaceChildren(h('div', {id: 'pages'})); // the page column (scaled as a whole during a pinch)
    doc = await pdfjs.getDocument({data: bytes, wasmUrl: new URL('pdfjs-wasm/', location.href).href}).promise;
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
      $('#pages').append(el); pageObserver.observe(el);
    }
    const mine = project.chats.filter(c => !isProjectChat(c) && c.paperId === id), pick = mine.find(c => c.id === chatId) || mine[0];
    if (keepChat && chat) showPaperHeader();
    else if (pick) showChat(await api(pathP('chats', pick.id))); else { loading = false; await newChat(); }
    notice(`Ready · ${pages.length} pages · ${Object.keys(index).length} detected equations. ${pages.every(p => !p.text.trim()) ? 'No text detected: OCR this PDF before asking questions.' : ''}`);
    indexReferences(); if (paper.meta) loadReferences(); else maybeLookup();
  } catch (err) { await destroyDoc(); notice('Could not open PDF: ' + err.message); }
  finally { loading = false; controls(); renderLibrary(); }
}

// ---------- rendering & zoom ----------
function sizePage(el) { el.style.width = Number(el.dataset.width) * zoom + 'px'; el.style.height = Number(el.dataset.height) * zoom + 'px'; el.style.setProperty('--total-scale-factor', zoom); }
const MAX_CANVAS_PIXELS = 12e6; // keeps a single page bitmap under ~48 MB at high zoom
// Pages within 800 px of the view are rendered; the others are freed. A page that leaves that band
// while it waits in the render queue is skipped, and one that leaves while rendering is dropped,
// so fast scrolling and long smooth jumps do not leave far pages rendered.
const nearPages = new Set();
const freePage = el => { el.querySelector('canvas')?.remove(); el.querySelector('.textLayer')?.remove(); delete el.dataset.rendered; };
const pageObserver = new IntersectionObserver(entries => entries.forEach(e => {
  if (e.isIntersecting) { nearPages.add(e.target); queueRender(e.target); }
  else { nearPages.delete(e.target); freePage(e.target); } // free far-away pages
}), {root: $('#pdf'), rootMargin: '800px'});
// force: render even if the page is not (yet) near the view, e.g. a citation's page before jumping to it.
function queueRender(el, force = false) {
  const gen = generation;
  renderQueue = renderQueue.catch(() => {}).then(async () => {
    if (gen !== generation || !doc || Number(el.dataset.rendered) === zoom) return;
    if (!force && !nearPages.has(el)) return;
    const z = zoom, page = await doc.getPage(Number(el.dataset.page)), base = page.getViewport({scale: 1});
    const ratio = Math.min(devicePixelRatio || 1, 2, Math.sqrt(MAX_CANVAS_PIXELS / (base.width * base.height * z * z)));
    const vp = page.getViewport({scale: z * ratio});
    const canvas = h('canvas', {width: Math.floor(vp.width), height: Math.floor(vp.height)});
    await page.render({canvasContext: canvas.getContext('2d'), viewport: vp}).promise;
    if (gen !== generation || (!force && !nearPages.has(el))) return;
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
  endPinch();
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
  rerenderTimer = setTimeout(() => visiblePages().forEach(el => queueRender(el)), 180); // sharpen after the gesture settles
}
// Pinch (Ctrl + wheel): while the gesture runs the page column is only scaled with a CSS transform
// around the pointer; the pages get their real size once no wheel event came for PINCH_END_MS,
// with the spot under the pointer kept in place exactly as setZoom does.
const PINCH_END_MS = 150;
let pinch = null; // {zoom, s, tx, ty, ax, ay, ox, oy, ...} of the running gesture
function pinchZoom(factor, clientX, clientY) {
  const wrap = $('#pages'), from = pinch ? pinch.zoom : zoom;
  if (!wrap) { setZoom(from * factor, clientX, clientY); return; }
  const next = clampZoom(from * factor); if (next === from) return;
  const pdf = $('#pdf');
  if (!pinch) {
    clearTimeout(rerenderTimer);
    const els = [...wrap.children], box = pdf.getBoundingClientRect();
    pinch = {zoom, s: 1, tx: 0, ty: 0, box, ox: wrap.offsetLeft, oy: wrap.offsetTop, w: wrap.offsetWidth, h: wrap.offsetHeight,
      pageW: Math.max(0, ...els.map(el => el.offsetWidth)), cw: pdf.clientWidth, ch: pdf.clientHeight};
    pinch.after = pdf.scrollHeight - pinch.oy - pinch.h; // padding (and the last page's margin) below the column
    wrap.style.transformOrigin = '0 0';
  }
  const p = pinch, sl = pdf.scrollLeft, st = pdf.scrollTop;
  p.ax = clientX - p.box.left; p.ay = clientY - p.box.top;
  Object.assign(p, pinchStep(p, next / from, sl + p.ax - p.ox, st + p.ay - p.oy), {zoom: next});
  // As with real sizes: a column narrower than the view stays centred, and the column is not pulled past its ends.
  const left = Math.max(0, (p.w - p.pageW) / 2); // the pages' left edge in the column, before scaling
  if (p.pageW * p.s + 2 * p.ox <= p.cw) p.tx = sl + p.cw / 2 - p.ox - p.s * (left + p.pageW / 2);
  else p.tx = Math.min(sl - p.s * left, Math.max(p.cw + sl - 2 * p.ox - p.s * (left + p.pageW), p.tx));
  p.ty = Math.min(st, Math.max(p.ch + st - p.oy - p.after - p.s * p.h, p.ty));
  wrap.style.transform = `translate(${p.tx}px,${p.ty}px) scale(${p.s})`;
  $('#zoom-reset').textContent = Math.round(next * 100) + '%';
  clearTimeout(p.timer); p.timer = setTimeout(() => endPinch(), PINCH_END_MS);
}
// Give the pages their real size for the zoom the pinch reached (commit false: just drop the transform).
function endPinch(commit = true) {
  if (!pinch) return;
  const p = pinch; pinch = null; clearTimeout(p.timer);
  const pdf = $('#pdf'), wrap = $('#pages');
  if (!wrap) return;
  if (!commit) { wrap.style.transform = ''; return; }
  // The point under the pointer, in the unscaled layout. Offsets are read without the transform
  // (a transformed column would be the pages' offsetParent).
  const sl = pdf.scrollLeft, st = pdf.scrollTop;
  pdf.style.overflowAnchor = 'none'; // the position is set below; the browser must not shift it as well
  wrap.style.transform = '';
  const els = [...wrap.children], rects = els.map(el => ({top: el.offsetTop, left: el.offsetLeft, width: el.offsetWidth, height: el.offsetHeight}));
  const a = zoomAnchor(rects, (sl + p.ax - p.ox - p.tx) / p.s + p.ox, (st + p.ay - p.oy - p.ty) / p.s + p.oy);
  zoom = p.zoom;
  els.forEach(sizePage);
  if (a) { const el = els[a.index]; pdf.scrollTo({left: el.offsetLeft + a.fx * el.offsetWidth - p.ax, top: el.offsetTop + a.fy * el.offsetHeight - p.ay, behavior: 'instant'}); }
  pdf.style.overflowAnchor = '';
  try { localStorage.setItem('margin-zoom', zoom); } catch {}
  visiblePages().forEach(el => queueRender(el));
}
// Chromium reports a trackpad pinch as a wheel event with ctrlKey set.
$('#pdf').addEventListener('wheel', e => { if (!e.ctrlKey) return; e.preventDefault(); pinchZoom(wheelZoomFactor(e.deltaY, e.deltaMode), e.clientX, e.clientY); }, {passive: false});
$('#zoom-in').onclick = () => setZoom(zoom * 1.2);
$('#zoom-out').onclick = () => setZoom(zoom / 1.2);
$('#zoom-reset').onclick = () => setZoom(1);
$('#zoom-reset').textContent = Math.round(zoom * 100) + '%';

// ---------- citations ----------
// A citation of a project chat names its paper (ref.paper, an id prefix); that paper is opened first
// unless switchPaper is false (automatic following only moves within the open paper).
const refPaper = ref => ref.paper ? resolvePaper(ref.paper, project?.papers || []) : null;
const isLocal = ref => !ref.paper || refPaper(ref)?.id === paper?.id;
// Automatic following (switchPaper false) stands back while a paper loads and just after the user
// picked a citation, so focusing or scrolling the answer does not move away from the chosen passage.
let pickedAt = 0;
async function navigate(ref, {switchPaper = true} = {}) {
  if (switchPaper) pickedAt = Date.now();
  else if (loading || Date.now() - pickedAt < 1500) return;
  if (ref.paper) {
    const target = refPaper(ref);
    if (!target) { notice('That paper is no longer in this project.'); return; }
    if (target.id !== paper?.id) {
      if (!switchPaper) return;
      if (working || loading) { notice('Wait for the answer to finish, then select the citation again.'); return; }
      await openPaper(target.id, null, null, {keepChat: true});
      if (paper?.id !== target.id) return;
    }
  }
  if (!doc) return;
  if (ref.quote) return navigateQuote(ref);
  const target = resolveReference(ref, index, overrides, doc.numPages);
  if (!target) { notice('Equation location is missing or ambiguous. Use the correction panel to choose its page and position.'); $('#manual').open = true; $('#equation').value = ref.equation || ''; return; }
  activeRef = ref;
  const el = $(`.pdf-page[data-page="${target.page}"]`);
  await queueRender(el, true);
  const box = target.manual ? null : target.box;
  const mark = h('div', {className: 'highlight' + (box ? ' eq' : target.y == null ? ' whole' : ''), title: target.manual ? 'Manually corrected location' : target.y == null ? 'Page citation' : 'Detected equation; verify against source'});
  if (box) placeBox(mark, box); else mark.style.top = target.y == null ? '0' : Math.max(0, target.y * 100 - 3) + '%';
  showMarks(el, [mark], box?.y0 ?? target.y ?? 0, target.page);
  notice(`${ref.equation ? 'Equation ' + ref.equation + ' · ' : ''}PDF page ${target.page}${target.manual ? ' · manual correction' : target.fallback ? ' · exact equation not located; showing page' : box ? ' · detected equation (verify visually)' : ''}`);
}
function placeBox(div, b) { Object.assign(div.style, {left: b.x0 * 100 + '%', top: b.y0 * 100 + '%', width: (b.x1 - b.x0) * 100 + '%', height: (b.y1 - b.y0) * 100 + '%'}); }
// Jumps longer than JUMP_SMOOTH_SCREENS view heights are instant (a smooth scroll would pass,
// and start rendering, every page on the way); shorter ones stay smooth.
const JUMP_SMOOTH_SCREENS = 3;
function showMarks(el, marks, y, page) {
  endPinch();
  document.querySelectorAll('.pdf-page .highlight').forEach(x => x.remove());
  el.append(...marks);
  const pdf = $('#pdf'), top = el.offsetTop + y * el.clientHeight - 100;
  pdf.scrollTo({top, behavior: Math.abs(top - pdf.scrollTop) > JUMP_SMOOTH_SCREENS * pdf.clientHeight ? 'instant' : 'smooth'});
  $('#page').value = page;
}
// Pages of the open paper prepared for quote search (normalised text built once per page).
function quoteIndex() {
  return Object.keys(pageBoxes).map(Number).map(n => {
    const el = $(`.pdf-page[data-page="${n}"]`); if (!el) return null;
    return quotePages[n] ??= {page: n, prepared: preparePage(pageBoxes[n]), W: Number(el.dataset.width), H: Number(el.dataset.height)};
  }).filter(Boolean);
}
// Highlight the quoted words; search the cited page first, then the rest of the paper.
// Highlight the cited or quoted words. The cited page wins if it matches well; otherwise the
// closest match anywhere in the paper is used (models sometimes cite a neighbouring page).
async function navigateQuote(ref) {
  const what = ref.anchor ? 'Cited text' : 'Quoted text';
  const found = locateQuote(quoteIndex(), ref.page, ref.quote), best = found?.rects, bestPage = found?.page;
  if (!best) {
    await navigate({page: ref.page});
    notice(`The cited words were not found in the extracted text; showing PDF page ${ref.page}.`);
    return;
  }
  activeRef = ref;
  const el = $(`.pdf-page[data-page="${bestPage}"]`);
  await queueRender(el, true);
  showMarks(el, best.map(r => { const d = h('div', {className: 'highlight text', title: what}); placeBox(d, r); return d; }), best[0].y0, bestPage);
  notice(`${what} · PDF page ${bestPage}${bestPage !== ref.page ? ` (cited as page ${ref.page})` : ''}${best.dist > 0 ? ' · close match' : ''}`);
}

const words4 = q => { const w = q.split(/\s+/); return w.slice(0, 4).join(' ') + (w.length > 4 ? '…' : ''); };
// Author-year label of a citation's paper ("Kingma & Ba 2015 · "), empty for citations without a paper.
const paperTag = ref => { if (!ref.paper) return ''; const p = refPaper(ref); return (p ? paperLabels(project.papers).get(p.id) : 'Removed paper') + ' · '; };
const refLabel = ref => paperTag(ref) + (ref.anchor ? `p. ${ref.page} · “${words4(ref.quote)}”` : ref.quote ? `“${ref.quote.split(/\s+/).slice(0, 5).join(' ')}…” · p. ${ref.page}` : ref.equation ? `Eq. (${ref.equation})${ref.page ? ' · p. ' + ref.page : ''}` : `Page ${ref.page}`);
const MATH = /\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|\$\$[\s\S]*?\$\$/g;

// Markdown + KaTeX, with citations made clickable where they appear:
// [[eq:..]] tokens become inline chips, a chip (or \tag{n}) right after a display
// equation makes the whole equation a link, and plain "Eq. (61)" / "p. 4" text is linked.
// In project chats (whole = true) plain-text mentions are not linked: they do not say which paper.
// Rendered answers are cached (HTML plus the citation of each link, in document order), so opening
// a chat again skips Markdown and KaTeX. The key includes the project's paper labels, which appear
// in citation chips. Least recently used entries go first beyond BODY_CACHE_CHARS characters.
const BODY_CACHE_CHARS = 16e6, REF_LINKS = '.cite,.ref-link,.eq-link,.quote-link';
const bodyCache = new Map(); let bodyCacheChars = 0;
const labelsKeys = new WeakMap();
const labelsKey = () => { const ps = project?.papers; if (!ps) return ''; let k = labelsKeys.get(ps); if (k === undefined) labelsKeys.set(ps, k = JSON.stringify([...paperLabels(ps)])); return k; };
function linkBody(body) {
  body.addEventListener('click', e => { const el = e.target.closest('.cite,.ref-link,.eq-link,.quote-link'); if (el?.ref) { e.stopPropagation(); navigate(el.ref); } });
  body.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('eq-link')) { e.preventDefault(); navigate(e.target.ref); } });
  return body;
}
function renderBody(text, linkRefs, whole = false) {
  const cacheKey = `${linkRefs ? 1 : 0}${whole ? 1 : 0}${labelsKey()}\u0000${text}`, hit = bodyCache.get(cacheKey);
  if (hit) {
    bodyCache.delete(cacheKey); bodyCache.set(cacheKey, hit);
    const body = h('div', {className: 'message-body', innerHTML: hit.html});
    if (!linkRefs) return body;
    body.querySelectorAll(REF_LINKS).forEach((el, i) => { el.ref = hit.refs[i]; });
    return linkBody(body);
  }
  const body = renderBodyFresh(text, linkRefs, whole);
  const html = body.innerHTML;
  if (html.length < BODY_CACHE_CHARS / 8) {
    bodyCache.set(cacheKey, {html, refs: linkRefs ? [...body.querySelectorAll(REF_LINKS)].map(el => el.ref) : null}); bodyCacheChars += html.length;
    for (const [k, v] of bodyCache) { if (bodyCacheChars <= BODY_CACHE_CHARS) break; bodyCache.delete(k); bodyCacheChars -= v.html.length; }
  }
  return body;
}
function renderBodyFresh(text, linkRefs, whole) {
  const body = h('div', {className: 'message-body'});
  const math = [], cites = [], quotes = [];
  const anchors = [];
  let t = linkRefs ? text.replace(QUOTE, (_, id, p, q) => { quotes.push(quoteRef(id, p, q)); return `QUOTEPH${quotes.length - 1}END`; })
    .replace(ANCHOR, (_, id, p, q) => { anchors.push(quoteRef(id, p, q, true)); return `ANCHPH${anchors.length - 1}END`; }) : text;
  t = t.replace(MATH, m => { math.push(m); return `MATHPH${math.length - 1}END`; });
  if (linkRefs) t = t.replace(TOKEN, (_, ...g) => { cites.push(tokenRef(...g.slice(0, 5))); return `CITEPH${cites.length - 1}END`; });
  body.innerHTML = DOMPurify.sanitize(marked.parse(t));
  body.querySelectorAll('img').forEach(img => img.remove());
  body.querySelectorAll('a').forEach(a => { a.rel = 'noopener noreferrer'; a.target = '_blank'; });
  const escape = s => { const span = document.createElement('span'); span.textContent = s; return span.innerHTML; };
  body.innerHTML = body.innerHTML.replace(/MATHPH(\d+)END/g, (_, i) => escape(math[Number(i)])).replace(/CITEPH(\d+)END/g, (_, i) => `<button type="button" class="cite" data-i="${i}"></button>`).replace(/QUOTEPH(\d+)END/g, (_, i) => `<button type="button" class="quote-link" data-q="${i}"></button>`).replace(/ANCHPH(\d+)END/g, (_, i) => `<button type="button" class="cite anchor" data-a="${i}"></button>`);
  body.querySelectorAll('button.cite.anchor').forEach(b => { b.ref = anchors[Number(b.dataset.a)]; b.textContent = refLabel(b.ref); b.title = `${b.ref.paper ? 'Open the paper and highlight' : 'Highlight in the paper'}: “${b.ref.quote}”`; });
  body.querySelectorAll('button.quote-link').forEach(b => { b.ref = quotes[Number(b.dataset.q)]; b.append(h('span', {textContent: `“${b.ref.quote}”`}), h('small', {textContent: ` ${paperTag(b.ref)}p. ${b.ref.page} ↗`})); b.title = 'Highlight this passage in the paper'; });
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
    else if (!whole) { const tag = tagOf(display.querySelector('annotation')?.textContent); if (tag) ref = {equation: tag, page: null}; }
    if (!ref) continue;
    const link = h('span', {className: 'eq-link', tabIndex: 0, title: 'Show this equation in the paper'});
    link.setAttribute('role', 'button'); link.ref = ref;
    host.replaceWith(link);
    link.append(host, h('span', {className: 'eq-badge', textContent: refLabel(ref) + ' ↗'}));
  }
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {acceptNode: n => n.parentElement.closest('.katex,code,pre,button,a,.eq-link') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT});
  const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of whole ? [] : nodes) {
    const found = findMentions(node.textContent); if (!found.length) continue;
    const frag = document.createDocumentFragment(); let at = 0;
    for (const {index, length, ref} of found) {
      frag.append(node.textContent.slice(at, index));
      const b = h('button', {type: 'button', className: 'ref-link', textContent: node.textContent.slice(index, index + length), title: 'Show in the paper'}); b.ref = ref;
      frag.append(b); at = index + length;
    }
    frag.append(node.textContent.slice(at)); node.replaceWith(frag);
  }
  return linkBody(body);
}

function addMessage(role, text, meta = {}, scroll = true) {
  $('#messages .chat-empty')?.remove();
  const article = buildMessage(role, text, meta, scroll);
  $('#messages').append(article);
  if (scroll) article.scrollIntoView({behavior: 'smooth', block: 'end'});
  return article;
}
// One message as an <article> (not yet in the page); `animate` false shows it without the rise-in.
function buildMessage(role, text, meta = {}, animate = true) {
  const article = h('article', {className: 'message ' + role + (animate ? '' : ' instant')});
  const when = meta.at ? ' · ' + new Date(meta.at).toLocaleString([], {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'}) : '';
  const extra = role === 'user' ? (meta.web ? ' · WEB SEARCH' : '') : meta.retrieval ? ` · ${meta.retrieval.passages} passages${meta.retrieval.mode === 'keywords' ? ' (keyword search)' : ''}` : '';
  article.append(h('small', {textContent: (role === 'user' ? 'YOU' : 'MARGIN' + (meta.model ? ' · ' + meta.model : '')) + extra + when}));
  if (meta.image && /^data:image\/(png|jpeg);base64,/.test(meta.image)) article.append(h('img', {className: 'msg-image', src: meta.image, alt: 'Attached equation image'}));
  const whole = isProjectChat(chat);
  const body = renderBody(text, role === 'assistant', whole);
  article.append(body);
  if (role === 'assistant') {
    const seen = new Set(), uniq = r => { const k = JSON.stringify(r); if (seen.has(k)) return false; seen.add(k); return true; };
    // Precise anchors first, so "follow chat" jumps to the exact passage. Project chats use only the
    // structured tokens (they name the paper); paper chats also link plain "Eq. (61)" / "p. 4" mentions.
    const refs = (whole ? structuredRefs(text) : [...structuredRefs(text.replace(TOKEN, '')), ...parseReferences(text.replace(QUOTE, '').replace(ANCHOR, ''))]).filter(uniq); article.refs = refs;
    if (refs.length) {
      article.append(h('div', {className: 'citations'}, ...refs.map(ref => h('button', {textContent: refLabel(ref), title: ref.paper ? 'Open this paper at the citation' : 'Show in the paper', onclick: () => navigate(ref)}))));
      article.tabIndex = 0;
      // Following (focus, click on the answer, scrolling) stays within the open paper.
      const local = () => refs.find(isLocal);
      // A press on a chip or link focuses the answer too; that focus must not jump to the first citation.
      article.addEventListener('mousedown', e => { article.skipFocus = !!e.target.closest('button,a,.eq-link'); });
      article.addEventListener('focus', () => { if (article.skipFocus) { article.skipFocus = false; return; } const r = local(); if (r) navigate(r, {switchPaper: false}); });
      article.addEventListener('click', e => { const r = local(); if (r && !e.target.closest('button,a,.eq-link') && !getSelection().toString()) navigate(r, {switchPaper: false}); });
    }
    if (meta.sources?.length) article.append(h('div', {className: 'sources'}, h('small', {textContent: 'WEB SOURCES'}),
      h('ol', {}, ...meta.sources.map(src => { let host = ''; try { host = new URL(src.url).hostname.replace(/^www\./, ''); } catch {}
        return h('li', {}, h('a', {href: src.url, target: '_blank', rel: 'noopener noreferrer', textContent: src.title || host || src.url}), host && src.title ? h('small', {textContent: ' · ' + host}) : ''); }))));
  }
  return article;
}
let scrollTimer;
$('#messages').addEventListener('scroll', () => {
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => {
    if (!$('#follow').checked) return;
    const root = $('#messages').getBoundingClientRect();
    const cards = [...document.querySelectorAll('.message')].filter(a => a.refs?.some(isLocal)).filter(a => { const r = a.getBoundingClientRect(); return r.bottom > root.top && r.top < root.bottom; });
    cards.sort((a, b) => Math.abs(a.getBoundingClientRect().top - root.top - 50) - Math.abs(b.getBoundingClientRect().top - root.top - 50));
    const first = cards[0]?.refs.find(isLocal);
    if (first && activeRef !== first) navigate(first, {switchPaper: false});
  }, 180);
});

// ---------- asking ----------
$('#ask').onsubmit = async e => {
  e.preventDefault();
  const typed = $('#question').value.trim(), ctx = context, whole = isProjectChat(chat);
  if ((!typed && !ctx) || !chat || (!doc && !whole) || working || loading) return;
  // In a project chat an attachment also names its paper, so the model can cite it.
  const of = whole && paper ? ` of ${paperLabels(project.papers).get(paper.id) || paperTitle(paper)} (paper ${shortId(paper.id)})` : '';
  const question = !ctx ? typed : ctx.kind === 'passage'
    ? `> ${ctx.text}\n>\n> — PDF page ${ctx.page}${of}${ctx.image ? ' (image of the selected lines attached, for symbols the text drops)' : ''}\n\n${typed || 'Explain this passage.'}`
    : ctx.kind === 'region'
      ? `**About a marked area on PDF page ${ctx.page}${of}** (${ctx.where}; image attached)${ctx.text ? `\n\n> ${ctx.text}` : ''}\n\n${typed || 'Explain what is in this marked area.'}`
      : `**About Eq. (${ctx.label}), PDF page ${ctx.page}${of}** (image of the equation attached)\n\n${typed || 'Explain this equation: what each term means and how the paper uses it.'}`;
  const image = ctx?.image;
  if (!whole && !pages.some(p => p.text.trim())) { notice('This PDF has no extractable text. Use OCR first.'); return; }
  if (whole && !project.papers.length) { notice('Add papers to this project first.'); return; }
  if (!session?.configured) { notice(`Add ${keyWanted()} in Settings first.`); $('#open-settings').click(); return; }
  working = true; controls(); showStatus();
  try { await loadMarkdown(); } catch (e) { notice('Could not load the chat view: ' + e.message); working = false; controls(); showStatus(); return; }
  const target = chat, projectId = project.id;
  const web = webSearch;
  const pending = addMessage('user', question, {at: new Date().toISOString(), image, web}); $('#question').value = ''; setContext(null);
  notice(whole ? `Searching the project's papers${web ? ' (and the web)' : ''} and asking ${session.model}… The first question in a project indexes its papers, which can take a minute.` : `Reading the paper${web ? ' (and searching the web)' : ''} and asking ${session.model}…`);
  const thinking = h('article', {className: 'message assistant thinking', ariaLabel: 'Margin is thinking'}, h('small', {textContent: 'MARGIN · ' + session.model}), h('div', {className: 'dots'}, h('span'), h('span'), h('span')));
  $('#messages').append(thinking); thinking.scrollIntoView({behavior: 'smooth', block: 'end'});
  try {
    const r = await api(`/api/projects/${projectId}/chats/${target.id}/messages`, {body: {question, ...(whole ? {} : {pages}), ...(image ? {image} : {}), ...(web ? {web} : {})}});
    target.messages.push(...r.messages); target.title = r.chat.title;
    if (project?.id === projectId) { const summary = project.chats.find(c => c.id === r.chat.id); if (summary) Object.assign(summary, r.chat); project.chats.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
    if (chat === target) {
      pending.remove(); // replace the optimistic copy with the stored one
      addMessage('user', r.messages[0].content, r.messages[0], false);
      const card = addMessage('assistant', r.messages[1].content, r.messages[1]);
      $('#chat-title').textContent = target.title;
      notice('Answer ready. Select a citation to inspect its source.');
      const local = card.refs?.find(isLocal);
      if ($('#follow').checked && local) navigate(local, {switchPaper: false});
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
// "New chat" asks what the chat is about: the open paper, or all papers of the project.
function openChatMenu(btn) {
  const menu = $('#new-chat-menu');
  if (!menu.hidden && menu.anchor === btn) { closeChatMenu(); return; }
  menu.anchor = btn;
  const one = menu.querySelector('[data-scope="paper"]');
  one.disabled = !paper;
  one.querySelector('small').textContent = paper ? `Reads “${paperTitle(paper).slice(0, 40)}${paperTitle(paper).length > 40 ? '…' : ''}” in full` : 'Open a paper first';
  menu.hidden = false; menu.style.animation = 'none'; void menu.offsetWidth; menu.style.animation = '';
  const r = btn.getBoundingClientRect(), w = menu.offsetWidth;
  menu.style.left = Math.max(8, r.left + w > innerWidth - 8 ? r.right - w : r.left) + 'px';
  menu.style.top = r.bottom + 6 + 'px';
  (paper ? one : menu.querySelector('[data-scope="project"]')).focus();
}
function closeChatMenu() { $('#new-chat-menu').hidden = true; }
$('#new-chat-menu').onclick = e => { const b = e.target.closest('button[data-scope]'); if (!b || b.disabled) return; closeChatMenu(); newChat(b.dataset.scope); };
document.addEventListener('mousedown', e => { if (!e.target.closest('#new-chat-menu,#new-chat,#new-chat-side')) closeChatMenu(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeChatMenu(); });
$('#new-chat').onclick = e => openChatMenu(e.currentTarget);
$('#web-toggle').onclick = e => {
  webSearch = !webSearch; e.currentTarget.setAttribute('aria-pressed', webSearch);
  notice(webSearch ? 'Web search on: answers may search the web and list their sources (billed per search).' : 'Web search off: answers use the papers only.');
};
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
  if (!doc || !/^(?:\d{1,3}(?:\.\d{1,3})?|[A-Z]\.?\d{1,3})[a-z]?$/i.test(eq) || !Number.isInteger(page) || page < 1 || page > doc.numPages || !Number.isFinite(pct) || pct < 0 || pct > 100) { notice('Enter an equation number, valid PDF page, and position from 0–100%.'); return; }
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
    const fresh = !announcedRecently(summary.id); // the change event may have announced it already
    await refreshProject(); refreshProjects(); hideRefCard();
    if (fresh) say(`Added “${(summary.meta?.title || summary.name).slice(0, 80)}” to ${project.name} (${how}). It is in the sidebar.`);
  };
  for (const url of [rec.pdfUrl, rec.oaUrl].filter(Boolean)) {
    busy('Downloading…');
    try { await added(await api(pathP('papers', 'from-url'), {body: {url, openalexId: rec.openalexId, doi: rec.doi}}), 'open-access copy'); return; } catch {}
  }
  const landing = rec.doi ? `https://doi.org/${rec.doi}` : rec.oaUrl || (rec.openalexId ? `https://openalex.org/${rec.openalexId}` : null);
  if (!landing) { done(); say('No link is known for this paper.'); return; }
  // With the browser extension: open the paper in the user's own browser and wait for the PDF.
  const ext = await api('/api/extension').catch(() => null);
  if (ext?.paired) {
    try {
      const {id} = await api('/api/fetch-requests', {body: {projectId: project.id, openalexId: rec.openalexId, doi: rec.doi, title: rec.title, landing}});
      const url = (session?.proxyPrefix || '') + landing + '#margin-request=' + id;
      if (window.marginDesktop) await window.marginDesktop.openExternal(url); else window.open(url, '_blank', 'noopener');
      busy('Waiting for your browser…');
      say('Opened in your browser. Sign in if asked; the Margin extension sends the PDF back here.');
      for (let i = 0; i < 300; i++) {           // up to 10 minutes
        await new Promise(r => setTimeout(r, 2000));
        const st = await api(`/api/fetch-requests/${id}`).catch(() => null);
        if (!st) break;
        if (st.status === 'done') { done(); await added(st.paper, 'from your browser'); return; }
      }
      done(); say('No PDF arrived from the browser. On the paper’s page, click the Margin icon and “Send this page’s PDF”.');
      return;
    } catch (e) { say('Could not hand the paper to the browser extension: ' + e.message); }
  }
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
let map = null, mapProject = null, mapStale = false, mapModule = null;
async function openMap(refresh = false) {
  if (!project) return;
  document.body.classList.add('map-mode'); $('#map-view').hidden = false; hideRefCard(); hidePop();
  $('#map-project').textContent = project.name; $('#map-card').hidden = true;
  if (map && mapProject === project.id && !refresh && !mapStale) { map.fit(0); return; }
  mapStale = false;
  let createMap; // the map code (d3) loads when the map is first opened
  try { ({createMap} = await (mapModule ??= import('./map.js'))); } catch (e) { mapModule = null; $('#map-status').textContent = 'Could not load the map: ' + e.message; return; }
  if (!project) return;
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


// ---------- change events from the server ----------
// Papers can arrive without this window asking (the extension's "Send this page's PDF", a fetch request
// answered after the window reloaded or stopped waiting, another window). The server announces every change
// on GET /api/events (Server-Sent Events, read with fetch so the session token goes in a header).
const ANNOUNCE_WINDOW = 15e3, recentAdds = new Map(); // paper id -> when its addition was announced here
// True when the paper's addition was announced in the last ANNOUNCE_WINDOW ms; marks it announced now.
function announcedRecently(id) {
  const t = Date.now(), seen = recentAdds.get(id);
  for (const [k, at] of recentAdds) if (t - at > ANNOUNCE_WINDOW) recentAdds.delete(k);
  recentAdds.set(id, t);
  return seen !== undefined && t - seen <= ANNOUNCE_WINDOW;
}
const VIA = {'extension': 'from your browser', 'extension-request': 'from your browser', 'open-access': 'open-access copy', 'upload': 'added in another window'};
async function openProjectFromToast(pid) {
  if (working || loading) { toast('Wait for the current answer to finish, then switch projects.'); return; }
  if (pid !== project?.id && projects.some(x => x.id === pid)) await switchProject(pid);
}
async function onServerEvent(ev) {
  if (ev.client && ev.client === CLIENT_ID) return; // this window's own change: its code already updated the view
  if (ev.type === 'paper-added' && ev.paper?.id) {
    const fresh = !announcedRecently(ev.paper.id);
    const title = (ev.paper.meta?.title || ev.paper.name || 'Untitled paper').slice(0, 80);
    if (ev.projectId === project?.id) {
      await refreshProject(); await refreshProjects();
      if (fresh) say(ev.isNew === false ? `“${title}” is already in ${project.name}.` : `Added “${title}” to ${project.name}${VIA[ev.via] ? ` (${VIA[ev.via]})` : ''}. It is in the sidebar.`);
    } else {
      await refreshProjects();
      const name = projects.find(x => x.id === ev.projectId)?.name || ev.projectName || 'another project';
      if (fresh) toast(ev.isNew === false ? `“${title}” is already in ${name}.` : `Added “${title}” to ${name}.`, 10000, {label: 'Open', run: () => openProjectFromToast(ev.projectId)});
    }
  } else if (ev.type === 'paper-removed') {
    if (ev.projectId === project?.id) await refreshProject();
    await refreshProjects();
  } else if (ev.type === 'project-deleted') {
    if (ev.projectId === project?.id && !working && !loading) { closeMap(); await closePaper(); project = null; await refreshProjects(); renderLibrary(); notice(`This project was deleted in another window. Now showing “${project?.name}”.`); }
    else await refreshProjects();
  }
}
// Keeps the stream open; reconnects with backoff (1 s doubling to 30 s). After a reconnect the view is
// reloaded, since changes made while disconnected were not announced. A stream silent for longer than
// three heartbeats (the server sends one every 20 s) is treated as dead.
async function listenForChanges() {
  let delay = 1000, missed = false, queue = Promise.resolve();
  for (;;) {
    const abort = new AbortController(); let quiet;
    const alive = () => { clearTimeout(quiet); quiet = setTimeout(() => abort.abort(), 65e3); };
    try {
      const r = await fetch('/api/events', {headers: {'X-Session-Token': session.token, 'X-Margin-Client': CLIENT_ID}, cache: 'no-store', signal: abort.signal});
      if (!r.ok || !r.body) throw Error(`events ${r.status}`);
      delay = 1000; alive(); announceProject();
      if (missed) queue = queue.then(() => refreshProject()).then(() => refreshProjects()).catch(() => {});
      const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      for (;;) {
        const {value, done} = await reader.read(); if (done) break;
        alive(); buf += value.replace(/\r\n?/g, '\n');
        for (let i; (i = buf.indexOf('\n\n')) >= 0;) {
          const data = buf.slice(0, i).split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n'); buf = buf.slice(i + 2);
          let ev = null; try { ev = data && JSON.parse(data); } catch {}
          if (ev) queue = queue.then(() => onServerEvent(ev)).catch(() => {});
        }
      }
    } catch {}
    clearTimeout(quiet); missed = true;
    await new Promise(r => setTimeout(r, delay)); delay = Math.min(delay * 2, 30e3);
  }
}

// ---------- start ----------
showWelcome(); controls();
try { session = await fetch('/api/status').then(r => r.json()); } catch { notice('Local server unavailable. Restart the app.'); }
showStatus();
if (session) {
  if (!session.configured) notice(`Welcome! Open Settings to add ${keyWanted()}.`);
  await Promise.all([loadModels(), refreshProjects().then(() => renderLibrary()).catch(e => notice(e.message))]);
  listenForChanges();
  idle(() => loadMarkdown().catch(() => {}), 3000); // so the first chat opens without waiting for the Markdown/maths code
  if (project?.papers.length && !paper) notice(session.configured ? `Project "${project.name}": pick a paper in the sidebar, or add a PDF.` : `Open Settings to add ${keyWanted()}.`);
}
