import {test} from 'node:test';
import assert from 'node:assert/strict';
import {detectEquations, findQuote, normParens} from '../src/layout.js';

// Synthetic single-column page, 600 x 800, text column 50..550. Each line is one item per word.
const W = 600, H = 800, h = 10;
function line(y, text, x0 = 50, x1 = null) {
  const parts = text.split(' ');
  const width = (x1 ?? (x0 + text.length * 5)) - x0, step = width / text.length;
  let x = x0; const out = [];
  for (const p of parts) { out.push({s: p, x0: x, x1: x + p.length * step, y0: y, y1: y + h}); x += (p.length + 1) * step; }
  return out;
}
const prose = (y, n = 4) => Array.from({length: n}, (_, i) => line(y + i * 14, 'the quick model of the drive is stiff and the result follows here', 50, 550)).flat();
const label = (y, s, x = 530) => ({s, x0: x, x1: x + s.length * 5, y0: y, y1: y + h});
const found = boxes => detectEquations(boxes, W, H).map(e => e.label);

test('labels: plain, split, overlapping fragments, broken-font parentheses', () => {
  const base = [...prose(100), ...prose(400)];
  assert.deepEqual(found([...base, ...line(200, 'x = A y + B u', 200), label(200, '(1)')]), ['1']);
  assert.deepEqual(found([...base, ...line(200, 'x = A y', 200), label(200, '('), label(200, '12', 535), label(200, ')', 545)]), ['12']);
  assert.deepEqual(found([...base, ...line(200, 'x = A y', 200), label(200, '(7', 530), label(200, '7)', 533)]), ['7']);
  assert.deepEqual(found([...base, ...line(200, 'x = A y', 200), label(200, '\u00033\u0004')]), ['3']);
  assert.equal(normParens('共' + '4' + '兲'), '(4)');
});

test('labels: references in prose and function arguments are rejected', () => {
  const base = [...prose(100), ...prose(400)];
  // "... as shown in Eq. (3)" ending a justified prose line
  assert.deepEqual(found([...base, ...line(250, 'the residual is computed as shown in Eq.', 50, 520), label(250, '(3)', 530)]), []);
  // x(1) where the parenthesis touches the symbol
  assert.deepEqual(found([...base, ...line(250, 'y = x', 300, 528), label(250, '(1)', 529)]), []);
});

test('labels: inset numbers set off by a gap are accepted', () => {
  const base = [...prose(100), ...prose(400)];
  assert.deepEqual(found([...base, ...line(250, 'F = m a', 200, 300), label(250, '(5)', 505)]), ['5']);
});

test('frames: number below a multi-line equation grows upward, not into prose', () => {
  const page = [...prose(100), ...line(170, 'Q = k x + c v', 150, 400), ...line(184, 'D = k y + c w', 150, 420), label(198, '(16)'), ...prose(220)];
  const [e] = detectEquations(page, W, H);
  assert.equal(e.label, '16');
  assert.ok(e.box.y0 * H <= 171 && e.box.y0 * H > 150, `top ${e.box.y0 * H}`); // includes both equation lines, not the prose above
  assert.ok(e.box.y1 * H >= 208 && e.box.y1 * H < 222, `bottom ${e.box.y1 * H}`);
});

test('frames: stacked equations do not swallow each other', () => {
  const page = [...prose(100), ...line(170, 'a = b + c', 200, 400), label(170, '(1)'), ...line(186, 'd = e + f', 200, 400), label(186, '(2)'), ...prose(220)];
  const [a, b] = detectEquations(page, W, H);
  assert.ok(a.box.y1 <= b.box.y0 + 4 / H, 'frame (1) ends where (2) begins');
});

test('quotes match across spacing, case and hyphenation', () => {
  const boxes = [...line(100, 'The residual is a filtered ver-', 50, 550), ...line(114, 'sion of the external torque.', 50, 400)];
  const rects = findQuote(boxes, 'residual is a filtered version of the external torque', W, H);
  assert.equal(rects.length, 2);
});

