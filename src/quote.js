// Finding quoted words in the paper, for highlighting citations. Gives the same results as
// findQuote() in layout.js (test/quote.test.js compares them), faster:
//  - each page's normalised text is built once (preparePage) and reused for every quote;
//  - an exact match is looked up first; otherwise pages that share too few three-letter pieces with
//    the quote to be within the allowed number of edits are skipped (q-gram lemma);
//  - the edit distance of the best match is found with Myers' bit-parallel algorithm (32 rows of the
//    table per machine word) instead of filling the whole table; the table is filled only over the
//    short stretch before the best match's end, to find its start exactly as findQuote does.

const key = s => s.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, '');

// Normalised character stream of a page and, for each character, the text item and its position in it.
export function preparePage(boxes) {
  const stream = [], owner = [], frac = [];
  boxes.forEach((b, i) => { const k = b.s.normalize('NFKC').toLowerCase(); for (let j = 0; j < k.length; j++) if (/[a-z0-9]/.test(k[j])) { stream.push(k[j]); owner.push(i); frac.push(k.length > 1 ? j / (k.length) : 0); } });
  return {boxes, text: stream.join(''), owner, frac, grams: null};
}

function trigrams(page) {
  if (!page.grams) { const g = new Set(), t = page.text; for (let i = 0; i + 3 <= t.length; i++) g.add(t.slice(i, i + 3)); page.grams = g; }
  return page.grams;
}

// Smallest edit distance of q to a substring of text, and the first end position where it occurs
// (the end column findQuote's table picks). Myers 1999, in the block form used by edlib.
function bestEnd(text, q) {
  const m = q.length, n = text.length, blocks = Math.ceil(m / 32);
  const peq = new Map();
  for (let i = 0; i < m; i++) { const c = q.charCodeAt(i); let v = peq.get(c); if (!v) peq.set(c, v = new Int32Array(blocks)); v[i >> 5] |= 1 << (i & 31); }
  const none = new Int32Array(blocks), P = new Int32Array(blocks).fill(-1), M = new Int32Array(blocks);
  const last = 1 << ((m - 1) & 31);
  let score = m, best = m, end = 0;
  for (let j = 0; j < n; j++) {
    const eqs = peq.get(text.charCodeAt(j)) || none;
    let hin = 0;
    for (let b = 0; b < blocks; b++) {
      let Pv = P[b], Mv = M[b], Eq = eqs[b];
      const Xv = Eq | Mv;
      if (hin < 0) Eq |= 1;
      const Xh = (((Eq & Pv) + Pv) ^ Pv) | Eq;
      let Ph = Mv | ~(Xh | Pv), Mh = Pv & Xh;
      const high = b === blocks - 1 ? last : 1 << 31;
      const hout = Ph & high ? 1 : Mh & high ? -1 : 0;
      Ph <<= 1; Mh <<= 1;
      if (hin < 0) Mh |= 1; else if (hin > 0) Ph |= 1;
      P[b] = Mh | ~(Xv | Ph); M[b] = Ph & Xv;
      hin = hout;
    }
    score += hin;
    if (score < best) { best = score; end = j + 1; }
  }
  return {dist: best, end};
}

// Start of the best alignment ending at column `end`, with findQuote's tie-breaking (its table, run
// over the only stretch an alignment with `dist` edits can cover).
function startOf(text, q, end, dist) {
  const from = Math.max(0, end - q.length - dist), t = text.slice(from, end), m = q.length, n = t.length;
  let prev = new Int32Array(n + 1), prevS = new Int32Array(n + 1), cur = new Int32Array(n + 1), curS = new Int32Array(n + 1);
  for (let j = 0; j <= n; j++) { prev[j] = 0; prevS[j] = j; }
  for (let i = 1; i <= m; i++) {
    cur[0] = i; curS[0] = 0; const qc = q.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      let d = prev[j - 1] + (t.charCodeAt(j - 1) === qc ? 0 : 1), st = prevS[j - 1];
      if (prev[j] + 1 < d) { d = prev[j] + 1; st = prevS[j]; }
      if (cur[j - 1] + 1 < d) { d = cur[j - 1] + 1; st = curS[j - 1]; }
      cur[j] = d; curS[j] = st;
    }
    [prev, cur] = [cur, prev]; [prevS, curS] = [curS, prevS];
  }
  return from + prevS[n];
}

