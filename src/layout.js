// Page-geometry helpers. A "box" is a text item in page pixels at scale 1, top-left origin:
// {s, x0, y0, x1, y1}. All results are normalised to 0..1 of the page width/height.

const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };
const words = s => (s.match(/[A-Za-z]{3,}/g) || []).length;
// Ordinary lowercase words, not math names, for telling running text from formulas.
// Math function names and common subscript abbreviations (τ_ext, x_ref, p_tot, ...).
const MATH_NAMES = new Set(('sin cos tan sec csc cot exp log lim max min sup inf det diag sgn sign arg mod rank trace span tanh sinh cosh arcsin arccos arctan rms var std ' +
  'ext int tot ref des act est obs nom eff err cmd dyn rel abs fric meas init').split(' '));
// Real words contain a vowel; subscript runs like "kbz" or "zkx" do not.
const isWord = w => /[aeiouy]/.test(w) && !MATH_NAMES.has(w);
// Lowercase words, plus capitalised ones of 4+ letters ("Here", "Figure"); short capitals are usually symbols.
const proseWords = s => (s.match(/\b(?:[a-z]{3,}|[A-Z][a-z]{3,})\b/g) || []).map(w => w.toLowerCase()).filter(isWord).length;
const STOPWORDS = /\b(where|is|are|and|the|of|to|with|for|as|in|that|then|which|be|by|on|it|this|from|or|if|we|its|thus|hence|here)\b/;
// Running text has words next to each other ("calculated from"); subscripts like τ_fric are isolated.
const wordPairs = s => [...s.matchAll(/\b([a-z]{2,})\s+(?=([a-z]{2,})\b)/g)].some(m => isWord(m[1]) && isWord(m[2]));
const union = bs => ({x0: Math.min(...bs.map(b => b.x0)), y0: Math.min(...bs.map(b => b.y0)), x1: Math.max(...bs.map(b => b.x1)), y1: Math.max(...bs.map(b => b.y1))});
const norm = (b, W, H) => ({x0: b.x0 / W, y0: b.y0 / H, x1: b.x1 / W, y1: b.y1 / H});
const cy = b => (b.y0 + b.y1) / 2;

// Left/right edges of the text column that holds a box ending at `right` (one- or two-column layouts).
// Two-column layout near this point? A gutter leaves the page centre empty on every line, while
// single-column text (even stored one item per word) covers the centre on most lines.
function isTwoColumn(boxes, label, W) {
  const near = boxes.filter(b => b.s.trim() && Math.abs(cy(b) - cy(label)) < 150);
  const lines = linesOf(near);
  if (lines.length < 3) return false;
  const covering = lines.filter(l => l.items.some(b => b.x0 < W * 0.5 - 2 && b.x1 > W * 0.5 + 2)).length;
  return covering < Math.max(2, 0.3 * lines.length);
}

export function columnOf(boxes, label, W) {
  const near = boxes.filter(b => b.s.trim() && Math.abs(cy(b) - cy(label)) < 260);
  const twoCol = isTwoColumn(boxes, label, W);
  const right = label.x1 > W * 0.56;
  const pool = !twoCol ? near : near.filter(b => right ? b.x0 >= W * 0.5 : b.x0 < W * 0.5 && b.x1 <= W * 0.56);
  // Left edge from line starts (not items: one-item-per-word PDFs would skew it): the smallest x
  // at which at least three lines begin.
  const starts = linesOf(pool).map(l => l.x0).sort((a, b) => a - b);
  let left = starts[0] ?? 0;
  for (const x of starts) if (starts.filter(v => v >= x - 0.5 && v <= x + 3).length >= 3) { left = x; break; }
  return {left: Math.min(left, label.x0), right: Math.max(label.x1, ...pool.map(b => b.x1).filter(x => x <= label.x1 + 4))};
}

// Group boxes into visual lines (by vertical centre).
function linesOf(boxes) {
  const lines = [];
  for (const b of [...boxes].sort((a, c) => cy(a) - cy(c))) {
    const h = b.y1 - b.y0, line = lines[lines.length - 1];
    if (line && Math.abs(cy(b) - line.cy) < Math.max(2, 0.42 * Math.min(h, line.h))) { line.items.push(b); Object.assign(line, union([line, b])); line.s += ' ' + b.s; }
    else lines.push({items: [b], ...union([b]), cy: cy(b), h, s: b.s});
  }
  return lines;
}

