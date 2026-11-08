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
  assert.deepEqual([...'a [[eq:6b|p:3]] b [[p:9]]'.matchAll(TOKEN)].map(m => tokenRef(m[1], m[2], m[3])), [{equation: '6b', page: 3}, {equation: null, page: 9}]);
});
import {QUOTE} from '../src/references.js';
test('quote tokens', () => {
  const m = [...'As stated, [[quote:7|the residual r is a filtered version of tau_ext]] holds.'.matchAll(QUOTE)];
  assert.equal(m.length, 1); assert.equal(m[0][1], '7'); assert.equal(m[0][2], 'the residual r is a filtered version of tau_ext');
});
