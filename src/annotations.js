// Annotations of the open paper: text highlights and sticky notes with a comment thread each (replies by
// the reader or by AI), a comments panel, and the import of annotations already inside the PDF file.
// The server keeps them per paper (lib/annotations.mjs); positions are fractions of the page as displayed
// (origin top-left), so the marks drawn here stay in place when pages are zoomed, freed and rendered again.
// The first part is pure geometry and text (tested in test/annotations-client.test.js); createAnnotations()
// below is the UI, wired to the reader by main.js.

// Highlight colours offered in the app: [name, #rrggbb]. Drawn at HL_OPACITY with a multiply blend (as the
// exported PDF does, lib/pdf-annotate.mjs), so black text stays black. The first is the default.
export const COLORS = [['Yellow', '#ffd400'], ['Green', '#7ddc6b'], ['Blue', '#6fbcff'], ['Pink', '#ff8fc0'], ['Orange', '#ffa94d']];
export const DEFAULT_COLOR = COLORS[0][1];
export const LIMITS = {rects: 200, text: 3000, comment: 5000, reply: 5000}; // as the server's (lib/annotations.mjs)
export const LINE_OVERLAP = 0.5; // rects sharing this much of the lower one's height are on one text line
export const LINE_GAP = 1.5;     // rects of a line further apart than this many line heights stay separate (columns)
export const JOIN_GAP = 0.15;    // text pieces of a line closer than this many line heights are joined without a space
export const HIT_PAD = 0.003;    // a click this close to a highlight (fraction of the page) still selects it
const NOTE_PT = 20;              // note icon size in PDF points at 100% (the exported PDF uses the same)
const DRAG_PX = 3;               // pointer travel before a press on a note becomes a move
const QUOTE_CHARS = {panel: 180, pop: 240};
const PDF_ID = /^[1-9]\d{0,9}R\d{0,5}$/; // pdf.js ids of annotations the server accepts (indirect objects)

const clamp01 = v => Math.min(1, Math.max(0, v));
const squash = s => String(s ?? '').replace(/\s+/g, ' ').trim();
const plural = (k, w) => `${k} ${k === 1 ? w : w === 'reply' ? 'replies' : w + 's'}`;
export const truncate = (s, n) => s.length > n ? s.slice(0, n).trimEnd() + '…' : s;

// One rect per visual line from the many rects a text selection yields (text-layer spans overlap, repeat
// and split lines into pieces). Rects are {x0,y0,x1,y1} in any unit with y growing downwards; `min` drops
// slivers. Pieces of a line separated by a wide gap (two columns side by side) stay separate rects.
export function mergeLineRects(rects, {overlap = LINE_OVERLAP, gap = LINE_GAP, min = 1} = {}) {
  const lines = [];
  for (const r of rects.filter(r => r.x1 - r.x0 >= min && r.y1 - r.y0 >= min).sort((a, b) => a.y0 + a.y1 - b.y0 - b.y1 || a.x0 - b.x0)) {
    const line = lines.findLast(l => Math.min(l.y1, r.y1) - Math.max(l.y0, r.y0) >= overlap * Math.min(l.y1 - l.y0, r.y1 - r.y0));
    if (line) { line.parts.push(r); line.y0 = Math.min(line.y0, r.y0); line.y1 = Math.max(line.y1, r.y1); }
    else lines.push({y0: r.y0, y1: r.y1, parts: [r]});
  }
  const out = [];
  for (const l of lines) {
    let cur = null;
    for (const p of l.parts.sort((a, b) => a.x0 - b.x0)) {
      if (cur && p.x0 - cur.x1 <= gap * (l.y1 - l.y0)) { cur.x1 = Math.max(cur.x1, p.x1); cur.y0 = Math.min(cur.y0, p.y0); cur.y1 = Math.max(cur.y1, p.y1); }
      else out.push(cur = {x0: p.x0, y0: p.y0, x1: p.x1, y1: p.y1});
    }
  }
  return out;
}
// Rects relative to a page box {left, top, width, height}, as fractions clamped to the page; empty ones are dropped.
export const normRects = (rects, pr) => rects.map(r => ({x0: clamp01((r.x0 - pr.left) / pr.width), y0: clamp01((r.y0 - pr.top) / pr.height), x1: clamp01((r.x1 - pr.left) / pr.width), y1: clamp01((r.y1 - pr.top) / pr.height)}))
  .filter(r => r.x1 > r.x0 && r.y1 > r.y0);
