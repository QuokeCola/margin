// Equation context for chats: the paper's equations (the merged set the reader shows: automatic detections,
// the user's frames and accepted AI frames) as an index the model reads with the paper, plus cropped images
// of the equations whose extracted text is unusable (scans, equations set as pictures, broken fonts).
// Shared by the app (building entries, choosing crops) and the server (validation, prompt text, the
// per-chat baseline and the "updates since your last answer" deltas). No DOM, no Node APIs.
//
// An entry: {label, page, box: {x0, y0, x1, y1} (normalised), text, poor, image?} where text is the
// cleaned text inside the frame (without the equation number), poor says the text cannot stand in for
// the equation (see isPoorText), and image is an optional data URL of the crop.
import {LABEL, cleanBox, normalizeLabel, isProse} from './equations.mjs';

export const EQ_TEXT_MAX = 200;        // characters of frame text in an index line
export const POOR_MIN_CHARS = 8;       // fewer readable non-space characters than this: poor
export const POOR_BAD_SHARE = 0.3;     // more than this share of unreadable characters: poor
export const MAX_ENTRIES = 400;        // entries a request may carry
export const CROP_WIDTH = 800;         // target crop width in pixels (scale capped at CROP_MAX_SCALE)
export const CROP_MAX_SCALE = 4;
export const CROP_PAD = 6;             // pixels of white around the frame
export const PNG_MAX = 80_000;         // data URL characters; a larger PNG is re-encoded as JPEG
export const JPEG_QUALITY = 0.85;
export const IMAGE_MAX = 400_000;      // data URL characters of one crop (server limit)
export const CAPS = {
  paper: {images: 30, bytes: 2_500_000},  // images in a paper chat's cached block
  update: {images: 8, bytes: 1_000_000},  // images sent with one turn's update section
  project: {images: 8, bytes: 1_000_000, perPaper: 40, entries: 150},
  send: {images: 60, bytes: 6_000_000},   // crops the app sends with a paper-chat turn
};
// A paper chat keeps the block it first sent (cached by the provider) and sends changes as updates, until
// more than REBUILD_SHARE of the entries (and at least REBUILD_MIN of them) changed since the block was
// built, or the provider's cache has expired anyway (REBUILD_IDLE_MS since the chat's last turn: Claude's
// default cache lifetime is 5 minutes), when the block is rebuilt from the current list. A rebuild re-writes
// the whole paper to the cache, so a few changes are cheaper as updates even in a short list.
export const REBUILD_SHARE = 0.25, REBUILD_MIN = 5, REBUILD_IDLE_MS = 5 * 60e3;

