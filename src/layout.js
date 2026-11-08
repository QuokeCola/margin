// Page-geometry helpers. A "box" is a text item in page pixels at scale 1, top-left origin:
// {s, x0, y0, x1, y1}. All results are normalised to 0..1 of the page width/height.

const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };
const words = s => (s.match(/[A-Za-z]{3,}/g) || []).length;
const union = bs => ({x0: Math.min(...bs.map(b => b.x0)), y0: Math.min(...bs.map(b => b.y0)), x1: Math.max(...bs.map(b => b.x1)), y1: Math.max(...bs.map(b => b.y1))});
const norm = (b, W, H) => ({x0: b.x0 / W, y0: b.y0 / H, x1: b.x1 / W, y1: b.y1 / H});
const cy = b => (b.y0 + b.y1) / 2;

// Left/right edges of the text column that holds a box ending at `right` (one- or two-column layouts).
export function columnOf(boxes, label, W) {
  const near = boxes.filter(b => b.s.trim() && Math.abs(cy(b) - cy(label)) < 260);
  const crossing = near.filter(b => b.x0 < W * 0.48 && b.x1 > W * 0.52).length;
  const twoCol = crossing < 3;
  let pool;
  if (!twoCol) pool = near;
  else if (label.x1 < W * 0.56) pool = near.filter(b => b.x1 <= W * 0.53);
  else pool = near.filter(b => b.x0 >= W * 0.47);
  const left = pool.length ? median(pool.map(b => b.x0).sort((a, b) => a - b).slice(0, Math.max(3, pool.length >> 3))) : 0;
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
export function equationBox(boxes, label, W, H, labelPattern = /^\(\s*\d+[a-z]?\s*\)$/i, debug = null) {
  const col = columnOf(boxes, label, W), colW = col.right - col.left;
  const inCol = boxes.filter(b => b !== label && b.s.trim() && b.x0 >= col.left - 3 && b.x1 <= col.right + 3);
  const lines = linesOf(inCol);
  const h = median(inCol.map(b => b.y1 - b.y0)) || (label.y1 - label.y0);
  const isLabel = b => labelPattern.test(b.s.trim());
  // Prose: many words, or a line starting at the column edge with a few words (incl. a paragraph's last line).
  const prose = l => words(l.s) >= 6 || (l.x0 <= col.left + 0.03 * colW && words(l.s) >= 1);
  // Another equation's number beside this line means the line belongs to that equation.
  const others = inCol.filter(b => isLabel(b) && b.x0 > col.left + 0.5 * colW);
  const hasOtherLabel = l => others.some(o => o.y1 > l.y0 + 0.1 * h && o.y0 < l.y1 - 0.1 * h);
  // Lines that vertically overlap the label (equation items may sit slightly above/below it).
  let picked = lines.filter(l => l.y1 > label.y0 - 0.15 * h && l.y0 < label.y1 + 0.15 * h && l.x0 < label.x0 && !prose(l));
  if (!picked.length) return norm({x0: label.x0 - 0.5 * colW, y0: label.y0 - 0.4 * h, x1: label.x1 + 2, y1: label.y1 + 0.4 * h}, W, H);
  const grow = dir => {
    for (let step = 0; step < 8; step++) {
      const edge = dir < 0 ? Math.min(...picked.map(l => l.y0)) : Math.max(...picked.map(l => l.y1));
      const cand = lines.filter(l => !picked.includes(l) && (dir < 0 ? l.y1 <= edge + 0.2 * h && edge - l.y1 < 0.9 * h : l.y0 >= edge - 0.2 * h && l.y0 - edge < 0.9 * h));
      const next = dir < 0 ? cand.sort((a, b) => b.y1 - a.y1)[0] : cand.sort((a, b) => a.y0 - b.y0)[0];
      if (!next || prose(next) || hasOtherLabel(next)) return;
      picked.push(next);
    }
  };
  grow(-1); grow(1);
  if (debug) debug.push(...picked.map(l => `${l.x0.toFixed(0)}-${l.x1.toFixed(0)} y${l.y0.toFixed(0)}-${l.y1.toFixed(0)} w${words(l.s)} ${JSON.stringify(l.s.slice(0, 70))}`), `col ${col.left.toFixed(0)}-${col.right.toFixed(0)}`);
  const box = union([...picked, label]);
  const pad = 0.25 * h;
  return norm({x0: Math.max(col.left - 2, box.x0 - pad), y0: box.y0 - pad, x1: Math.min(col.right + pad, box.x1 + pad), y1: box.y1 + pad}, W, H);
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

// A real equation number ends its line and sits at the right edge of its text column
// (the edge is read from nearby justified prose lines). Rejects "x(0)" inside formulas
// and "Eq. (2)" in running text.
export function isEquationLabel(boxes, label, W) {
  const h = label.y1 - label.y0;
  const followed = boxes.some(b => b !== label && b.s.trim() && b.x0 >= label.x1 - 1 && b.x0 < label.x1 + 0.015 * W && b.y1 > label.y0 + 0.3 * h && b.y0 < label.y1 - 0.3 * h);
  if (followed) return false;
  const right = label.x1 > W * 0.56;
  const side = boxes.filter(b => b.s.trim() && Math.abs(cy(b) - cy(label)) < 300 && (right ? b.x0 >= W * 0.45 : b.x1 <= W * 0.55));
  const prose = linesOf(side).filter(l => words(l.s) >= 5);
  if (prose.length < 3) return true; // not enough context to judge
  const edge = median(prose.map(l => l.x1).sort((a, b) => b - a).slice(0, Math.max(3, prose.length >> 1)));
  return label.x1 >= edge - 0.025 * W;
}
