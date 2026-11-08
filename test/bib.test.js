import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseBibliography, findMarkers, matchEntries, normBrackets} from '../src/bib.js';

const paper = refs => [{page: 1, text: 'Intro text citing [1] and [2]–[4].\n'}, {page: 2, text: 'More text [3, 5].\nREFERENCES\n' + refs}];

test('numbered bibliographies: [n] style, n. style, broken-font brackets', () => {
  const a = parseBibliography(paper('[1] A. Author, “First title,” J., 2010.\n[2] B. Author, “Second,” 2011.\n[3] C, “Third,” 2012.\n[4] D, “Fourth,” 2013.\n[5] E, “Fifth,” 2014.\n\nJohn Smith (M’10) received...'));
  assert.equal(a.entries.size, 5); assert.equal(a.start.page, 2);
  assert.match(a.entries.get(1), /First title/); assert.doesNotMatch(a.entries.get(5), /received/);
  const b = parseBibliography([{page: 1, text: 'x'}, {page: 2, text: 'References\n1. Givehchi, O. Cloud computing.\n2. Verl, A. An approach.\n3. Third one.'}]);
  assert.equal(b.entries.size, 3); assert.match(b.entries.get(2), /Verl/);
  const c = parseBibliography([{page: 1, text: 'References\n\u0001 1 \u0002 Altintas, Y., 2005.\n\u0001 2 \u0002 Reinhart, G.\n\u0001 3 \u0002 Third.'}]);
  assert.equal(c.entries.size, 3);
  assert.equal(normBrackets('关 7 兴'), '[ 7 ]');
});

test('in-text markers: single, lists, ranges', () => {
  assert.deepEqual(findMarkers('see [12].').map(m => m.nums), [[12]]);
  assert.deepEqual(findMarkers('as in [3, 7] and [8–10]').map(m => m.nums), [[3, 7], [8, 9, 10]]);
  assert.deepEqual(findMarkers('works [21]–[23] show').map(m => m.nums), [[21, 22, 23]]);
  const m = findMarkers('x [4] y')[0]; assert.equal('x [4] y'.slice(m.index, m.index + m.length), '[4]');
  assert.deepEqual(findMarkers('vector [a b]'), []);
});

test('entries match records by title words', () => {
  const entries = new Map([[1, 'A. De Luca and L. Ferrajoli, “Exploiting robot redundancy in collision detection and reaction,” IROS 2008.'], [2, 'Unrelated entry about ball screws.']]);
  const recs = [{title: 'Exploiting Robot Redundancy in Collision Detection and Reaction'}, {title: 'Something else entirely different'}];
  const m = matchEntries(entries, recs);
  assert.equal(m.get(1), recs[0]); assert.equal(m.has(2), false);
});
