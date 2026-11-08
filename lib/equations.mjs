// Equation frames of a paper: the stored corrections format, merging them with automatic detection,
// AI labelling results (parsing, snapping to the page, merging as suggestions) and its cost estimate.
// Shared by the server (validation, migration) and the app (everything else). No DOM, no Node APIs.
//
// Stored per paper as `overrides`, keyed by equation label:
//   {"12": {page: 3, box: {x0, y0, x1, y1}, source: 'user'|'ai', accepted: true|false}}  a frame
//   {"7":  {deleted: true, pages: [10]}}   automatic detections of (7) removed (on those pages; no pages: everywhere)
// Boxes are normalised to the page (0..1, top-left origin). A frame with accepted false is an AI suggestion
// waiting for a decision: shown in edit mode only, it changes nothing else. An accepted frame (every user
// frame) replaces all automatic detections with the same label, on any page.
// Older versions stored {page, y} (a position only); those are read as a full-width band at y.

// Equation numbers: 12, 12b, per-section 3.12 / 3.12b, appendix A.3 / A3.
export const LABEL = /^(?:\d{1,3}(?:\.\d{1,3})?|[A-Z]\.?\d{1,3})[a-z]?$/i;
export const MAX_OVERRIDES = 2000, MAX_PAGE = 300;

// A typed or model-returned label in canonical form ("(12)" -> "12", "Eq. 3a" -> "3a", "5-a" -> "5a"), or null.
export function normalizeLabel(s) {
  if (typeof s !== 'string' && typeof s !== 'number') return null;
  let t = String(s).trim().replace(/^(?:eqs?\.?|equations?)\s*/i, '').replace(/\s+/g, '');
  const m = /^[([{]?(.*?)[)\]}]?$/.exec(t); t = m ? m[1] : t;
  t = t.replace(/^(\d{1,3}(?:\.\d{1,3})?|[A-Z]\.?\d{1,3})-([a-z])$/i, '$1$2');
  return LABEL.test(t) ? t : null;
}
export const LABEL_HINT = 'Use an equation number like 12, 3a, 2.14 or A.3.';

const fin01 = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
const MIN_SIZE = 0.002; // a frame at least ~1.5 pt on a letter page
export function cleanBox(b) {
  if (!b || typeof b !== 'object' || ![b.x0, b.y0, b.x1, b.y1].every(fin01)) return null;
  if (b.x1 - b.x0 < MIN_SIZE || b.y1 - b.y0 < MIN_SIZE) return null;
  const r = v => Math.round(v * 1e5) / 1e5;
  return {x0: r(b.x0), y0: r(b.y0), x1: r(b.x1), y1: r(b.y1)};
}
const validPage = p => Number.isInteger(p) && p >= 1 && p <= MAX_PAGE;
// The band older versions highlighted for a {page, y} correction (same left/width/height as their marker).
export const legacyBox = y => ({x0: 0.04, y0: Math.max(0, Math.round((y - 0.03) * 1e5) / 1e5), x1: 0.96, y1: Math.min(1, Math.round((y + 0.04) * 1e5) / 1e5)});

// One stored entry in the current format, or null when it is malformed.
export function cleanEntry(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  if (v.deleted === true) {
    if (v.pages === undefined) return {deleted: true};
    if (!Array.isArray(v.pages) || v.pages.length > MAX_PAGE || !v.pages.every(validPage)) return null;
    return {deleted: true, pages: [...new Set(v.pages)].sort((a, b) => a - b)};
  }
  if (!validPage(v.page)) return null;
  if (v.box === undefined && fin01(v.y)) return {page: v.page, box: legacyBox(v.y), source: 'user', accepted: true}; // old {page, y}
  const box = cleanBox(v.box);
  if (!box) return null;
  const source = v.source === 'ai' ? 'ai' : v.source === 'user' || v.source === undefined ? 'user' : null;
  if (!source || (v.accepted !== undefined && typeof v.accepted !== 'boolean')) return null;
  return {page: v.page, box, source, accepted: source === 'user' ? true : v.accepted === true};
}
// Validated, migrated copy of a whole overrides object; null when anything in it is invalid (the server
// refuses the request). `lenient` drops bad entries instead (reading what is already stored).
export function cleanOverrides(o, {lenient = false} = {}) {
  if (o === undefined || o === null) return lenient ? {} : null;
  if (typeof o !== 'object' || Array.isArray(o)) return lenient ? {} : null;
  const entries = Object.entries(o);
  if (entries.length > MAX_OVERRIDES && !lenient) return null;
  const out = {};
  for (const [k, v] of entries.slice(0, MAX_OVERRIDES)) {
    const e = LABEL.test(k) ? cleanEntry(v) : null;
    if (!e) { if (lenient) continue; return null; }
    out[k] = e;
  }
  return out;
}
export const migrateOverrides = o => cleanOverrides(o, {lenient: true});

