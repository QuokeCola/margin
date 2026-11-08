import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseReferences,resolveReference} from '../src/references.js';
test('structured equations and pages',()=>assert.deepEqual(parseReferences('See [[eq:61|p:11]] and [[p:4]].'),[{equation:'61',page:11},{equation:null,page:4}]));
test('natural references and ranges',()=>{const r=parseReferences('Equation (60) on PDF page 11; Eqs. 57–58; p. 4');assert(r.some(x=>x.equation==='60'&&x.page===11));assert(r.some(x=>x.equation==='58'));assert(r.some(x=>x.page===4));});
test('manual overrides win',()=>assert.deepEqual(resolveReference({equation:'61',page:11},{61:[{page:11,y:.2}]},{61:{page:12,y:.4}},20),{page:12,y:.4,manual:true}));
test('ambiguous labels require page or manual selection',()=>{const index={6:[{page:1,y:.2},{page:3,y:.5}]};assert.equal(resolveReference({equation:'6'},index,{},4),null);assert.equal(resolveReference({equation:'6',page:3},index,{},4).y,.5);});
test('missing equation falls back only to valid pages',()=>{assert.equal(resolveReference({equation:'99',page:3},{},{},4).fallback,true);assert.equal(resolveReference({page:9},{},{},4),null);});
import {findMentions, tagOf, TOKEN, tokenRef} from '../src/references.js';
test('inline mentions keep their position', () => {
  const t = 'From Eq. (61) on page 11 and Eqs. 57–58, see p. 4. Equal weights 3.';
  const m = findMentions(t);
  assert.deepEqual(m.map(x => t.slice(x.index, x.index + x.length)), ['Eq. (61) on page 11', 'Eqs. 57–58', 'p. 4']);
  assert.deepEqual(m.map(x => x.ref), [{equation: '61', page: 11}, {equation: '57', page: null}, {equation: null, page: 4}]);
});
test('equation tags and tokens', () => {
  assert.equal(tagOf('\\dot r = K(p - \\hat p) \\tag{24}'), '24'); assert.equal(tagOf('x^2'), null);
  assert.deepEqual([...'a [[eq:6b|p:3]] b [[p:9]]'.matchAll(TOKEN)].map(m => tokenRef(...m.slice(1))), [{equation: '6b', page: 3}, {equation: null, page: 9}]);
});
import {QUOTE} from '../src/references.js';
test('quote tokens', () => {
  const m = [...'As stated, [[quote:7|the residual r is a filtered version of tau_ext]] holds.'.matchAll(QUOTE)];
  assert.equal(m.length, 1); assert.equal(m[0][1], undefined); assert.equal(m[0][2], '7'); assert.equal(m[0][3], 'the residual r is a filtered version of tau_ext');
});
import {ANCHOR, quoteRef, structuredRefs} from '../src/references.js';
test('cross-paper anchors carry the paper id; the old forms still parse', () => {
  const t = 'Adam [[cite:3fa9c2d1:2|estimates of lower-order moments]] vs [[cite:4|old style anchor words]], ' +
    '[[quote:ABCDEF12:7|exact words here]], [[p:3fa9c2d1:11]], [[eq:6b|p:3fa9c2d1:3]], [[eq:2|p:5]], [[p:9]].';
  assert.deepEqual(structuredRefs(t), [
    {page: 2, quote: 'estimates of lower-order moments', anchor: true, paper: '3fa9c2d1'},
    {page: 4, quote: 'old style anchor words', anchor: true},
    {page: 7, quote: 'exact words here', paper: 'abcdef12'},
    {equation: null, page: 11, paper: '3fa9c2d1'},
    {equation: '6b', page: 3, paper: '3fa9c2d1'},
    {equation: '2', page: 5},
    {equation: null, page: 9},
  ]);
  // Too-short ids are not paper ids, and a label in place of an id is left as text.
  assert.equal([...'[[cite:abc:4|some words here]] [[cite:Kingma 2015:4|some words here]]'.matchAll(ANCHOR)].length, 0);
  assert.deepEqual(quoteRef(undefined, '3', ' a  b\nc '), {page: 3, quote: 'a b c'});
});

test('quote and cite anchors may contain the paper\'s own [n] citation markers', async () => {
  const {QUOTE, ANCHOR} = await import('../src/references.js');
  const t = 'a [[quote:6aa729c7:2|caused by a collision [24], [25].]] b [[cite:3|see [12] here]] c [[quote:4|ends with [7]]] d';
  assert.deepEqual([...t.matchAll(QUOTE)].map(m => m[3]), ['caused by a collision [24], [25].', 'ends with [7]']);
  assert.deepEqual([...t.matchAll(ANCHOR)].map(m => m[3]), ['see [12] here']);
});
