import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {connectionText, composeHint, webTitle, searchNote, keyHint, settingsBody, savingText, providerOf} from '../src/providers.js';
import {KEY_ART, CLAUDE_KEY_ART, EXT_ART} from '../src/guides.js';

const status = (provider, openai, anthropic, extra = {}) => ({provider, configured: provider === 'anthropic' ? anthropic : openai,
  model: provider === 'anthropic' ? 'claude-opus-5-5' : 'gpt-6-astra', embeddings: openai ? 'openai' : 'keywords', proxyPrefix: '',
  providers: {openai: {configured: openai, keyHint: openai ? 'sk-…abcd' : '', model: 'gpt-6-astra'}, anthropic: {configured: anthropic, keyHint: anthropic ? 'sk-ant-…wxyz' : '', model: 'claude-opus-5-5'}}, ...extra});

test('provider: anything but anthropic (including an older server without the field) is OpenAI', () => {
  assert.equal(providerOf(status('anthropic', false, true)), 'anthropic');
  assert.equal(providerOf({configured: true, model: 'gpt-6-astra'}), 'openai');
  assert.equal(providerOf(null), 'openai');
});

test('header status names the selected provider', () => {
  assert.equal(connectionText(null), '○ Server offline');
  assert.equal(connectionText(status('openai', true, false)), '● Connected · OpenAI');
  assert.equal(connectionText(status('anthropic', true, true)), '● Connected · Claude');
  assert.equal(connectionText(status('anthropic', true, false)), '○ Anthropic API key needed');
});

test('composer hint says where data goes', () => {
  assert.match(composeHint(status('openai', true, false), false), /Paper text \+ this chat are sent to OpenAI\.$/);
  assert.match(composeHint(status('anthropic', false, true), false), /sent to Anthropic\.$/);
  assert.match(composeHint(status('anthropic', false, true), true), /sent to Anthropic\.$/); // keyword search: nothing to OpenAI
  assert.match(composeHint(status('anthropic', true, true), true), /sent to Anthropic; papers and questions also go to OpenAI for passage search\.$/);
  assert.match(composeHint(status('openai', true, true), true), /papers \+ this chat are sent to OpenAI\.$/);
  assert.doesNotMatch(webTitle(status('anthropic', true, true)), /OpenAI/);
  assert.match(webTitle(status('openai', true, false)), /OpenAI web search/);
});

test('search note only with Claude: keyword search without an OpenAI key', () => {
  assert.equal(searchNote('openai', status('openai', false, false)), null);
  assert.equal(searchNote('anthropic', status('anthropic', false, true)).kind, 'keywords');
  assert.match(searchNote('anthropic', status('openai', false, false)).text, /keyword search.*OpenAI key for semantic search \(embeddings billed to OpenAI\)/);
  assert.equal(searchNote('anthropic', status('anthropic', true, true)).kind, 'info');
  assert.match(keyHint(status('anthropic', false, true), 'anthropic'), /sk-ant-…wxyz/);
  assert.equal(keyHint(status('anthropic', false, true), 'openai'), 'No key saved yet.');
});

test('settings body sends only what changed, with per-provider fields', () => {
  const s = status('openai', true, false);
  assert.equal(settingsBody({status: s, selected: 'openai', model: 'gpt-6-astra', proxyPrefix: ''}), null);
  assert.deepEqual(settingsBody({status: s, selected: 'anthropic', keys: {anthropic: 'sk-ant-x'}, model: 'claude-opus-5-5', proxyPrefix: ''}), {anthropicKey: 'sk-ant-x', provider: 'anthropic'});
  assert.deepEqual(settingsBody({status: s, selected: 'anthropic', model: 'claude-sonnet-5-5'}), {provider: 'anthropic', anthropicModel: 'claude-sonnet-5-5'});
  assert.deepEqual(settingsBody({status: s, selected: 'openai', keys: {openai: 'sk-1', anthropic: ''}, model: 'gpt-x'}), {apiKey: 'sk-1', openaiModel: 'gpt-x'});
  assert.deepEqual(settingsBody({status: status('anthropic', false, true), selected: 'anthropic', keys: {openai: 'sk-2'}, model: ''}), {apiKey: 'sk-2'});
  assert.deepEqual(settingsBody({status: s, selected: 'openai', proxyPrefix: 'https://p/x?url='}), {proxyPrefix: 'https://p/x?url='});
  assert.equal(savingText({apiKey: 'a', anthropicKey: 'b'}), 'Checking the keys with OpenAI and Anthropic…');
  assert.equal(savingText({anthropicKey: 'b', provider: 'anthropic'}), 'Checking the key with Anthropic…');
  assert.equal(savingText({provider: 'anthropic'}), 'Saving…');
});

// Every animation in the guides has its keyframes, and every guide class styled in guides.css is drawn.
test('guides: animations resolve and styled shapes exist', () => {
  const css = readFileSync(new URL('../src/guides.css', import.meta.url), 'utf8');
  const frames = new Set([...css.matchAll(/@keyframes ([\w-]+)/g)].map(m => m[1]));
  for (const m of css.matchAll(/animation-name:([\w-]+)/g)) assert.ok(frames.has(m[1]), m[1]);
  const svg = KEY_ART + CLAUDE_KEY_ART + EXT_ART;
  for (const m of new Set([...css.matchAll(/\.((?:ant|key|ext)-[\w-]+)/g)].map(m => m[1]))) assert.match(svg, new RegExp(`class="[^"]*\\b${m}\\b`), m);
  assert.equal((CLAUDE_KEY_ART.match(/<g\b/g) || []).length, (CLAUDE_KEY_ART.match(/<\/g>/g) || []).length);
});
