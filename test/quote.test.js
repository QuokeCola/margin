import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {findQuote, textBoxes} from '../src/layout.js';
import {preparePage, findQuoteIn, locateQuote} from '../src/quote.js';

// The page choice navigateQuote made before quote.js (cited page if ≤ 10 % edits, else the closest page).
function oldLocate(pages, citedPage, quote) {
  const find = n => { const p = pages.find(x => x.page === n); return p ? findQuote(p.boxes, quote, p.W, p.H) : null; };
  let best = null, bestPage = null;
  const own = find(citedPage);
  if (own && own.dist <= 0.1) { best = own; bestPage = citedPage; }
  else {
    if (own) { best = own; bestPage = citedPage; }
    for (const n of pages.map(p => p.page)) {
      if (n === citedPage) continue;
      const r = find(n);
      if (r && (!best || r.dist < best.dist - 0.02)) { best = r; bestPage = n; }
    }
  }
  return best ? {rects: best, page: bestPage} : null;
}

let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const pick = a => a[Math.floor(rnd() * a.length)];
const VOCAB = 'the of and model state gain estimate converges error bound stochastic gradient variance controller robust tracking delay matrix stiffness filter residual torque observer kalman noise sample step size lemma theorem proof assumption convex smooth lipschitz iteration batch'.split(' ');
// Synthetic page: lines of words, each word one text item (as many PDFs store them), some hyphenated or with symbols.
function synthPage(lines = 40) {
  const boxes = [];
  for (let l = 0; l < lines; l++) {
    let x = 50; const y = 60 + l * 14;
    for (let w = 0; w < 11; w++) {
      let s = pick(VOCAB); if (rnd() < 0.05) s += ','; if (rnd() < 0.03) s = s.toUpperCase(); if (rnd() < 0.02) s = 'α' + s; if (rnd() < 0.03) s += '(' + Math.floor(rnd() * 40) + ')';
      boxes.push({s, x0: x, x1: x + s.length * 5, y0: y, y1: y + 10}); x += s.length * 5 + 4;
    }
  }
  return boxes;
}
const wordsOf = boxes => boxes.map(b => b.s);
function quotesFor(pages, rounds = 24) {
  const out = [];
  for (let i = 0; i < rounds; i++) {
    const p = pick(pages), w = wordsOf(p.boxes).join(' ').split(/\s+/).filter(Boolean);
    if (w.length < 30) continue;
    const len = [3, 6, 15, 40, 90][i % 5], at = Math.floor(rnd() * Math.max(1, w.length - len)), q = w.slice(at, at + len);
    const cited = rnd() < 0.3 ? pick(pages).page : p.page; // sometimes the wrong page
    out.push([q.join(' '), cited]);                                                                   // exact
    out.push([q.map((x, k) => k % 5 === 2 ? x.slice(0, -1) + 'x' : x).join(' '), cited]);             // changed letters
    out.push([q.filter((_, k) => k !== 3).join(' '), cited]);                                         // a dropped word
    out.push([q.map((x, k) => k % 3 === 1 ? pick(VOCAB) : x).join(' '), cited]);                      // replaced words
  }
  out.push(['the proposed controller achieves robust tracking with bounded estimation error under stochastic disturbances and delays '.repeat(3), pages[0].page]); // not in the paper
  out.push(['zzqqxx kkjjvv', pages[0].page], ['ab', pages[0].page], ['', pages[0].page]);
  return out;
}
function compare(pages, label, rounds) {
  for (const p of pages) p.prepared = preparePage(p.boxes);
  let n = 0, found = 0;
  let fuzzy = 0;
  for (const [q, cited] of quotesFor(pages, rounds)) {
    for (const p of pages) assert.deepEqual(findQuoteIn(p.prepared, q, p.W, p.H), findQuote(p.boxes, q, p.W, p.H), `${label} page ${p.page}: ${q.slice(0, 60)}`);
    const a = locateQuote(pages, cited, q), b = oldLocate(pages, cited, q);
    assert.deepEqual(a, b, `${label} locate: ${q.slice(0, 60)}`);
    n++; if (a) found++; if (a?.rects.dist > 0) fuzzy++;
  }
  return {n, found, fuzzy};
}

test('quote search gives the same rectangles and pages as findQuote (synthetic pages)', () => {
  const pages = Array.from({length: 8}, (_, i) => ({page: i + 1, boxes: synthPage(), W: 600, H: 800}));
  const {n, found, fuzzy} = compare(pages, "synthetic");
  assert.ok(n > 80 && found > 40 && found < n && fuzzy > 20, JSON.stringify({n, found, fuzzy}));
});

test('a quote longer than 32 and 400 characters, and matches at the very start and end of a page', () => {
  const boxes = synthPage(30), page = preparePage(boxes), text = boxes.map(b => b.s).join(' ');
  for (const q of [text.slice(0, 120), text.slice(-120), text.slice(0, 700), text.slice(5, 45).replace(/e/g, 'a')])
    assert.deepEqual(findQuoteIn(page, q, 600, 800), findQuote(boxes, q, 600, 800));
});

// Real papers from the equation corpus, when it is on this computer.
const CORPUS = '/home/quokecola/Projects/margin-eq-corpus/papers';
for (const id of ['2401.13105v1', '2401.15890v1', '2401.06266v1']) {
  const file = `${CORPUS}/${id}/paper.pdf`;
  test(`quote search matches findQuote on ${id}`, {skip: !existsSync(file) && 'corpus not present'}, async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({data: new Uint8Array(readFileSync(file)), verbosity: 0}).promise;
    const pages = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const pg = await doc.getPage(n), vp = pg.getViewport({scale: 1}), tc = await pg.getTextContent();
      pages.push({page: n, boxes: textBoxes(tc.items.filter(t => typeof t.str === 'string'), vp, pdfjs.Util), W: vp.width, H: vp.height});
    }
    const {n, found, fuzzy} = compare(pages, id, 10);
    assert.ok(n > 30 && found > 0 && fuzzy > 0);
  });
}
