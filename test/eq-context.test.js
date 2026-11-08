import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cleanEqText, isPoorText, frameText, buildEntries, mentionedLabels, validateEquations, pickImages, indexText, indexLine, diffEntries, planTurn, cropGeometry,
  keyOf, CAPS, MAX_ENTRIES, IMAGE_MAX, REBUILD_IDLE_MS, CROP_WIDTH, CROP_PAD} from '../lib/eq-context.mjs';
import {mergeEquations} from '../lib/equations.mjs';

const box = (y = 0.2) => ({x0: 0.1, y0: y, x1: 0.9, y1: y + 0.05});
const img = n => 'data:image/png;base64,' + 'A'.repeat(n);
const hash = s => 'h' + s.length;

test('frame text: the equation number is removed, wherever the reading order puts it', () => {
  assert.equal(cleanEqText('  x  =  A y + B u   (12) ', '12'), 'x = A y + B u');
  assert.equal(cleanEqText('(3a) a + b = c', '3a'), 'a + b = c');
  assert.equal(cleanEqText('T X − 1 F = 1 (1) j { t }', '1'), 'T X − 1 F = 1 j { t }');
  assert.equal(cleanEqText('f(1) = 2 (2)', '2'), 'f(1) = 2', 'only the label, not other numbers');
  assert.equal(cleanEqText('y = 1 共12兲', '12'), 'y = 1', 'broken-encoding parentheses');
  const items = [{s: 'b', x0: 60, y0: 100, x1: 70, y1: 110}, {s: 'a =', x0: 20, y0: 101, x1: 50, y1: 111}, {s: 'outside', x0: 20, y0: 300, x1: 90, y1: 310}, {s: 'c', x0: 30, y0: 120, x1: 40, y1: 130}];
  assert.equal(frameText(items, {x0: 0, y0: 0, x1: 1, y1: 0.5}, 100, 300), 'a = b c');
});

test('poor text: short, unreadable, or prose with no formula sign', () => {
  assert.equal(isPoorText(''), true);
  assert.equal(isPoorText('x = A y + B u'), true, 'fewer than 8 readable characters');
  assert.equal(isPoorText('x = A y + B u + w'), false);
  assert.equal(isPoorText('\ue001\ue002\ue003 = a + b + c'), true, 'private-use glyphs over 30%');
  assert.equal(isPoorText('\ue001 = a + b + c + d + e'), false, 'a few unmapped glyphs are fine');
  assert.equal(isPoorText('number d to the diagonal elements:'), true, 'an OCR layer that kept only the next words');
  assert.equal(isPoorText('the Newton-Euler and/or equations of 2.1'), true, 'hyphens and slashes are prose');
  assert.equal(isPoorText('where the torque is τ = J u'), false);
});

test('equations named in a question or the chat', () => {
  assert.deepEqual([...mentionedLabels('Explain Eqs. (3)–(6) and eq 12, Equation A.3, equation 2.14b')], ['3', '4', '5', '6', '12', 'A.3', '2.14b']);
  assert.deepEqual([...mentionedLabels('From [[eq:7|p:3]] we get **About Eq. (9), PDF page 4**')], ['7', '9']);
  assert.deepEqual([...mentionedLabels('the equations of motion (12) and equal parts')], []);
  assert.deepEqual([...mentionedLabels('eqs 1 to 40')], ['1', '40'], 'ranges over 20 are not expanded');
});

test('entries from the merged set, in page order, poor flag from the frame text', () => {
  const auto = {2: [{label: '2', box: box(0.5)}], 1: [{label: '1', box: box(0.1)}]};
  const {byPage} = mergeEquations(auto, {'3': {page: 1, box: box(0.6), source: 'user', accepted: true}, '2': {deleted: true}});
  const items = {1: [{s: 'x = A y + B u + w (1)', x0: 100, y0: 110, x1: 400, y1: 125}]};
  const e = buildEntries(byPage, n => items[n] ? {items: items[n], W: 500, H: 1000} : {items: [], W: 500, H: 1000});
  assert.deepEqual(e.map(x => [x.label, x.page, x.text, x.poor]), [['1', 1, 'x = A y + B u + w', false], ['3', 1, '', true]]);
});