// ---------- frame text ----------
// Characters that mark text as unreadable: control characters, private-use glyphs (unmapped symbol fonts),
// the replacement character, and CJK / full-width forms (broken encodings of older papers, e.g. 共 for "(").
const BAD = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f\ue000-\uf8ff\ufffd\u3000-\u9fff\uff00-\uffef]/u;
const BAD_G = new RegExp(BAD.source, 'gu');
const cut = (s, n) => s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
// Frame text cleaned for the prompt: whitespace collapsed, the equation's own number "(12)" at either end
// removed, unreadable characters kept (they decide isPoorText) but not shown.
export function cleanEqText(s, label = null) {
  let t = String(s || '').replace(/\s+/g, ' ').trim();
  if (label != null) {
    const esc = String(label).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // The number as a token of its own, usually last but anywhere in the reading order of a multi-line frame.
    const num = new RegExp(`(^|\\s)[(（共]\\s*${esc}\\s*[)）兲](?=\\s|$)`, 'g'), hits = [...t.matchAll(num)];
    if (hits.length) { const m = hits[hits.length - 1]; t = (t.slice(0, m.index) + m[1] + t.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim(); }
  }
  return t;
}
const shown = t => cut(t.replace(BAD_G, '').replace(/\s+/g, ' ').trim(), EQ_TEXT_MAX);
// Signs of a formula (digits, brackets, hyphens and slashes excluded: prose has them too).
const MATH_SIGN = /[=+−×·∑∏∫∂√∞≈≠≤≥<>^_|\u0370-\u03ff\u2190-\u22ff\u{1d400}-\u{1d7ff}]/u;
// Poor text: fewer than POOR_MIN_CHARS readable non-space characters, more than POOR_BAD_SHARE of the
// characters unreadable, or running prose without any formula sign (an OCR text layer that skipped the
// equation, leaving only words of the line next to it inside the frame). Such an equation gets an image
// when the caps allow.
export function isPoorText(text) {
  const t = String(text || '').replace(/\s+/g, '');
  const bad = (t.match(BAD_G) || []).length, good = [...t].length - bad;
  if (good < POOR_MIN_CHARS || bad / Math.max(1, good + bad) > POOR_BAD_SHARE) return true;
  const s = String(text).replace(/\s+/g, ' ');
  return isProse(s) && !MATH_SIGN.test(s);
}
// Text of the items whose centre lies inside the frame, in reading order. items: {s, x0, y0, x1, y1} in
// page units (W x H), as layout.js builds them.
export function frameText(items, box, W, H) {
  const inside = (items || []).filter(t => {
    if (!t.s || !t.s.trim()) return false;
    const x = (t.x0 + t.x1) / 2 / W, y = (t.y0 + t.y1) / 2 / H;
    return x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1;
  });
  inside.sort((a, c) => Math.abs(a.y0 - c.y0) > 3 ? a.y0 - c.y0 : a.x0 - c.x0);
  return inside.map(t => t.s).join(' ');
}
// Entries of a merged equation set (byPage from mergeEquations), in page order, with their frame text.
// itemsOf(page) -> {items, W, H} or null.
export function buildEntries(byPage, itemsOf) {
  const out = [];
  for (const p of Object.keys(byPage || {}).map(Number).sort((a, b) => a - b)) for (const e of byPage[p]) {
    const pg = itemsOf(p), text = cleanEqText(pg ? frameText(pg.items, e.box, pg.W, pg.H) : '', e.label);
    out.push({label: e.label, page: p, box: e.box, text: text.slice(0, 400), poor: isPoorText(text)});
  }
  return out.slice(0, MAX_ENTRIES);
}

// ---------- equations named in a question ----------
// Labels named as "Eq. 12", "Eqs. (3) and (4)", "equations (5)–(7)", "Equation A.3", a citation token
// [[eq:12|p:4]], or the attachment header "About Eq. (12)". Ranges are expanded up to 20 numbers.
const ONE = String.raw`[A-Z]?\.?\d{1,3}(?:\.\d{1,3})?[a-z]?`;
const LIST = new RegExp(String.raw`\b(?:eqs?|equations?)\.?\s*((?:\(?${ONE}\)?(?:\s*(?:,|and|or|to|-|–|—)\s*)?)+)`, 'gi');
export function mentionedLabels(text) {
  const out = new Set(), s = String(text || '');
  for (const m of s.matchAll(/\[\[eq:([^|\]]{1,12})\|/g)) { const l = normalizeLabel(m[1]); if (l) out.add(l); }
  for (const m of s.matchAll(LIST)) {
    const parts = [...m[1].matchAll(new RegExp(String.raw`\(?(${ONE})\)?|(to|-|–|—)`, 'g'))];
    let prev = null, range = false;
    for (const p of parts) {
      if (p[2]) { range = true; continue; }
      const l = normalizeLabel(p[1]); if (!l) continue;
      if (range && prev && /^\d+$/.test(prev) && /^\d+$/.test(l) && +l > +prev && +l - +prev <= 20) for (let k = +prev + 1; k < +l; k++) out.add(String(k));
      out.add(l); prev = l; range = false;
    }
  }
  return out;
}

// ---------- validation (server) ----------
const IMG = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/;
// The app's equation list, checked: at most MAX_ENTRIES entries with a valid label, page and box, text
// as a string (cut to 400 characters), images as PNG/JPEG data URLs of at most IMAGE_MAX characters (each)
// and CAPS.send in total. Returns the clean entries (poor recomputed here) or null when the shape is wrong.
export function validateEquations(list, numPages) {
  if (!Array.isArray(list) || list.length > MAX_ENTRIES) return null;
  const out = [];
  let images = 0, bytes = 0;
  for (const e of list) {
    if (!e || typeof e !== 'object') return null;
    const label = typeof e.label === 'string' && LABEL.test(e.label) ? e.label : null, box = cleanBox(e.box);
    if (!label || !box || !Number.isInteger(e.page) || e.page < 1 || e.page > numPages) return null;
    if (e.text !== undefined && typeof e.text !== 'string') return null;
    const text = cleanEqText((e.text || '').slice(0, 400), label);
    const entry = {label, page: e.page, box, text, poor: isPoorText(text)};
    if (e.image !== undefined) {
      if (typeof e.image !== 'string' || e.image.length > IMAGE_MAX || !IMG.test(e.image)) return null;
      if (++images <= CAPS.send.images && (bytes += e.image.length) <= CAPS.send.bytes) entry.image = e.image;
    }
    out.push(entry);
  }
  return out;
}

// ---------- choosing images ----------
// Poor-text entries that have an image, at most `images` of them and `bytes` data-URL characters in all:
// those named in the question first, then those named in the chat so far, then page order. Returns the
// chosen entries' keys. `already` (keys) are skipped.
export const keyOf = e => `${e.label}@${e.page}`;
export function pickImages(entries, {images, bytes}, {question = new Set(), history = new Set(), already = new Set()} = {}) {
  const cand = entries.filter(e => e.poor && e.image && !already.has(keyOf(e)));
  const rank = e => question.has(e.label) ? 0 : history.has(e.label) ? 1 : 2;
  const order = cand.map((e, i) => [rank(e), i, e]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = new Set();
  let used = 0;
  for (const [, , e] of order) {
    if (out.size >= images) break;
    if (used + e.image.length > bytes) continue;
    used += e.image.length; out.add(keyOf(e));
  }
  return out;
}

// ---------- prompt text ----------
export const eqName = e => `Eq. (${e.label}) · page ${e.page}`;
// One index line. `imaged`: an image of this equation is attached.
export function indexLine(e, imaged) {
  if (imaged) return `${eqName(e)} · image attached`;
  const t = shown(e.text || '');
  if (!t) return `${eqName(e)} · no readable text`;
  return `${eqName(e)} · text${e.poor ? ' (garbled)' : ''}: "${t}"`;
}
export const INDEX_HEAD = 'EQUATION INDEX (the numbered equations of this paper as framed in the reader: found automatically, framed by the user, or labelled with AI and accepted; this list is authoritative for equation numbers and their pages. Text is what the PDF text layer holds inside each frame, which often garbles maths; where an image is attached it shows the equation as printed.)';
export function indexText(entries, imaged = new Set()) {
  if (!entries.length) return '';
  return `${INDEX_HEAD}\n${entries.map(e => indexLine(e, imaged.has(keyOf(e)))).join('\n')}`;
}
export const imageCaption = e => `Image of ${eqName(e)}`;

// ---------- per-chat baseline and updates ----------
// What the model was shown of one entry: {label, page, box, text, poor, img} (img: hash of the image shown, or null).
const sameBox = (a, b) => ['x0', 'y0', 'x1', 'y1'].every(k => Math.abs(a[k] - b[k]) < 1e-4);
export function diffEntries(seen, current) {
  const was = new Map(seen.map(e => [keyOf(e), e])), now = new Map(current.map(e => [keyOf(e), e]));
  const added = [], changed = [], removed = [];
  for (const [k, e] of now) { const o = was.get(k); if (!o) added.push(e); else if (!sameBox(o.box, e.box) || o.text !== e.text) changed.push(e); }
  for (const [k, e] of was) if (!now.has(k)) removed.push(e);
  return {added, changed, removed, count: added.length + changed.length + removed.length};
}
export const UPDATE_HEAD = 'EQUATION UPDATES SINCE YOUR LAST ANSWER (the user changed the equation frames; these entries override the EQUATION INDEX and earlier updates)';
export function updateText({added, changed, removed}, imaged = new Set(), extra = []) {
  const lines = [...added.map(e => 'Added: ' + indexLine(e, imaged.has(keyOf(e)))), ...changed.map(e => 'Changed: ' + indexLine(e, imaged.has(keyOf(e)))),
    ...removed.map(e => `Removed: ${eqName(e)} (no longer framed; do not cite it there)`)];
  const more = extra.map(e => `${eqName(e)} · image attached`);
  const parts = [];
  if (lines.length) parts.push(`${UPDATE_HEAD}\n${lines.join('\n')}`);
  if (more.length) parts.push(`IMAGES OF EQUATIONS NAMED IN THIS QUESTION\n${more.join('\n')}`);
  return parts.join('\n\n');
}

// Decide what a paper-chat turn sends. `current`: validated entries (with images); `state`: the chat's
// stored {base, seen, at} or null; `hash(image)`: a stable id of an image. Returns
//   {rebuilt, base: entries for the cached block (img set), seen, update: {text, entries}} where the block
// is built from `base` (see blockOf) and update.entries are the current entries whose images go with the turn.
export function planTurn(current, state, {question = '', history = [], now = Date.now(), hash}) {
  const q = mentionedLabels(question), h = new Set(history.flatMap(m => [...mentionedLabels(m.content)]));
  const strip = (e, img) => ({label: e.label, page: e.page, box: e.box, text: e.text, poor: e.poor, img});
  const fresh = () => {
    const chosen = pickImages(current, CAPS.paper, {question: q, history: h});
    const base = current.map(e => strip(e, chosen.has(keyOf(e)) ? hash(e.image) : null));
    return {rebuilt: true, base, seen: base, update: {text: '', entries: []}};
  };
  if (!state?.base || !Array.isArray(state.seen)) return fresh();
  const vsBase = diffEntries(state.base, current);
  const idle = !(now - Date.parse(state.at) <= REBUILD_IDLE_MS);
  if (vsBase.count && (idle || (vsBase.count >= REBUILD_MIN && vsBase.count > REBUILD_SHARE * Math.max(state.base.length, current.length)))) return fresh();
  // Changes since the last turn, with images for added or changed poor-text equations, and images of
  // poor-text equations the question names that the model has not seen yet.
  const d = diffEntries(state.seen, current);
  const changedKeys = new Set([...d.added, ...d.changed].map(keyOf));
  const seenImg = new Map(state.seen.map(e => [keyOf(e), e.img]));
  const imaged = pickImages(current.filter(e => changedKeys.has(keyOf(e)) || (q.has(e.label) && !seenImg.get(keyOf(e)))), CAPS.update, {question: q, history: h});
  const extra = current.filter(e => imaged.has(keyOf(e)) && !changedKeys.has(keyOf(e)));
  const text = updateText(d, imaged, extra);
  // Images sent with a turn are not re-sent with the history (it stays text), so they count as not seen:
  // a later question naming that equation attaches it again.
  const seen = current.map(e => { const k = keyOf(e); return strip(e, changedKeys.has(k) || imaged.has(k) ? null : seenImg.get(k) ?? null); });
  return {rebuilt: false, base: state.base, seen, update: {text, entries: current.filter(e => imaged.has(keyOf(e)))}};
}

// ---------- crops ----------
// Where to render a crop of `box` on a page of W x H points: the scale that makes the frame CROP_WIDTH
// pixels wide (at most CROP_MAX_SCALE) and the pixel rectangle {x, y, w, h} at that scale, CROP_PAD pixels
// around the frame, clipped to the page. The app and the server use the same geometry.
export function cropGeometry(box, W, H) {
  const scale = Math.min(CROP_MAX_SCALE, CROP_WIDTH / Math.max(1, (box.x1 - box.x0) * W));
  const pw = W * scale, ph = H * scale;
  const x = Math.max(0, Math.floor(box.x0 * pw - CROP_PAD)), y = Math.max(0, Math.floor(box.y0 * ph - CROP_PAD));
  const w = Math.min(Math.floor(pw) - x, Math.ceil((box.x1 - box.x0) * pw + 2 * CROP_PAD)), h = Math.min(Math.floor(ph) - y, Math.ceil((box.y1 - box.y0) * ph + 2 * CROP_PAD));
  return {scale, x, y, w: Math.max(1, w), h: Math.max(1, Math.min(h, 1200))};
}
