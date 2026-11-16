// The pure helpers of src/annotations.js: line rects of a selection, PDF quads → page fractions,
// text under a highlight, the import payload, panel order.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mergeLineRects, normRects, quadRects, rectCorner, joinPieces, textUnder, sortAnnotations, hitTest, contextText, hexColor, pdfDate, exportName, isImportable, importItems, unionBox, noteBox, DEFAULT_COLOR, LIMITS} from '../src/annotations.js';

const R = (x0, y0, x1, y1) => ({x0, y0, x1, y1});
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);
const nearRect = (r, e, eps = 1e-9) => { for (const k of ['x0', 'y0', 'x1', 'y1']) near(r[k], e[k], eps); };

test('mergeLineRects: overlapping and repeated span rects become one rect per line', () => {
  const out = mergeLineRects([R(100, 50, 180, 62), R(100, 50, 180, 62), R(170, 51, 260, 63), R(262, 50, 300, 62), // line 1: duplicate, overlap, word gap
    R(40, 66, 300, 78), R(120, 68, 140, 74),                                                                       // line 2 with a subscript inside it
    R(40, 82, 90, 94), R(0, 0, 0.4, 12), R(10, 10, 300, 10.2)]);                                                   // line 3, and two slivers
  assert.deepEqual(out, [R(100, 50, 300, 63), R(40, 66, 300, 78), R(40, 82, 90, 94)]);
});
test('mergeLineRects: lines are ordered top to bottom whatever the input order; neighbouring lines stay apart', () => {
  const out = mergeLineRects([R(40, 82, 90, 94), R(200, 50, 300, 62), R(40, 66, 300, 78), R(100, 50, 190, 62)]);
  assert.deepEqual(out, [R(100, 50, 300, 62), R(40, 66, 300, 78), R(40, 82, 90, 94)]);
  // 3 px of overlap between 12 px lines (tight leading) is not the same line
  assert.equal(mergeLineRects([R(0, 0, 50, 12), R(0, 9, 50, 21)]).length, 2);
});
test('mergeLineRects: pieces of one line far apart (two columns) stay separate rects', () => {
  const out = mergeLineRects([R(40, 100, 280, 112), R(320, 101, 560, 113), R(40, 116, 100, 128)]);
  assert.deepEqual(out, [R(40, 100, 280, 112), R(320, 101, 560, 113), R(40, 116, 100, 128)]);
  // a gap of exactly LINE_GAP line heights still joins (justified text, tab stops)
  assert.deepEqual(mergeLineRects([R(0, 0, 50, 10), R(65, 0, 100, 10)]), [R(0, 0, 100, 10)]);
});
test('normRects: fractions of the page box, clamped; rects outside the page are dropped', () => {
  const page = {left: 100, top: 200, width: 400, height: 800};
  assert.deepEqual(normRects([R(200, 400, 300, 440), R(50, 180, 140, 240), R(600, 300, 700, 320)], page), [R(0.25, 0.25, 0.5, 0.3), R(0, 0, 0.1, 0.05)]);
});