// Box around the displayed equation that carries `label` (the "(12)" text item).
// Starts from the material left of the label on its line, then grows over neighbouring
// lines that look like math (few words, not a full-width prose line), stopping at other labels.
// `otherLabels`: the page's other equation-number boxes (from detectEquations); without it, plain "(n)" items are used.
export function equationBox(boxes, label, W, H, otherLabels = null, debug = null) {
  const col = columnOf(boxes, label, W), colW = col.right - col.left;
  const inCol = boxes.filter(b => b !== label && b.s.trim() && b.x0 >= col.left - 3 && b.x1 <= col.right + 3);
  const lines = linesOf(inCol);
  const h = median(inCol.map(b => b.y1 - b.y0)) || (label.y1 - label.y0);
  // Prose: running text, or a line starting at the column edge with ordinary words and no math
  // (a paragraph's last line, or "where"). Math names like min/max/sin are not words here.
  const atLeft = l => l.x0 <= col.left + 0.03 * colW, pw = l => proseWords(l.s);
  // Lines with math operators (incl. "¼"/"þ", which some fonts use for = and +) need strong evidence;
  // equations carry short notes such as "for region 1" or "for some i".
  const ops = l => /[=+\u2212\u2211\u222b<>\u2264\u2265\u2248\u225c\u00bc\u00fe]/.test(l.s);
  const proseText = l => pw(l) >= 6 || (wordPairs(l.s) && pw(l) >= 4) || (!ops(l) && ((wordPairs(l.s) && pw(l) >= 3) || (atLeft(l) && (STOPWORDS.test(l.s) || pw(l) >= 1))));
  // Judge the whole visual line: odd glyphs can split one text line into fragments with shifted centres.
  const prose = l => {
    const row = inCol.filter(b => Math.min(b.y1, l.y1) - Math.max(b.y0, l.y0) >= 0.5 * Math.min(b.y1 - b.y0, l.y1 - l.y0)).sort((a, b) => a.x0 - b.x0);
    return proseText(l) || proseText({...union(row.length ? row : [l]), s: row.map(b => b.s).join(' ')});
  };
  // Another equation's number beside this line means the line belongs to that equation.
  const others = (otherLabels ?? inCol.filter(b => /^\(\s*\d+[a-z]?\s*\)$/i.test(b.s.trim()))).filter(b => b !== label && b.x0 >= col.left - 3 && b.x1 <= col.right + 3 && b.x0 > col.left + 0.5 * colW);
  const hasOtherLabel = l => others.some(o => o.y1 > l.y0 + 0.1 * h && o.y0 < l.y1 - 0.1 * h);
  // Lines that vertically overlap the label (equation items may sit slightly above/below it).
  let picked = lines.filter(l => l.y1 > label.y0 - 0.15 * h && l.y0 < label.y1 + 0.15 * h && l.x0 < label.x0 && !prose(l));
  // Keep the horizontally contiguous run of items that ends nearest the number; stray pieces of
  // neighbouring prose (e.g. a lone "x," at the column edge) are separated by a large gap.
  if (picked.length) {
    const items = picked.flatMap(l => l.items).filter(b => b.x1 <= label.x0 + 1).sort((a, b) => b.x1 - a.x1);
    const run = []; let left = Infinity;
    for (const b of items) if (!run.length || b.x1 >= left - 0.06 * W) { run.push(b); left = Math.min(left, b.x0); }
    // Extend the run leftwards along the same visual row (parts of one formula can sit slightly higher or lower).
    for (let added = true; added && run.length;) {
      added = false; const u = union(run);
      for (const b of inCol) {
        if (run.includes(b) || b.x1 > label.x0 + 1 || b.x1 < left - 0.06 * W || prose({...b, cy: cy(b)})) continue;
        const ov = Math.min(b.y1, u.y1) - Math.max(b.y0, u.y0);
        if (ov >= 0.4 * (b.y1 - b.y0)) { run.push(b); left = Math.min(left, b.x0); added = true; }
      }
    }
    picked = run.length ? [{items: run, ...union(run), s: run.map(b => b.s).join(' ')}] : [];
  }
  const span = () => union(picked.length ? picked : [label]);
  // A number on its own line (below a multi-line equation) seeds growth from the number itself.
  const alone = !picked.length;
  const grow = dir => {
    for (let step = 0; step < 8; step++) {
      const edge = dir < 0 ? Math.min(label.y0, ...picked.map(l => l.y0)) : Math.max(label.y1, ...picked.map(l => l.y1));
      // Integral signs and fractions space lines apart, so allow up to 1.25 line heights; lines must
      // overlap the equation horizontally (a stray piece beside it is skipped, not a stop).
      const sp = span(), reach = alone && !picked.length ? 0.6 * colW : 0.05 * W;
      const cand = lines.filter(l => !picked.includes(l) && l.x1 >= sp.x0 - reach && l.x0 <= sp.x1 + 0.05 * W && (dir < 0 ? l.y1 <= edge + 0.2 * h && edge - l.y1 < 1.25 * h : l.y0 >= edge - 0.2 * h && l.y0 - edge < 1.25 * h));
      const next = dir < 0 ? cand.sort((a, b) => b.y1 - a.y1)[0] : cand.sort((a, b) => a.y0 - b.y0)[0];
      if (!next) return;
      // A line just above/below another equation's number belongs to that equation (stacked equations, integral limits).
      const vgap = (a, b) => Math.max(0, Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1));
      const own = Math.min(vgap(next, label), dir < 0 ? edge - next.y1 : next.y0 - edge);
      const neighbour = others.some(o => vgap(next, o) <= own);
      if (prose(next) || hasOtherLabel(next) || neighbour) { if (debug) debug.push(`stop ${dir < 0 ? 'up' : 'down'} at y${next.y0.toFixed(0)}-${next.y1.toFixed(0)} prose=${prose(next)} label=${hasOtherLabel(next)} neighbour=${neighbour} ${JSON.stringify(next.s.slice(0, 40))}`); return; }
      picked.push(next);
    }
  };
  grow(-1); if (!alone || !picked.length) grow(1);
  // Sweep in line fragments that sit within the frame's height and continue it sideways
  // (one visual row can be split into several fragments with slightly different centres).
  for (let added = picked.length > 0; added;) {
    added = false; const u = union(picked);
    for (const l of lines) {
      if (picked.includes(l) || l.x1 > label.x0 + 1 || prose(l) || hasOtherLabel(l)) continue;
      const ov = Math.min(l.y1, u.y1) - Math.max(l.y0, u.y0);
      const c = (l.y0 + l.y1) / 2, mine = Math.max(0, Math.max(l.y0, label.y0) - Math.min(l.y1, label.y1));
      const theirs = others.some(o => Math.max(0, Math.max(l.y0, o.y0) - Math.min(l.y1, o.y1)) < mine);
      if (c > u.y0 && c < u.y1 && ov >= 0.5 * (l.y1 - l.y0) && !theirs && l.x1 >= u.x0 - 0.06 * W && l.x0 <= u.x1 + 0.02 * W) { picked.push(l); added = true; }
    }
  }
  if (!picked.length && debug) { const near = lines.filter(l => Math.abs(l.cy - cy(label)) < 4 * h).map(l => `  near ${l.x0.toFixed(0)}-${l.x1.toFixed(0)} y${l.y0.toFixed(0)}-${l.y1.toFixed(0)} prose=${prose(l)} ${JSON.stringify(l.s.slice(0, 50))}`); debug.push(`label ${label.x0.toFixed(0)}-${label.x1.toFixed(0)} y${label.y0.toFixed(0)}-${label.y1.toFixed(0)} h${h.toFixed(1)} col ${col.left.toFixed(0)}-${col.right.toFixed(0)}`, ...near); }
  if (!picked.length) return norm({x0: label.x0 - 0.5 * colW, y0: label.y0 - 0.4 * h, x1: label.x1 + 2, y1: label.y1 + 0.4 * h}, W, H);
  if (debug) debug.push(`label y${label.y0.toFixed(0)}-${label.y1.toFixed(0)} h${h.toFixed(1)} alone=${alone}`, ...picked.map(l => `${l.x0.toFixed(0)}-${l.x1.toFixed(0)} y${l.y0.toFixed(0)}-${l.y1.toFixed(0)} pw${proseWords(l.s)} ${JSON.stringify(l.s.slice(0, 70))}`), `col ${col.left.toFixed(0)}-${col.right.toFixed(0)}`);
  const box = union([...picked, label]);
  const pad = 0.25 * h;
  return norm({x0: Math.max(col.left - pad - 2, box.x0 - pad), y0: box.y0 - pad, x1: Math.min(col.right + pad, box.x1 + pad), y1: box.y1 + pad}, W, H);
}