test('validation of the app\'s list', () => {
  const ok = {label: '12', page: 3, box: box(), text: 'x = A y + B u + w'};
  assert.deepEqual(validateEquations([ok], 5), [{label: '12', page: 3, box: box(), text: 'x = A y + B u + w', poor: false}]);
  for (const bad of [{...ok, label: '1 2'}, {...ok, label: 12}, {...ok, page: 6}, {...ok, page: 0}, {...ok, box: {x0: 'a'}}, {...ok, box: {x0: 0.5, y0: 0, x1: 0.4, y1: 1}},
    {...ok, text: 5}, {...ok, image: 'data:image/gif;base64,AAAA'}, {...ok, image: img(IMAGE_MAX)}, null])
    assert.equal(validateEquations([bad], 5), null, JSON.stringify(bad));
  assert.equal(validateEquations(Array(MAX_ENTRIES + 1).fill(ok), 5), null);
  assert.equal(validateEquations({}, 5), null);
  assert.equal(validateEquations([{...ok, text: 'y'.repeat(1000)}], 5)[0].text.length, 400);
  // Images beyond the sending cap are dropped, not refused.
  const many = Array.from({length: CAPS.send.images + 2}, (_, i) => ({...ok, label: String(i + 1), text: '', image: img(100)}));
  assert.equal(validateEquations(many, 5).filter(e => e.image).length, CAPS.send.images);
});

test('images: named in the question first, then in the chat, then page order; within count and byte caps', () => {
  const es = Array.from({length: 6}, (_, i) => ({label: String(i + 1), page: 1, box: box(), text: '', poor: true, image: img(100)}));
  es[1] = {...es[1], poor: false};
  const pick = (caps, named = {}) => [...pickImages(es, caps, named)];
  assert.deepEqual(pick({images: 3, bytes: 1e6}), ['1@1', '3@1', '4@1'], 'poor text only');
  assert.deepEqual(pick({images: 3, bytes: 1e6}, {question: new Set(['6']), history: new Set(['5'])}), ['6@1', '5@1', '1@1']);
  assert.deepEqual(pick({images: 9, bytes: 250}), ['1@1', '3@1']);
  assert.deepEqual(pick({images: 9, bytes: 1e6}, {already: new Set(['1@1'])}), ['3@1', '4@1', '5@1', '6@1']);
});

test('index lines', () => {
  const e = {label: '12', page: 5, text: 'x =\ue001 A y + B u + w', poor: false};
  assert.equal(indexLine(e, false), 'Eq. (12) · page 5 · text: "x = A y + B u + w"');
  assert.equal(indexLine(e, true), 'Eq. (12) · page 5 · image attached');
  assert.equal(indexLine({...e, text: '', poor: true}, false), 'Eq. (12) · page 5 · no readable text');
  assert.equal(indexLine({...e, text: 'a b', poor: true}, false), 'Eq. (12) · page 5 · text (garbled): "a b"');
  assert.equal(indexLine({...e, text: 'x = '.repeat(100)}, false).length, 'Eq. (12) · page 5 · text: ""'.length + 200);
  assert.equal(indexText([]), '');
  assert.match(indexText([e], new Set([keyOf(e)])), /^EQUATION INDEX \(.*\)\nEq\. \(12\) · page 5 · image attached$/);
});

