// Annotations: validation (lib/annotations.mjs), the per-paper store (lib/store.mjs) and the export of an
// annotated PDF (lib/pdf-annotate.mjs), read back with pdf-lib (raw objects) and pdf.js (what a viewer sees).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pdfLib from 'pdf-lib';
import {createStore} from '../lib/store.mjs';
import {cleanAnnotation, cleanPatch, cleanImported, cleanRects, aiReplyPrompt, LIMITS, DEFAULT_COLOR, AI_CONTEXT} from '../lib/annotations.mjs';
import {annotatePdf, pageGeometry, AUTHOR, HIGHLIGHT_OPACITY, NOTE_SIZE} from '../lib/pdf-annotate.mjs';

const {PDFDocument, PDFName, PDFString, PDFHexString, PDFArray, PDFRef, degrees} = pdfLib;
const N = s => PDFName.of(s);
const R = {x0: 0.1, y0: 0.2, x1: 0.5, y1: 0.25};
const hl = (over = {}) => ({kind: 'highlight', page: 1, rects: [R], color: '#FFD400', text: 'some words', comment: 'why?', ...over});

async function library() {
  const dir = await mkdtemp(join(tmpdir(), 'margin-ann-'));
  const store = createStore(dir); await store.init();
  const [project] = await store.listProjects();
  const paper = await store.addPaper(Buffer.from('%PDF-1.4\n% annotations\n'), 'a.pdf');
  await store.addToProject(project.id, paper.id);
  return {dir, store, project, paper};
}

test('validation: fields are checked, clamped and cut', () => {
  const a = cleanAnnotation(hl({rects: [{x0: 0.5, y0: 1.4, x1: -0.2, y1: 0.25}, {x0: 0.3, y0: 0.3, x1: 0.3, y1: 0.4}], text: ' ' + 'x'.repeat(4000), comment: 'a\r\nb\u0000' + 'c'.repeat(6000)}));
  assert.deepEqual(a.rects, [{x0: 0, y0: 0.25, x1: 0.5, y1: 1}], 'corners ordered and clamped to the page; the empty rect is dropped');
  assert.equal(a.color, '#ffd400');
  assert.equal(a.text.length, LIMITS.text); assert.equal(a.comment.length, LIMITS.comment); assert.ok(a.comment.startsWith('a\nbccc'));
  assert.deepEqual(Object.keys(a), ['kind', 'page', 'rects', 'color', 'text', 'comment']);
  assert.equal(cleanAnnotation(hl({color: undefined})).color, DEFAULT_COLOR);
  assert.equal(cleanAnnotation(hl({comment: 7, text: null})).comment, '');

  const note = cleanAnnotation({kind: 'note', page: 3, rects: [{x0: 0.4, y0: 0.6, x1: 0.9, y1: 0.9}, R], text: 'ignored', comment: 'n'});
  assert.deepEqual(note.rects, [{x0: 0.4, y0: 0.6, x1: 0.4, y1: 0.6}], 'a note is one point');
  assert.equal(note.text, '');

  const many = Array.from({length: LIMITS.rects + 1}, () => R);
  for (const b of [hl({kind: 'ink'}), hl({page: 0}), hl({page: 1.5}), hl({page: LIMITS.page + 1}), hl({rects: []}), hl({rects: 'x'}), hl({rects: [{x0: 0, y0: 0, x1: NaN, y1: 1}]}),
    hl({rects: [{x0: 0.2, y0: 0.2, x1: 0.2, y1: 0.2}]}), hl({rects: many}), hl({color: 'red'}), hl({color: '#12345'}), null, []])
    assert.throws(() => cleanAnnotation(b), e => e.status === 400, JSON.stringify(b)?.slice(0, 60));
  assert.equal(cleanRects('highlight', many, {truncate: true}).length, LIMITS.rects);

  assert.deepEqual(cleanPatch({color: '#00FF00', comment: ' hi ', other: 1}, 'highlight'), {color: '#00ff00', comment: 'hi'});
  assert.deepEqual(cleanPatch({rects: [{x0: 2, y0: 0.5, x1: 2, y1: 0.5}]}, 'note'), {rects: [{x0: 1, y0: 0.5, x1: 1, y1: 0.5}]});
  for (const b of [{}, {color: 'blue'}, {comment: 5}, {rects: []}, {text: 'cannot change'}]) assert.throws(() => cleanPatch(b, 'highlight'), e => e.status === 400);

  const at = '2026-01-02T03:04:05.000Z';
  const imp = cleanImported({...hl({color: 'nope', rects: many}), pdfId: '12R', createdAt: '2025-05-06T07:08:09+02:00',
    replies: [{text: 'r1'}, {text: ' ', author: 'ai'}, {text: 'r2', author: 'ai', at: '2025-06-01T00:00:00Z'}, null]}, at);
  assert.equal(imp.color, DEFAULT_COLOR); assert.equal(imp.rects.length, LIMITS.rects); assert.equal(imp.createdAt, '2025-05-06T05:08:09.000Z');
  assert.deepEqual(imp.replies, [{author: 'user', text: 'r1', at: '2025-05-06T05:08:09.000Z'}, {author: 'ai', text: 'r2', at: '2025-06-01T00:00:00.000Z'}]);
  assert.equal(cleanImported({...hl(), pdfId: '7R2', createdAt: 'yesterday'}, at).createdAt, at);
  for (const pdfId of [undefined, 'annot_p0_1', '0R', 'R', '12', 12]) assert.equal(cleanImported({...hl(), pdfId}, at), null);
  assert.equal(cleanImported({...hl({page: 0}), pdfId: '3R'}, at), null);
});