// pdf.js viewport transforms at scale 1 for a 600×800 pt page (PageViewport, origin-0 view box).
const UPRIGHT = [1, 0, 0, -1, 0, 800], ROT90 = [0, 1, 1, 0, 0, 0], ROT180 = [-1, 0, 0, 1, 600, 0], ROT270 = [0, -1, -1, 0, 800, 600];
// A quad as PDF writers store it: upper-left, upper-right, lower-left, lower-right of a line (PDF space, y up).
const quad = (x0, y0, x1, y1) => [x0, y1, x1, y1, x0, y0, x1, y0];
test('quadRects: PDF quads become normalised rects from the top-left of the page', () => {
  const out = quadRects(quad(60, 700, 300, 712), UPRIGHT, 600, 800);
  assert.equal(out.length, 1); nearRect(out[0], R(0.1, 0.11, 0.5, 0.125));
});
test('quadRects: per-word quads of a line merge; lines come out top to bottom; typed arrays work', () => {
  const out = quadRects(new Float32Array([...quad(60, 680, 200, 692), ...quad(60, 700, 150, 712), ...quad(153, 700, 300, 712)]), UPRIGHT, 600, 800);
  assert.equal(out.length, 2);
  nearRect(out[0], R(0.1, 0.11, 0.5, 0.125), 1e-6); nearRect(out[1], R(0.1, 0.135, 1 / 3, 0.15), 1e-6);
  assert.deepEqual(quadRects(null, UPRIGHT, 600, 800), []); assert.deepEqual(quadRects([1, 2, 3], UPRIGHT, 600, 800), []);
});
test('quadRects: rotated pages (/Rotate 90, 180, 270) use the rotated viewport', () => {
  // the same line of text, 60..300 across and 700..712 up in PDF space
  const q = quad(60, 700, 300, 712);
  nearRect(quadRects(q, ROT90, 800, 600)[0], R(700 / 800, 60 / 600, 712 / 800, 300 / 600));     // shown as a vertical strip near the right edge
  nearRect(quadRects(q, ROT180, 600, 800)[0], R(0.5, 0.875, 0.9, 0.89));                         // upside down: bottom right
  nearRect(quadRects(q, ROT270, 800, 600)[0], R(88 / 800, 0.5, 100 / 800, 0.9));
});
test('quadRects agrees with the viewports of real pdf.js pages, rotated or not', async () => {
  const {default: pdfLib} = await import('pdf-lib'), pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const src = await pdfLib.PDFDocument.create();
  for (const rotation of [0, 90, 180, 270]) src.addPage([600, 800]).setRotation(pdfLib.degrees(rotation));
  const doc = await pdfjs.getDocument({data: await src.save(), verbosity: 0}).promise;
  for (let n = 1; n <= 4; n++) {
    const vp = (await doc.getPage(n)).getViewport({scale: 1});
    assert.deepEqual([vp.width, vp.height], n % 2 ? [600, 800] : [800, 600]);
    const [r] = quadRects(quad(60, 700, 300, 712), vp.transform, vp.width, vp.height);
    const a = vp.convertToViewportPoint(60, 712), b = vp.convertToViewportPoint(300, 700);
    nearRect(r, R(Math.min(a[0], b[0]) / vp.width, Math.min(a[1], b[1]) / vp.height, Math.max(a[0], b[0]) / vp.width, Math.max(a[1], b[1]) / vp.height));
    assert.deepEqual([...vp.transform], [UPRIGHT, ROT90, ROT180, ROT270][n - 1]);
  }
  await doc.loadingTask.destroy();
});
test('rectCorner: the top-left corner of a note as displayed', () => {
  const c = rectCorner([540, 700, 560, 720], UPRIGHT, 600, 800); near(c.x, 0.9); near(c.y, 0.1);
  const d = rectCorner([540, 700, 560, 720], ROT90, 800, 600); near(d.x, 700 / 800); near(d.y, 540 / 600);
});

const B = (s, x0, y0, x1, y1) => ({s, x0, y0, x1, y1});
test('joinPieces: touching pieces of a line join without a space, the rest with one', () => {
  assert.equal(joinPieces([B('con', 0, 0, 30, 10), B('troller', 30.5, 0, 90, 10), B('gain', 95, 0, 130, 10), B('matrix', 0, 14, 60, 24)]), 'controller gain matrix');
  assert.equal(joinPieces([]), '');
});
test('textUnder: words of the text items under each line rect, partial items by width', () => {
  const boxes = [B('The robust controller', 60, 88, 270, 100), B('tracks', 275, 88, 335, 100), B('the reference', 60, 104, 190, 116), B('Page 3', 60, 700, 120, 712)];
  // line 1 from "robust" on (item 1 starts 4 of 21 characters in), all of line 2
  assert.equal(textUnder(boxes, [R(100 / 600, 86 / 800, 340 / 600, 101 / 800), R(60 / 600, 102 / 800, 190 / 600, 117 / 800)], 600, 800), 'robust controller tracks the reference');
  assert.equal(textUnder(boxes, [R(0.1, 0.4, 0.5, 0.42)], 600, 800), '');
});

