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
// Same results as Math.min(...bs.map(...)) (NaN and -0 included), without the temporary arrays.
const union = bs => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of bs) { x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0); x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1); }
  return {x0, y0, x1, y1};
};

const norm = (b, W, H) => ({x0: b.x0 / W, y0: b.y0 / H, x1: b.x1 / W, y1: b.y1 / H});
const cy = b => (b.y0 + b.y1) / 2;

// Left/right edges of the text column that holds a box ending at `right` (one- or two-column layouts).
// Two-column layout near this point? A gutter leaves the page centre empty on every line, while
// single-column text (even stored one item per word) covers the centre on most lines.
function isTwoColumn(boxes, label, W) {
  const near = boxes.filter(b => b.s.trim() && Math.abs(cy(b) - cy(label)) < 150);
  let lines = linesOf(near);
  if (lines.length < 3) return false;
  // Judge by lines of running text (4+ words): formulas leave the centre empty in any layout, so on
  // equation-dense stretches use the text lines of the whole page instead.
  // Only lines with text on both sides of the centre can tell (a short last line or "(i) for the
  // first case:" does not reach the middle in any layout).
  const text = ls => ls.filter(l => proseWords(l.s) >= 4 && l.x0 < W * 0.4 && l.x1 > W * 0.6);
  // A line covers the centre if an item crosses it or two neighbouring items leave only a word
  // space there (lines stored one item per word or phrase); a gutter is wider than 1.2% of the page.
  const crosses = l => {
    const it = [...l.items].sort((a, b) => a.x0 - b.x0), c = W * 0.5;
    if (it.some(b => b.x0 < c - 2 && b.x1 > c + 2)) return true;
    for (let i = 1; i < it.length; i++) if (it[i - 1].x1 <= c + 2 && it[i].x0 >= c - 2 && it[i].x0 - it[i - 1].x1 < 0.012 * W) return true;
    return false;
  };
  if (text(lines).length >= 3) lines = text(lines);
  else {
    // Too few lines span the centre here (formulas, or a picture filling the other column): look
    // for justified text in one half, 3+ lines sharing a right edge just left of the centre (or a
    // left edge just right of it), where a gutter would be.
    const page = linesOf(boxes.filter(b => b.s.trim())), prose = page.filter(l => proseWords(l.s) >= 4);
    if (text(page).filter(crosses).length >= 3) return false; // paragraph lines run across the centre elsewhere on the page
    const shared = xs => xs.some(x => xs.filter(v => Math.abs(v - x) < 0.01 * W).length >= 3);
    return shared(prose.filter(l => l.x1 < W * 0.5 && l.x1 > W * 0.4).map(l => l.x1)) || shared(prose.filter(l => l.x0 > W * 0.5 && l.x0 < W * 0.6).map(l => l.x0));
  }
  // The nearest lines decide: a full-width caption or title block nearby must not outvote them.
  lines = lines.sort((a, b) => Math.abs(a.cy - cy(label)) - Math.abs(b.cy - cy(label))).slice(0, 8);
  const covering = lines.filter(crosses).length;
  return lines.length - covering >= 2 && covering < Math.max(2, 0.3 * lines.length);
}

