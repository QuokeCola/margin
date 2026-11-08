import {test} from 'node:test';
import assert from 'node:assert/strict';
import {providerOf, modelOf, openaiRequest, openaiSources, anthropicRequest, anthropicResult, webSearchTool, ANTHROPIC_KEY_PATTERN, FALLBACK_BETA} from '../lib/llm.mjs';

const IMG = 'data:image/png;base64,iVBORw0KGgo=';
const base = {model: 'claude-opus-5-5', instructions: 'INSTR', source: 'SOURCE DOCUMENT\n[PDF PAGE 1]\nx', question: 'Why?',
  history: [{role: 'user', content: 'q1'}, {role: 'assistant', content: 'a1'}]};

test('provider and model selection', () => {
  assert.equal(providerOf({}), 'openai');
  assert.equal(providerOf({PROVIDER: 'anthropic'}), 'anthropic');
  assert.equal(providerOf({PROVIDER: 'other'}), 'openai');
  assert.equal(modelOf('openai', {}), 'gpt-6-astra');
  assert.equal(modelOf('anthropic', {}), 'claude-opus-5-5');
  assert.equal(modelOf('anthropic', {ANTHROPIC_MODEL: 'claude-sonnet-5-5', OPENAI_MODEL: 'gpt-x'}), 'claude-sonnet-5-5');
  assert(ANTHROPIC_KEY_PATTERN.test('sk-ant-api03-AbC_d-1234567890123456') && !ANTHROPIC_KEY_PATTERN.test('sk-proj-AbC_d-1234567890123456'));
});

test('OpenAI request is the Responses API body sent before providers existed', () => {
  const o = {...base, model: 'gpt-6-astra', web: true, image: IMG};
  assert.deepEqual(JSON.stringify(openaiRequest(o)), JSON.stringify({model: 'gpt-6-astra', store: false, max_output_tokens: 8000, instructions: 'INSTR',
    tools: [{type: 'web_search'}], input: [{role: 'user', content: o.source}, ...o.history, {role: 'user', content: [{type: 'input_text', text: 'Why?'}, {type: 'input_image', image_url: IMG, detail: 'high'}]}]}));
  const plain = openaiRequest({...o, web: false, image: undefined});
  assert.equal(plain.max_output_tokens, 5000); assert(!('tools' in plain)); assert.equal(plain.input.at(-1).content, 'Why?');
  assert.deepEqual(openaiSources({output: [{type: 'message', content: [{annotations: [{type: 'url_citation', url: 'https://a.org', title: 'A'}, {type: 'url_citation', url: 'https://a.org', title: 'A'}, {type: 'url_citation', url: 'javascript:x'}]}]}]}), [{url: 'https://a.org', title: 'A'}]);
});

test('Anthropic request: system prompt, history roles, image, caching for a paper chat', () => {
  const r = anthropicRequest({...base, image: IMG});
  assert.deepEqual(r.system, [{type: 'text', text: 'INSTR'}]);
  assert.equal(r.max_tokens, 16000);
  assert(!('tools' in r));
  assert.deepEqual(r.messages[0], {role: 'user', content: [{type: 'text', text: base.source, cache_control: {type: 'ephemeral'}}]});
  assert.deepEqual(r.messages.slice(1, 3), [{role: 'user', content: 'q1'}, {role: 'assistant', content: 'a1'}]);
  assert.deepEqual(r.messages[3], {role: 'user', content: [{type: 'image', source: {type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo='}}, {type: 'text', text: 'Why?', cache_control: {type: 'ephemeral'}}]});
  assert.deepEqual(r.betas, [FALLBACK_BETA]); assert.equal(r.fallbacks, 'default');
  const breakpoints = JSON.stringify(r).split('cache_control').length - 1;
  assert.equal(breakpoints, 2);
});

test('Anthropic request: project chat caches only the instructions; web tool per model', () => {
  const r = anthropicRequest({...base, cache: 'system', web: true, model: 'claude-haiku-5-5'});
  assert.deepEqual(r.system, [{type: 'text', text: 'INSTR', cache_control: {type: 'ephemeral'}}]);
  assert.equal(JSON.stringify(r.messages).includes('cache_control'), false);
  assert.deepEqual(r.tools, [{type: 'web_search_20250305', name: 'web_search', max_uses: 5}]);
  assert(!('fallbacks' in r) && !('betas' in r));
  for (const m of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-opus-4-8', 'claude-sonnet-4-6']) assert.equal(webSearchTool(m).type, 'web_search_20260209', m);
  for (const m of ['claude-haiku-5-5', 'claude-haiku-4-5', 'claude-fable-5-1', 'claude-opus-4-5']) assert.equal(webSearchTool(m).type, 'web_search_20250305', m);
  assert.throws(() => anthropicRequest({...base, image: 'data:image/gif;base64,AAAA'}));
});

test('Anthropic result: text, web sources and usage across a paused turn', () => {
  const r = anthropicResult([
    {model: 'claude-opus-5-5', stop_reason: 'pause_turn', usage: {input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 0},
      content: [{type: 'thinking', thinking: ''}, {type: 'text', text: 'Hello '}, {type: 'server_tool_use', id: 's', name: 'web_search', input: {}},
        {type: 'web_search_tool_result', tool_use_id: 's', content: [{type: 'web_search_result', url: 'https://unused.org', title: 'U'}]}]},
    {model: 'claude-opus-5-5', stop_reason: 'end_turn', usage: {input_tokens: 5, output_tokens: 3, cache_creation_input_tokens: 7},
      content: [{type: 'text', text: 'world', citations: [{type: 'web_search_result_location', url: 'https://a.org/x', title: 'A', cited_text: 'c'},
        {type: 'web_search_result_location', url: 'https://a.org/x', title: 'A'}, {type: 'web_search_result_location', url: 'ftp://b'}]}, {type: 'text', text: '.'}]},
  ]);
  assert.equal(r.text, 'Hello world.');
  assert.deepEqual(r.sources, [{url: 'https://a.org/x', title: 'A'}]);
  assert.deepEqual(r.usage, {input: 15, output: 5, cacheRead: 100, cacheWrite: 7});
  assert.equal(r.stopReason, 'end_turn');
  assert.equal(anthropicResult([{content: [{type: 'text', text: '  '}]}]).text, '');
});