test('store: create, change, reply, delete; removed with the paper', async () => {
  const {dir, store, project, paper} = await library();
  assert.deepEqual(await store.loadAnnotations(paper.id), {v: 1, imported: false, importedPdfIds: [], items: []});
  const a = await store.addAnnotation(paper.id, hl());
  assert.match(a.id, /^[0-9a-f]{16}$/);
  assert.deepEqual({...a, id: 0, createdAt: 0, updatedAt: 0}, {id: 0, kind: 'highlight', page: 1, rects: [R], color: '#ffd400', text: 'some words', comment: 'why?', replies: [], origin: 'margin', createdAt: 0, updatedAt: 0});
  assert.ok(!Number.isNaN(Date.parse(a.createdAt)));
  const note = await store.addAnnotation(paper.id, {kind: 'note', page: 2, rects: [{x0: 0.3, y0: 0.4, x1: 0.3, y1: 0.4}], comment: 'note'});
  assert.equal(note.color, DEFAULT_COLOR);

  const p = await store.patchAnnotation(paper.id, a.id, {comment: 'changed', color: '#00ff00', rects: [R, {x0: 0.1, y0: 0.26, x1: 0.4, y1: 0.3}]});
  assert.deepEqual([p.comment, p.color, p.rects.length, p.text], ['changed', '#00ff00', 2, 'some words']);
  await assert.rejects(store.patchAnnotation(paper.id, 'f'.repeat(16), {comment: 'x'}), e => e.status === 404);
  await assert.rejects(store.patchAnnotation(paper.id, a.id, {color: 'x'}), e => e.status === 400);
  await assert.rejects(store.addAnnotation('0'.repeat(64), hl()), e => e.status === 404);
  await assert.rejects(store.addAnnotation(paper.id, hl({page: 0})), e => e.status === 400);

  const r1 = await store.addReply(paper.id, a.id, {text: ' first '});
  const r2 = await store.addReply(paper.id, a.id, {text: 'answer', author: 'ai', model: 'gpt-6-astra'});
  assert.deepEqual(r2.replies.map(r => [r.author, r.text, r.model]), [['user', 'first', undefined], ['ai', 'answer', 'gpt-6-astra']]);
  assert.match(r1.replies[0].id, /^[0-9a-f]{8}$/); assert.ok(!('model' in r2.replies[0]));
  await assert.rejects(store.addReply(paper.id, a.id, {text: '  '}), e => e.status === 400);
  await assert.rejects(store.addReply(paper.id, 'e'.repeat(16), {text: 'x'}), e => e.status === 404);
  assert.equal((await store.addReply(paper.id, a.id, {text: 'x'.repeat(LIMITS.reply + 10)})).replies.at(-1).text.length, LIMITS.reply);
  const d = await store.deleteReply(paper.id, a.id, r1.replies[0].id);
  assert.deepEqual(d.replies.map(r => r.author), ['ai', 'user']);
  assert.equal((await store.deleteReply(paper.id, a.id, 'abcdef01')).replies.length, 2, 'unknown reply: unchanged');
  for (let i = d.replies.length; i < LIMITS.replies; i++) await store.addReply(paper.id, a.id, {text: 'r' + i});
  await assert.rejects(store.addReply(paper.id, a.id, {text: 'one too many'}), e => e.status === 400 && /at most 50/.test(e.message));

  const onDisk = JSON.parse(await readFile(join(dir, 'papers', paper.id, 'annotations.json'), 'utf8'));
  assert.deepEqual([onDisk.v, onDisk.imported, onDisk.items.length, onDisk.items[0].replies.length], [1, false, 2, LIMITS.replies]);
  await store.deleteAnnotation(paper.id, note.id); await store.deleteAnnotation(paper.id, note.id);
  assert.deepEqual((await store.loadAnnotations(paper.id)).items.map(x => x.id), [a.id]);

  // A file this version does not understand is never overwritten.
  await writeFile(join(dir, 'papers', paper.id, 'annotations.json'), JSON.stringify({v: 2, things: []}));
  await assert.rejects(store.addAnnotation(paper.id, hl()));
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'papers', paper.id, 'annotations.json'), 'utf8')), {v: 2, things: []});

  await store.removeFromProject(project.id, paper.id);
  assert.equal(await stat(join(dir, 'papers', paper.id)).catch(() => null), null, 'annotations go with the paper');
  await rm(dir, {recursive: true, force: true});
});