export function columnOf(boxes, label, W) {
  const near = boxes.filter(b => b.s.trim() && Math.abs(cy(b) - cy(label)) < 260);
  const twoCol = isTwoColumn(boxes, label, W);
  const right = (label.x0 + label.x1) / 2 > W * 0.5; // column of the number by its centre (a number can start a line in the right column)
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
// `beside`: the number stands beside the formula's lines (left numbers, on a mirrored page): a
// line reaching past the number's start is surrounding text, not part of this equation.
export function equationBox(boxes, label, W, H, otherLabels = null, debug = null, beside = false) {
  const col = columnOf(boxes, label, W);
  // A display wider than its column (spanning both columns, number in the right one): the formula
  // nearest the number runs leftwards across the gutter without a column-sized gap.
  if (col.left > W * 0.4) {
    const h0 = label.y1 - label.y0;
    // Items of the label's row, including fraction numerators and denominators just above and below it.
    const row = boxes.filter(b => b !== label && b.s.trim() && b.x1 <= label.x0 + 1 && Math.abs(cy(b) - cy(label)) < 1.2 * h0).sort((a, b) => b.x1 - a.x1);
    let left = label.x0;
    const isNumber = b => (otherLabels ?? []).includes(b) || LABEL.test(normParens(b.s).trim());
    for (const b of row) {
      if (isNumber(b) || (left < label.x0 ? b.x1 < left - 0.05 * W : b.x0 < col.left - 3)) break; // starts in the number's column
      left = Math.min(left, b.x0);
    }
    if (left < W * 0.45 && !proseWords(row.filter(b => b.x0 >= left).map(b => b.s).join(' '))) {
      const starts = linesOf(boxes.filter(b => b.s.trim() && Math.abs(cy(b) - cy(label)) < 260)).map(l => l.x0);
      col.left = Math.min(left, ...starts.filter(x => starts.filter(v => Math.abs(v - x) < 3).length >= 3));
    }
  }
  const colW = col.right - col.left;
  const inCol = boxes.filter(b => b !== label && b.s.trim() && b.x0 >= col.left - 3 && b.x1 <= col.right + 3);
  const lines = linesOf(inCol);
  const h = median(inCol.map(b => b.y1 - b.y0)) || (label.y1 - label.y0);
  // Prose: running text, or a line starting at the column edge with ordinary words and no math
  // (a paragraph's last line, or "where"). Math names like min/max/sin are not words here.
  const atLeft = l => l.x0 <= col.left + 0.03 * colW, pw = l => proseWords(l.s);
  // Lines with math operators (incl. "¼"/"þ", which some fonts use for = and +) need strong evidence;
  // equations carry short notes such as "for region 1" or "for some i".
  const ops = l => /[=+\u2212\u2211\u222b<>\u2264\u2265\u2248\u225c\u00bc\u00fe]/.test(l.s);
  // A line filling the column from edge to edge with running words is a paragraph line even
  // when it holds inline math ("Note that f ≥ 0 on S is equivalent to ...").
  const full = l => l.x0 <= col.left + 0.03 * colW && l.x1 >= col.right - 0.03 * colW;
  const proseText = l => pw(l) >= 6 || (wordPairs(l.s) && pw(l) >= 4) || (full(l) && wordPairs(l.s) && pw(l) >= 2) || (!ops(l) && ((wordPairs(l.s) && pw(l) >= 3) || (atLeft(l) && (STOPWORDS.test(l.s) || pw(l) >= 1))));
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
        if (run.includes(b) || b.x1 > label.x0 + 1 || b.x1 < left - 0.06 * W) continue;
        const ov = Math.min(b.y1, u.y1) - Math.max(b.y0, u.y0);
        if (ov >= 0.4 * (b.y1 - b.y0) && !prose({...b, cy: cy(b)})) { run.push(b); left = Math.min(left, b.x0); added = true; }
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
      if (prose(next) || hasOtherLabel(next) || neighbour || (beside && next.x1 > label.x0 + 2)) { if (debug) debug.push(`stop ${dir < 0 ? 'up' : 'down'} at y${next.y0.toFixed(0)}-${next.y1.toFixed(0)} prose=${prose(next)} label=${hasOtherLabel(next)} neighbour=${neighbour} ${JSON.stringify(next.s.slice(0, 40))}`); return; }
      picked.push(next);
    }
  };
  grow(-1); if (!alone || !picked.length) grow(1);
  // Sweep in line fragments that sit within the frame's height and continue it sideways
  // (one visual row can be split into several fragments with slightly different centres).
  for (let added = picked.length > 0; added;) {
    added = false; const u = union(picked);
    for (const l of lines) {
      if (picked.includes(l) || l.x1 > label.x0 + 1) continue;
      const ov = Math.min(l.y1, u.y1) - Math.max(l.y0, u.y0);
      const c = (l.y0 + l.y1) / 2;
      if (!(c > u.y0 && c < u.y1 && ov >= 0.5 * (l.y1 - l.y0) && l.x1 >= u.x0 - 0.06 * W && l.x0 <= u.x1 + 0.02 * W) || prose(l) || hasOtherLabel(l)) continue;
      const mine = Math.max(0, Math.max(l.y0, label.y0) - Math.min(l.y1, label.y1));
      const theirs = others.some(o => Math.max(0, Math.max(l.y0, o.y0) - Math.min(l.y1, o.y1)) < mine);
      if (!theirs) { picked.push(l); added = true; }
    }
  }
  if (!picked.length && debug) { const near = lines.filter(l => Math.abs(l.cy - cy(label)) < 4 * h).map(l => `  near ${l.x0.toFixed(0)}-${l.x1.toFixed(0)} y${l.y0.toFixed(0)}-${l.y1.toFixed(0)} prose=${prose(l)} ${JSON.stringify(l.s.slice(0, 50))}`); debug.push(`label ${label.x0.toFixed(0)}-${label.x1.toFixed(0)} y${label.y0.toFixed(0)}-${label.y1.toFixed(0)} h${h.toFixed(1)} col ${col.left.toFixed(0)}-${col.right.toFixed(0)}`, ...near); }
  if (!picked.length) return norm({x0: label.x0 - 0.5 * colW, y0: label.y0 - 0.4 * h, x1: label.x1 + 2, y1: label.y1 + 0.4 * h}, W, H);
  if (debug) debug.push(`label y${label.y0.toFixed(0)}-${label.y1.toFixed(0)} h${h.toFixed(1)} alone=${alone}`, ...picked.map(l => `${l.x0.toFixed(0)}-${l.x1.toFixed(0)} y${l.y0.toFixed(0)}-${l.y1.toFixed(0)} pw${proseWords(l.s)} ${JSON.stringify(l.s.slice(0, 70))}`), `col ${col.left.toFixed(0)}-${col.right.toFixed(0)}`);
  const box = union([...picked, label]);
  const pad = 0.25 * h;
  return norm({x0: Math.max(col.left - pad - 2, box.x0 - pad), y0: box.y0 - pad, x1: Math.min(col.right + pad, box.x1 + pad), y1: box.y1 + pad}, W, H);
}

