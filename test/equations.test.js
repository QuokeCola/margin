import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeLabel, cleanOverrides, migrateOverrides, legacyBox, mergeEquations, suggestions, mergeAiPage, parseAiEquations, snapToText, snapToInk, snapBox,
  iou, estimateCost, usageCost, imageTokens, AGREE_IOU} from '../lib/equations.mjs';
import {resolveReference} from '../src/references.js';

const B = (x0, y0, x1, y1) => ({x0, y0, x1, y1});

test('labels: canonical forms accepted, everything else refused', () => {
  for (const [typed, want] of [['12', '12'], ['(12)', '12'], [' 3a ', '3a'], ['2.14', '2.14'], ['A.3', 'A.3'], ['A3', 'A3'], ['Eq. 7', '7'], ['(5-a)', '5a'], ['[4]', '4'], [12, '12']])
    assert.equal(normalizeLabel(typed), want, typed);
  for (const bad of ['', 'x', '1234', '1.2.3', 'AB3', '12ab', '(', 'eq', null, undefined, {}, '3 a b'])
    assert.equal(normalizeLabel(bad), null, String(bad));
});

test('overrides: old {page, y} corrections migrate to frames; current entries are validated', () => {
  assert.deepEqual(migrateOverrides({61: {page: 12, y: 0.4}}), {61: {page: 12, box: legacyBox(0.4), source: 'user', accepted: true}});
  assert.deepEqual(legacyBox(0.4), B(0.04, 0.37, 0.96, 0.44));
  assert.deepEqual(legacyBox(0.01).y0, 0);
  const ok = {'3a': {page: 2, box: B(0.1, 0.2, 0.9, 0.25), source: 'ai', accepted: false}, 'A.3': {deleted: true}, 7: {deleted: true, pages: [4, 2, 4]}, 9: {page: 1, box: B(0.1, 0.2, 0.5, 0.3)}};
  assert.deepEqual(cleanOverrides(ok), {'3a': {page: 2, box: B(0.1, 0.2, 0.9, 0.25), source: 'ai', accepted: false}, 'A.3': {deleted: true}, 7: {deleted: true, pages: [2, 4]}, 9: {page: 1, box: B(0.1, 0.2, 0.5, 0.3), source: 'user', accepted: true}});
  // a user frame is always accepted; extra fields are dropped
  assert.deepEqual(cleanOverrides({1: {page: 1, box: B(0, 0, 0.5, 0.5), source: 'user', accepted: false, evil: '<x>'}})[1], {page: 1, box: B(0, 0, 0.5, 0.5), source: 'user', accepted: true});
  for (const bad of [[], 'x', {'(1)': {page: 1, y: 0.5}}, {1: {page: 0, y: 0.5}}, {1: {page: 1, y: 2}}, {1: {page: 1, box: B(0.5, 0.1, 0.4, 0.2)}}, {1: {page: 1, box: B(0, 0, 1, 1.2)}},
    {1: {page: 1, box: B(0.1, 0.1, 0.1005, 0.2)}}, {1: {page: 1, box: B(0, 0, 1, 1), source: 'robot'}}, {1: {page: 1, box: B(0, 0, 1, 1), accepted: 'yes'}}, {1: {deleted: true, pages: [0]}}, {1: {deleted: true, pages: 'all'}}, {1: null}])
    assert.equal(cleanOverrides(bad), null, JSON.stringify(bad));
  assert.equal(cleanOverrides(Object.fromEntries(Array.from({length: 2001}, (_, i) => [String(i % 999 + 1) + 'abcdefghijklmnopqrstuvwxyz'[Math.floor(i / 999)], {deleted: true}]))), null);
  // reading what is stored: bad entries are dropped instead
  assert.deepEqual(migrateOverrides({1: {page: 1, y: 0.5}, 'x!': {page: 1, y: 0.5}, 2: {page: 'a'}}), {1: {page: 1, box: legacyBox(0.5), source: 'user', accepted: true}});
  assert.deepEqual(migrateOverrides(undefined), {});
});

