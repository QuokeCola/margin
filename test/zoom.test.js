import {test} from 'node:test';
import assert from 'node:assert/strict';
import {zoomAnchor, pinchStep, clampZoom} from '../src/zoom.js';

test('zoomAnchor: page under the point and the point as fractions of it', () => {
  const pages = [{top: 24, left: 50, width: 600, height: 800}, {top: 846, left: 50, width: 600, height: 800}];
  assert.deepEqual(zoomAnchor(pages, 350, 424), {index: 0, fx: 0.5, fy: 0.5});
  assert.deepEqual(zoomAnchor(pages, 50, 835), {index: 1, fx: 0, fy: -11 / 800}); // in the gap: the next page
  assert.equal(zoomAnchor(pages, 0, 5000).index, 1);                               // past the end: the last page
  assert.equal(zoomAnchor([], 0, 0), null);
});

test('pinchStep keeps the focal point in place over a whole gesture', () => {
  let t = {s: 1, tx: 0, ty: 0};
  const X = 123.4, Y = 5678.9; // a point of the unscaled column
  const shown = t => [t.tx + t.s * X, t.ty + t.s * Y];
  const [fx, fy] = shown(t);
  for (const k of [1.04, 1.04, 1.1, 0.9, 1.2]) t = pinchStep(t, k, fx, fy);
  shown(t).forEach((v, i) => assert.ok(Math.abs(v - [fx, fy][i]) < 1e-6));
  assert.ok(Math.abs(t.s - 1.04 * 1.04 * 1.1 * 0.9 * 1.2) < 1e-12);
  assert.equal(clampZoom(7), 3);
});
