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