test('store: importing the PDF\'s own annotations happens once per annotation', async () => {
  const {dir, store, paper} = await library();
  assert.deepEqual(await store.importAnnotations(paper.id, []), {items: [], imported: true, added: 0, skipped: 0});
  assert.deepEqual(await store.loadAnnotations(paper.id), {v: 1, imported: true, importedPdfIds: [], items: []}, 'an empty import still counts');
  const list = [{...hl({comment: 'from the pdf'}), pdfId: '12R', createdAt: '2025-01-01T00:00:00Z', replies: [{text: 'a reply'}, {text: 'ai said', author: 'ai'}]},
    {kind: 'note', page: 2, rects: [{x0: 0.5, y0: 0.5, x1: 0.6, y1: 0.6}], comment: 'n', pdfId: '13R2'},
    {...hl(), pdfId: '12R'}, {...hl(), pdfId: 'annot_p0_1'}, {...hl({rects: []}), pdfId: '14R'}];
  const first = await store.importAnnotations(paper.id, list);
  assert.deepEqual([first.imported, first.added, first.skipped, first.items.length], [true, 2, 2, 2]);
  const [h, n] = first.items;
  assert.deepEqual([h.origin, h.pdfId, h.comment, h.createdAt, h.updatedAt], ['pdf', '12R', 'from the pdf', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z']);
  assert.deepEqual(h.replies.map(r => [r.author, r.text, r.at, /^[0-9a-f]{8}$/.test(r.id)]), [['user', 'a reply', h.createdAt, true], ['ai', 'ai said', h.createdAt, true]]);
  assert.deepEqual([n.origin, n.pdfId, n.rects], ['pdf', '13R2', [{x0: 0.5, y0: 0.5, x1: 0.5, y1: 0.5}]]);
  // Deleted and edited copies are not imported again.
  await store.deleteAnnotation(paper.id, n.id); await store.patchAnnotation(paper.id, h.id, {comment: 'edited'});
  const again = await store.importAnnotations(paper.id, [...list, {...hl(), pdfId: '20R'}]);
  assert.deepEqual([again.added, again.items.length, again.items[0].comment], [1, 2, 'edited']);
  assert.deepEqual((await store.loadAnnotations(paper.id)).importedPdfIds, ['12R', '13R2', '20R']);
  await assert.rejects(store.importAnnotations(paper.id, 'x'), e => e.status === 400);
  await assert.rejects(store.importAnnotations(paper.id, undefined), e => e.status === 400);
  await rm(dir, {recursive: true, force: true});
});

test('store: concurrent changes to one paper are all kept', async () => {
  const {dir, store, paper} = await library();
  const a = await store.addAnnotation(paper.id, hl());
  const jobs = [store.patchAnnotation(paper.id, a.id, {color: '#112233'}), store.patchAnnotation(paper.id, a.id, {comment: 'both kept'}),
    ...Array.from({length: 25}, (_, i) => store.addAnnotation(paper.id, hl({comment: 'c' + i}))),
    ...Array.from({length: 10}, (_, i) => store.addReply(paper.id, a.id, {text: 'r' + i})),
    store.patchAnnotation(paper.id, a.id, {color: 'bad'}).catch(e => e.status), // a failed change does not block the queue
    store.importAnnotations(paper.id, [{...hl(), pdfId: '5R'}])];
  const results = await Promise.all(jobs);
  assert.equal(results.at(-2), 400);
  const doc = await store.loadAnnotations(paper.id), mine = doc.items.find(x => x.id === a.id);
  assert.equal(doc.items.length, 27);
  assert.deepEqual([mine.color, mine.comment, mine.replies.map(r => r.text).join()], ['#112233', 'both kept', 'r0,r1,r2,r3,r4,r5,r6,r7,r8,r9']);
  assert.deepEqual(doc.items.slice(1, 26).map(x => x.comment), Array.from({length: 25}, (_, i) => 'c' + i), 'in the order they were asked');
  await rm(dir, {recursive: true, force: true});
});

test('AI reply prompt: paper details, the page with its neighbours, the passage and the thread', () => {
  const paper = {name: 'file', meta: {title: 'Momentum observers', authors: ['A', 'B'], year: 2017, venue: 'T-RO', abstract: 'x'.repeat(5000)}};
  const pages = [{page: 1, text: 'one ' + 'a'.repeat(6000) + ' END1'}, {page: 2, text: 'page two text'}, {page: 3, text: 'START3 ' + 'b'.repeat(6000)}, {page: 4, text: 'four'}];
  const a = {kind: 'highlight', page: 2, rects: [R], text: 'the residual\nconverges', comment: 'Why does it converge?', replies: [{author: 'ai', text: 'Because K > 0.'}, {author: 'user', text: 'And if K = 0?'}]};
  const {source, question} = aiReplyPrompt(paper, a, pages);
  assert.match(source, /^PAPER\nTitle: Momentum observers\nAuthors: A, B\nYear: 2017\nVenue: T-RO\nAbstract: x+…\n/);
  assert.ok(source.includes('[PDF PAGE 1, its end]\n…') && source.includes('END1') && !source.includes('one '));
  assert.ok(source.includes('[PDF PAGE 2]\npage two text') && source.includes('[PDF PAGE 3, its start]\nSTART3') && !source.includes('four'));
  assert.ok(source.length < 5000 + AI_CONTEXT.before + AI_CONTEXT.after);
  assert.ok(question.includes('HIGHLIGHT on PDF page 2. The highlighted passage:\n> the residual\n> converges'));
  assert.ok(question.includes('Reader: Why does it converge?\n\nAI: Because K > 0.\n\nReader: And if K = 0?'));
  assert.match(question, /Write the next reply in this thread\.$/);
  const bare = aiReplyPrompt({name: 'Only a file name'}, {...a, page: 9, comment: '', replies: []}, null);
  assert.match(bare.source, /Title: Only a file name\n\n\[PDF PAGE 9\]\n\(No text could be extracted/);
  assert.match(bare.question, /\(The reader wrote no comment\.\)\n\nExplain the highlighted passage\.$/);
  assert.match(aiReplyPrompt(paper, {kind: 'note', page: 1, rects: [{x0: 0.25, y0: 0.5, x1: 0.25, y1: 0.5}], text: '', comment: 'q', replies: []}, pages).question, /^NOTE placed on PDF page 1, about 25% from the left edge and 50% from the top/);
});

// ---------- export ----------
// Page 1: 612 x 792. Page 2: media box 500 x 700 with a crop box that starts at (50, 60), 400 x 600, turned by 90 degrees
// (shown 600 wide, 400 high). Page 1 carries a link, a highlight with a reply and a pop-up (imported into Margin), and
// someone else's note with a reply (not imported).
async function samplePdf({rotate2 = 90} = {}) {
  const doc = await PDFDocument.create(), ctx = doc.context;
  const p1 = doc.addPage([612, 792]), p2 = doc.addPage([500, 700]);
  p1.drawText('Page one', {x: 72, y: 700, size: 12}); p2.drawText('Page two', {x: 100, y: 300, size: 12});
  p2.setCropBox(50, 60, 400, 600); p2.setRotation(degrees(rotate2));
  const reg = o => ctx.register(ctx.obj(o));
  const link = reg({Type: 'Annot', Subtype: 'Link', Rect: [72, 690, 200, 712], Border: [0, 0, 0], A: {Type: 'Action', S: 'URI', URI: PDFString.of('https://example.org/')}});
  const old = reg({Type: 'Annot', Subtype: 'Highlight', Rect: [72, 600, 300, 612], QuadPoints: [72, 612, 300, 612, 72, 600, 300, 600], C: [1, 1, 0], Contents: PDFString.of('original comment'), T: PDFString.of('Alice')});
  const oldReply = reg({Type: 'Annot', Subtype: 'Text', Rect: [72, 600, 92, 620], IRT: old, RT: 'R', Contents: PDFString.of('I agree'), T: PDFString.of('Bob')});
  const oldNested = reg({Type: 'Annot', Subtype: 'Text', Rect: [72, 600, 92, 620], IRT: oldReply, RT: 'R', Contents: PDFString.of('nested reply'), T: PDFString.of('Carol')});
  const popup = reg({Type: 'Annot', Subtype: 'Popup', Rect: [320, 560, 500, 660], Parent: old, Open: false});
  ctx.lookup(old).set(N('Popup'), popup);
  const other = reg({Type: 'Annot', Subtype: 'Text', Rect: [400, 400, 420, 420], Contents: PDFString.of('not imported'), T: PDFString.of('Dave')});
  const otherReply = reg({Type: 'Annot', Subtype: 'Text', Rect: [400, 400, 420, 420], IRT: other, RT: 'R', Contents: PDFString.of('reply to Dave'), T: PDFString.of('Erin')});
  p1.node.set(N('Annots'), ctx.obj([link, old, oldReply, oldNested, popup, other, otherReply]));
  const id = ref => `${ref.objectNumber}R`;
  return {bytes: await doc.save(), ids: {link: id(link), old: id(old), oldReply: id(oldReply), popup: id(popup), other: id(other)}};
}
const T0 = '2026-03-04T05:06:07.000Z';
const item = over => ({id: 'a'.repeat(16), kind: 'highlight', page: 1, rects: [R], color: '#ffd400', text: 'words', comment: '', replies: [], origin: 'margin', createdAt: T0, updatedAt: T0, ...over});
const rawAnnots = (doc, page) => { const arr = doc.getPages()[page].node.Annots(); return arr ? arr.asArray().map(r => ({ref: r, d: doc.context.lookup(r)})) : []; };
const nums = v => v.asArray().map(n => n.asNumber());
const text = v => v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : undefined;
const close = (a, b, eps = 0.01) => { assert.equal(a.length, b.length); a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) <= eps, `${a} vs ${b}`)); };
async function viewed(bytes) { // every page's annotations as pdf.js reports them, with rects normalised to the displayed page
  const {getDocument} = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({data: new Uint8Array(bytes), isEvalSupported: false, verbosity: 0});
  try {
    const doc = await task.promise, out = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n), vp = page.getViewport({scale: 1});
      out.push((await page.getAnnotations()).map(a => {
        const [ax, ay] = vp.convertToViewportPoint(a.rect[0], a.rect[1]), [bx, by] = vp.convertToViewportPoint(a.rect[2], a.rect[3]);
        return {...a, box: [Math.min(ax, bx) / vp.width, Math.min(ay, by) / vp.height, Math.max(ax, bx) / vp.width, Math.max(ay, by) / vp.height], size: [Math.abs(bx - ax), Math.abs(by - ay)]};
      }));
    }
    return out;
  } finally { await task.destroy(); }
}