const isFrame = e => !!e && !e.deleted && !!e.box;
export const isSuggestion = e => isFrame(e) && e.source === 'ai' && !e.accepted;
export const isAccepted = e => isFrame(e) && (e.source === 'user' || e.accepted);
const deletedOn = (e, page) => !!e?.deleted && (!e.pages || e.pages.includes(page));

// Final equation set: automatic detections, minus deleted ones and those whose label has an accepted
// frame, plus the accepted frames. `auto` is {page: [{label, box, ...}]}. Returns byPage and an index
// by label, entries {page, label, box, y, x, source: 'auto'|'user'|'ai'} (y, x: as the detector reported them).
export function mergeEquations(auto, overrides = {}) {
  const byPage = {}, index = {};
  const add = e => { (byPage[e.page] ??= []).push(e); (index[e.label] ??= []).push(e); };
  for (const [p, list] of Object.entries(auto || {})) for (const a of list) {
    const o = overrides[a.label], page = Number(p);
    if (isAccepted(o) || deletedOn(o, page)) continue;
    add({...a, page, source: 'auto', y: a.y ?? a.box.y0, x: a.x ?? a.box.x0});
  }
  for (const [label, o] of Object.entries(overrides)) if (isAccepted(o))
    add({page: o.page, label, box: o.box, y: o.box.y0, x: o.box.x0, source: o.source});
  for (const list of Object.values(byPage)) list.sort((a, b) => a.box.y0 - b.box.y0 || a.box.x0 - b.box.x0);
  return {byPage, index};
}
export const suggestions = overrides => Object.entries(overrides || {}).filter(([, o]) => isSuggestion(o)).map(([label, o]) => ({label, ...o}));

