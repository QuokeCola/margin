import {test} from 'node:test';
import assert from 'node:assert/strict';
import {citingSentence, sentenceEnds, normSentence, traceKeyText, parseTrace, quoteKey, quotePage, verifyQuotes, tracePrompt, traceQuery, matchText, TRACE, TRACE_V} from '../lib/citation-trace.mjs';
import {findMarkers} from '../src/bib.js';
import {previewCrop, placeCard, PREVIEW, CARD} from '../src/trace.js';

// Text items as the app has them: one per line here, 5 pt per character, 14 pt apart.
const line = (s, row, x0 = 50) => ({s, x0, x1: x0 + s.length * 5, y0: 100 + row * 14, y1: 110 + row * 14});
const at = (boxes, i, k = 0) => { const m = findMarkers(boxes[i].s)[k]; return {i, index: m.index, length: m.length}; };

test('citing sentence: wraps over lines, hyphenation is undone, abbreviations do not end it', () => {
  const boxes = [line('Earlier work used force sensors. Collisions are detected with a momen-', 0), line('tum observer [12], which needs no accel-', 1),
    line('eration. Smith et al. [3] showed in Fig. 2 that it', 2), line('works, e.g. on a 7-DoF arm. The gain sets the bandwidth.', 3)];
  assert.deepEqual(citingSentence(boxes, at(boxes, 1)), {sentence: 'Collisions are detected with a momentum observer [12], which needs no acceleration.',
    before: 'Earlier work used force sensors.', after: 'Smith et al. [3] showed in Fig. 2 that it works, e.g. on a 7-DoF arm.'});
  assert.deepEqual(citingSentence(boxes, at(boxes, 2)), {sentence: 'Smith et al. [3] showed in Fig. 2 that it works, e.g. on a 7-DoF arm.',
    before: 'Collisions are detected with a momentum observer [12], which needs no acceleration.', after: 'The gain sets the bandwidth.'});
});

test('citing sentence: a marker at the sentence end, before or after the full stop', () => {
  const boxes = [line('The residual converges [4]. The gain sets the bandwidth.[5] Next we', 0), line('show more. [6] Then nothing. [7] proposes an observer. Last one [8, 9]', 1)];
  const s = (i, k) => citingSentence(boxes, at(boxes, i, k)).sentence;
  assert.equal(s(0, 0), 'The residual converges [4].');
  assert.equal(s(0, 1), 'The gain sets the bandwidth.[5]', 'marker straight after the full stop');
  assert.equal(s(1, 0), 'Next we show more. [6]', 'marker after the full stop and a space, a capital follows');
  assert.equal(s(1, 1), '[7] proposes an observer.', 'a lower-case word follows: the marker starts the sentence');
  assert.equal(s(1, 2), 'Last one [8, 9]', 'the page text ends without a full stop');
  assert.deepEqual(citingSentence(boxes, at(boxes, 1, 0)), {sentence: 'Next we show more. [6]', before: 'The gain sets the bandwidth.[5]', after: 'Then nothing.'});
});

test('citing sentence: pieces of a line, initials, long text, broken brackets, nothing to find', () => {
  // One line set as several items: a gap makes a space, touching pieces stay one word.
  const a = {s: 'As J. Smith con', x0: 50, x1: 125, y0: 100, y1: 110}, b = {s: 'firmed', x0: 125.2, x1: 155, y0: 100, y1: 110}, c = {s: '\u000112\u0002, it holds.', x0: 160, x1: 240, y0: 100, y1: 110};
  assert.equal(citingSentence([a, b, c], {i: 2, index: 0, length: 4}).sentence, 'As J. Smith confirmed [12], it holds.');
  assert.deepEqual(sentenceEnds('It is 3.5 m long. See the U.S. Army report! Done'), [17, 43, 48]);
  const long = [line('x '.repeat(500) + 'the marker [2] sits here ' + 'y '.repeat(500) + '.', 0)];
  const cut = citingSentence(long, at(long, 0)).sentence;
  assert.ok(cut.length <= TRACE.sentence + 2 && cut.includes('the marker [2] sits here') && cut.startsWith('…') && cut.endsWith('…'), cut.length);
  const ctx = [line('A '.repeat(400) + 'end. Here [1] it is. ' + 'B '.repeat(400) + 'end.', 0)], r = citingSentence(ctx, at(ctx, 0));
  assert.ok(r.before.length <= TRACE.context + 1 && r.before.startsWith('…') && r.before.endsWith('end.'));
  assert.ok(r.after.length <= TRACE.context + 1 && r.after.endsWith('…'));
  assert.equal(citingSentence([], {i: 0, index: 0, length: 3}), null);
  assert.equal(citingSentence(null, null), null);
});