test('merge: detections minus deleted, accepted frames replace same label anywhere, suggestions change nothing', () => {
  const auto = {2: [{label: '1', box: B(0.1, 0.1, 0.9, 0.15)}, {label: '2', box: B(0.1, 0.3, 0.9, 0.35)}], 5: [{label: '2', box: B(0.1, 0.5, 0.9, 0.55)}, {label: '3', box: B(0.1, 0.7, 0.9, 0.75)}]};
  const ov = {
    1: {page: 3, box: B(0.2, 0.2, 0.8, 0.3), source: 'user', accepted: true}, // replaces the detection on page 2
    2: {deleted: true, pages: [5]},                                             // only page 5's (2) goes
    3: {page: 5, box: B(0.1, 0.8, 0.9, 0.85), source: 'ai', accepted: false},  // suggestion: detection stays
    4: {page: 4, box: B(0.1, 0.1, 0.9, 0.2), source: 'ai', accepted: true},    // accepted AI frame, no detection
  };
  const {byPage, index} = mergeEquations(auto, ov);
  assert.deepEqual(Object.fromEntries(Object.entries(byPage).map(([p, l]) => [p, l.map(e => `${e.label}:${e.source}`)])), {2: ['2:auto'], 3: ['1:user'], 4: ['4:ai'], 5: ['3:auto']});
  assert.deepEqual(index['1'].map(e => e.page), [3]);
  assert.equal(index['1'][0].y, 0.2);
  assert.deepEqual(suggestions(ov).map(s => s.label), ['3']);
  assert.equal(mergeEquations(auto, {2: {deleted: true}}).index['2'], undefined, 'deletion without pages removes every (2)');
  // citations resolve through the merged index; a stored frame passed directly also works
  assert.equal(resolveReference({equation: '1', page: 2}, index, {}, 9).page, 3);
  assert.deepEqual(resolveReference({equation: '1', page: null}, {}, ov, 9), {page: 3, y: 0.2, box: ov[1].box, manual: true});
  assert.equal(resolveReference({equation: '3', page: 5}, {}, ov, 9).fallback, true, 'a pending suggestion is not a location');
});

test('AI merge: agreement keeps the detection, differences and new labels become suggestions, user decisions win', () => {
  const autoP = [{label: '4', box: B(0.1, 0.20, 0.9, 0.25)}, {label: '5', box: B(0.1, 0.40, 0.9, 0.45)}];
  const ov = {6: {page: 3, box: B(0.1, 0.6, 0.9, 0.65), source: 'user', accepted: true}, 7: {deleted: true, pages: [3]}, 4: {page: 3, box: B(0, 0, 0.1, 0.1), source: 'ai', accepted: false}};
  const ai = [{label: '4', box: B(0.12, 0.2, 0.88, 0.25)}, {label: '5', box: B(0.1, 0.5, 0.9, 0.55)}, {label: '6', box: B(0.1, 0.7, 0.9, 0.75)},
    {label: '7', box: B(0.1, 0.8, 0.9, 0.85)}, {label: '8', box: B(0.1, 0.9, 0.9, 0.95)}, {label: '8', box: B(0, 0, 1, 1)}];
  const {overrides, stats} = mergeAiPage(3, ai, autoP, ov);
  assert.ok(iou(ai[0].box, autoP[0].box) >= AGREE_IOU);
  assert.equal(overrides[4], undefined, 'agreeing run clears an older suggestion');
  assert.deepEqual(overrides[5], {page: 3, box: ai[1].box, source: 'ai', accepted: false});
  assert.deepEqual(overrides[6], ov[6]); assert.deepEqual(overrides[7], ov[7]);
  assert.deepEqual(overrides[8].box, ai[4].box, 'first of a duplicated label wins');
  assert.deepEqual(stats.labels.map(l => l.result), ['agree', 'differs', 'kept', 'kept', 'new']);
  assert.deepEqual([stats.found, stats.agree, stats.suggested, stats.kept], [5, 1, 2, 2]);
  assert.deepEqual(ov[4].box, B(0, 0, 0.1, 0.1), 'input not modified');
});