// Approximate substring search: the stretch of `text` closest to `q` (edit distance, free start and
// end in `text`). Returns {start, end, dist}. O(len(q) * len(text)) with two rolling rows.
function closest(text, q) {
  const m = q.length, n = text.length;
  let prev = new Int32Array(n + 1), prevS = new Int32Array(n + 1), cur = new Int32Array(n + 1), curS = new Int32Array(n + 1);
  for (let j = 0; j <= n; j++) { prev[j] = 0; prevS[j] = j; }
  for (let i = 1; i <= m; i++) {
    cur[0] = i; curS[0] = 0; const qc = q.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      let d = prev[j - 1] + (text.charCodeAt(j - 1) === qc ? 0 : 1), st = prevS[j - 1];
      if (prev[j] + 1 < d) { d = prev[j] + 1; st = prevS[j]; }
      if (cur[j - 1] + 1 < d) { d = cur[j - 1] + 1; st = curS[j - 1]; }
      cur[j] = d; curS[j] = st;
    }
    [prev, cur] = [cur, prev]; [prevS, curS] = [curS, prevS];
  }
  let end = 0; for (let j = 1; j <= n; j++) if (prev[j] < prev[end]) end = j;
  return {start: prevS[end], end, dist: prev[end]};
}

// Highlight rectangles (one per line) for the words of `quote` on a page, or null. Matching ignores
// case, spacing, hyphenation and punctuation, and tolerates small differences (a dropped word, a
// garbled symbol): up to ~20% of the characters. The result carries `dist` (0 = exact).
export function findQuote(boxes, quote, W, H) {
  const key = s => s.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, '');
  const stream = [], owner = [], frac = [];
  boxes.forEach((b, i) => { const k = b.s.normalize('NFKC').toLowerCase(); for (let j = 0; j < k.length; j++) if (/[a-z0-9]/.test(k[j])) { stream.push(k[j]); owner.push(i); frac.push(k.length > 1 ? j / (k.length) : 0); } });
  const text = stream.join(''), q = key(quote).slice(0, 400);
  if (q.length < 6 || !text.length) return null;
  let at = text.indexOf(q), len = q.length, dist = 0;
  if (at < 0) {
    const r = closest(text, q);
    dist = r.dist;
    if (dist > Math.max(2, Math.floor(0.2 * q.length))) return null;
    at = r.start; len = r.end - r.start;
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

// A real equation number ends its line: no text follows it within its column, and it is
// either at the column's right edge (read from nearby justified prose) or set off from the
// formula by a clear gap, as with tab-stop numbering inset from the margin.
// Rejects "x(0)" inside formulas and "Eq. (2)" in running text.
export function isEquationLabel(boxes, label, W) {
  const why = () => false; // rejection reasons are spelled out at each call site
  const h = label.y1 - label.y0;
  const sameLine = b => b !== label && b.s.trim() && b.y1 > label.y0 + 0.3 * h && b.y0 < label.y1 - 0.3 * h;
  const right = (label.x0 + label.x1) / 2 > W * 0.5; // column of the number by its centre (a number can start a line in the right column)
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
  // Algorithm comments cite equations at line ends ("▷ (12)"), as do lists like "(13), (23)".
  if (/[\u25b7\u22b3]|\/\/\s*$/.test(leftText.slice(-12))) return why('algorithm comment');
  if (gap < 0.012 * W && /(?:^|\s)\(\s*[A-Z]?\.?\d+(?:\.\d+)?[a-z]?\s*\)\s*(?:,|and|or|to|[-\u2013])\s*$/.test(normParens(leftText))) return why('list of references');
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
// (control characters U+0003/U+0004, the CJK pair 共/兲 in older ASME papers, full-width forms,
// and ð/Þ from the MT Extra font in Elsevier PDFs, the same encoding that turns = into ¼ and + into þ).
export const normParens = s => s.replace(/[\u0003共（\u00f0]/g, '(').replace(/[\u0004兲）\u00de]/g, ')');
// Equation numbers: 12, 12b, per-section 3.12 / 3.12b, appendix A.3 / A3. At most three digits
// and no leading zero: "(2008)" is a year in a reference, "(0.5)" a value.
const LABEL = /^\(\s*((?:[1-9]\d{0,2}(?:\.[1-9]\d{0,2})?|[A-Z]\.?[1-9]\d{0,2})(?:-?[a-z])?)\s*\)$/;
// "(5-a)" is printed for 5a in some journals; the label is reported as "5a".
const labelText = m => m[1].replace('-', '');

// Join label pieces left to right; pieces that overlap on the page repeat their shared characters.
function joinPieces(a, aBox, b, bBox) {
  if (bBox.x0 < aBox.x1 - 0.5) for (let k = Math.min(a.length, b.length); k > 0; k--) if (a.endsWith(b.slice(0, k))) return a + b.slice(k);
  return a + b;
}

// Equations on one page: [{label, box, labelBox}] with boxes normalised to the page.
// Labels are assembled by position from an opening "(" and the pieces to its right on the same
// line, because some PDFs split "(12)" into "(", "12", ")" or overlapping "(1" + "12)" fragments
// that are not adjacent in the text order.
// Numbers normally sit at the right (end of line). A page with none there is checked for numbers
// on the left (leqno, as in SIAM and some math journals) by running the same tests on the
// mirrored page, with a stricter check that the rest of the line is a formula, not a list item.
export function detectEquations(boxes, W, H) {
  let found = findLabels(boxes, W, (all, b) => isEquationLabel(all, b, W)), mirrored = false;
  if (!found.length) {
    found = findLabels(boxes, W, (all, b) => leftLabel(all, b, W));
    mirrored = found.length > 0;
  }
  const flip = mirrored ? (b => ({...b, x0: W - b.x1, x1: W - b.x0})) : (b => b);
  // Second pass: frames, knowing every number on the page (so stacked equations split correctly).
  const used = new Set(found.flatMap(f => f.parts));
  const labels = found.map(f => flip(f.b)), page = [...boxes.filter(v => !used.has(v)).map(flip), ...labels];
  const out = found.map((f, i) => {
    let box = equationBox(page, labels[i], W, H, labels, null, mirrored);
    if (mirrored) box = {...box, x0: 1 - box.x1, x1: 1 - box.x0};
    return {label: f.label, box, labelBox: norm(f.b, W, H)};
  });
  return splitStacked(out, boxes.filter(b => b.s.trim() && !used.has(b)), W, H);
}

// A number at the start of its line (leqno): the mirrored page must pass the usual test, and the
// rest of the line must read as a formula ("(1) The first step ..." is a list item).
function leftLabel(boxes, label, W) {
  const flip = b => ({...b, x0: W - b.x1, x1: W - b.x0});
  if (!isEquationLabel(boxes.map(flip), flip(label), W)) return false;
  const h = label.y1 - label.y0;
  const rest = boxes.filter(b => b !== label && b.s.trim() && b.x0 >= label.x1 - 1 && b.y1 > label.y0 + 0.3 * h && b.y0 < label.y1 - 0.3 * h).sort((a, b) => a.x0 - b.x0);
  const text = rest.map(b => b.s).join(' ');
  const ops = /[=+\u2212\u2211\u222b<>\u2264\u2265\u2248\u225c\u2208\u2286\u2aaf\u00bc\u00fe]/.test(text);
  // Left numbers are set well apart from the (centred) formula; a list label is followed closely.
  if (rest.length && rest[0].x0 - label.x1 < 0.02 * W) return false;
  return proseWords(text) < 4 && !(wordPairs(text) && !ops);
}

// Number candidates accepted by `accept(boxes, labelBox)`: [{label, parts, b}].
function findLabels(boxes, W, accept) {
  const found = [], used = new Set();
  for (const t of boxes) {
    if (used.has(t)) continue;
    const s0 = normParens(t.s).trim();
    let hit = null;
    if (LABEL.test(s0)) hit = {m: s0.match(LABEL), parts: [t]};
    else if (/^\(\s+\)$/.test(s0)) {
      // "( )" drawn as one item with the number in another font placed between the parentheses.
      const h = t.y1 - t.y0;
      const inner = boxes.filter(b => b !== t && !used.has(b) && Math.abs(cy(b) - cy(t)) < 0.5 * h && b.x0 >= t.x0 - 0.5 && b.x1 <= t.x1 + 0.5).sort((a, b) => a.x0 - b.x0);
      const str = `(${inner.map(b => b.s.trim()).join('')})`;
      if (inner.length && LABEL.test(str)) hit = {m: str.match(LABEL), parts: [t, ...inner]};
    }
    else if (/^\(\s*(?:[A-Z]\.?)?\d*(?:\.\d*)?-?[a-z]?$/.test(s0)) {
      const h = t.y1 - t.y0;
      const pieces = boxes.filter(b => b !== t && !used.has(b) && b.s.trim() && Math.abs(cy(b) - cy(t)) < 0.5 * h && b.x0 >= t.x0 - 0.5 && b.x0 <= t.x1 + 0.02 * W).sort((a, b) => a.x0 - b.x0);
      let str = s0, last = t; const parts = [t];
      for (const b of pieces) {
        const bs = normParens(b.s).trim();
        if (!/^[\d\s.\-a-z)]+$/i.test(bs) || b.x0 > last.x1 + 0.02 * W) break;
        str = joinPieces(str, last, bs, b); parts.push(b); last = b;
        if (LABEL.test(str)) { hit = {m: str.match(LABEL), parts}; break; }
        if (str.length > 8) break;
      }
    }
    if (!hit) continue;
    const g = hit.parts, b = {s: `(${labelText(hit.m)})`, x0: Math.min(...g.map(v => v.x0)), x1: Math.max(...g.map(v => v.x1)), y0: Math.min(...g.map(v => v.y0)), y1: Math.max(...g.map(v => v.y1))};
    if (!accept([...boxes.filter(v => !g.includes(v)), b], b)) continue;
    g.forEach(v => used.add(v));
    found.push({label: labelText(hit.m), parts: g, b});
  }
  return found;
}

// Frames of stacked equations (align rows, constraint lists) can still overlap where sums,
// subscripts or cases reach between rows. Split each overlapping pair of frames, one above the
// other, at the widest blank band between their two numbers.
function splitStacked(eqs, boxes, W, H) {
  const px = b => ({x0: b.x0 * W, y0: b.y0 * H, x1: b.x1 * W, y1: b.y1 * H});
  const order = eqs.map((e, i) => i).sort((i, j) => eqs[i].labelBox.y0 - eqs[j].labelBox.y0);
  for (let a = 0; a < order.length; a++) for (let c = a + 1; c < order.length; c++) {
    const A = eqs[order[a]], B = eqs[order[c]];
    const fa = px(A.box), fb = px(B.box), la = px(A.labelBox), lb = px(B.labelBox);
    if (fa.x0 >= fb.x1 || fb.x0 >= fa.x1 || fa.y1 <= fb.y0 || la.y1 > lb.y0) continue; // side by side, apart, or numbers overlapping
    // Blank bands between the numbers, over the frames' common width.
    const x0 = Math.max(fa.x0, fb.x0), x1 = Math.min(fa.x1, fb.x1);
    const ink = boxes.filter(b => b.x1 > x0 && b.x0 < x1 && b.y1 > la.y1 && b.y0 < lb.y0).map(b => [Math.max(b.y0, la.y1), Math.min(b.y1, lb.y0)]).sort((p, q) => p[0] - q[0]);
    let best = null, at = la.y1;
    for (const [y0, y1] of [...ink, [lb.y0, lb.y0]]) { if (y0 > at && (!best || y0 - at > best[1] - best[0])) best = [at, y0]; at = Math.max(at, y1); }
    const cut = best ? (best[0] + best[1]) / 2 : (la.y1 + lb.y0) / 2;
    A.box = {...A.box, y1: Math.max(A.labelBox.y1, Math.min(A.box.y1, cut / H))};
    B.box = {...B.box, y0: Math.min(B.labelBox.y0, Math.max(B.box.y0, cut / H))};
  }
  return eqs;
}
