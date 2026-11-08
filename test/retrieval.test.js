import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chunkPages, sentences, cosine, lexicalScores, rankPassages, projectContext, searchQuery} from '../lib/retrieval.mjs';
import {authorYear, paperLabels, resolvePaper, shortId} from '../lib/labels.mjs';

const para = (n, word) => Array.from({length: n}, (_, i) => `Sentence ${i} talks about ${word} in some detail here.`).join(' ');

test('passages stay on their page, are about a paragraph long and overlap by one sentence', () => {
  const pages = [{page: 1, text: para(40, 'momentum')}, {page: 2, text: 'Short page with one line.'}, {page: 3, text: ''}];
  const chunks = chunkPages(pages, {target: 300, max: 500, min: 80});
  assert(chunks.length > 3);
  assert.deepEqual([...new Set(chunks.map(c => c.page))], [1, 2]);
  for (const c of chunks.filter(c => c.page === 1)) assert(c.text.length <= 500 + 80, c.text.length);
  const [a, b] = chunks;
  const lastOfA = sentences(a.text).pop();
  assert(b.text.startsWith(lastOfA), 'next passage repeats the last sentence');
  assert.equal(chunks.find(c => c.page === 2).text, 'Short page with one line.');
  // every sentence of page 1 is in some passage
  for (let i = 0; i < 40; i++) assert(chunks.some(c => c.text.includes(`Sentence ${i} talks`)), i);
});

test('line-break hyphenation is joined and over-long runs are cut', () => {
  const [c] = chunkPages([{page: 4, text: 'adaptive estimates of lower-order mo-\nments are used.'}]);
  assert.equal(c.text, 'adaptive estimates of lower-order moments are used.');
  const long = sentences('x'.repeat(10) + ' ' + 'word '.repeat(400), 200);
  assert(long.every(s => s.length <= 200) && long.length > 5);
});

test('ranking: best first, capped per paper, no contained duplicates, threshold', () => {
  const items = [
    {paperId: 'a', page: 1, text: 'alpha one', score: 0.9}, {paperId: 'a', page: 1, text: 'alpha one', score: 0.85},
    {paperId: 'a', page: 2, text: 'alpha two', score: 0.8}, {paperId: 'a', page: 3, text: 'alpha three', score: 0.7},
    {paperId: 'b', page: 1, text: 'beta one', score: 0.6}, {paperId: 'b', page: 2, text: 'beta two', score: 0.1},
  ];
  assert.deepEqual(rankPassages(items, {k: 4, perPaper: 2}).map(x => x.text), ['alpha one', 'alpha two', 'beta one', 'beta two']);
  assert.deepEqual(rankPassages(items, {k: 10, perPaper: 10, minScore: 0.5}).map(x => x.score), [0.9, 0.8, 0.7, 0.6]);
});

test('cosine and keyword fallback rank the relevant passage first', () => {
  assert.equal(cosine([1, 0], [1, 0]), 1); assert.equal(cosine([1, 0], [0, 1]), 0); assert.equal(cosine([0, 0], [1, 1]), 0);
  const texts = ['Dropout randomly omits hidden units during training.', 'Adam uses bias-corrected moment estimates of the gradient.', 'The weather is nice.'];
  const s = lexicalScores('How does Adam correct the bias of its moment estimates?', texts);
  assert(s[1] > s[0] && s[1] > s[2] && s[2] === 0);
});

test('labels: author-year, suffixes for equal labels, id prefixes', () => {
  const ps = [
    {id: 'aa11bb22' + '0'.repeat(56), meta: {authors: ['Diederik P. Kingma', 'Jimmy Ba'], year: 2015}},
    {id: 'cc33dd44' + '0'.repeat(56), meta: {authors: ['Nitish Srivastava', 'G. Hinton', 'A. Krizhevsky'], authorCount: 5, year: 2014}},
    {id: 'ee55ff66' + '0'.repeat(56), meta: {authors: ['N. Srivastava', 'X', 'Y'], year: 2014}},
    {id: '0123abcd' + '0'.repeat(56), name: 'my scanned notes on observers'},
  ];
  assert.equal(authorYear(ps[0]), 'Kingma & Ba 2015');
  assert.deepEqual([...paperLabels(ps).values()], ['Kingma & Ba 2015', 'Srivastava et al. 2014a', 'Srivastava et al. 2014b', 'my scanned notes on…']);
  assert.equal(shortId(ps[1].id), 'cc33dd44');
  assert.equal(resolvePaper('CC33DD44', ps), ps[1]); assert.equal(resolvePaper('cc33', ps), null); assert.equal(resolvePaper('99999999', ps), null);
});

test('project context lists every paper and groups passages by paper and page', () => {
  const papers = [{id: 'aa11bb22' + '0'.repeat(56), label: 'Kingma & Ba 2015', title: 'Adam', abstract: 'We introduce Adam.', pages: 15},
    {id: 'cc33dd44' + '0'.repeat(56), label: 'Hinton 2012', title: 'Dropout', firstPage: 'Improving neural networks…', note: 'no text'}];
  const t = projectContext(papers, [{paperId: papers[1].id, page: 3, text: 'P3'}, {paperId: papers[0].id, page: 5, text: 'P5'}, {paperId: papers[0].id, page: 2, text: 'P2'}]);
  assert.match(t, /\[paper aa11bb22\] Kingma & Ba 2015 · “Adam” · 15 pages\nAbstract: We introduce Adam\./);
  assert.match(t, /Note: no text\nFirst page \(no abstract on record\): Improving/);
  assert(t.indexOf('PDF PAGE 2]\nP2') < t.indexOf('PDF PAGE 5]\nP5') && t.indexOf('PDF PAGE 5]') < t.indexOf('[paper cc33dd44 · Hinton 2012 · PDF PAGE 3]\nP3'));
  assert.equal(searchQuery('And then?', [{role: 'user', content: 'What is Adam?'}, {role: 'assistant', content: 'x'}]), 'And then?\n\n(Previous question: What is Adam?)');
});