test('AI answers: fences, prose, arrays, pixel and 0..1000 coordinates, swapped corners, junk dropped', () => {
  const want = [{label: '3', box: B(0.1, 0.2, 0.5, 0.3)}];
  assert.deepEqual(parseAiEquations('{"equations":[{"label":"(3)","box":{"x0":0.1,"y0":0.2,"x1":0.5,"y1":0.3}}]}'), want);
  assert.deepEqual(parseAiEquations('Here you go:\n```json\n{"equations": [{"label": "3", "box": [0.5, 0.3, 0.1, 0.2]}]}\n```\nDone.'), want);
  assert.deepEqual(parseAiEquations('[{"label":"3","bbox":[100,200,500,300]}]'), want, '0..1000 grid');
  assert.deepEqual(parseAiEquations('{"equations":[{"label":"3","box":[160,640,800,960]}]}', {width: 1600, height: 3200}), want, 'pixels of the image');
  assert.deepEqual(parseAiEquations('{"equations":[{"label":"3","box":{"x":0.1,"y":0.2,"width":0.4,"height":0.1}}]}').map(e => e.box).map(b => Object.values(b).map(v => +v.toFixed(5))), [[0.1, 0.2, 0.5, 0.3]]);
  assert.deepEqual(parseAiEquations('{"equations":[{"label":"x","box":[0,0,1,1]},{"label":"4","box":[0,0,"a",1]},{"label":"5"},{"label":"6","box":[0.2,0.2,0.2,0.3]},{"label":"7","box":[-0.1,0.1,0.5,1.0004]}]}'),
    [{label: '7', box: B(0, 0.1, 0.5, 1)}]);
  assert.deepEqual(parseAiEquations('{"equations": []}'), []);
  assert.equal(parseAiEquations('I could not find any.'), null);
  assert.equal(parseAiEquations('{"other": 1}'), null);
  assert.equal(parseAiEquations('{"equations": [{"label": "1", "box": [0,0,0.5'), null, 'truncated JSON');
});

// Synthetic page 600 x 800: prose, a two-line equation numbered (7) and a stacked neighbour (8).
const W = 600, H = 800;
const item = (s, x0, y0, x1, y1 = y0 + 10) => ({s, x0, y0, x1, y1});
const prose = y => item('the drive model is stiff and the result follows from the measured data here', 50, y, 550);
const page = [prose(100), prose(114), item('x', 200, 160, 210), item('=', 215, 160, 225), item('A y + B u', 230, 160, 330), item('(7)', 530, 166, 550),
  item('+ C w', 230, 173, 290), item('z = D x', 200, 190, 280), item('(8)', 530, 190, 550), prose(220), prose(234)];
const tight7 = B(200 / W, 160 / H, 550 / W, 183 / H);

test('snapping to text: rough frames tighten to the equation, not the prose or the stacked neighbour', () => {
  const near = (a, b) => iou(a, b) > 0.97;
  for (const rough of [B(0.30, 0.19, 0.95, 0.235), B(0.35, 0.205, 0.9, 0.226), B(0.31, 0.196, 0.93, 0.24)]) {
    const r = snapToText(rough, page, W, H, '7');
    assert.ok(r && near(r.box, tight7), `${JSON.stringify(rough)} -> ${JSON.stringify(r?.box)}`);
  }
  // without the label, the stacked (8) line inside a too-tall frame is kept
  assert.ok(snapToText(B(0.3, 0.19, 0.95, 0.25), page, W, H).box.y1 >= 200 / H);
  assert.ok(snapToText(B(0.3, 0.19, 0.95, 0.25), page, W, H, '7').box.y1 < 185 / H);
  // a frame over prose only, or over nothing, gives no text snap
  assert.equal(snapToText(B(0.05, 0.12, 0.95, 0.16), page, W, H, '7'), null);
  assert.equal(snapToText(B(0.1, 0.5, 0.9, 0.6), page, W, H, '7'), null);
  assert.equal(snapToText(B(0, 0, 1, 1), [], W, H), null);
});