// Highlight rectangles (one per line) for the words of `quote` on a page, or null.
// Matching ignores case, spacing, hyphenation and punctuation.
export function findQuote(boxes, quote, W, H) {
  const key = s => s.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, '');
  const stream = [], owner = [], frac = [];
  boxes.forEach((b, i) => { const k = b.s.normalize('NFKC').toLowerCase(); for (let j = 0; j < k.length; j++) if (/[a-z0-9]/.test(k[j])) { stream.push(k[j]); owner.push(i); frac.push(k.length > 1 ? j / (k.length) : 0); } });
  const text = stream.join(''), q = key(quote);
  if (q.length < 6) return null;
  let at = text.indexOf(q), len = q.length;
  if (at < 0 && q.length > 50) { // fall back to the longest of the opening/closing 40 characters that matches
    for (const part of [q.slice(0, 40), q.slice(-40)]) { const i = text.indexOf(part); if (i >= 0) { at = i; len = part.length; break; } }
  }
  if (at < 0) return null;
  const parts = new Map();
  for (let k = at; k < at + len; k++) {
    const i = owner[k], b = boxes[i], f = frac[k], w = b.x1 - b.x0;
    const x0 = b.x0 + w * f, x1 = b.x0 + w * (f + 1 / Math.max(1, b.s.length));
    const p = parts.get(i); if (p) { p.x1 = Math.max(p.x1, x1); } else parts.set(i, {x0, y0: b.y0, x1, y1: b.y1});
  }
  return linesOf([...parts.values()].map(p => ({...p, s: ''}))).map(l => norm({x0: l.x0 - 1, y0: l.y0 - 1, x1: l.x1 + 1, y1: l.y1 + 1}, W, H));
}