test('quotes tolerate small differences and reject unrelated text', () => {
  const boxes = [...line(100, 'Collision detection uses the generalized momentum of the robot', 50, 550), ...line(114, 'and a first-order filter on the residual signal.', 50, 400)];
  const near = findQuote(boxes, 'collision detection uses generalised momentum of the robot', W, H); // one word dropped, one spelling changed
  assert.ok(near && near.dist > 0 && near.dist <= 0.2, `dist ${near?.dist}`);
  assert.equal(findQuote(boxes, 'the stiffness matrix of the ball screw nut', W, H), null);
  assert.equal(findQuote(boxes, 'first-order filter on the residual', W, H).dist, 0);
});

// Fixtures from the equation benchmark (arXiv LaTeX ground truth + ScienceDirect PDFs).
// Prose set as real text: one item per word, word spaces of 3 px.
function words(y, text, x0 = 50, x1 = 550) {
  const ws = text.split(' '), gap = 3, cw = (x1 - x0 - gap * (ws.length - 1)) / ws.join('').length;
  let x = x0; return ws.map(w => { const b = {s: w, x0: x, x1: x + w.length * cw, y0: y, y1: y + h}; x = b.x1 + gap; return b; });
}
const para = (y, n = 4, x0 = 50, x1 = 550) => Array.from({length: n}, (_, i) => words(y + i * 14, 'the quick model of the drive is stiff and the result follows from the measured data here', x0, x1)).flat();

test('labels: years, values and four-digit numbers are not equation numbers', () => {
  const base = [...para(100), ...para(400)];
  assert.deepEqual(found([...base, ...line(250, 'Smith J Jones K Precision Engineering 2008', 50, 400), label(250, '(2008)', 520)]), []);
  assert.deepEqual(found([...base, ...line(250, 'k =', 200, 230), label(250, '(0.5)', 520)]), []);
});

test('labels: section, appendix and hyphenated numbers; parentheses around a separate digit', () => {
  const base = [...para(100), ...para(400)];
  assert.deepEqual(found([...base, ...line(200, 'x = A y', 200), label(200, '(2.14)', 520)]), ['2.14']);
  assert.deepEqual(found([...base, ...line(200, 'x = A y', 200), label(200, '(A.3)', 520)]), ['A.3']);
  assert.deepEqual(found([...base, ...line(200, 'x = A y', 200), label(200, '(5-a)', 520)]), ['5a']);
  // "( )" as one item with the digit drawn between the parentheses in another font
  assert.deepEqual(found([...base, ...line(200, 'x = A y', 200), {s: '( )', x0: 530, x1: 541, y0: 200, y1: 210}, {s: '7', x0: 533, x1: 538, y0: 200, y1: 210}]), ['7']);
  // MT Extra parentheses (Elsevier): "ð12Þ"
  assert.deepEqual(found([...base, ...line(200, 'x ¼ A y þ B', 200), label(200, 'ð12Þ', 520)]), ['12']);
});

test('labels: algorithm comments and reference lists are not equation numbers', () => {
  const base = [...para(100), ...para(400)];
  assert.deepEqual(found([...base, ...line(250, '5: if p < q then ▷', 60, 300), label(250, '(22)', 305)]), []);
  assert.deepEqual(found([...base, ...line(250, 's.t. (3) ,', 400, 515), label(250, '(23)', 518)]), []);
  // ...but an equation ending in "x)," before a well-separated number is one
  assert.deepEqual(found([...base, ...line(250, 'u = m ( e + x ) ,', 100, 300), label(250, '(8)', 520)]), ['8']);
});

test('labels: a number starting a line in the right column is a list item', () => {
  // Two columns: 50..290 and 310..550; "(5)" sits left of the page centre line + 6%, text follows it closely.
  const page = [...para(100, 6, 50, 290), ...para(100, 6, 310, 550), ...words(190, 'operator interactions are bound to handheld', 50, 290),
    label(190, '(5)', 312), ...words(190, 'Type : The objects type.', 332, 450), ...para(210, 6, 310, 550), ...para(210, 6, 50, 290)];
  assert.deepEqual(found(page), []);
});