test('snapping to ink (scanned pages): blank margins trimmed, cut glyphs recovered, masked prose ignored', () => {
  const iw = 200, ih = 300, gray = new Uint8Array(iw * ih).fill(255);
  const ink = (x0, y0, x1, y1) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) gray[y * iw + x] = 0; };
  ink(40, 100, 160, 104); ink(40, 108, 150, 112); // a two-line equation, rows 100..111
  ink(20, 80, 180, 84);                           // a prose line above, gap of 16 px
  const px = b => [b.x0 * iw, b.y0 * ih, b.x1 * iw, b.y1 * ih].map(Math.round);
  assert.deepEqual(px(snapToInk(gray, iw, ih, B(0.1, 0.31, 0.95, 0.4))), [39, 99, 161, 113], 'trim to ink');
  // a frame cutting through the first line grows over it (up to `grow` of the page) and stops at the blank
  // band before the second line (4 px here; bands under 0.25% of the page height are bridged)
  assert.deepEqual(px(snapToInk(gray, iw, ih, B(0.3, 0.345, 0.7, 0.36), {grow: 0.2})), [39, 99, 161, 105], 'grow over cut ink until blank');
  assert.deepEqual(px(snapToInk(gray, iw, ih, B(0.3, 0.345, 0.7, 0.36))), [47, 99, 153, 105], 'growth limited to 3% of the page');
  assert.equal(snapToInk(gray, iw, ih, B(0.1, 0.5, 0.9, 0.6)), null, 'no ink');
  const withProse = snapToInk(gray, iw, ih, B(0.05, 0.25, 0.95, 0.4), {mask: [B(0.1, 0.266, 0.9, 0.281)]});
  assert.deepEqual(px(withProse), [39, 99, 161, 113], 'prose masked out');
  assert.deepEqual(px(snapToInk(gray, iw, ih, B(0.05, 0.25, 0.95, 0.4))), [19, 79, 181, 113], 'without the mask the prose is inside the frame');
  // snapBox: text first, then ink with prose items masked, then the frame as returned
  assert.equal(snapBox(B(0.30, 0.19, 0.95, 0.235), page, W, H, null, '7').method, 'text');
  const scan = snapBox(B(0.05, 0.25, 0.95, 0.4), [item('the drive model is stiff and the result follows here', 0.1 * 600, 0.266 * 800, 0.9 * 600, 0.281 * 800)], 600, 800, {gray, width: iw, height: ih}, '3');
  assert.equal(scan.method, 'ink'); assert.deepEqual(px(scan.box), [39, 99, 161, 113]);
  assert.deepEqual(snapBox(B(0.1, 0.5, 0.9, 0.6), [], W, H, {gray, width: iw, height: ih}), {box: B(0.1, 0.5, 0.9, 0.6), method: 'none'});
});

test('cost estimate and actual cost', () => {
  assert.equal(imageTokens('anthropic', 1237, 1600), 2639);
  assert.equal(imageTokens('anthropic', 3000, 3000), 4784);
  assert.equal(imageTokens('openai', 1237, 1600), 765);
  const e = estimateCost('anthropic', 'claude-opus-5-5', 10, 1237, 1600);
  assert.deepEqual([e.input, e.output], [32390, 4000]);
  assert.ok(Math.abs(e.usd - (32390 * 4 + 4000 * 20) / 1e6) < 1e-9);
  assert.equal(estimateCost('openai', 'gpt-6-astra', 2).usd, null, 'no price known: tokens only');
  assert.ok(Math.abs(usageCost('claude-sonnet-5-5', {input: 1e6, output: 1e5, cacheRead: 1e6, cacheWrite: 0}) - (2 + 1 + 0.2)) < 1e-9);
  assert.equal(usageCost('unknown-model', {input: 1}), null);
});