// A real equation number ends its line: no text follows it within its column, and it is
// either at the column's right edge (read from nearby justified prose) or set off from the
// formula by a clear gap, as with tab-stop numbering inset from the margin.
// Rejects "x(0)" inside formulas and "Eq. (2)" in running text.
export function isEquationLabel(boxes, label, W) {
  const why = () => false; // rejection reasons are spelled out at each call site
  const h = label.y1 - label.y0;
  const sameLine = b => b !== label && b.s.trim() && b.y1 > label.y0 + 0.3 * h && b.y0 < label.y1 - 0.3 * h;
  const right = label.x1 > W * 0.56;
  // Column of the number: in two-column layouts each column holds the items that start on its side
  // of the page middle (gutters can be narrow, so text across the gutter never counts).
  const near = boxes.filter(b => b.s.trim() && Math.abs(cy(b) - cy(label)) < 300);
  const twoCol = isTwoColumn(boxes, label, W);
  const side = !twoCol ? near : near.filter(b => right ? b.x0 >= W * 0.5 : b.x0 < W * 0.5 && b.x1 <= W * 0.56);
  const prose = linesOf(side).filter(l => words(l.s) >= 5);
  const edge = prose.length >= 3 ? median(prose.map(l => l.x1).sort((a, b) => b - a).slice(0, Math.max(3, prose.length >> 1))) : null;
  const limit = Math.max(edge ?? 0, label.x1) + 0.006 * W;
  if (boxes.some(b => sameLine(b) && b.x0 >= label.x1 - 1 && b.x0 < limit)) return false; // followed by text
  // What precedes it in its column: a prose line or "Eq." means a reference in running text;
  // a "(" touching a letter or digit means a function argument such as x(1).
  const inCol = b => !twoCol || (right ? b.x0 >= W * 0.5 : b.x0 < W * 0.5);
  const left = boxes.filter(b => sameLine(b) && inCol(b) && b.x1 <= label.x0 + 1).sort((a, b) => a.x1 - b.x1);
  const colLeft = prose.length >= 3 ? median(prose.map(l => l.x0)) : null;
  const leftText = left.map(b => b.s).join(' '), pw = proseWords(leftText);
  const hasOps = /[=+\u2212\u2211\u222b<>\u2264\u2265\u2248\u225c\u00bc\u00fe]/.test(leftText); // an equation, possibly with notes
  if (wordPairs(leftText) && (pw >= (hasOps ? 12 : 8) || (!hasOps && pw >= 3 && colLeft != null && left.length && left[0].x0 <= colLeft + 0.015 * W))) return why('prose line: ' + leftText);
  const prev = left[left.length - 1], gap = label.x0 - (prev ? prev.x1 : -Infinity);
  if (prev && gap < 0.015 * W && /\b(eqs?|equations?)\.?\s*$/i.test(prev.s)) return why('after Eq.');
  if (prev && gap < 0.004 * W && /[A-Za-z0-9]\s*$/.test(prev.s)) return why(`touching ${JSON.stringify(prev.s.slice(-12))} gap ${(gap / W * 100).toFixed(2)}%`);
  if (edge == null || label.x1 >= edge - 0.025 * W) return true;
  return label.x1 >= edge - 0.12 * W && gap >= 0.02 * W;
}