test('turn planning: baseline, unchanged turns, updates, rebuilds', () => {
  const mk = (n, extra = {}) => ({label: String(n), page: 1 + (n > 10), box: box(0.01 * n), text: '', poor: true, image: img(100 + n), ...extra});
  const list = Array.from({length: 20}, (_, i) => mk(i + 1));
  const t0 = Date.parse('2026-11-08T10:00:00Z'), at = new Date(t0).toISOString();
  // First turn: the block holds up to CAPS.paper.images images (20 here).
  const p1 = planTurn(list, null, {question: 'Explain Eq. 3', now: t0, hash});
  assert.equal(p1.rebuilt, true); assert.equal(p1.base.filter(e => e.img).length, 20); assert.equal(p1.update.text, '');
  const state = {base: p1.base, seen: p1.seen, at};
  // Unchanged list: same base, nothing to add.
  const p2 = planTurn(list, state, {question: 'More', now: t0 + 60e3, hash});
  assert.equal(p2.rebuilt, false); assert.equal(p2.base, state.base); assert.equal(p2.update.text, ''); assert.deepEqual(p2.update.entries, []);
  // Two changes: an update with images for the added and the changed equation.
  const changed = [...list.slice(0, 19), mk(20, {box: box(0.5)}), mk(21)];
  const p3 = planTurn(changed, state, {question: 'And?', now: t0 + 60e3, hash});
  assert.equal(p3.rebuilt, false);
  assert.equal(p3.update.text, 'EQUATION UPDATES SINCE YOUR LAST ANSWER (the user changed the equation frames; these entries override the EQUATION INDEX and earlier updates)\n' +
    'Added: Eq. (21) · page 2 · image attached\nChanged: Eq. (20) · page 2 · image attached');
  assert.deepEqual(p3.update.entries.map(e => e.label), ['20', '21']);
  // The next turn compares with what the model has now seen: nothing new.
  const p4 = planTurn(changed, {...state, seen: p3.seen}, {question: 'Ok', now: t0 + 120e3, hash});
  assert.equal(p4.update.text, ''); assert.equal(p4.base, state.base);
  // A removal.
  const p5 = planTurn(list.slice(1), state, {question: 'Ok', now: t0 + 60e3, hash});
  assert.match(p5.update.text, /\nRemoved: Eq\. \(1\) · page 1 \(no longer framed; do not cite it there\)$/);
  // More than a quarter changed (and at least 5): rebuilt from the current list.
  const p6 = planTurn(list.map((e, i) => i < 6 ? {...e, text: 'x = A y + B u + w'} : e), state, {question: 'Ok', now: t0 + 60e3, hash});
  assert.equal(p6.rebuilt, true); assert.equal(p6.base[0].text, 'x = A y + B u + w');
  // Any change after the cache has expired: rebuilt; no change: kept.
  assert.equal(planTurn(changed, state, {question: 'Ok', now: t0 + REBUILD_IDLE_MS + 1, hash}).rebuilt, true);
  assert.equal(planTurn(list, state, {question: 'Ok', now: t0 + REBUILD_IDLE_MS + 1, hash}).rebuilt, false);
  // Over the image cap: the named equations get images in the block; a later question naming one that has
  // no image yet gets it with that turn.
  const big = Array.from({length: CAPS.paper.images + 5}, (_, i) => mk(i + 1));
  const b1 = planTurn(big, null, {question: 'Explain Eq. 35', now: t0, hash});
  assert.equal(b1.base.filter(e => e.img).length, CAPS.paper.images);
  assert(b1.base.find(e => e.label === '35').img); assert.equal(b1.base.find(e => e.label === '34').img, null);
  const b2 = planTurn(big, {base: b1.base, seen: b1.seen, at}, {question: 'And Eq. 34?', now: t0 + 1000, hash});
  assert.equal(b2.update.text, 'IMAGES OF EQUATIONS NAMED IN THIS QUESTION\nEq. (34) · page 2 · image attached');
  assert.equal(b2.seen.find(e => e.label === '34').img, null, 'a turn image is not kept in the history');
  const b3 = planTurn(big, {base: b1.base, seen: b2.seen, at}, {question: 'Eq. 34 again', now: t0 + 2000, hash});
  assert.deepEqual(b3.update.entries.map(e => e.label), ['34'], 'so naming it again re-attaches it');
  assert.equal(planTurn(big, {base: b1.base, seen: b2.seen, at}, {question: 'Eq. 35 again', now: t0 + 2000, hash}).update.text, '', 'block images stay seen');
  assert.equal(diffEntries(b1.base, big).count, 0);
});

test('crop geometry: the frame at CROP_WIDTH pixels, padded, inside the page', () => {
  const g = cropGeometry({x0: 0.5, y0: 0.6, x1: 0.9, y1: 0.65}, 612, 792);
  assert.equal(Math.round(g.scale * 1e6) / 1e6, Math.round(CROP_WIDTH / (0.4 * 612) * 1e6) / 1e6);
  assert.equal(g.w, CROP_WIDTH + 2 * CROP_PAD);
  const small = cropGeometry({x0: 0.5, y0: 0.6, x1: 0.55, y1: 0.62}, 612, 792);
  assert.equal(small.scale, 4, 'narrow frames are not enlarged beyond 4x');
  const edge = cropGeometry({x0: 0, y0: 0, x1: 1, y1: 0.05}, 612, 792);
  assert.equal(edge.x, 0); assert.equal(edge.y, 0); assert(edge.w <= Math.floor(612 * edge.scale));
});