const toView = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
// Highlight quads of a PDF annotation (8 numbers per quad, PDF user space) as normalised line rects.
// `m` is the page viewport's transform at scale 1 (it carries the page rotation), W×H that viewport's size.
export function quadRects(quads, m, W, H) {
  const px = [];
  for (let i = 0; i + 8 <= (quads?.length || 0); i += 8) {
    const pts = [0, 2, 4, 6].map(j => toView(m, quads[i + j], quads[i + j + 1])), xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    px.push({x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys)});
  }
  return normRects(mergeLineRects(px, {min: 0.5}), {left: 0, top: 0, width: W, height: H});
}
// Top-left corner (normalised) of a PDF rect [x1,y1,x2,y2] as displayed.
export function rectCorner(rect, m, W, H) {
  const pts = [[rect[0], rect[1]], [rect[0], rect[3]], [rect[2], rect[1]], [rect[2], rect[3]]].map(p => toView(m, p[0], p[1]));
  return {x: clamp01(Math.min(...pts.map(p => p[0])) / W), y: clamp01(Math.min(...pts.map(p => p[1])) / H)};
}
// Text pieces [{s, x0, y0, x1, y1}] in reading order as one string: pieces that touch on a line are joined
// directly (a word split over several text items), everything else with a space.
export function joinPieces(pieces, gap = JOIN_GAP) {
  let out = '', prev = null;
  for (const p of pieces) {
    const same = prev && Math.min(prev.y1, p.y1) - Math.max(prev.y0, p.y0) > 0.5 * Math.min(prev.y1 - prev.y0, p.y1 - p.y0);
    out += (prev && !(same && p.x0 - prev.x1 < gap * (p.y1 - p.y0)) ? ' ' : '') + p.s; prev = p;
  }
  return squash(out);
}
// The text under normalised line rects, from a page's text items (layout.js textBoxes: page pixels at scale 1).
// An item only partly under a rect gives the matching share of its characters (by width, so approximate).
export function textUnder(boxes, rects, W, H) {
  const pieces = [];
  for (const r of rects) {
    const x0 = r.x0 * W, x1 = r.x1 * W, y0 = r.y0 * H, y1 = r.y1 * H, line = [];
    for (const b of boxes) {
      const cy = (b.y0 + b.y1) / 2, w = b.x1 - b.x0;
      if (cy < y0 || cy > y1 || b.x1 <= x0 || b.x0 >= x1 || !b.s.trim()) continue;
      const n = b.s.length, s = w > 0 ? b.s.slice(Math.round(n * Math.max(0, x0 - b.x0) / w), Math.round(n * Math.min(w, x1 - b.x0) / w)) : b.s;
      if (s.trim()) line.push({s, x0: Math.max(b.x0, x0), x1: Math.min(b.x1, x1), y0: b.y0, y1: b.y1});
    }
    pieces.push(...line.sort((a, b) => a.x0 - b.x0));
  }
  return joinPieces(pieces).slice(0, LIMITS.text);
}
// Order of the comments panel: page, then position on the page (top to bottom, left to right), then age.
export const sortAnnotations = items => [...items].sort((a, b) => a.page - b.page || (a.rects[0]?.y0 ?? 0) - (b.rects[0]?.y0 ?? 0) || (a.rects[0]?.x0 ?? 0) - (b.rects[0]?.x0 ?? 0) || String(a.createdAt).localeCompare(String(b.createdAt)));
export const unionBox = rects => ({x0: Math.min(...rects.map(r => r.x0)), y0: Math.min(...rects.map(r => r.y0)), x1: Math.max(...rects.map(r => r.x1)), y1: Math.max(...rects.map(r => r.y1))});
// The area around a note that is shown to the tutor with it (a note marks a spot, not a passage).
export const noteBox = r => ({x0: clamp01(r.x0 - 0.3), y0: clamp01(r.y0 - 0.04), x1: clamp01(r.x0 + 0.3), y1: clamp01(r.y0 + 0.08)});
// The highlight under a point of a page (the smallest one when several overlap), with the rect that was hit.
export function hitTest(items, page, u, v, pad = HIT_PAD) {
  let best = null, area = Infinity;
  for (const a of items) {
    if (a.page !== page || a.kind !== 'highlight') continue;
    const rect = a.rects.find(r => u >= r.x0 - pad && u <= r.x1 + pad && v >= r.y0 - pad && v <= r.y1 + pad); if (!rect) continue;
    const s = a.rects.reduce((t, r) => t + (r.x1 - r.x0) * (r.y1 - r.y0), 0);
    if (s < area) { best = {a, rect}; area = s; }
  }
  return best;
}
// What "Ask AI about this" attaches to the chat: the passage (or the note), with the reader's comment.
export function contextText(a) {
  const text = squash(a.text), comment = squash(a.comment);
  return (a.kind === 'note' ? (comment ? `My note at this spot of the page: “${comment}”` : '')
    : text + (comment ? `${text ? ' — ' : ''}my comment on this passage: “${comment}”` : '')).slice(0, LIMITS.text);
}
// pdf.js colour ([r, g, b], 0–255) as #rrggbb; the default when the annotation has none.
export const hexColor = c => c?.length === 3 && [...c].every(v => Number.isFinite(v)) ? '#' + [...c].map(v => Math.min(255, Math.max(0, Math.round(v))).toString(16).padStart(2, '0')).join('') : DEFAULT_COLOR;
// A PDF date string ("D:20240131120000+01'00'") as ISO time, or null.
export function pdfDate(s) {
  const m = /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?\s*(?:(Z)|([+-])(\d{2})'?(\d{2})?'?)?/.exec(typeof s === 'string' ? s.trim() : '');
  if (!m) return null;
  const t = Date.UTC(+m[1], +(m[2] || 1) - 1, +(m[3] || 1), +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) - (m[8] ? (m[8] === '-' ? -1 : 1) * (+m[9] * 60 + +(m[10] || 0)) * 60e3 : 0);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
// File name of the exported PDF, from the paper's title.
export const exportName = title => (squash(String(title ?? '').replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')).slice(0, 120).trim() || 'paper') + ' (annotated).pdf';

// ---------- annotations already in the PDF (pdf.js page.getAnnotations()) ----------
const contentsOf = a => String(a.contentsObj?.str ?? a.contents ?? '').trim();
// Highlights and sticky notes (Text annotations; review-status marks are not comments) that are objects
// of the file. These are imported, and from then on drawn by Margin instead of by pdf.js.
export const isImportable = a => !!a && (a.subtype === 'Highlight' || (a.subtype === 'Text' && !a.state && !a.stateModel)) && PDF_ID.test(String(a.id));
// Import payload from per-page data [{page, annots, transform, W, H, boxes}] (viewport at scale 1; boxes:
// the page's text items, for the highlighted words). A Text annotation that replies to another becomes
// a reply of the first annotation of its thread; when that one is not imported it stays a note of its own.
export function importItems(pagesData) {
  const out = [], byId = new Map(), replies = [], parent = new Map();
  const note = (a, p) => { const c = rectCorner(a.rect, p.transform, p.W, p.H); return {kind: 'note', page: p.page, rects: [{x0: c.x, y0: c.y, x1: c.x, y1: c.y}], color: hexColor(a.color), text: '', comment: contentsOf(a).slice(0, LIMITS.comment), pdfId: a.id, replies: [], createdAt: pdfDate(a.creationDate) || pdfDate(a.modificationDate) || undefined}; };
  for (const p of pagesData) for (const a of p.annots || []) {
    if (!isImportable(a)) continue;
    let item = null;
    if (a.subtype === 'Highlight') {
      const r = a.rect, quads = a.quadPoints?.length >= 8 ? a.quadPoints : r?.length === 4 ? [r[0], r[3], r[2], r[3], r[0], r[1], r[2], r[1]] : null;
      const rects = quadRects(quads, p.transform, p.W, p.H).slice(0, LIMITS.rects); if (!rects.length) continue;
      item = {kind: 'highlight', page: p.page, rects, color: hexColor(a.color), text: textUnder(p.boxes || [], rects, p.W, p.H), comment: contentsOf(a).slice(0, LIMITS.comment), pdfId: a.id, replies: [], createdAt: pdfDate(a.creationDate) || pdfDate(a.modificationDate) || undefined};
    } else {
      if (a.inReplyTo) { replies.push({a, p}); parent.set(a.id, a.inReplyTo); continue; }
      if (a.rect?.length !== 4) continue;
      item = note(a, p);
    }
    byId.set(a.id, item); out.push(item);
  }
  const root = id => { for (let i = 0; i < 50 && parent.has(id); i++) id = parent.get(id); return id; };
  replies.sort((x, y) => String(pdfDate(x.a.creationDate) || '').localeCompare(String(pdfDate(y.a.creationDate) || '')));
  for (const {a, p} of replies) {
    const to = byId.get(root(a.id)), text = contentsOf(a);
    if (to) { if (text) to.replies.push({text: text.slice(0, LIMITS.reply), ...aiAuthor(a.titleObj?.str), ...(pdfDate(a.creationDate) ? {at: pdfDate(a.creationDate)} : {})}); }
    else if (text && a.rect?.length === 4) out.push(note(a, p));
  }
  return out;
}

// Replies that Margin exported as written by the AI carry the author "AI" or "AI (model)" (lib/pdf-annotate.mjs);
// read back, they are AI replies again. Any other author is the reader.
export function aiAuthor(title) {
  const m = /^AI(?: \(([A-Za-z0-9._:-]{1,100})\))?$/.exec(String(title ?? '').trim());
  return m ? {author: 'ai', ...(m[1] ? {model: m[1]} : {})} : {};
}

// ---------- UI ----------
const ICON = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 2.5h14A1.5 1.5 0 0 1 18.5 4v9a1.5 1.5 0 0 1-1.5 1.5H9.5l-4 3.5v-3.5H3A1.5 1.5 0 0 1 1.5 13V4A1.5 1.5 0 0 1 3 2.5z" fill="var(--ann-color)" stroke="#000000b3" stroke-width="1.2" stroke-linejoin="round"/><path d="M5.5 6.5h9M5.5 9.5h6" stroke="#000000a6" stroke-width="1.2" stroke-linecap="round" fill="none"/></svg>';
const COLOR_KEY = 'margin-hl-color', PANEL_KEY = 'margin-comments-open';

// app: {pdf, h, api, notice, confirmBox, state() -> {doc, pageBoxes}, storageMode (pdf.js AnnotationMode.ENABLE_STORAGE),
//   renderBody(text) -> element or null while the Markdown code loads, loadMarkdown(), jump(page, y), visiblePages(),
//   rerender(pageEl), cropRegion(page, box), attach(context), title(), save(bytes, name), onMode(on)}
export function createAnnotations(app) {
  const {h, api, notice} = app, $ = s => document.querySelector(s);
  let paperId = null, epoch = 0;       // epoch: changes when the paper closes; results of older requests are dropped
  let items = [], imported = null;     // imported: what the server said (null: not known, e.g. the list could not be loaded)
  let loaded = Promise.resolve(), hideNative = false, selected = null, pop = null, placing = false, exporting = false;
  const pending = new Set(), errors = new Map(); // AI replies being written; the last error per annotation
  const drafts = new Map(), editing = new Set(); // unsaved text and open comment editors, by `${where}:${id}`
  let color = DEFAULT_COLOR;
  try { const c = localStorage.getItem(COLOR_KEY); if (COLORS.some(x => x[1] === c)) color = c; } catch {}

  const base = () => `/api/papers/${paperId}/annotations`;
  const byId = id => items.find(a => a.id === id);
  const put = a => { items = items.map(x => x.id === a.id ? a : x); };
  const pageEl = n => document.querySelector(`.pdf-page[data-page="${n}"]`);
  const when = at => { const d = new Date(at); return isNaN(d) ? '' : d.toLocaleString([], {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'}); };
  const hasThread = a => !!(a.comment || a.replies.length);
  const labelled = (el, label) => { el.setAttribute('aria-label', label); return el; };

  // ---------- on the page ----------
  function draw(el) {
    const n = Number(el.dataset.page), list = items.filter(a => a.page === n), old = el.querySelector(':scope > .ann-layer');
    if (!list.length) { old?.remove(); return; }
    const layer = h('div', {className: 'ann-layer'});
    for (const a of list) {
      const sel = a.id === selected ? ' selected' : '', r0 = a.rects[0];
      if (a.kind === 'note') layer.append(noteEl(a, sel));
      else {
        for (const r of a.rects) {
          const d = h('div', {className: 'ann-hl' + sel}); d.dataset.id = a.id; d.style.background = a.color;
          Object.assign(d.style, {left: r.x0 * 100 + '%', top: r.y0 * 100 + '%', width: (r.x1 - r.x0) * 100 + '%', height: (r.y1 - r.y0) * 100 + '%'});
          layer.append(d);
        }
        if (hasThread(a)) {
          const b = labelled(h('button', {type: 'button', className: 'ann-mark' + sel, innerHTML: ICON, title: truncate(a.comment || plural(a.replies.length, 'reply'), 200), onclick: () => togglePop(a)}), `Comment on a highlight, page ${a.page}`);
          b.dataset.id = a.id; b.style.setProperty('--ann-color', a.color); Object.assign(b.style, {left: r0.x1 * 100 + '%', top: r0.y0 * 100 + '%'});
          layer.append(b);
        }
      }
    }
    if (old) old.replaceWith(layer); else el.append(layer);
  }
  function drawPages() {
    const ps = new Set(items.map(a => a.page));
    document.querySelectorAll('.pdf-page').forEach(el => { if (ps.has(Number(el.dataset.page)) || el.querySelector(':scope > .ann-layer')) draw(el); });
  }
  function noteEl(a, sel) {
    const r = a.rects[0];
    const b = labelled(h('button', {type: 'button', className: 'ann-note' + sel + (a.replies.length ? ' has-thread' : ''), innerHTML: ICON, title: a.comment ? truncate(a.comment, 200) : 'Note (drag to move)'}), `Note on page ${a.page}${a.comment ? ': ' + truncate(a.comment, 80) : ''}`);
    b.dataset.id = a.id; b.style.setProperty('--ann-color', a.color); Object.assign(b.style, {left: r.x0 * 100 + '%', top: r.y0 * 100 + '%'});
    b.onclick = () => { if (b.dragged) { b.dragged = false; return; } togglePop(a); };
    b.onpointerdown = e => {
      if (e.button !== 0) return;
      e.preventDefault();
      const el = b.closest('.pdf-page'), br = b.getBoundingClientRect(), dx = e.clientX - br.left, dy = e.clientY - br.top, sx = e.clientX, sy = e.clientY;
      let pos = null;
      const move = ev => {
        if (!pos && Math.hypot(ev.clientX - sx, ev.clientY - sy) < DRAG_PX) return;
        const pr = el.getBoundingClientRect(), fit = (v, size, total) => Math.min(Math.max(0, 1 - size / total), Math.max(0, v / total));
        pos = {x0: fit(ev.clientX - dx - pr.left, br.width, pr.width), y0: fit(ev.clientY - dy - pr.top, br.height, pr.height)};
        b.style.left = pos.x0 * 100 + '%'; b.style.top = pos.y0 * 100 + '%'; b.classList.add('dragging');
      };
      const up = async () => {
        for (const [t, f] of [['pointermove', move], ['pointerup', up], ['pointercancel', up]]) b.removeEventListener(t, f);
        if (!pos) return;
        b.dragged = true; setTimeout(() => { b.dragged = false; }, 50); b.classList.remove('dragging');
        const e0 = epoch;
        try { const r = await api(`${base()}/${a.id}`, {method: 'PATCH', body: {rects: [{x0: pos.x0, y0: pos.y0, x1: pos.x0, y1: pos.y0}]}}); if (e0 === epoch) put(r); }
        catch (err) { notice('Could not move the note: ' + err.message); }
        if (e0 === epoch) refresh();
      };
      b.setPointerCapture(e.pointerId);
      for (const [t, f] of [['pointermove', move], ['pointerup', up], ['pointercancel', up]]) b.addEventListener(t, f);
    };
    return b;
  }
  function select(id, scrollPanel = false) {
    selected = id;
    document.querySelectorAll('.ann-layer [data-id],#ann-list .ann-item').forEach(x => x.classList.toggle('selected', x.dataset.id === id));
    if (scrollPanel && id) $(`#ann-list .ann-item[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({block: 'nearest'});
  }
  function flash(id) {
    const els = document.querySelectorAll(`.ann-layer [data-id="${CSS.escape(id)}"]`);
    els.forEach(x => { x.classList.remove('flash'); void x.offsetWidth; x.classList.add('flash'); });
    setTimeout(() => els.forEach(x => x.classList.remove('flash')), 1600);
  }
  // From the panel: bring the annotation into view and flash it.
  async function reveal(a) {
    const e = epoch; select(a.id);
    await app.jump(a.page, a.rects[0].y0);
    if (e === epoch) flash(a.id);
  }

  // ---------- the popover of one annotation (a child of its page, so it scrolls and zooms with it) ----------
  function openPop(a, at = null, edit = false) {
    closePop();
    const el = pageEl(a.page); if (!el) return;
    if (edit) editing.add(`pop:${a.id}`);
    const box = labelled(h('div', {className: 'ann-pop'}), a.kind === 'note' ? 'Note' : 'Highlight'); box.setAttribute('role', 'dialog');
    pop = {id: a.id, el: box, at};
    el.append(box); select(a.id, true); renderPop();
    box.scrollIntoView({block: 'nearest', inline: 'nearest'});
    if (edit) box.querySelector('[data-role=comment]')?.focus({preventScroll: true});
  }
  const togglePop = a => pop?.id === a.id ? closePop() : openPop(a);
  // Closing saves a comment still being edited; a note left without any text is deleted.
  function closePop() {
    if (!pop) return;
    const {id, el} = pop, a = byId(id), k = `pop:${id}`; pop = null; el.remove();
    if (!a) return;
    const dropEmpty = () => { const now = byId(id); if (now && now.kind === 'note' && now.origin !== 'pdf' && !now.comment && !now.replies.length && !pending.has(id)) remove(now, true); };
    if (editing.has(k)) saveComment(a, 'pop').then(dropEmpty); else dropEmpty();
  }
  function renderPop() {
    if (!pop) return;
    const a = byId(pop.id); if (!a) { pop.el.remove(); pop = null; return; }
    const r = a.rects[0], note = a.kind === 'note';
    // Below the anchor (a note's icon, or the clicked line of a highlight); shifted left by the anchor's
    // share of its own width, so it stays inside the page from edge to edge.
    const u = note ? r.x0 : pop.at?.u ?? (r.x0 + r.x1) / 2, v = note ? r.y0 : pop.at?.v ?? r.y1;
    Object.assign(pop.el.style, {left: u * 100 + '%', top: `calc(${v * 100}% + ${note ? `max(16px, ${NOTE_PT}px * var(--total-scale-factor)) + ` : ''}6px)`, transform: `translateX(${-u * 100}%)`});
    pop.el.replaceChildren(itemView(a, 'pop'));
  }

  // ---------- one annotation as shown in the panel and in the popover ----------
  const md = text => {
    const ready = app.renderBody(text); if (ready) return ready;
    const el = h('div', {className: 'message-body', textContent: text});
    app.loadMarkdown().then(() => { const b = el.isConnected && app.renderBody(text); if (b) el.replaceWith(b); }).catch(() => {});
    return el;
  };
  function swatches(current, pick) {
    return h('span', {className: 'ann-swatches'}, ...COLORS.map(([name, c]) => {
      const b = labelled(h('button', {type: 'button', className: 'ann-swatch', title: name, onclick: () => pick(c)}), `Colour: ${name.toLowerCase()}`);
      b.style.background = c; b.setAttribute('aria-pressed', c === current);
      return b;
    }));
  }
  function itemView(a, where) {
    const k = `${where}:${a.id}`, busy = pending.has(a.id);
    const box = h('div', {className: `ann-item${a.id === selected ? ' selected' : ''}`}); box.dataset.id = a.id;
    const label = `PAGE ${a.page} · ${a.kind === 'note' ? 'NOTE' : 'HIGHLIGHT'}${a.origin === 'pdf' ? ' · FROM THE PDF' : ''}`;
    const x = (title, run, cls = '') => labelled(h('button', {type: 'button', className: 'icon ann-x ' + cls, textContent: '×', title, onclick: run}), title);
    const chip = h('span', {className: 'ann-chip'}); chip.style.background = a.color;
    const head = h('div', {className: 'ann-head'}, chip,
      where === 'panel' ? h('button', {type: 'button', className: 'ann-where', textContent: label, title: 'Show in the paper', onclick: () => reveal(a)}) : h('small', {className: 'ann-where', textContent: label}));
    head.append(...(where === 'pop' ? [swatches(a.color, c => recolor(a, c)), x('Close (Esc)', closePop)] : [x('Delete this annotation', () => remove(a), 'ann-del')]));
    const main = h('div', {className: 'ann-main'});
    if (a.text) {
      const q = where === 'panel' ? h('button', {type: 'button', className: 'ann-quote', textContent: `“${truncate(a.text, QUOTE_CHARS.panel)}”`, title: 'Show in the paper', onclick: () => reveal(a)})
        : h('div', {className: 'ann-quote', textContent: `“${truncate(a.text, QUOTE_CHARS.pop)}”`});
      q.style.borderLeftColor = a.color; main.append(q);
    }
    if (editing.has(k)) {
      const ta = labelled(h('textarea', {value: drafts.get(k) ?? a.comment, maxLength: LIMITS.comment, rows: 3, placeholder: a.kind === 'note' ? 'Write a note…' : 'Add a comment…'}), 'Comment');
      ta.dataset.role = 'comment'; ta.oninput = () => drafts.set(k, ta.value);
      ta.onkeydown = e => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveComment(a, where).then(refresh); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelEdit(a, where); }
      };
      main.append(h('div', {className: 'ann-edit'}, ta, h('div', {className: 'ann-edit-buttons'}, h('small', {textContent: 'Ctrl+Enter saves'}),
        h('button', {type: 'button', className: 'small', textContent: 'Cancel', onclick: () => cancelEdit(a, where)}),
        h('button', {type: 'button', className: 'small primary', textContent: 'Save', onclick: () => saveComment(a, where).then(refresh)}))));
    } else if (a.comment) {
      const c = h('div', {className: 'ann-comment', tabIndex: 0, textContent: a.comment, title: 'Edit this comment', onclick: () => { if (!getSelection().toString()) startEdit(a, where); }});
      c.setAttribute('role', 'button'); c.dataset.role = 'comment-text';
      c.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); startEdit(a, where); } };
      main.append(c);
    } else {
      const add = h('button', {type: 'button', className: 'ann-add', textContent: a.kind === 'note' ? 'Write a note…' : 'Add a comment…', onclick: () => startEdit(a, where)});
      add.dataset.role = 'comment-text'; main.append(add);
    }
    // "Make AI answer this": shown while the pointer or the focus is on the comment (always on touch screens).
    if (a.comment || a.replies.length || a.text) {
      const ai = h('button', {type: 'button', className: 'small ann-ai', textContent: busy ? 'AI is answering…' : 'Make AI answer this', disabled: busy,
        title: a.comment || a.replies.length ? 'The AI replies to this comment thread, using the text of this page' : 'The AI explains the highlighted passage', onclick: () => aiReply(a)});
      ai.dataset.role = 'ai'; main.append(ai);
    }
    const thread = h('div', {className: 'ann-thread'}, ...a.replies.map(r => {
      const ai = r.author === 'ai';
      return h('div', {className: 'ann-reply' + (ai ? ' ai' : '')}, h('div', {className: 'ann-reply-head'},
        h('small', {textContent: (ai ? `AI${r.model ? ' · ' + r.model : ''}` : 'YOU') + (when(r.at) ? ' · ' + when(r.at) : '')}), x(ai ? 'Delete this AI reply' : 'Delete this reply', () => removeReply(a, r))),
        ai ? md(r.text) : h('div', {className: 'ann-reply-text', textContent: r.text}));
    }));
    if (busy) thread.append(labelled(h('div', {className: 'ann-reply ai thinking'}, h('div', {className: 'ann-reply-head'}, h('small', {textContent: 'AI · THINKING'})), h('div', {className: 'dots'}, h('span'), h('span'), h('span'))), 'The AI is thinking'));
    if (errors.has(a.id)) { const p = h('p', {className: 'ann-error', textContent: errors.get(a.id)}); p.setAttribute('role', 'alert'); thread.append(p); }
    box.append(head, main, thread);
    if (hasThread(a)) {
      const input = labelled(h('input', {type: 'text', maxLength: LIMITS.reply, placeholder: 'Reply…', value: drafts.get(k + ':reply') ?? '', autocomplete: 'off'}), 'Reply');
      input.dataset.role = 'reply'; input.oninput = () => drafts.set(k + ':reply', input.value);
      box.append(h('form', {className: 'ann-reply-box', onsubmit: e => { e.preventDefault(); reply(a, where); }}, input, h('button', {type: 'submit', className: 'small', textContent: 'Reply'})));
    }
    if (where === 'pop') box.append(h('div', {className: 'ann-actions'},
      ...(contextText(a) ? [h('button', {type: 'button', className: 'small primary', textContent: 'Ask AI about this ↗', title: 'Attach this to your next chat question', onclick: () => ask(a)})] : []),
      h('button', {type: 'button', className: 'small ann-delete', textContent: 'Delete', onclick: () => remove(a)})));
    return box;
  }
  function renderPanel() {
    const n = items.length, t = $('#ann-toggle');
    t.querySelector('.ann-count')?.remove();
    if (n) t.append(h('span', {className: 'ann-count', textContent: n}));
    $('#ann-total').textContent = n || ''; $('#ann-total').title = n ? plural(n, 'annotation') : '';
    $('#ann-export').disabled = !paperId || exporting;
    if ($('#ann-panel').hidden) return;
    $('#ann-list').replaceChildren(...(n ? sortAnnotations(items).map(a => itemView(a, 'panel'))
      : [h('p', {className: 'ann-empty', textContent: paperId ? 'Select text to highlight it, or add a note.' : 'Open a paper to see its highlights and notes.'})]));
  }
  // Redraw everything from `items`, keeping the focus (and caret) in the field that had it.
  function refresh() {
    const act = document.activeElement, host = act?.closest?.('#ann-list,.ann-pop');
    const keep = host && act.dataset.role ? {panel: host.id === 'ann-list', id: act.closest('.ann-item')?.dataset.id, role: act.dataset.role, a: act.selectionStart, b: act.selectionEnd} : null;
    drawPages(); renderPanel(); renderPop();
    if (!keep?.id) return;
    const el = (keep.panel ? $('#ann-list') : pop?.el)?.querySelector(`.ann-item[data-id="${CSS.escape(keep.id)}"] [data-role="${keep.role}"]`);
    if (el) { el.focus({preventScroll: true}); try { el.setSelectionRange(keep.a, keep.b); } catch {} }
  }
  const focusRole = (where, id, role) => (where === 'panel' ? $('#ann-list') : pop?.el)?.querySelector(`.ann-item[data-id="${CSS.escape(id)}"] [data-role="${role}"]`)?.focus({preventScroll: true});

  // ---------- changes ----------
  function startEdit(a, where) { editing.add(`${where}:${a.id}`); refresh(); focusRole(where, a.id, 'comment'); }
  function cancelEdit(a, where) {
    const k = `${where}:${a.id}`; editing.delete(k); drafts.delete(k);
    if (where === 'pop' && a.kind === 'note' && !hasThread(a)) closePop(); else { refresh(); focusRole(where, a.id, 'comment-text'); }
  }
  // Stores the comment being edited (nothing is sent when it did not change). The caller redraws.
  async function saveComment(a, where) {
    const k = `${where}:${a.id}`, text = (drafts.get(k) ?? a.comment).trim().slice(0, LIMITS.comment), e = epoch, url = `${base()}/${a.id}`;
    editing.delete(k);
    if (text === a.comment) { drafts.delete(k); return; }
    try { const r = await api(url, {method: 'PATCH', body: {comment: text}}); if (e !== epoch) return; put(r); drafts.delete(k); errors.delete(a.id); }
    catch (err) { if (e !== epoch) return; editing.add(k); notice('Could not save the comment: ' + err.message); } // the text stays in the editor
    if (e === epoch && !pop && where === 'pop') refresh(); // saved while the popover closed: the page marks and the panel still show the old text
  }
  async function recolor(a, c) {
    const e = epoch, was = a.color;
    put({...a, color: c}); refresh();
    try { const r = await api(`${base()}/${a.id}`, {method: 'PATCH', body: {color: c}}); if (e !== epoch) return; put({...byId(a.id), color: r.color, updatedAt: r.updatedAt}); }
    catch (err) { if (e !== epoch) return; const now = byId(a.id); if (now) put({...now, color: was}); notice('Could not change the colour: ' + err.message); }
    refresh();
  }
  async function reply(a, where) {
    const k = `${where}:${a.id}:reply`, text = (drafts.get(k) || '').trim(), e = epoch; if (!text) return;
    try { const r = await api(`${base()}/${a.id}/replies`, {body: {text}}); if (e !== epoch) return; put(r); drafts.delete(k); errors.delete(a.id); }
    catch (err) { if (e !== epoch) return; errors.set(a.id, err.message); notice('Could not add the reply: ' + err.message); }
    refresh();
  }
  async function removeReply(a, r) {
    const e = epoch;
    try { const out = await api(`${base()}/${a.id}/replies/${r.id}`, {method: 'DELETE'}); if (e !== epoch) return; put(out); }
    catch (err) { if (e !== epoch) return; notice('Could not delete the reply: ' + err.message); }
    refresh();
  }
  // Deleting an annotation that has a comment or replies asks first (there is no undo); quiet: no question, e.g. an empty note.
  async function remove(a, quiet = false) {
    if (!quiet && hasThread(a) && !await app.confirmBox({title: `Delete this ${a.kind === 'note' ? 'note' : 'highlight'}?`, ok: 'Delete', body: [
      a.replies.length ? `Its ${a.comment ? 'comment and ' : ''}${plural(a.replies.length, 'reply')} will be deleted.` : 'Its comment will be deleted.', {className: 'hint', textContent: 'This cannot be undone.'}]})) return;
    const e = epoch;
    try { await api(`${base()}/${a.id}`, {method: 'DELETE'}); }
    catch (err) { if (e !== epoch) return; if (err.status !== 404) { notice('Could not delete the annotation: ' + err.message); return; } }
    if (e !== epoch) return;
    items = items.filter(x => x.id !== a.id);
    if (pop?.id === a.id) { pop.el.remove(); pop = null; }
    if (selected === a.id) selected = null;
    errors.delete(a.id); for (const m of [drafts, editing]) for (const k of [...m.keys()]) if (k.split(':')[1] === a.id) m.delete(k);
    refresh();
  }
  // "Make AI answer this": the server writes the reply (it can take many seconds) and returns the annotation.
  async function aiReply(a) {
    if (pending.has(a.id)) return;
    const e = epoch, url = `${base()}/${a.id}/ai-reply`;
    pending.add(a.id); errors.delete(a.id); refresh();
    try { const r = await api(url, {method: 'POST'}); if (e !== epoch) return; put(r); }
    catch (err) { if (e !== epoch) return; errors.set(a.id, err.message); notice(err.message); }
    finally { if (e === epoch) { pending.delete(a.id); refresh(); } }
  }
  // "Ask AI about this": the passage with the reader's comment (or the area around a note) goes to the chat composer.
  async function ask(a) {
    const box = a.kind === 'note' ? noteBox(a.rects[0]) : unionBox(a.rects), e = epoch;
    let image = null; try { image = await app.cropRegion(a.page, box); } catch {}
    if (e !== epoch) return;
    closePop();
    app.attach({kind: 'passage', page: a.page, text: contextText(a), box, image});
  }

  // ---------- creating ----------
  // Text of a selection per page: [{page, rects, text}] with one normalised rect per line. Only text-layer
  // text counts, piece by piece (a range's own rects also include whole pages and canvases it spans).
  function selectionParts(range) {
    const root = range.commonAncestorContainer, nodes = [], by = new Map();
    if (root.nodeType === 3) nodes.push(root);
    else { const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); while (w.nextNode()) if (range.intersectsNode(w.currentNode)) nodes.push(w.currentNode); }
    for (const n of nodes) {
      const layer = n.parentElement?.closest('.textLayer'); if (!layer || n.parentElement.closest('.endOfContent')) continue;
      const r = document.createRange(); r.selectNodeContents(n);
      if (n === range.startContainer) r.setStart(n, range.startOffset);
      if (n === range.endContainer) r.setEnd(n, range.endOffset);
      const s = r.toString(), rs = [...r.getClientRects()].map(c => ({x0: c.left, y0: c.top, x1: c.right, y1: c.bottom})).filter(c => c.x1 - c.x0 > 0 && c.y1 - c.y0 > 0);
      if (!s.trim() || !rs.length) continue;
      const el = layer.parentElement; let p = by.get(el); if (!p) by.set(el, p = {rects: [], pieces: []});
      p.rects.push(...rs); p.pieces.push({s, ...unionBox(rs)});
    }
    return [...by].map(([el, p]) => ({page: Number(el.dataset.page), rects: normRects(mergeLineRects(p.rects), el.getBoundingClientRect()), text: joinPieces(p.pieces).slice(0, LIMITS.text)})).filter(p => p.rects.length && p.text);
  }
  // One highlight per page of the selection; with `comment` the first one opens with its comment editor.
  async function highlight(parts, c, comment = false) {
    if (!paperId || !parts?.length) return;
    if (c && c !== color) { color = c; try { localStorage.setItem(COLOR_KEY, c); } catch {} }
    const e = epoch, url = base(), made = [];
    for (const p of parts) {
      if (p.rects.length > LIMITS.rects) notice(`A highlight covers at most ${LIMITS.rects} lines; the rest of page ${p.page} was left out.`);
      try { const a = await api(url, {body: {kind: 'highlight', page: p.page, rects: p.rects.slice(0, LIMITS.rects), color, text: p.text, comment: ''}}); if (e !== epoch) return; items.push(a); made.push(a); }
      catch (err) { if (e === epoch) notice('Could not save the highlight: ' + err.message); break; }
    }
    if (e !== epoch) return;
    refresh();
    if (comment && made[0]) openPop(made[0], null, true);
  }
  function setPlacing(on, quiet = false) {
    if (on && !paperId) { notice('Open a paper first.'); on = false; }
    if (on === placing) return;
    placing = on; app.pdf.classList.toggle('noting', on);
    const b = $('#note-mode'); b.classList.toggle('active', on); b.setAttribute('aria-pressed', on);
    if (on) { closePop(); app.onMode(true); if (!quiet) notice('Add note: click the spot on the page where the note should go. Esc cancels.'); }
  }
  app.pdf.addEventListener('click', async e => {
    if (!placing) return;
    const el = e.target.closest('.pdf-page'); if (!el) return;
    const r = el.getBoundingClientRect(), W = Number(el.dataset.width), H = Number(el.dataset.height), e0 = epoch;
    // The icon is centred on the click and kept inside the page.
    const x = Math.min(Math.max(0, 1 - NOTE_PT / W), Math.max(0, (e.clientX - r.left) / r.width - NOTE_PT / 2 / W)), y = Math.min(Math.max(0, 1 - NOTE_PT / H), Math.max(0, (e.clientY - r.top) / r.height - NOTE_PT / 2 / H));
    setPlacing(false);
    try {
      const a = await api(base(), {body: {kind: 'note', page: Number(el.dataset.page), rects: [{x0: x, y0: y, x1: x, y1: y}], color: DEFAULT_COLOR, text: '', comment: ''}});
      if (e0 !== epoch) return;
      items.push(a); refresh(); openPop(a, null, true);
    } catch (err) { if (e0 === epoch) notice('Could not add the note: ' + err.message); }
  });
  document.addEventListener('keydown', e => { if (e.key !== 'Escape') return; if (placing) setPlacing(false); else if (pop && !$('#confirm')?.open) closePop(); });
  document.addEventListener('mousedown', e => {
    if (!pop || e.target.closest?.('.ann-pop,#confirm')) return;
    const own = e.target.closest?.('.ann-layer [data-id]'); // a press on its own icon closes it through the icon's click
    if (own?.dataset.id !== pop.id) closePop();
  });
  $('#note-mode').onclick = () => setPlacing(!placing);

  // ---------- panel ----------
  function showPanel(on) {
    const panel = $('#ann-panel'), was = panel.hidden;
    panel.hidden = !on; $('#ann-toggle').setAttribute('aria-pressed', on);
    // Slide in when it opens (not when it is restored open at startup); the class goes away with the animation.
    if (on && was) { panel.classList.add('ann-in'); panel.addEventListener('animationend', () => panel.classList.remove('ann-in'), {once: true}); }
    try { localStorage.setItem(PANEL_KEY, on ? '1' : ''); } catch {}
    renderPanel();
    if (on && selected) select(selected, true);
  }
  $('#ann-toggle').onclick = () => showPanel($('#ann-panel').hidden);
  $('#ann-close').onclick = () => { showPanel(false); $('#ann-toggle').focus(); };
  $('#ann-export').onclick = async () => {
    if (!paperId || exporting) return;
    const e = epoch, url = `/api/papers/${paperId}/annotated.pdf`, name = exportName(app.title());
    exporting = true; renderPanel(); notice('Preparing the annotated PDF…');
    try { const bytes = await api(url, {binary: true}); app.save(bytes, name); notice(`Annotated PDF saved as “${name}”${window.marginDesktop ? '' : ' (see your browser’s downloads)'}.`); }
    catch (err) { notice('Could not export the annotated PDF: ' + err.message); }
    finally { exporting = false; if (e === epoch || !paperId) renderPanel(); }
  };

  // ---------- loading, and annotations already in the PDF ----------
  // Once the PDF's own highlights and notes are imported, Margin draws them, so pdf.js must not paint them
  // too: each such annotation is marked "not viewed" in the document's annotation storage and pages are
  // rendered with that storage. Everything else the PDF draws (links, form fields, stamps, ink…) is unchanged.
  async function renderOpts(page) {
    if (!hideNative) return {};
    try {
      const ids = (await page.getAnnotations()).filter(isImportable).map(a => a.id); if (!ids.length) return {};
      const st = app.state().doc?.annotationStorage; if (!st) return {};
      for (const id of ids) if (!st.has(id)) st.setValue(id, {noView: true});
      return {annotationMode: app.storageMode};
    } catch { return {}; }
  }
  async function setHidden(e) {
    hideNative = true;
    const {doc} = app.state(); if (!doc) return;
    for (const el of app.visiblePages()) {
      try { const page = await doc.getPage(Number(el.dataset.page)); if (e !== epoch) return; if ((await page.getAnnotations()).some(isImportable)) app.rerender(el); } catch {}
      if (e !== epoch) return;
    }
  }
  function open(id) {
    reset(); paperId = id;
    const e = epoch;
    loaded = api(base()).then(r => {
      if (e !== epoch) return;
      items = r.items || []; imported = !!r.imported;
      if (imported) setHidden(e);
      refresh();
    }).catch(err => { if (e === epoch) { imported = null; notice('Could not load the annotations of this paper: ' + err.message); } });
    renderPanel();
  }
  // All pages are indexed: read the PDF's own annotations once per paper (the server remembers that it was done).
  function docReady() {
    const e = epoch;
    loaded.then(async () => {
      if (e !== epoch || imported !== false) return;
      const {doc, pageBoxes} = app.state(), data = [];
      try {
        for (let n = 1; n <= doc.numPages; n++) {
          const page = await doc.getPage(n), annots = await page.getAnnotations();
          if (e !== epoch) return;
          if (!annots.some(isImportable)) continue;
          const vp = page.getViewport({scale: 1});
          data.push({page: n, annots, transform: vp.transform, W: vp.width, H: vp.height, boxes: pageBoxes[n] || []});
        }
        const found = importItems(data), r = await api(base() + '/import', {body: {items: found}});
        if (e !== epoch) return;
        items = r.items || []; imported = true;
        const n = items.filter(a => a.origin === 'pdf').length;
        refresh(); await setHidden(e);
        if (n) notice(`${plural(n, 'annotation')} found in the PDF ${n === 1 ? 'is' : 'are'} now in Comments.`);
      } catch (err) { if (e === epoch) notice('Could not read the annotations inside this PDF: ' + err.message); }
    });
  }
  function reset() {
    epoch++; paperId = null; items = []; imported = null; hideNative = false; selected = null; loaded = Promise.resolve();
    pop?.el.remove(); pop = null; exporting = false;
    for (const m of [pending, errors, drafts, editing]) m.clear();
    setPlacing(false, true); renderPanel();
  }
  try { if (localStorage.getItem(PANEL_KEY)) { $('#ann-panel').hidden = false; $('#ann-toggle').setAttribute('aria-pressed', true); } } catch {}
  renderPanel();

  return {
    open, docReady, reset, renderOpts, selectionParts, highlight, setPlacing, closePop,
    mount: el => { if (items.length) draw(el); },
    // A click on the page at (u, v): opens the highlight there, if any.
    clickAt(el, u, v) { const hit = hitTest(items, Number(el.dataset.page), u, v); if (hit) openPop(hit.a, {u, v: hit.rect.y1}); return !!hit; },
    get placing() { return placing; }, get color() { return color; },
  };
}
