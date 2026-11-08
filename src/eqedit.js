// "∑ Edit equations": every equation frame of the paper shown with its label, editable with pointer and
// keyboard, and "Label equations with AI" (page images sent to the chosen provider; results come back as
// suggestions). Frames are stored as the paper's overrides (format in lib/equations.mjs); main.js owns
// that state and rebuilds the merged equation set every view uses (hover, Ask AI about Eq., citations).
import {normalizeLabel, LABEL_HINT, suggestions, isAccepted, cleanBox, snapBox, mergeAiPage, estimateCost, usageCost} from '../lib/equations.mjs';

const MIN_W_PX = 12, MIN_H_PX = 8;           // a drag smaller than this is a click, not a frame
const DRAG_PX = 3;                           // pointer travel before a press on a frame becomes a move
const KEY_STEP = 0.002, KEY_STEP_BIG = 0.01; // arrow keys move/resize by this fraction of the page
const UNDO_LIMIT = 50;
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const clamp01 = v => Math.min(1, Math.max(0, v));
const plural = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`;
const SOURCE_TEXT = {auto: 'detected', user: 'yours', ai: 'AI, accepted'};

// app: {pdf, h, notice, api, confirmBox, state(), update(overrides), pageImage(n), currentPage(), onMode(on), providerInfo()}
//   state() -> {paper, doc, overrides, auto, byPage, pageBoxes}; update() stores, rebuilds and saves.
export function createEquationEditor(app) {
  const {h} = app, $ = s => document.querySelector(s);
  let on = false, selected = null, drag = null, editor = null, undo = [], run = null, keyBurst = 0;
  const fresh = new Map(); // suggestion key -> order, for the reveal animation of new AI results

  const pageEl = n => document.querySelector(`.pdf-page[data-page="${n}"]`);
  const keyOf = f => f.suggest ? `ai?${f.label}` : `${f.source}:${f.label}:${f.page}`;
  // Frames to show: the merged set plus pending AI suggestions.
  function frames() {
    const s = app.state(), out = [];
    for (const [p, list] of Object.entries(s.byPage)) for (const e of list) out.push({page: Number(p), label: e.label, box: e.box, source: e.source});
    for (const g of suggestions(s.overrides)) out.push({page: g.page, label: g.label, box: g.box, source: 'ai', suggest: true});
    return out;
  }
  const frameByKey = k => frames().find(f => keyOf(f) === k) || null;
  function commit(next, {snapshot = true} = {}) {
    if (snapshot) { undo.push(JSON.stringify(app.state().overrides)); if (undo.length > UNDO_LIMIT) undo.shift(); }
    app.update(next); render(); updateBar();
  }
  const copy = () => structuredClone(app.state().overrides);

  // ---------- rendering ----------
  function render() {
    document.querySelectorAll('.eq-layer').forEach(x => x.remove());
    if (!on) return;
    const focusKey = document.activeElement?.closest?.('.eq-frame')?.dataset.key;
    const byPage = {};
    for (const f of frames()) (byPage[f.page] ??= []).push(f);
    for (const [p, list] of Object.entries(byPage)) {
      const el = pageEl(p); if (!el) continue;
      const layer = h('div', {className: 'eq-layer'});
      for (const f of list) layer.append(frameEl(f));
      el.append(layer);
    }
    if (focusKey) document.querySelector(`.eq-frame[data-key="${CSS.escape(focusKey)}"]`)?.focus({preventScroll: true});
  }
  function frameEl(f) {
    const key = keyOf(f);
    const d = h('div', {className: `eq-frame ${f.suggest ? 'suggest' : f.source}${selected === key ? ' selected' : ''}${fresh.has(key) ? ' reveal' : ''}`, tabIndex: 0});
    if (fresh.has(key)) d.style.setProperty('--i', fresh.get(key));
    d.dataset.key = key;
    d.setAttribute('role', 'group');
    d.setAttribute('aria-label', f.suggest ? `AI suggestion: Eq. (${f.label}), page ${f.page}. Enter accepts, Delete rejects.`
      : `Eq. (${f.label}), page ${f.page}, ${SOURCE_TEXT[f.source]}. Arrow keys move, Alt+arrows resize, Enter relabels, Delete removes.`);
    place(d, f.box);
    const chip = h('button', {type: 'button', className: 'eq-chip', title: f.suggest ? 'AI suggestion' : 'Relabel (or double-click the frame)'},
      h('b', {textContent: `(${f.label})`}), f.suggest || f.source === 'ai' ? h('span', {className: 'eq-badge-ai', textContent: 'AI'}) : f.source === 'user' ? h('span', {className: 'eq-badge-user', textContent: 'edited'}) : '');
    chip.tabIndex = -1;
    if (!f.suggest) chip.onclick = e => { e.stopPropagation(); openLabel(f); };
    d.append(chip);
    if (f.suggest) d.append(h('span', {className: 'eq-actions'},
      h('button', {type: 'button', className: 'eq-accept', textContent: '✓', title: 'Accept this AI frame', tabIndex: -1, onclick: e => { e.stopPropagation(); accept([f.label]); }}),
      h('button', {type: 'button', className: 'eq-reject', textContent: '×', title: 'Reject this AI frame', tabIndex: -1, onclick: e => { e.stopPropagation(); reject([f.label]); }})));
    else {
      d.append(h('button', {type: 'button', className: 'eq-x', textContent: '×', title: 'Delete this frame (Delete key)', tabIndex: -1, onclick: e => { e.stopPropagation(); remove(f); }}));
      for (const k of HANDLES) { const s = h('span', {className: `eq-h ${k}`}); s.dataset.h = k; d.append(s); }
    }
    d.addEventListener('focus', () => select(key, false));
    d.addEventListener('dblclick', e => { if (!f.suggest) { e.stopPropagation(); openLabel(f); } });
    return d;
  }
  function place(div, b) { Object.assign(div.style, {left: b.x0 * 100 + '%', top: b.y0 * 100 + '%', width: (b.x1 - b.x0) * 100 + '%', height: (b.y1 - b.y0) * 100 + '%'}); }
  function select(key, rerender = true) {
    if (selected === key) return;
    selected = key;
    document.querySelectorAll('.eq-frame.selected').forEach(x => x.classList.remove('selected'));
    if (key) document.querySelector(`.eq-frame[data-key="${CSS.escape(key)}"]`)?.classList.add('selected');
    if (rerender && !key) render();
  }

  // ---------- edits ----------
  // A moved, resized or relabelled frame becomes the user's own; it replaces detections with its label.
  function setFrame(f, box, label = f.label) {
    const next = copy();
    if (label !== f.label) {
      if (f.source === 'auto') next[f.label] = withDeletion(next[f.label], f.page); // hide the detection under its old number
      else delete next[f.label];
    }
    next[label] = {page: f.page, box: cleanBox(box) || f.box, source: 'user', accepted: true};
    commit(next);
    selected = keyOf({page: f.page, label, source: 'user'}); render();
  }
  const withDeletion = (o, page) => o?.deleted ? (o.pages ? {deleted: true, pages: [...new Set([...o.pages, page])]} : o) : {deleted: true, pages: [page]};
  function remove(f) {
    if (f.suggest) return reject([f.label]);
    const next = copy(), s = app.state();
    if (f.source === 'auto') next[f.label] = withDeletion(next[f.label], f.page);
    else if (Object.values(s.auto).some(list => list.some(a => a.label === f.label))) next[f.label] = {deleted: true}; // the detections it replaced stay hidden
    else delete next[f.label];
    selected = null; commit(next);
    app.notice(`Frame of Eq. (${f.label}) on page ${f.page} deleted. Ctrl+Z undoes it.`);
  }
  function accept(labels) {
    const next = copy();
    for (const l of labels) if (next[l]?.source === 'ai') next[l] = {...next[l], accepted: true};
    commit(next);
    app.notice(labels.length === 1 ? `AI frame of Eq. (${labels[0]}) accepted.` : `${plural(labels.length, 'AI frame')} accepted.`);
  }
  function reject(labels) {
    const next = copy();
    for (const l of labels) if (next[l]?.source === 'ai' && !next[l].accepted) delete next[l];
    commit(next);
  }
  function undoLast() {
    const prev = undo.pop();
    if (!prev) { app.notice('Nothing to undo.'); return; }
    app.update(JSON.parse(prev)); selected = null; render(); updateBar(); app.notice('Undone.');
  }

  // ---------- label input (new frame or relabel) ----------
  // Resolves with the label, or null when cancelled (Esc, or focus left the field).
  function askLabel(page, box, value, taken) {
    closeLabel();
    const el = pageEl(page); if (!el) return Promise.resolve(null);
    const input = h('input', {className: 'eq-label-input', value, placeholder: '12', maxLength: 12, autocomplete: 'off', spellcheck: false});
    input.setAttribute('aria-label', 'Equation number');
    const msg = h('small', {className: 'eq-label-msg', textContent: 'Equation number · Enter saves · Esc cancels'});
    const wrap = h('div', {className: 'eq-label-pop'}, input, msg);
    wrap.style.left = box.x0 * 100 + '%'; wrap.style.top = `calc(${box.y1 * 100}% + 4px)`;
    el.append(wrap);
    return new Promise(resolve => {
      const done = v => { if (editor?.wrap !== wrap) return; editor = null; wrap.remove(); resolve(v); };
      editor = {wrap, cancel: () => done(null)};
      input.onkeydown = e => {
        e.stopPropagation();
        if (e.key === 'Escape') { e.preventDefault(); done(null); }
        else if (e.key === 'Enter') {
          e.preventDefault();
          const label = normalizeLabel(input.value);
          const clash = label && taken(label);
          if (!label || clash) { msg.textContent = !label ? LABEL_HINT : clash; wrap.classList.remove('bad'); void wrap.offsetWidth; wrap.classList.add('bad'); input.setAttribute('aria-invalid', 'true'); return; }
          done(label);
        }
      };
      input.onblur = () => setTimeout(() => { if (editor?.wrap === wrap && !wrap.contains(document.activeElement)) done(null); }, 0);
      input.focus(); input.select();
    });
  }
  function closeLabel() { editor?.cancel(); }
  const clashFor = (except) => label => {
    const o = app.state().overrides[label];
    if (label === except || !isAccepted(o)) return null;
    return `Eq. (${label}) already has a frame on page ${o.page}. Use another number, or delete that frame first.`;
  };
  async function openLabel(f) {
    select(keyOf(f), false);
    const label = await askLabel(f.page, f.box, f.label, clashFor(f.label));
    if (label && label !== f.label) { setFrame(f, f.box, label); app.notice(`Relabelled to Eq. (${label}).`); }
    focusSelected();
  }
  async function newFrame(page, box, div) {
    const label = await askLabel(page, box, '', clashFor(null));
    div.remove();
    if (!label) return;
    const replaces = Object.values(app.state().auto).flat().some(a => a.label === label);
    setFrame({page, label, box, source: 'user'}, box);
    app.notice(`Eq. (${label}) framed on page ${page}${replaces ? '; it replaces the detected frame with that number' : ''}.`);
    focusSelected();
  }
  const focusSelected = () => selected && document.querySelector(`.eq-frame[data-key="${CSS.escape(selected)}"]`)?.focus({preventScroll: true});

  // ---------- pointer: draw, move, resize ----------
  function pagePoint(el, e) { const r = el.getBoundingClientRect(); return {u: clamp01((e.clientX - r.left) / r.width), v: clamp01((e.clientY - r.top) / r.height), r}; }
  app.pdf.addEventListener('pointerdown', e => {
    if (!on || e.button !== 0 || run) return;
    if (e.target.closest('.eq-label-pop,.eq-chip,.eq-x,.eq-actions')) return;
    const el = e.target.closest('.pdf-page'); if (!el) return;
    const page = Number(el.dataset.page), frameDiv = e.target.closest('.eq-frame');
    e.preventDefault(); closeLabel();
    const {u, v} = pagePoint(el, e);
    if (frameDiv) {
      const f = frameByKey(frameDiv.dataset.key); if (!f) return;
      select(frameDiv.dataset.key); frameDiv.focus({preventScroll: true});
      if (f.suggest) return;
      drag = {kind: e.target.closest('.eq-h')?.dataset.h || 'move', f, el, div: frameDiv, u, v, x: e.clientX, y: e.clientY, box: f.box, moved: false};
    } else {
      select(null, false);
      const div = h('div', {className: 'eq-frame draft'}); place(div, {x0: u, y0: v, x1: u, y1: v}); el.append(div);
      drag = {kind: 'draw', page, el, div, u, v, box: null};
    }
    app.pdf.setPointerCapture(e.pointerId);
  });
  app.pdf.addEventListener('pointermove', e => {
    if (!drag) return;
    const {u, v} = pagePoint(drag.el, e);
    if (drag.kind === 'draw') { drag.box = {x0: Math.min(drag.u, u), y0: Math.min(drag.v, v), x1: Math.max(drag.u, u), y1: Math.max(drag.v, v)}; place(drag.div, drag.box); return; }
    if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < DRAG_PX) return;
    drag.moved = true; drag.div.classList.add('dragging');
    const b = {...drag.f.box}, du = u - drag.u, dv = v - drag.v, k = drag.kind;
    if (k === 'move') {
      const w = b.x1 - b.x0, hh = b.y1 - b.y0, x0 = clamp01(Math.min(1 - w, b.x0 + du)), y0 = clamp01(Math.min(1 - hh, b.y0 + dv));
      Object.assign(b, {x0, y0, x1: x0 + w, y1: y0 + hh});
    } else {
      const minW = 0.006, minH = 0.004;
      if (k.includes('w')) b.x0 = clamp01(Math.min(b.x1 - minW, b.x0 + du));
      if (k.includes('e')) b.x1 = clamp01(Math.max(b.x0 + minW, b.x1 + du));
      if (k.includes('n')) b.y0 = clamp01(Math.min(b.y1 - minH, b.y0 + dv));
      if (k.includes('s')) b.y1 = clamp01(Math.max(b.y0 + minH, b.y1 + dv));
    }
    drag.box = b; place(drag.div, b);
  });
  app.pdf.addEventListener('pointerup', () => {
    const d = drag; drag = null; if (!d) return;
    if (d.kind === 'draw') {
      const r = d.el.getBoundingClientRect();
      if (!d.box || (d.box.x1 - d.box.x0) * r.width < MIN_W_PX || (d.box.y1 - d.box.y0) * r.height < MIN_H_PX) { d.div.remove(); return; }
      newFrame(d.page, d.box, d.div);
      return;
    }
    if (d.moved && d.box) setFrame(d.f, d.box);
  });
  app.pdf.addEventListener('pointercancel', () => { if (drag?.kind === 'draw') drag.div.remove(); drag = null; render(); });

  // ---------- keyboard ----------
  document.addEventListener('keydown', e => {
    if (!on || e.defaultPrevented) return;
    if (e.target.closest?.('input,textarea,select,dialog')) return;
    if (e.key === 'Escape') { if (run) return; e.preventDefault(); setMode(false); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); if (!run) undoLast(); return; }
    const f = selected && frameByKey(selected); if (!f || run) return;
    if (f.suggest) {
      if (e.key === 'Enter') { e.preventDefault(); accept([f.label]); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); reject([f.label]); }
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); remove(f); return; }
    if (e.key === 'Enter' || e.key === 'F2') { e.preventDefault(); openLabel(f); return; }
    const dir = {ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]}[e.key];
    if (!dir) return;
    e.preventDefault();
    const s = e.shiftKey ? KEY_STEP_BIG : KEY_STEP, b = {...f.box};
    if (e.altKey) { b.x1 = clamp01(Math.max(b.x0 + 0.006, b.x1 + dir[0] * s)); b.y1 = clamp01(Math.max(b.y0 + 0.004, b.y1 + dir[1] * s)); }
    else {
      const w = b.x1 - b.x0, hh = b.y1 - b.y0;
      b.x0 = clamp01(Math.min(1 - w, b.x0 + dir[0] * s)); b.y0 = clamp01(Math.min(1 - hh, b.y0 + dir[1] * s)); b.x1 = b.x0 + w; b.y1 = b.y0 + hh;
    }
    // One undo step per burst of key presses.
    const burst = Date.now() - keyBurst < 800; keyBurst = Date.now();
    const next = copy(); // a detected frame becomes the user's own
    next[f.label] = {page: f.page, box: cleanBox(b) || f.box, source: 'user', accepted: true};
    commit(next, {snapshot: !burst});
    selected = keyOf({page: f.page, label: f.label, source: 'user'}); render(); focusSelected();
  });

  // ---------- AI labelling ----------
  async function labelWithAI() {
    const s = app.state(), info = app.providerInfo();
    if (!s.doc || run) return;
    if (!info.configured) { app.notice(`Add ${info.company === 'Anthropic' ? 'an Anthropic' : 'an OpenAI'} API key in Settings to label equations with AI.`); return; }
    const all = $('#eq-ai-scope').value === 'all', cur = app.currentPage();
    const pages = all ? Array.from({length: s.doc.numPages}, (_, i) => i + 1) : [cur];
    const size = await app.pageImageSize(pages[0]);
    const est = estimateCost(info.provider, info.model, pages.length, size.width, size.height);
    const k = n => n >= 10000 ? `${Math.round(n / 1000)}k` : n.toLocaleString();
    const ok = await app.confirmBox({title: 'Label equations with AI?', ok: `Label ${plural(pages.length, 'page')}`, primary: true, body: [
      `${all ? `All ${plural(pages.length, 'page')}` : `Page ${cur}`} will be sent as ${pages.length === 1 ? 'an image' : 'images'} (up to ${Math.max(size.width, size.height)} px) to ${info.company}, model ${info.model}.`,
      `Rough cost: ${est.usd != null ? `about $${est.usd < 0.1 ? est.usd.toFixed(3) : est.usd.toFixed(2)}` : 'unknown for this model'} (≈ ${k(est.input)} input and ${k(est.output)} output tokens; the real amount depends on the pages and how long the model reasons).`,
      'Only numbered display equations are labelled. Results appear as suggestions to accept or reject; frames you have edited or deleted are left as they are.',
      {className: 'hint', textContent: 'You can cancel at any time; pages already done keep their suggestions.'}]});
    if (!ok) return;
    const paperId = s.paper.id, abort = new AbortController();
    run = {abort}; undo.push(JSON.stringify(s.overrides)); setBusy(true);
    const errors = [], totals = {found: 0, agree: 0, suggested: 0, kept: 0, snapped: {text: 0, ink: 0, none: 0}}, usage = {input: 0, output: 0, cacheRead: 0, cacheWrite: 0};
    let model = info.model, done = 0;
    for (const [i, p] of pages.entries()) {
      if (abort.signal.aborted || app.state().paper?.id !== paperId) break;
      progress(i, pages.length, `Page ${p}${pages.length > 1 ? ` (${i + 1} of ${pages.length})` : ''}: rendering…`);
      try {
        const img = await app.pageImage(p);
        progress(i, pages.length, `Page ${p}${pages.length > 1 ? ` (${i + 1} of ${pages.length})` : ''}: asking ${info.model}…`);
        const r = await app.api(`/api/papers/${paperId}/label-equations`, {body: {page: p, pages: s.doc.numPages, image: img.dataUrl, width: img.width, height: img.height}, signal: abort.signal});
        if (app.state().paper?.id !== paperId) break;
        model = r.model || model;
        for (const key of Object.keys(usage)) usage[key] += r.usage?.[key] || 0;
        const st = app.state(), el = pageEl(p), W = Number(el.dataset.width), H = Number(el.dataset.height);
        const snapped = r.equations.map(e => { const sb = snapBox(e.box, st.pageBoxes[p] || [], W, H, img, e.label); totals.snapped[sb.method]++; return {label: e.label, box: sb.box, raw: e.box}; });
        const m = mergeAiPage(p, snapped, st.auto[p] || [], st.overrides);
        for (const key of ['found', 'agree', 'suggested', 'kept']) totals[key] += m.stats[key];
        // New suggestions on this page fade and wipe in one after another (once; later renders show them still).
        const before = new Set(suggestions(st.overrides).map(g => g.label));
        const added = suggestions(m.overrides).filter(g => !before.has(g.label) && g.page === p).sort((a, b) => a.box.y0 - b.box.y0);
        added.forEach((g, i) => fresh.set(`ai?${g.label}`, i));
        if (added.length) setTimeout(() => added.forEach(g => fresh.delete(`ai?${g.label}`)), 900 + added.length * 140);
        app.update(m.overrides); render(); updateBar(); done++;
        app.onPageLabelled?.(p, {equations: r.equations, snapped, stats: m.stats, usage: r.usage, model: r.model});
      } catch (e) {
        if (abort.signal.aborted) break;
        errors.push({page: p, message: e.message});
        if (e.data?.fatal) break; // no key, rejected key or unknown model: every page would fail the same way
      }
    }
    setBusy(false); run = null;
    const cost = usageCost(model, usage);
    const parts = [`${abort.signal.aborted ? 'Cancelled after' : 'AI labelled'} ${plural(done, 'page')}: ${plural(totals.found, 'numbered equation')} found`,
      totals.found ? `${totals.agree} match${totals.agree === 1 ? 'es' : ''} detection, ${plural(totals.suggested, 'suggestion')} to review${totals.kept ? `, ${totals.kept} left as you set ${totals.kept === 1 ? 'it' : 'them'}` : ''}` : null].filter(Boolean).join('; ');
    const used = usage.input || usage.output ? ` Used ${k(usage.input + usage.cacheRead + usage.cacheWrite)} input and ${k(usage.output)} output tokens${cost != null ? ` (about $${cost < 0.1 ? cost.toFixed(3) : cost.toFixed(2)})` : ''}.` : '';
    const failed = errors.length ? ` ${plural(errors.length, 'page')} failed: ${errors.slice(0, 3).map(x => `p. ${x.page}: ${x.message}`).join('; ')}${errors.length > 3 ? '; …' : ''}` : '';
    msg(parts + '.' + used + failed);
    app.notice(parts + '.');
    return {done, errors, totals, usage, cost, model};
  }
  function progress(i, n, text) { const p = $('#eq-progress'); p.hidden = false; p.querySelector('progress').max = n; p.querySelector('progress').value = i; p.querySelector('span').textContent = text; }
  function setBusy(b) {
    $('#eq-progress').hidden = !b; $('#eq-ai').disabled = b; $('#eq-ai-scope').disabled = b; $('#eq-done').disabled = b;
    $('#eq-accept-all').disabled = $('#eq-reject-all').disabled = b;
    app.pdf.classList.toggle('eq-busy', b);
  }
  const msg = t => { $('#eq-msg').textContent = t; };

  // ---------- mode and bar ----------
  function updateBar() {
    const n = suggestions(app.state().overrides).length;
    const acc = $('#eq-accept-all'), rej = $('#eq-reject-all');
    acc.hidden = rej.hidden = !n; acc.textContent = `Accept all AI (${n})`;
    const b = $('#eq-edit');
    b.querySelector('.eq-count')?.remove();
    if (n) b.append(h('span', {className: 'eq-count', textContent: n, title: `${plural(n, 'AI suggestion')} to review`}));
    const cur = app.state().doc ? app.currentPage() : 1;
    $('#eq-ai-scope').options[0].textContent = `This page (${cur})`;
    $('#eq-ai-scope').options[1].textContent = `Whole paper${app.state().doc ? ` (${app.state().doc.numPages} pages)` : ''}`;
  }
  function setMode(next) {
    if (next && !app.state().doc) return;
    if (!next && run) run.abort.abort();
    on = next; closeLabel(); drag = null;
    if (!next) selected = null;
    app.pdf.classList.toggle('eq-editing', on);
    $('#eq-edit').classList.toggle('active', on); $('#eq-edit').setAttribute('aria-pressed', on);
    $('#eq-bar').hidden = !on;
    if (on) { msg(''); updateBar(); }
    render(); app.onMode(on);
  }
  $('#eq-edit').onclick = () => setMode(!on);
  $('#eq-done').onclick = () => setMode(false);
  $('#eq-ai').onclick = () => labelWithAI();
  $('#eq-cancel').onclick = () => run?.abort.abort();
  $('#eq-accept-all').onclick = () => accept(suggestions(app.state().overrides).map(g => g.label));
  $('#eq-reject-all').onclick = () => { const n = suggestions(app.state().overrides).length; reject(suggestions(app.state().overrides).map(g => g.label)); app.notice(`${plural(n, 'AI suggestion')} rejected.`); };
  app.pdf.addEventListener('scroll', () => { if (on) updateBar(); }, {passive: true});

  return {
    get on() { return on; },
    setMode, render, labelWithAI,
    reset() { if (run) run.abort.abort(); undo = []; selected = null; if (on) setMode(false); updateBar(); },
    refresh() { updateBar(); if (on) render(); },
  };
}