test('cache key text: the cited paper and the sentence, whatever its spacing, case or Unicode form', () => {
  const id = 'a'.repeat(64);
  assert.equal(normSentence('  The ﬁrst\n Result  [3]. '), 'the first result [3].');
  assert.equal(traceKeyText(id, 'The ﬁrst\nresult [3].'), traceKeyText(id, ' the first result  [3]. '));
  assert.notEqual(traceKeyText(id, 'The first result [3].'), traceKeyText(id, 'The first result [4].'));
  assert.notEqual(traceKeyText(id, 'The first result [3].'), traceKeyText('b'.repeat(64), 'The first result [3].'));
  assert.ok(traceKeyText(id, 'x').startsWith(`${TRACE_V}\n${id}\n`));
});

test('model answer: JSON, fenced or with words around it; anything else is refused', () => {
  const j = '{"status": "found", "quotes": [{"page": 2, "quote": " The residual\\n converges. "}, {"page": 3}, {"quote": ""}, null], "note": "It  says so."}';
  const want = {status: 'found', quotes: [{page: 2, quote: 'The residual converges.'}], note: 'It says so.'};
  assert.deepEqual(parseTrace(j), want);
  assert.deepEqual(parseTrace('```json\n' + j + '\n```'), want);
  assert.deepEqual(parseTrace('Here it is: ' + j + ' Done.'), want);
  assert.deepEqual(parseTrace('{"status": "general"}'), {status: 'general', quotes: [], note: ''});
  for (const bad of ['', 'no json', '{"status": "maybe", "quotes": []}', '{"status": "found"', '[1, 2]', null]) assert.equal(parseTrace(bad), null, String(bad));
  assert.ok(parseTrace(JSON.stringify({status: 'none', note: 'w '.repeat(400)})).note.length <= TRACE.note + 1);
});

const PAGES = [{page: 1, text: 'The momen-\ntum observer   residual converges to the\nexternal torque. Its gain K sets the band-\nwidth of the ﬁltered estimate.'},
  {page: 2, text: 'No acceleration measurement is needed.\nThe threshold is tuned by hand.'}];
test('quote verification: white space, line-end hyphens and ligatures are forgiven, words are not', () => {
  assert.equal(quoteKey('The momen-\ntum  “Observer”, ﬁrst!'), 'themomentumobserverfirst');
  assert.equal(quotePage(PAGES, 1, 'The momentum observer residual converges to the external torque.'), 1);
  assert.equal(quotePage(PAGES, 1, 'Its gain K sets the bandwidth of the filtered estimate.'), 1);
  assert.equal(quotePage(PAGES, 1, 'No acceleration measurement is needed.'), 2, 'on another page than stated: that page');
  assert.equal(quotePage(PAGES, 7, 'The threshold is tuned by hand.'), 2);
  assert.equal(quotePage(PAGES, 1, 'The momentum observer residual diverges from the external torque.'), null, 'one changed word');
  assert.equal(quotePage(PAGES, 1, 'The residual converges to the torque.'), null, 'words left out');
  assert.equal(quotePage(PAGES, 1, 'Its gain K'), null, 'too short to mean anything');
  assert.equal(quotePage([{page: 1, text: 'word '.repeat(300)}], 1, 'word '.repeat(200)), null, 'too long');
});

test('verified answer: invented quotes are dropped, "found" without a real quote becomes "none"', () => {
  const real = {page: 1, quote: 'Its gain K sets the bandwidth of the filtered estimate.'}, fake = {page: 1, quote: 'The observer is provably optimal in every case.'};
  assert.deepEqual(verifyQuotes({status: 'found', quotes: [fake, real, {...real, page: 2}], note: 'n'}, PAGES), {status: 'found', quotes: [real], dropped: 1, note: 'n'});
  const none = verifyQuotes({status: 'found', quotes: [fake], note: 'It says so.'}, PAGES);
  assert.deepEqual([none.status, none.quotes, none.dropped], ['none', [], 1]); assert.match(none.note, /does not occur in the cited paper/);
  assert.match(verifyQuotes({status: 'found', quotes: [], note: 'x'}, PAGES).note, /named no passage/);
  assert.deepEqual(verifyQuotes({status: 'general', quotes: [fake], note: 'A survey.'}, PAGES), {status: 'general', quotes: [], dropped: 1, note: 'A survey.'});
  assert.deepEqual(verifyQuotes({status: 'none', quotes: [real], note: 'Nothing.'}, PAGES), {status: 'none', quotes: [], dropped: 0, note: 'Nothing.'});
  const many = ['The momentum observer residual converges to the external torque.', 'Its gain K sets the bandwidth', 'No acceleration measurement is needed.', 'The threshold is tuned by hand.'];
  assert.deepEqual(verifyQuotes({status: 'found', quotes: many.map(quote => ({page: 1, quote})), note: ''}, PAGES).quotes.map(q => q.page), [1, 1, 2], `at most ${TRACE.quotes}`);
});