test('export: highlights, notes and replies become PDF annotations; imported originals are left out', async () => {
  const {bytes, ids} = await samplePdf();
  const before = Buffer.from(bytes);
  const items = [
    item({id: '1'.repeat(16), rects: [R, {x0: 0.1, y0: 0.26, x1: 0.3, y1: 0.31}], comment: 'Why? ünïcode ✓', replies: [
      {id: 'aaaaaaaa', author: 'user', text: 'first reply', at: '2026-03-05T00:00:00.000Z'},
      {id: 'bbbbbbbb', author: 'ai', text: 'AI says \\(x\\)', at: '2026-03-05T00:00:00.000Z', model: 'claude-opus-5-5'}]}),
    item({id: '2'.repeat(16), kind: 'note', rects: [{x0: 0.5, y0: 0.5, x1: 0.5, y1: 0.5}], color: '#3366ff', text: '', comment: 'a note'}),
    item({id: '3'.repeat(16), page: 2, color: '#00ff00', comment: 'on the turned page'}),
    item({id: '4'.repeat(16), page: 2, kind: 'note', rects: [{x0: 0.5, y0: 0.25, x1: 0.5, y1: 0.25}], text: '', comment: 'turned note'}),
    item({id: '5'.repeat(16), origin: 'pdf', pdfId: ids.old, rects: [{x0: 0.1, y0: 0.6, x1: 0.4, y1: 0.62}], comment: 'edited in Margin', replies: [
      {id: 'cccccccc', author: 'user', text: 'I agree', at: T0}, {id: 'dddddddd', author: 'user', text: 'mine', at: T0}]}),
    item({id: '6'.repeat(16), page: 3}), item({id: '7'.repeat(16), kind: 'ink'}),
  ];
  const out = await annotatePdf(bytes, {items, importedPdfIds: [ids.old, '99999R', 'junk']});
  assert.equal(out.error, undefined);
  assert.deepEqual([out.written, out.skipped], [5, 2], 'a page the PDF does not have and an unknown kind are skipped');
  assert.ok(before.equals(Buffer.from(bytes)), 'the input is not changed');

  const doc = await PDFDocument.load(out.pdf), a1 = rawAnnots(doc, 0), a2 = rawAnnots(doc, 1);
  const sub = x => x.d.get(N('Subtype')).asString().slice(1), by = (list, nm) => list.find(x => text(x.d.get(N('NM'))) === nm);
  // Untouched: the link, and the note that was not imported with its reply. Gone: the imported highlight, its replies and pop-up.
  assert.deepEqual(a1.slice(0, 3).map(x => [sub(x), text(x.d.get(N('Contents')))]), [['Link', undefined], ['Text', 'not imported'], ['Text', 'reply to Dave']]);
  assert.equal(a1.length, 3 + 2 + 2 + 1 + 2 /* h1 + 2 replies, note, imported copy + 2 replies */ + 0);
  for (const gone of ['original comment', 'nested reply']) assert.ok(!a1.some(x => text(x.d.get(N('Contents'))) === gone));
  assert.ok(!a1.some(x => sub(x) === 'Popup'));
  assert.equal(doc.context.lookup(PDFRef.of(Number(ids.old.slice(0, -1)))), undefined, 'the old object is not kept in the file');
  assert.equal(doc.context.lookup(PDFRef.of(Number(ids.popup.slice(0, -1)))), undefined);

  // Highlight on page 1: quads in Acrobat's order (top-left, top-right, bottom-left, bottom-right), y measured from the bottom.
  const h = by(a1, 'margin-' + '1'.repeat(16));
  assert.equal(sub(h), 'Highlight');
  close(nums(h.d.get(N('QuadPoints'))), [61.2, 633.6, 306, 633.6, 61.2, 594, 306, 594, 61.2, 586.08, 183.6, 586.08, 61.2, 546.48, 183.6, 546.48]);
  close(nums(h.d.get(N('Rect'))), [61.2, 546.48, 306, 633.6]);
  close(nums(h.d.get(N('C'))), [1, 0.831, 0]);
  assert.equal(h.d.get(N('CA')).asNumber(), HIGHLIGHT_OPACITY); assert.equal(h.d.get(N('F')).asNumber(), 4);
  assert.equal(text(h.d.get(N('Contents'))), 'Why? ünïcode ✓'); assert.equal(text(h.d.get(N('T'))), AUTHOR);
  assert.equal(h.d.get(N('M')).decodeDate().toISOString(), T0);
  assert.equal(h.d.get(N('P')), doc.getPages()[0].ref);
  const ap = doc.context.lookup(h.d.lookup(N('AP')).get(N('N')));
  close(nums(ap.dict.get(N('BBox'))), [61.2, 546.48, 306, 633.6]);
  assert.equal(ap.dict.lookup(N('Resources')).lookup(N('ExtGState')).lookup(N('GS0')).get(N('BM')), N('Multiply'));
  const stream = Buffer.from((await import('pako')).default.inflate(ap.contents)).toString();
  assert.match(stream, /^\/GS0 gs\n1 0\.831 0 rg\n61\.2 633\.6 m 306 633\.6 l 306 594 l 61\.2 594 l h\n61\.2 586\.08 m .* l h\nf\n$/);

  // Replies: /Text annotations in reply to the highlight, listed after it, in order, drawn as nothing.
  const replies = a1.filter(x => x.d.get(N('IRT')) === h.ref);
  assert.deepEqual(replies.map(x => [sub(x), x.d.get(N('RT')), text(x.d.get(N('Contents'))), text(x.d.get(N('T'))), x.d.get(N('F')).asNumber()]),
    [['Text', N('R'), 'first reply', AUTHOR, 28], ['Text', N('R'), 'AI says \\(x\\)', 'AI (claude-opus-5-5)', 28]]);
  assert.ok(replies[1].d.get(N('M')).decodeDate() > replies[0].d.get(N('M')).decodeDate(), 'same time stamps are spread so the order survives');
  close(nums(replies[0].d.get(N('Rect'))), [61.2, 633.6, 61.2, 633.6]);
  assert.equal(doc.context.lookup(replies[0].d.lookup(N('AP')).get(N('N'))).contents.length > 0, true);

  // Note: a /Text annotation with the Comment icon, its box hanging from the point.
  const note = by(a1, 'margin-' + '2'.repeat(16));
  assert.deepEqual([sub(note), note.d.get(N('Name')), text(note.d.get(N('Contents'))), note.d.get(N('IRT'))], ['Text', N('Comment'), 'a note', undefined]);
  close(nums(note.d.get(N('Rect'))), [306, 396 - NOTE_SIZE, 306 + NOTE_SIZE, 396]);
  close(nums(note.d.get(N('C'))), [0.2, 0.4, 1]);
  assert.ok(note.d.lookup(N('AP')).get(N('N')) instanceof PDFRef);

  // The imported highlight comes back from Margin's copy, with the original authors where they can be told.
  const back = by(a1, 'margin-' + '5'.repeat(16));
  assert.deepEqual([text(back.d.get(N('Contents'))), text(back.d.get(N('T')))], ['edited in Margin', 'Alice']);
  assert.deepEqual(a1.filter(x => x.d.get(N('IRT')) === back.ref).map(x => [text(x.d.get(N('Contents'))), text(x.d.get(N('T')))]), [['I agree', 'Bob'], ['mine', AUTHOR]]);

  // Turned page (90 degrees, crop box origin 50,60, 400 x 600): display x runs along PDF y, display y along PDF x.
  const t = by(a2, 'margin-' + '3'.repeat(16));
  close(nums(t.d.get(N('QuadPoints'))), [130, 120, 130, 360, 150, 120, 150, 360]);
  close(nums(t.d.get(N('Rect'))), [130, 120, 150, 360]);
  const tn = by(a2, 'margin-' + '4'.repeat(16));
  close(nums(tn.d.get(N('Rect'))), [150, 360, 150 + NOTE_SIZE, 360 + NOTE_SIZE]);
  close(nums(doc.context.lookup(tn.d.lookup(N('AP')).get(N('N'))).dict.get(N('Matrix'))), [0, 1, -1, 0, 0, 0]);

  // What a viewer (pdf.js) makes of it: the same boxes on the displayed pages.
  const [v1, v2] = await viewed(out.pdf);
  const seen = (list, sub, contents) => list.find(a => a.subtype === sub && a.contentsObj?.str === contents);
  close(seen(v1, 'Highlight', 'Why? ünïcode ✓').box, [0.1, 0.2, 0.5, 0.31], 1e-4);
  assert.ok(seen(v1, 'Highlight', 'Why? ünïcode ✓').hasAppearance);
  close(seen(v2, 'Highlight', 'on the turned page').box, [R.x0, R.y0, R.x1, R.y1], 1e-4);
  close(seen(v2, 'Text', 'turned note').box.slice(0, 2), [0.5, 0.25], 1e-4);
  close(seen(v2, 'Text', 'turned note').size, [NOTE_SIZE, NOTE_SIZE]);
  close(seen(v1, 'Text', 'a note').box.slice(0, 2), [0.5, 0.5], 1e-4);
  const vr = seen(v1, 'Text', 'first reply');
  assert.deepEqual([vr.inReplyTo, vr.replyType, vr.titleObj.str], [seen(v1, 'Highlight', 'Why? ünïcode ✓').id, 'R', AUTHOR]);
  assert.ok(!v1.some(a => a.id === ids.old || a.id === ids.oldReply), 'the originals are gone for a viewer too');
  assert.ok(v1.some(a => a.id === ids.link && a.subtype === 'Link') && v1.some(a => a.id === ids.other));
});