const ann = (id, page, y0, x0 = 0.1, over = {}) => ({id, kind: 'highlight', page, rects: [R(x0, y0, x0 + 0.2, y0 + 0.02)], color: '#ffd400', text: 't', comment: '', replies: [], createdAt: '2026-01-01T00:00:00.000Z', ...over});
test('sortAnnotations: page, then top to bottom, then left to right, then age; the input is not changed', () => {
  const items = [ann('c', 2, 0.1), ann('b', 1, 0.5), ann('a', 1, 0.2, 0.6), ann('d', 1, 0.2, 0.1), ann('f', 3, 0.3, 0.1, {createdAt: '2026-02-01T00:00:00.000Z'}), ann('e', 3, 0.3)];
  assert.deepEqual(sortAnnotations(items).map(a => a.id), ['d', 'a', 'b', 'c', 'e', 'f']);
  assert.equal(items[0].id, 'c');
});
test('hitTest: the highlight under a point; the smaller of two overlapping ones; notes are not hit', () => {
  const big = ann('big', 1, 0.2, 0.1, {rects: [R(0.1, 0.2, 0.9, 0.22), R(0.1, 0.22, 0.9, 0.24)]}), small = ann('small', 1, 0.2, 0.3), note = {...ann('n', 1, 0.5), kind: 'note', rects: [R(0.5, 0.5, 0.5, 0.5)]};
  assert.equal(hitTest([big, small, note], 1, 0.35, 0.21).a.id, 'small');
  assert.deepEqual(hitTest([big, small], 1, 0.7, 0.23).rect, R(0.1, 0.22, 0.9, 0.24));
  assert.equal(hitTest([big, small, note], 1, 0.5, 0.5), null);
  assert.equal(hitTest([big], 2, 0.5, 0.21), null);
});
test('contextText: the passage with the reader\'s comment; a note gives its text; an empty note nothing', () => {
  assert.equal(contextText(ann('a', 1, 0.1, 0.1, {text: 'the gain\n matrix', comment: ' why  positive?'})), 'the gain matrix — my comment on this passage: “why positive?”');
  assert.equal(contextText(ann('a', 1, 0.1, 0.1, {text: 'the gain'})), 'the gain');
  assert.equal(contextText({kind: 'note', text: '', comment: 'check this'}), 'My note at this spot of the page: “check this”');
  assert.equal(contextText({kind: 'note', text: '', comment: ''}), '');
});
test('hexColor, pdfDate, exportName, boxes', () => {
  assert.equal(hexColor(new Uint8ClampedArray([255, 212, 0])), '#ffd400');
  assert.equal(hexColor(null), DEFAULT_COLOR); assert.equal(hexColor([1, 2]), DEFAULT_COLOR);
  assert.equal(pdfDate("D:20240131120000+01'00'"), '2024-01-31T11:00:00.000Z');
  assert.equal(pdfDate('D:20240131120000Z'), '2024-01-31T12:00:00.000Z');
  assert.equal(pdfDate("D:20240131233000-05'30'"), '2024-02-01T05:00:00.000Z');
  assert.equal(pdfDate('D:2024'), '2024-01-01T00:00:00.000Z');
  assert.equal(pdfDate('yesterday'), null); assert.equal(pdfDate(undefined), null);
  assert.equal(exportName('Attention: is all/you need?.pdf'), 'Attention is all you need (annotated).pdf');
  assert.equal(exportName(''), 'paper (annotated).pdf');
  assert.deepEqual(unionBox([R(0.2, 0.3, 0.5, 0.32), R(0.1, 0.32, 0.4, 0.34)]), R(0.1, 0.3, 0.5, 0.34));
  nearRect(noteBox(R(0.9, 0.02, 0.9, 0.02)), R(0.6, 0, 1, 0.1));
});