test('frames: a formula far left of its number on an equation-dense single-column page', () => {
  // Formula lines leave the page centre empty, so only the two prose lines show it is one column.
  const page = [...words(80, 'where the voltage between stator and ring is applied to the flexible ring here')];
  for (let i = 0; i < 8; i++) page.push(...line(105 + 20 * i, `q${i} = 1 / 2 b r`, 60, 200), label(105 + 20 * i, `(${i + 1})`));
  page.push(...words(270, 'thus the total force per unit arc length of the ring is found as follows'));
  const eqs = detectEquations(page, W, H);
  assert.equal(eqs.length, 8);
  for (const e of eqs) assert.ok(e.box.x0 * W < 70, `frame (${e.label}) starts at ${e.box.x0 * W}, should hold the formula at x=60`);
});

test('frames: rows of a constraint list with tall sums reaching between rows do not overlap', () => {
  // Each row: a summation sign taller than the row, the row, its number, and a subscript line below.
  const page = [...para(100), ...para(250)];
  [170, 192, 214].forEach((y, i) => page.push({s: '\u2211', x0: 200, x1: 214, y0: y - 4, y1: y + 18}, ...line(y, 'f <= x R', 220, 420), label(y, `(${i + 1})`), ...line(y + 15, 'p in P', 198, 232)));
  const eqs = detectEquations(page, W, H);
  assert.equal(eqs.length, 3);
  for (let i = 1; i < eqs.length; i++) assert.ok(eqs[i - 1].box.y1 <= eqs[i].box.y0 + 1e-9, `frames ${i} and ${i + 1} overlap`);
});

test('left-side numbers (leqno): found when a page has none on the right; list items are not', () => {
  const page = [...para(100), label(170, '(3.10)', 60), ...line(170, 'f + e x = s + t w', 200, 420), ...para(200), label(270, '(3.11)', 60), ...line(270, 'g = h', 250, 300), ...para(300)];
  const eqs = detectEquations(page, W, H);
  assert.deepEqual(eqs.map(e => e.label), ['3.10', '3.11']);
  const [a] = eqs;
  assert.ok(a.box.x0 * W <= 60 && a.box.x1 * W >= 420, 'frame spans number and formula');
  assert.ok(a.box.y0 * H > 150 && a.box.y1 * H < 195, `frame stays off the paragraphs: ${a.box.y0 * H}-${a.box.y1 * H}`);
  // "(1) The first step ..." lines are an enumerated list
  assert.deepEqual(found([...para(100), label(170, '(1)', 60), ...words(170, 'The first step reads the model from the file', 80, 400), ...para(200)]), []);
});

test('frames: a paragraph line with inline math is not part of the equation above it', () => {
  const page = [...para(100), ...line(170, 'f = s + t', 250, 350), label(170, '(7)'), ...words(186, 'Note that f >= 0 on R is equivalent to f >= 0 on S for all the points'), ...para(200)];
  const [e] = detectEquations(page, W, H);
  assert.ok(e.box.y1 * H < 188, `frame ends above the paragraph line: ${e.box.y1 * H}`);
});

test('frames: a display spanning both columns of a two-column page is framed whole', () => {
  // Columns 50..290 and 310..550; the formula runs from x=80 across the gutter, its number in the right column.
  const page = [...para(100, 6, 50, 290), ...para(100, 6, 310, 550), ...line(200, 'G11 = x1 / u = m2 s2 + c s + k', 80, 300), ...line(200, 'G13 = x1 / d2 = c s + k', 318, 480), label(200, '(5)'),
    ...para(220, 6, 50, 290), ...para(220, 6, 310, 550)];
  const [e] = detectEquations(page, W, H);
  assert.equal(e.label, '5');
  assert.ok(e.box.x0 * W < 85, `frame starts at ${e.box.x0 * W}`);
  assert.ok(e.box.y0 * H > 180 && e.box.y1 * H < 220, 'frame stays on the display row');
});