const cy = b => (b.y0 + b.y1) / 2;
const union = bs => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const b of bs) { x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0); x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1); } return {x0, y0, x1, y1}; };
const norm = (b, W, H) => ({x0: b.x0 / W, y0: b.y0 / H, x1: b.x1 / W, y1: b.y1 / H});
// Same grouping into visual lines as layout.js.
function linesOf(boxes) {
  const lines = [];
  for (const b of [...boxes].sort((a, c) => cy(a) - cy(c))) {
    const h = b.y1 - b.y0, line = lines[lines.length - 1];
    if (line && Math.abs(cy(b) - line.cy) < Math.max(2, 0.42 * Math.min(h, line.h))) { line.items.push(b); Object.assign(line, union([line, b])); line.s += ' ' + b.s; }
    else lines.push({items: [b], ...union([b]), cy: cy(b), h, s: b.s});
  }
  return lines;
}

// Highlight rectangles for `quote` on a prepared page, or null; `.dist` is the share of edited
// characters (0 = exact). Same result as findQuote(page.boxes, quote, W, H). With `below`, only a
// match whose share is < below matters: weaker ones may be returned as null without searching.
export function findQuoteIn(page, quote, W, H, below = Infinity) {
  const {boxes, text, owner, frac} = page, q = key(quote).slice(0, 400);
  if (q.length < 6 || !text.length) return null;
  let at = text.indexOf(q), len = q.length, dist = 0;
  if (at < 0) {
    const limit = Math.max(2, Math.floor(0.2 * q.length));
    let k = limit; while (k >= 0 && !(k / q.length < below)) k--;
    if (k < 0) return null;
    // q-gram lemma: k edits destroy at most 3k of the quote's m-2 three-letter pieces.
    const need = q.length - 2 - 3 * k;
    if (need > 0) { const g = trigrams(page); let have = 0; for (let i = 0; i + 3 <= q.length && have < need; i++) if (g.has(q.slice(i, i + 3))) have++; if (have < need) return null; }
    const r = bestEnd(text, q);
    dist = r.dist;
    if (dist > limit || dist > k) return null;
    at = startOf(text, q, r.end, dist); len = r.end - at;
  }
  if (len <= 0) return null;
  const parts = new Map();
  for (let k = at; k < at + len; k++) {
    const i = owner[k], b = boxes[i], f = frac[k], w = b.x1 - b.x0;
    const x0 = b.x0 + w * f, x1 = b.x0 + w * (f + 1 / Math.max(1, b.s.length));
    const p = parts.get(i); if (p) { p.x1 = Math.max(p.x1, x1); } else parts.set(i, {x0, y0: b.y0, x1, y1: b.y1});
  }
  const rects = linesOf([...parts.values()].map(p => ({...p, s: ''}))).map(l => norm({x0: l.x0 - 1, y0: l.y0 - 1, x1: l.x1 + 1, y1: l.y1 + 1}, W, H));
  rects.dist = dist / q.length;
  return rects;
}

// The page and rectangles a quote citation points at: the cited page if it matches well (≤ 10 %
// edits), otherwise the closest match in the paper (a page must beat the best so far by 2 points).
// pages: [{page, prepared, W, H}] in page order. Returns {rects, page} or null.
export function locateQuote(pages, citedPage, quote) {
  const find = (p, below) => findQuoteIn(p.prepared, quote, p.W, p.H, below);
  const cited = pages.find(p => p.page === citedPage);
  let best = null, bestPage = null;
  const own = cited ? find(cited) : null;
  if (own && own.dist <= 0.1) { best = own; bestPage = citedPage; }
  else {
    if (own) { best = own; bestPage = citedPage; }
    for (const p of pages) {
      if (p.page === citedPage) continue;
      const r = find(p, best ? best.dist - 0.02 : Infinity);
      if (r && (!best || r.dist < best.dist - 0.02)) { best = r; bestPage = p.page; }
    }
  }
  return best ? {rects: best, page: bestPage} : null;
}