test('isImportable: highlights and notes that are objects of the file; not status marks, other kinds or inline annotations', () => {
  assert.ok(isImportable({subtype: 'Highlight', id: '12R'})); assert.ok(isImportable({subtype: 'Text', id: '7R2'}));
  assert.ok(!isImportable({subtype: 'Highlight', id: 'annot_p0_1'}));
  assert.ok(!isImportable({subtype: 'Text', id: '9R', state: 'Accepted', stateModel: 'Review'}));
  for (const subtype of ['Link', 'Underline', 'FreeText', 'Popup', 'Widget']) assert.ok(!isImportable({subtype, id: '3R'}));
});
test('importItems: highlights with text and comment, notes, replies in thread order', () => {
  const boxes = [B('The robust controller', 60, 88, 270, 100)];
  const annots = [
    {subtype: 'Link', id: '1R', rect: [0, 0, 10, 10]},
    {subtype: 'Highlight', id: '10R', quadPoints: new Float32Array(quad(60, 700, 270, 712)), rect: [60, 700, 270, 712], color: new Uint8ClampedArray([0, 255, 0]), contentsObj: {str: ' why? '}, creationDate: 'D:20240131120000Z'},
    {subtype: 'Text', id: '11R', rect: [540, 700, 560, 720], color: null, contentsObj: {str: 'check'}, modificationDate: 'D:20240201000000Z'},
    {subtype: 'Text', id: '13R', rect: [60, 700, 80, 720], inReplyTo: '12R', contentsObj: {str: 'second'}, creationDate: 'D:20240203000000Z'},
    {subtype: 'Text', id: '12R', rect: [60, 700, 80, 720], inReplyTo: '10R', contentsObj: {str: 'first'}, creationDate: 'D:20240202000000Z'},
    {subtype: 'Text', id: '14R', rect: [60, 700, 80, 720], inReplyTo: '10R', state: 'Accepted', stateModel: 'Review', contentsObj: {str: 'Accepted'}},
    {subtype: 'Text', id: '15R', rect: [100, 100, 120, 120], inReplyTo: '99R', contentsObj: {str: 'orphan'}},
    {subtype: 'Highlight', id: 'annot_p0_3', quadPoints: quad(60, 600, 270, 612)},
    {subtype: 'Highlight', id: '16R', quadPoints: null, rect: [60, 500, 270, 512]},
  ];
  const out = importItems([{page: 2, annots, transform: UPRIGHT, W: 600, H: 800, boxes}]);
  assert.deepEqual(out.map(a => a.pdfId), ['10R', '11R', '16R', '15R']);
  const [hl, note, bare, orphan] = out;
  assert.equal(hl.kind, 'highlight'); assert.equal(hl.page, 2); assert.equal(hl.color, '#00ff00'); assert.equal(hl.comment, 'why?');
  assert.equal(hl.text, 'The robust controller'); assert.equal(hl.createdAt, '2024-01-31T12:00:00.000Z');
  nearRect(hl.rects[0], R(0.1, 0.11, 0.45, 0.125), 1e-6);
  assert.deepEqual(hl.replies, [{text: 'first', at: '2024-02-02T00:00:00.000Z'}, {text: 'second', at: '2024-02-03T00:00:00.000Z'}]);
  assert.equal(note.kind, 'note'); assert.equal(note.color, DEFAULT_COLOR); assert.equal(note.comment, 'check'); assert.equal(note.text, '');
  nearRect(note.rects[0], R(0.9, 0.1, 0.9, 0.1)); assert.equal(note.createdAt, '2024-02-01T00:00:00.000Z');
  nearRect(bare.rects[0], R(0.1, 0.36, 0.45, 0.375), 1e-6); // a highlight without quads uses its rect
  assert.equal(orphan.kind, 'note'); assert.equal(orphan.comment, 'orphan'); // a reply to something that is not imported
  assert.deepEqual(importItems([]), []); assert.deepEqual(importItems([{page: 1, annots: [], transform: UPRIGHT, W: 600, H: 800}]), []);
});
test('importItems: a highlight is cut at the rect limit', () => {
  const quads = []; for (let i = 0; i < LIMITS.rects + 20; i++) quads.push(...quad(60, 10 + i * 3, 300, 12 + i * 3));
  const [a] = importItems([{page: 1, annots: [{subtype: 'Highlight', id: '5R', quadPoints: quads}], transform: [1, 0, 0, -1, 0, 800], W: 600, H: 800, boxes: []}]);
  assert.equal(a.rects.length, LIMITS.rects);
});

test('aiAuthor: replies exported as "AI (model)" are AI replies again on import', async () => {
  const {aiAuthor} = await import('../src/annotations.js');
  assert.deepEqual(aiAuthor('AI (gpt-6.1-terra)'), {author: 'ai', model: 'gpt-6.1-terra'});
  assert.deepEqual(aiAuthor('AI'), {author: 'ai'});
  assert.deepEqual(aiAuthor('Aiden'), {});
  assert.deepEqual(aiAuthor('AI (not a model!)'), {});
  assert.deepEqual(aiAuthor(undefined), {});
});