export function iou(a, b) {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  if (w <= 0 || h <= 0) return 0;
  const i = w * h, u = (a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - i;
  return u > 0 ? i / u : 0;
}

// ---------- AI labelling ----------
// Agreement between an AI frame and the automatic one with the same label: at least this overlap
// (intersection over union) and the automatic frame is kept; less, and the AI frame becomes a suggestion.
export const AGREE_IOU = 0.5;
// Merge one page of AI results (boxes already snapped) into the overrides. Labels the user has already
// decided (a frame of their own, an accepted AI frame, or a deletion) are left alone. Returns the new
// overrides and what happened to each equation.
export function mergeAiPage(page, ai, autoOnPage, overrides) {
  const out = {...overrides}, stats = {found: 0, agree: 0, suggested: 0, kept: 0, labels: []};
  const seen = new Set();
  for (const e of ai) {
    if (seen.has(e.label)) continue; // the model listed a number twice: first one wins
    seen.add(e.label); stats.found++;
    const o = overrides[e.label];
    if (isAccepted(o) || o?.deleted) { stats.kept++; stats.labels.push({label: e.label, result: 'kept'}); continue; }
    const auto = autoOnPage.find(a => a.label === e.label);
    if (auto && iou(auto.box, e.box) >= AGREE_IOU) {
      if (isSuggestion(o)) delete out[e.label]; // an older suggestion this run no longer supports
      stats.agree++; stats.labels.push({label: e.label, result: 'agree'}); continue;
    }
    out[e.label] = {page, box: cleanBox(e.box) || e.box, source: 'ai', accepted: false};
    stats.suggested++; stats.labels.push({label: e.label, result: auto ? 'differs' : 'new'});
  }
  return {overrides: out, stats};
}

// The model's answer as [{label, box}] (normalised boxes). Tolerates code fences, prose around the JSON,
// a bare array, box arrays [x0, y0, x1, y1] or objects (also {x, y, width, height}), swapped corners,
// and coordinates in pixels of the sent image or on a 0..1000 scale. Entries without a valid label or
// box are dropped.
export function parseAiEquations(text, {width = 0, height = 0} = {}) {
  let data = text;
  if (typeof text === 'string') {
    const s = text.replace(/```(?:json)?/gi, '');
    data = null;
    // Whichever comes first: an object ({"equations": [...]}) or a bare array.
    const pairs = [['{', '}'], ['[', ']']].sort((a, b) => (s.indexOf(a[0]) + 1 || Infinity) - (s.indexOf(b[0]) + 1 || Infinity));
    for (const [open, close] of pairs) {
      const a = s.indexOf(open), b = s.lastIndexOf(close);
      if (a < 0 || b <= a) continue;
      try { data = JSON.parse(s.slice(a, b + 1)); break; } catch {}
    }
    if (data === null) return null;
  }
  const list = Array.isArray(data) ? data : Array.isArray(data?.equations) ? data.equations : null;
  if (!list) return null;
  const out = [];
  for (const it of list.slice(0, 200)) {
    const label = normalizeLabel(it?.label ?? it?.number ?? it?.tag);
    let b = it?.box ?? it?.bbox ?? it?.bounding_box;
    if (Array.isArray(b) && b.length === 4) b = {x0: b[0], y0: b[1], x1: b[2], y1: b[3]};
    else if (b && b.x0 === undefined && [b.x, b.y, b.width, b.height].every(Number.isFinite)) b = {x0: b.x, y0: b.y, x1: b.x + b.width, y1: b.y + b.height};
    if (!label || !b || ![b.x0, b.y0, b.x1, b.y1].every(v => typeof v === 'number' && Number.isFinite(v))) continue;
    let [x0, x1] = [Math.min(b.x0, b.x1), Math.max(b.x0, b.x1)], [y0, y1] = [Math.min(b.y0, b.y1), Math.max(b.y0, b.y1)];
    const max = Math.max(x1, y1);
    if (max > 1.001) { // not fractions: pixels of the sent image when they fit in it, else a 0..1000 grid
      const px = width && height && x1 <= width * 1.01 && y1 <= height * 1.01;
      const sx = px ? width : max <= 1000.5 ? 1000 : width, sy = px ? height : max <= 1000.5 ? 1000 : height;
      if (!sx || !sy) continue;
      x0 /= sx; x1 /= sx; y0 /= sy; y1 /= sy;
    }
    const c = v => Math.min(1, Math.max(0, v));
    const box = cleanBox({x0: c(x0), y0: c(y0), x1: c(x1), y1: c(y1)});
    if (box) out.push({label, box});
  }
  return out;
}

// ---------- snapping a box to the page ----------
// Text items: {s, x0, y0, x1, y1} in page units (pdf.js scale 1, top-left origin), as layout.js builds them.
const MATH_NAMES = new Set('sin cos tan sec csc cot exp log lim max min sup inf det diag sgn sign arg mod rank trace span tanh sinh cosh rms var std ext int tot ref des act est obs nom eff err cmd dyn rel abs fric meas init'.split(' '));
const isWord = w => /[aeiouy]/.test(w) && !MATH_NAMES.has(w);
const proseWords = s => (s.match(/\b(?:[a-z]{3,}|[A-Z][a-z]{3,})\b/g) || []).map(w => w.toLowerCase()).filter(isWord).length;
const wordPairs = s => [...s.matchAll(/\b([a-z]{2,})\s+(?=([a-z]{2,})\b)/g)].some(m => isWord(m[1]) && isWord(m[2]));
// A line of running text (not a formula): several real words, some of them next to each other.
export const isProse = s => proseWords(s) >= 4 && wordPairs(s);
// Signs found in formulas: operators, brackets, digits, Greek letters, mathematical symbols.
const MATHY = /[=+\-−×·∑∏∫∂√∞≈≠≤≥<>^_()[\]{}|\/\d\u0370-\u03ff\u2190-\u22ff\u{1d400}-\u{1d7ff}]/u;
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };
const cy = b => (b.y0 + b.y1) / 2, cx = b => (b.x0 + b.x1) / 2;
function linesOf(items, tol) {
  const lines = [];
  for (const b of [...items].sort((a, c) => cy(a) - cy(c))) {
    const l = lines.find(l => Math.abs(cy(l) - cy(b)) <= tol);
    if (l) { l.items.push(b); l.y0 = Math.min(l.y0, b.y0); l.y1 = Math.max(l.y1, b.y1); l.x0 = Math.min(l.x0, b.x0); l.x1 = Math.max(l.x1, b.x1); }
    else lines.push({items: [b], x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1});
  }
  for (const l of lines) { l.items.sort((a, c) => a.x0 - c.x0); l.s = l.items.map(t => t.s).join(' '); }
  return lines.sort((a, c) => a.y0 - c.y0);
}
// Tighten a rough frame (normalised) to the text items of the equation it covers: lines whose centre
// lies inside the frame, without running text at its top or bottom edge, and within those lines the items
// whose centre is inside, grown sideways over items its left/right edges cut off or just missed (gap under
// ~1.5 line heights, at most ~1.5 line heights or 5% of the frame width beyond each edge). Lines wholly
// outside the frame are never added (above and below an equation are lead-in text or a neighbouring
// equation; adding short formula-like lines there was tried and made frames worse). With the equation's
// `label`, lines inside the frame that carry another equation number are left out (stacked equations).
// Returns {box, items} or null when no formula text lies under the frame (scanned pages, image-only maths).
export function snapToText(box, items, W, H, label = null) {
  const all = items.filter(t => t.s.trim() && t.x1 > t.x0 && t.y1 > t.y0);
  if (!all.length) return null;
  const lh = median(all.map(t => t.y1 - t.y0)) || 10;
  const B = {x0: box.x0 * W, y0: box.y0 * H, x1: box.x1 * W, y1: box.y1 * H};
  const padY = Math.max(lh, 0.25 * (B.y1 - B.y0)), padX = Math.max(1.5 * lh, 0.05 * (B.x1 - B.x0));
  const R = {x0: B.x0 - padX, y0: B.y0 - padY, x1: B.x1 + padX, y1: B.y1 + padY};
  const near = all.filter(t => cx(t) >= R.x0 && cx(t) <= R.x1 && cy(t) >= R.y0 && cy(t) <= R.y1);
  const lines = linesOf(near, lh * 0.45);
  let core = lines.filter(l => cy(l) >= B.y0 && cy(l) <= B.y1);
  while (core.length && isProse(core[0].s)) core.shift();
  while (core.length && isProse(core.at(-1).s)) core.pop();
  // Lines of plain words without any mathematical sign (headings, OCR fragments) are not part of a formula.
  core = core.filter(l => MATHY.test(l.s) || !proseWords(l.s));
  if (!core.length) return null;
  // With the equation's label known, lines carrying another equation number belong to a neighbour.
  const foreign = l => label != null && l.items.some(t => { const m = /^\(\s*([^()\s]{1,8})\s*\)$/.exec(t.s.trim()); return m && normalizeLabel(m[1]) && normalizeLabel(m[1]) !== label; });
  core = core.filter(l => !foreign(l));
  if (!core.length) return null;
  const kept = new Set(core);
  const its = [...kept].flatMap(l => l.items);
  let pick = its.filter(t => cx(t) >= B.x0 && cx(t) <= B.x1);
  if (!pick.length) return null;
  let x0 = Math.min(...pick.map(t => t.x0)), x1 = Math.max(...pick.map(t => t.x1));
  for (let grew = true; grew;) {
    grew = false;
    for (const t of its) if (!pick.includes(t) && cx(t) >= R.x0 && cx(t) <= R.x1 && ((t.x1 <= x0 + 0.5 && x0 - t.x1 < 1.5 * lh) || (t.x0 >= x1 - 0.5 && t.x0 - x1 < 1.5 * lh))) {
      pick.push(t); x0 = Math.min(x0, t.x0); x1 = Math.max(x1, t.x1); grew = true;
    }
  }
  const y0 = Math.min(...pick.map(t => t.y0)), y1 = Math.max(...pick.map(t => t.y1));
  const c = v => Math.min(1, Math.max(0, v));
  return {box: {x0: c(x0 / W), y0: c(y0 / H), x1: c(x1 / W), y1: c(y1 / H)}, items: pick.length};
}

// Tighten a rough frame to the ink under it on a rendered page (grey values 0..255, row-major), for pages
// whose maths has no text items (scans, equations set as images). Blank margins inside the frame are
// trimmed; an edge that cuts through ink is pushed out until a blank band (≥ 0.25% of the page height,
// ≥ 1% of its width) or at most `grow` of the page. Areas in `mask` (normalised boxes, e.g. running text
// next to the equation) count as blank. A frame over nothing but blank or masked text moves to the nearest
// band of ink within `search` of the page (see below). Returns the box or null when there is no ink.
export function snapToInk(gray, iw, ih, box, {mask = [], threshold = 160, minInk = 2, grow = 0.03, search = 0.06} = {}) {
  const m = mask.map(b => ({x0: Math.floor(b.x0 * iw), y0: Math.floor(b.y0 * ih), x1: Math.ceil(b.x1 * iw), y1: Math.ceil(b.y1 * ih)}));
  const dark = (x, y) => gray[y * iw + x] < threshold && !m.some(r => x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1);
  // A row (column) has ink when at least minInk of its pixels are dark (fewer when the span is shorter).
  const rowInk = (y, x0, x1) => { const k = Math.min(minInk, x1 - x0 + 1); let n = 0; for (let x = x0; x <= x1; x++) if (dark(x, y) && ++n >= k) return true; return false; };
  const colInk = (x, y0, y1) => { const k = Math.min(minInk, y1 - y0 + 1); let n = 0; for (let y = y0; y <= y1; y++) if (dark(x, y) && ++n >= k) return true; return false; };
  let x0 = Math.max(0, Math.floor(box.x0 * iw)), x1 = Math.min(iw - 1, Math.ceil(box.x1 * iw) - 1);
  let y0 = Math.max(0, Math.floor(box.y0 * ih)), y1 = Math.min(ih - 1, Math.ceil(box.y1 * ih) - 1);
  const shrink = () => {
    while (y0 <= y1 && !rowInk(y0, x0, x1)) y0++;
    while (y1 >= y0 && !rowInk(y1, x0, x1)) y1--;
    if (y0 > y1) return false;
    while (x0 <= x1 && !colInk(x0, y0, y1)) x0++;
    while (x1 >= x0 && !colInk(x1, y0, y1)) x1--;
    return x0 <= x1;
  };
  const gapY = Math.max(2, Math.round(0.0025 * ih)), gapX = Math.max(3, Math.round(0.01 * iw));
  if (!shrink()) {
    if (!search) return null;
    // Nothing but blank or masked text under the frame: the frame may sit a line or two off the equation
    // (seen with scanned pages). Take the nearest band of ink within `search` of the page above or below,
    // preferring one with ink at the frame's left or right end, where the equation number is printed.
    const lim = Math.round(search * ih), from = Math.max(0, y0 - lim), to = Math.min(ih - 1, y1 + lim);
    const bands = [];
    for (let y = from, start = -1, blank = 0; y <= to + 1; y++) {
      const inked = y <= to && rowInk(y, x0, x1);
      if (inked) { if (start < 0) start = y; blank = 0; }
      else if (start >= 0 && (++blank >= gapY || y > to)) { bands.push([start, y - blank]); start = -1; blank = 0; }
    }
    const edge = Math.max(2, Math.round(0.1 * (x1 - x0)));
    const numbered = ([a, b]) => { for (let x = x1 - edge; x <= x1; x++) if (colInk(x, a, b)) return true; for (let x = x0; x <= x0 + edge; x++) if (colInk(x, a, b)) return true; return false; };
    const dist = ([a, b]) => a > y1 ? a - y1 : y0 > b ? y0 - b : 0;
    const best = bands.filter(b => b[1] - b[0] >= 2).sort((p, q) => (numbered(q) - numbered(p)) || dist(p) - dist(q))[0];
    if (!best) return null;
    [y0, y1] = best;
    if (!shrink()) return null;
  }
  const limY = Math.round(grow * ih), limX = Math.round(grow * iw);
  // Push one edge outward while ink continues (blank runs shorter than `gap` are bridged).
  const push = (from, dir, lim, gap, inkAt, bound) => {
    let edge = from, blank = 0;
    for (let k = 1; k <= lim; k++) {
      const p = from + dir * k;
      if (p < 0 || p > bound) break;
      if (inkAt(p)) { edge = p; blank = 0; } else if (++blank >= gap) break;
    }
    return edge;
  };
  for (let pass = 0; pass < 2; pass++) {
    if (rowInk(y0, x0, x1)) y0 = push(y0, -1, limY, gapY, y => rowInk(y, x0, x1), ih - 1);
    if (rowInk(y1, x0, x1)) y1 = push(y1, 1, limY, gapY, y => rowInk(y, x0, x1), ih - 1);
    if (colInk(x0, y0, y1)) x0 = push(x0, -1, limX, gapX, x => colInk(x, y0, y1), iw - 1);
    if (colInk(x1, y0, y1)) x1 = push(x1, 1, limX, gapX, x => colInk(x, y0, y1), iw - 1);
  }
  const pad = 1; // one pixel around the ink
  return cleanBox({x0: Math.max(0, x0 - pad) / iw, y0: Math.max(0, y0 - pad) / ih, x1: Math.min(iw, x1 + 1 + pad) / iw, y1: Math.min(ih, y1 + 1 + pad) / ih});
}

// Snap an AI frame: to the text under it when there is formula text, else to the ink of the rendered
// page (running text masked out), else keep it as returned. `image`: {gray, width, height} or null.
// Share of the dark pixels in `box` that lie under some text item (normalised rects): high for typeset
// maths, low for equations that are part of a scanned image.
export function textCoverage(gray, iw, ih, box, rects, threshold = 160) {
  const x0 = Math.max(0, Math.floor(box.x0 * iw)), x1 = Math.min(iw - 1, Math.ceil(box.x1 * iw)), y0 = Math.max(0, Math.floor(box.y0 * ih)), y1 = Math.min(ih - 1, Math.ceil(box.y1 * ih));
  const rs = rects.map(r => ({x0: r.x0 * iw - 1, y0: r.y0 * ih - 1, x1: r.x1 * iw + 1, y1: r.y1 * ih + 1})).filter(r => r.x1 > x0 && r.x0 < x1 && r.y1 > y0 && r.y0 < y1);
  let dark = 0, under = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (gray[y * iw + x] < threshold) { dark++; if (rs.some(r => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1)) under++; }
  return dark ? under / dark : 0;
}
// Snap an AI frame: to the text under it when the equation is typeset text, else to the ink of the rendered
// page (running text masked out), else keep it as returned. When the text and ink frames disagree (overlap
// under TEXT_INK_AGREE), the ink frame is the larger one (the text found only a fragment) and under
// IMAGE_MATH_COVERAGE of the ink is covered by text items, the equation is
// an image (a scan with a text layer from OCR, maths set as pictures) and the ink wins: stray OCR words must
// not become the frame. (Coverage alone is not enough: some publishers' fonts give text boxes that cover
// little of the glyphs.) `image`: {gray, width, height} or null.
export const IMAGE_MATH_COVERAGE = 0.35, TEXT_INK_AGREE = 0.5, REFINE_AGREE = 0.3;
export function snapBox(box, items, W, H, image = null, label = null) {
  const t = snapToText(box, items, W, H, label), tb = t && cleanBox(t.box);
  let ink = null;
  if (image) {
    const prose = linesOf(items.filter(i => i.s.trim()), 4).filter(l => isProse(l.s)).flatMap(l => l.items).map(i => ({x0: i.x0 / W, y0: i.y0 / H, x1: i.x1 / W, y1: i.y1 / H}));
    ink = snapToInk(image.gray, image.width, image.height, box, {mask: prose});
    if (ink && tb) {
      const rects = items.filter(i => i.s.trim()).map(i => ({x0: i.x0 / W, y0: i.y0 / H, x1: i.x1 / W, y1: i.y1 / H}));
      const area = b => (b.x1 - b.x0) * (b.y1 - b.y0);
      if (iou(tb, ink) < TEXT_INK_AGREE && area(ink) > area(tb) && textCoverage(image.gray, image.width, image.height, ink, rects) < IMAGE_MATH_COVERAGE) return {box: ink, method: 'ink'};
    }
  }
  if (tb && image) {
    // The text decides which lines belong to the equation; the ink then gives the exact extent (text boxes
    // come from font metrics, which miss fraction bars and radicals and in some PDFs sit half a line off).
    // The refined frame is kept when it still overlaps the text frame by REFINE_AGREE (intersection over union).
    // No padding: an edge that cuts through glyphs is pushed out anyway, and padding reaches into the next line.
    const prose = linesOf(items.filter(i => i.s.trim()), 4).filter(l => isProse(l.s)).flatMap(l => l.items).map(i => ({x0: i.x0 / W, y0: i.y0 / H, x1: i.x1 / W, y1: i.y1 / H}));
    const fine = snapToInk(image.gray, image.width, image.height, tb, {mask: prose, search: 0});
    if (fine && iou(fine, tb) >= REFINE_AGREE) return {box: fine, method: 'text'};
  }
  if (tb) return {box: tb, method: 'text'};
  if (ink) return {box: ink, method: 'ink'};
  return {box, method: 'none'};
}

// ---------- cost estimate ----------
// Rough: image tokens for a page image of w x h pixels, a fixed prompt, and output tokens observed per page
// (thinking or reasoning plus the JSON). Prices in USD per million tokens [input, output]; models not listed
// get token counts only.
export const PRICES = {
  'claude-fable-5-1': [10, 50], 'claude-fable-5': [10, 50], 'claude-opus-5-5': [4, 20], 'claude-opus-5': [5, 25], 'claude-opus-4-8': [5, 25],
  'claude-opus-4-7': [5, 25], 'claude-opus-4-6': [5, 25], 'claude-sonnet-5-5': [2, 10], 'claude-sonnet-5': [2, 10], 'claude-sonnet-4-6': [3, 15],
  'claude-haiku-5-5': [0.1, 0.5], 'claude-haiku-4-5': [1, 5],
};
export const PROMPT_TOKENS = 600;
// Claude: measured 10–600 (about 80 on average) output tokens per page with Opus, Sonnet and Haiku 5.5; 400 leaves room for dense pages.
// OpenAI: not measured; reasoning models may think much longer, so 3000.
export const OUTPUT_TOKENS = {anthropic: 400, openai: 3000};
export function imageTokens(provider, w, h) {
  if (provider === 'anthropic') return Math.min(4784, Math.ceil(w * h / 750));
  // OpenAI "high" detail: fit in 2048, shortest side 768, 512-px tiles at 170 tokens plus 85.
  let s = Math.min(1, 2048 / Math.max(w, h)); let a = w * s, b = h * s;
  s = Math.min(1, 768 / Math.min(a, b)); a *= s; b *= s;
  return 85 + 170 * Math.ceil(a / 512) * Math.ceil(b / 512);
}
export const priceOf = model => PRICES[model] || PRICES[String(model).replace(/-\d{8}$/, '')] || null;
export function estimateCost(provider, model, pages, w = 1237, h = 1600) {
  const input = pages * (imageTokens(provider, w, h) + PROMPT_TOKENS), output = pages * OUTPUT_TOKENS[provider === 'anthropic' ? 'anthropic' : 'openai'];
  const p = priceOf(model);
  return {input, output, usd: p ? (input * p[0] + output * p[1]) / 1e6 : null};
}
export function usageCost(model, u) {
  const p = priceOf(model); if (!p || !u) return null;
  return ((u.input || 0) * p[0] + (u.cacheWrite || 0) * p[0] * 1.25 + (u.cacheRead || 0) * p[0] * 0.1 + (u.output || 0) * p[1]) / 1e6;
}