test('prompt: the cited paper, its passages with pages, and the sentence with its neighbours', () => {
  const {source, question} = tracePrompt({sentence: 'Collisions are detected with an observer [12].', before: 'Before.', after: 'After.', refNum: 12,
    target: {title: 'Momentum observers', authors: ['A One', 'B Two', 'C Three', 'D Four', 'E Five'], year: 2017, abstract: 'An  abstract. ' + 'w '.repeat(900)},
    passages: [{page: 4, text: 'Passage four.'}, {page: 2, text: 'Passage two.'}]});
  assert.match(source, /^CITED PAPER\nTitle: Momentum observers\nAuthors: A One, B Two, C Three, et al\.\nYear: 2017\nAbstract: An abstract\. /);
  assert.ok(source.endsWith('[PDF PAGE 4]\nPassage four.\n\n[PDF PAGE 2]\nPassage two.'));
  assert.ok(source.length < TRACE.abstract + 300);
  assert.equal(question, 'CITING SENTENCE (the cited paper is reference [12] there)\nCollisions are detected with an observer [12].\n\nThe sentence before it:\nBefore.\n\nThe sentence after it:\nAfter.\n\nWhere in the cited paper does this come from? Answer with the JSON object.');
  const bare = tracePrompt({sentence: 'S.', target: {title: 'T', firstPage: 'First page text.'}, passages: []});
  assert.match(bare.source, /First page \(no abstract on record\): First page text\./); assert.match(bare.question, /^CITING SENTENCE\nS\.\n\nWhere/);
  assert.equal(traceQuery({sentence: 'Observers [3, 4] and [5]–[7] work.', before: 'Before [1].'}), 'Before . Observers and – work.');
  assert.ok(matchText('w '.repeat(600)).length <= TRACE.matchChars + 1);
});

test('page picture: the highlighted words with room around them, inside the page', () => {
  const one = previewCrop([{x0: 0.55, y0: 0.5, x1: 0.9, y1: 0.512}]);
  assert.ok(Math.abs(one.x1 - one.x0 - PREVIEW.minWidth) < 1e-9 && one.x0 <= 0.55 - 0.03 + 1e-9 && one.x1 <= 1);
  assert.deepEqual([one.y0, one.y1].map(v => Math.round(v * 1000)), [470, 542]);
  const edge = previewCrop([{x0: 0.01, y0: 0.01, x1: 0.2, y1: 0.02}]);
  assert.deepEqual([edge.x0, edge.y0], [0, 0]); assert.ok(Math.abs(edge.x1 - PREVIEW.minWidth) < 1e-9);
  const tall = previewCrop([{x0: 0.1, y0: 0.2, x1: 0.9, y1: 0.22}, {x0: 0.1, y0: 0.22, x1: 0.9, y1: 0.95}]);
  assert.ok(Math.abs(tall.y1 - tall.y0 - PREVIEW.maxHeight) < 1e-9 && Math.abs(tall.y0 - 0.17) < 1e-9, 'a long quote: its start');
  assert.deepEqual([tall.x0, tall.x1].map(v => Math.round(v * 100)), [7, 93]);
});

test('card position: beside the reference card, never over it, inside the window', () => {
  const near = (left, top, w = 420, h = 200) => ({left, top, right: left + w, bottom: top + h});
  assert.deepEqual(placeCard(near(100, 80), 440, 300, 1400, 900), {left: 530, top: 80});
  assert.deepEqual(placeCard(near(900, 80), 440, 300, 1400, 900), {left: 450, top: 80}, 'no room on the right: left');
  assert.deepEqual(placeCard(near(100, 700), 440, 300, 1400, 900), {left: 530, top: 900 - 300 - CARD.edge}, 'kept inside at the bottom');
  assert.deepEqual(placeCard(near(300, 80), 440, 300, 1000, 900), {left: 300, top: 290, maxHeight: 602}, 'narrow window: below, with the height left');
  assert.deepEqual(placeCard(near(300, 600), 440, 300, 1000, 900), {left: 300, top: 290, maxHeight: 582, above: true}, 'above');
  assert.deepEqual(placeCard(near(300, 150, 420, 600), 440, 300, 1000, 900), {left: 552, top: CARD.edge}, 'nowhere: the top right corner');
});