test('export: every page rotation maps the displayed position back to the same place', async () => {
  for (const rot of [0, 90, 180, 270, -90, 450]) {
    const {bytes} = await samplePdf({rotate2: rot});
    const rects = [{x0: 0.12, y0: 0.07, x1: 0.61, y1: 0.11}, {x0: 0.7, y0: 0.9, x1: 0.95, y1: 0.99}];
    const out = await annotatePdf(bytes, {items: [item({page: 2, rects, comment: 'h'}), item({id: 'b'.repeat(16), page: 2, kind: 'note', rects: [{x0: 0.3, y0: 0.6, x1: 0.3, y1: 0.6}], comment: 'n'}),
      item({id: 'c'.repeat(16), page: 2, kind: 'note', rects: [{x0: 1, y0: 1, x1: 1, y1: 1}], comment: 'corner'})]});
    const [, v2] = await viewed(out.pdf);
    const h = v2.find(a => a.subtype === 'Highlight'), n = v2.find(a => a.contentsObj.str === 'n'), corner = v2.find(a => a.contentsObj.str === 'corner');
    close(h.box, [0.12, 0.07, 0.95, 0.99], 1e-4);
    close(n.box.slice(0, 2), [0.3, 0.6], 1e-4); close(n.size, [NOTE_SIZE, NOTE_SIZE]);
    close(corner.box.slice(2), [1, 1], 1e-4); // a note at the edge is moved inside the page
    // Each quad, read as top-left, top-right, bottom-left, bottom-right, is the displayed rect again.
    const doc = await PDFDocument.load(out.pdf), page = doc.getPages()[1], g = pageGeometry(page);
    const q = nums(rawAnnots(doc, 1).find(x => x.d.get(N('Subtype')) === N('Highlight')).d.get(N('QuadPoints')));
    rects.forEach((r, i) => close(q.slice(i * 8, i * 8 + 8), [g.toPdf(r.x0, r.y0), g.toPdf(r.x1, r.y0), g.toPdf(r.x0, r.y1), g.toPdf(r.x1, r.y1)].flat(), 0.002));
    assert.deepEqual([g.W, g.H], ((rot % 180) + 180) % 180 === 90 ? [600, 400] : [400, 600]);
  }
});

test('export: encrypted and unreadable PDFs give an error instead of throwing', async () => {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>',
    '<< /Filter /Standard /V 1 /R 2 /O (' + 'o'.repeat(32) + ') /U (' + 'u'.repeat(32) + ') /P -4 >>'];
  let pdf = '%PDF-1.4\n';
  const offsets = objs.map((o, i) => { const at = pdf.length; pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
  const xref = pdf.length;
  pdf += `xref\n0 5\n0000000000 65535 f \n` + offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('') + `trailer\n<< /Size 5 /Root 1 0 R /Encrypt 4 0 R /ID [<00><00>] >>\nstartxref\n${xref}\n%%EOF\n`;
  assert.deepEqual(await annotatePdf(Buffer.from(pdf, 'latin1'), {items: [item()]}), {error: 'encrypted'});
  assert.equal((await annotatePdf(Buffer.from('%PDF-1.4\n% nothing here\n'), {items: [item()]})).error, 'unreadable');
  assert.equal((await annotatePdf(Buffer.from('not a pdf at all'), {items: [item()]})).error, 'unreadable');
});