// Text-item boxes in page pixels (scale 1, top-left origin) from pdf.js text content.
// `Util` is pdfjs.Util; `vp` a scale-1 viewport.
export function textBoxes(items, vp, Util) {
  return items.filter(t => typeof t.str === 'string' && t.str.length).map(t => {
    const m = Util.transform(vp.transform, t.transform), fh = Math.hypot(m[2], m[3]);
    return {s: t.str, x0: m[4], x1: m[4] + t.width, y0: m[5] - fh * 0.82, y1: m[5] + fh * 0.22};
  });
}

// Parenthesis look-alikes produced by broken font encodings in some PDFs
// (control characters U+0003/U+0004, the CJK pair 共/兲 in older ASME papers, full-width forms).
export const normParens = s => s.replace(/[\u0003共（]/g, '(').replace(/[\u0004兲）]/g, ')');
const LABEL = /^\(\s*(\d+[a-z]?)\s*\)$/i;

// Join label pieces left to right; pieces that overlap on the page repeat their shared characters.
function joinPieces(a, aBox, b, bBox) {
  if (bBox.x0 < aBox.x1 - 0.5) for (let k = Math.min(a.length, b.length); k > 0; k--) if (a.endsWith(b.slice(0, k))) return a + b.slice(k);
  return a + b;
}

// Equations on one page: [{label, box, labelBox}] with boxes normalised to the page.
// Labels are assembled by position from an opening "(" and the pieces to its right on the same
// line, because some PDFs split "(12)" into "(", "12", ")" or overlapping "(1" + "12)" fragments
// that are not adjacent in the text order.
export function detectEquations(boxes, W, H) {
  const found = [], used = new Set();
  for (const t of boxes) {
    if (used.has(t)) continue;
    const s0 = normParens(t.s).trim();
    let hit = null;
    if (LABEL.test(s0)) hit = {m: s0.match(LABEL), parts: [t]};
    else if (/^\(\s*\d*[a-z]?$/i.test(s0)) {
      const h = t.y1 - t.y0;
      const pieces = boxes.filter(b => b !== t && !used.has(b) && b.s.trim() && Math.abs(cy(b) - cy(t)) < 0.5 * h && b.x0 >= t.x0 - 0.5 && b.x0 <= t.x1 + 0.02 * W).sort((a, b) => a.x0 - b.x0);
      let str = s0, last = t; const parts = [t];
      for (const b of pieces) {
        const bs = normParens(b.s).trim();
        if (!/^[\d\sa-z)]+$/i.test(bs) || b.x0 > last.x1 + 0.02 * W) break;
        str = joinPieces(str, last, bs, b); parts.push(b); last = b;
        if (LABEL.test(str)) { hit = {m: str.match(LABEL), parts}; break; }
        if (str.length > 8) break;
      }
    }
    if (!hit) continue;
    const g = hit.parts, b = {s: `(${hit.m[1]})`, x0: Math.min(...g.map(v => v.x0)), x1: Math.max(...g.map(v => v.x1)), y0: Math.min(...g.map(v => v.y0)), y1: Math.max(...g.map(v => v.y1))};
    if (!isEquationLabel([...boxes.filter(v => !g.includes(v)), b], b, W)) continue;
    g.forEach(v => used.add(v));
    found.push({label: hit.m[1], parts: g, b});
  }
  // Second pass: frames, knowing every number on the page (so stacked equations split correctly).
  const labels = found.map(f => f.b), page = [...boxes.filter(v => !used.has(v)), ...labels];
  return found.map(f => ({label: f.label, box: equationBox(page, f.b, W, H, labels), labelBox: norm(f.b, W, H)}));
}
