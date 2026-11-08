// End to end: a Margin server on a free port with temporary data and settings, talking to a local fake
// OpenAI/Anthropic API (base URLs overridden), never to the real services.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const log = [];
let fake, server, dir, base, token;

function makePdf(lines) { // one-page text PDF with a correct xref table
  const body = 'BT /F1 11 Tf 14 TL 72 720 Td ' + lines.map(l => `(${l}) Tj T*`).join(' ') + ' ET';
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [4 0 R] /Count 1 >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>',
    `<< /Length ${Buffer.byteLength(body)} >>\nstream\n${body}\nendstream`];
  let out = '%PDF-1.4\n';
  const offsets = objs.map((o, i) => { const at = Buffer.byteLength(out); out += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  return Buffer.from(out + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`, 'latin1');
}

// Fake API. Keys containing "bad" are rejected (401), "down" fail (500). The last user text picks the Claude
// behaviour: PAUSE (a paused web search turn, then the rest), REFUSE (refusal).
function startFake() {
  return new Promise(resolve => {
    const s = http.createServer(async (req, res) => {
      let body = ''; for await (const c of req) body += c;
      const anthropic = !!req.headers['anthropic-version'], j = body ? JSON.parse(body) : {};
      const key = req.headers['x-api-key'] || String(req.headers.authorization || '').replace(/^Bearer /, '');
      log.push({anthropic, path: req.url, beta: req.headers['anthropic-beta'] || null, key, body: j});
      const send = (o, code = 200) => { res.writeHead(code, {'content-type': 'application/json'}); res.end(JSON.stringify(o)); };
      if (key.includes('bad')) return send({type: 'error', error: {type: 'authentication_error', message: 'invalid key'}}, 401);
      if (key.includes('down')) return send({type: 'error', error: {type: 'api_error', message: 'down'}}, 500);
      if (anthropic && req.url.startsWith('/v1/models')) return send({data: [
        {type: 'model', id: 'claude-sonnet-5-5', display_name: 'Sonnet', created_at: '2026-08-01T00:00:00Z'},
        {type: 'model', id: 'claude-opus-5-5', display_name: 'Opus', created_at: '2026-09-01T00:00:00Z'}], has_more: false, first_id: null, last_id: null});
      if (anthropic && req.url.startsWith('/v1/messages')) {
        const last = j.messages.at(-1), lastText = Array.isArray(last.content) ? last.content.filter(b => b.type === 'text').map(b => b.text).join('') : String(last.content);
        const msg = (content, stop_reason) => send({id: 'msg', type: 'message', role: 'assistant', model: j.model, content, stop_reason, stop_sequence: null, usage: {input_tokens: 1, output_tokens: 1}});
        if (/REFUSE/.test(lastText)) return msg([], 'refusal');
        if (last.role === 'assistant') return msg([{type: 'text', text: 'resumed', citations: [{type: 'web_search_result_location', url: 'https://example.org/r', title: 'R', cited_text: 'c', encrypted_index: 'i'}]}], 'end_turn');
        if (/PAUSE/.test(lastText)) return msg([{type: 'text', text: 'first part, '}, {type: 'server_tool_use', id: 'srv', name: 'web_search', input: {query: 'q'}}], 'pause_turn');
        return msg([{type: 'thinking', thinking: '', signature: 's'}, {type: 'text', text: 'Claude answer'}], 'end_turn');
      }
      if (!anthropic && req.url.startsWith('/v1/models')) return send({object: 'list', data: [{id: 'gpt-6-astra', object: 'model', created: 1}]});
      if (!anthropic && req.url.startsWith('/v1/embeddings')) { const input = [].concat(j.input); return send({object: 'list', data: input.map((t, index) => ({object: 'embedding', index, embedding: [1, t.length % 7, 0.5]}))}); }
      if (!anthropic && req.url.startsWith('/v1/responses')) return send({id: 'r', object: 'response', created_at: 1, status: 'completed', model: j.model,
        output: [{type: 'message', id: 'm', role: 'assistant', status: 'completed', content: [{type: 'output_text', text: 'OpenAI answer', annotations: []}]}]});
      send({error: 'not found'}, 404);
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}
const freePort = () => new Promise(r => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

before(async () => {
  fake = await startFake();
  dir = await mkdtemp(join(tmpdir(), 'margin-providers-'));
  const port = await freePort(), fakeUrl = `http://127.0.0.1:${fake.address().port}`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(OPENAI_|ANTHROPIC_|PROVIDER$|MARGIN_)/.test(k)));
  Object.assign(env, {PORT: String(port), MARGIN_PRODUCTION: '1', MARGIN_DATA_DIR: join(dir, 'data'), MARGIN_ENV_FILE: join(dir, 'settings.env'),
    OPENAI_BASE_URL: fakeUrl + '/v1', ANTHROPIC_BASE_URL: fakeUrl});
  server = spawn(process.execPath, ['server.mjs', '--production'], {cwd: root, env, stdio: ['ignore', 'pipe', 'inherit']});
  await new Promise((resolve, reject) => { server.stdout.on('data', d => { if (String(d).includes('Margin:')) resolve(); }); server.on('exit', reject); });
  base = `http://127.0.0.1:${port}`;
  token = (await (await fetch(base + '/api/status')).json()).token;
});
after(async () => { server?.kill(); fake?.close(); if (dir) await rm(dir, {recursive: true, force: true}); });

async function call(method, path, body, headers = {}) {
  const r = await fetch(base + path, {method, headers: {'x-session-token': token, ...(body && !Buffer.isBuffer(body) ? {'content-type': 'application/json'} : {}), ...headers},
    body: body ? (Buffer.isBuffer(body) ? body : JSON.stringify(body)) : undefined});
  return {status: r.status, j: await r.json().catch(() => null)};
}
const settings = body => call('POST', '/api/settings', body);
const messages = () => log.filter(l => l.anthropic && l.path.startsWith('/v1/messages'));
const OKEY = 'sk-ant-api03-good-000000000000000000000';

test('provider settings, models and answers', async t => {
  await t.test('defaults to OpenAI, nothing configured', async () => {
    const s = await (await fetch(base + '/api/status')).json();
    assert.equal(s.provider, 'openai'); assert.equal(s.configured, false); assert.equal(s.model, 'gpt-6-astra');
    assert.deepEqual(s.providers.anthropic, {configured: false, keyHint: null, model: 'claude-opus-5-5'});
    assert.equal(s.embeddings, 'keywords');
  });

  await t.test('Anthropic key validation', async () => {
    assert.equal((await settings({anthropicKey: 'sk-proj-notanthropic-0000000000000'})).status, 400);
    const bad = await settings({anthropicKey: 'sk-ant-bad-00000000000000000000000'});
    assert.equal(bad.status, 400); assert.match(bad.j.error, /Anthropic rejected/);
    assert.equal((await settings({provider: 'anthropic'})).status, 400, 'no Claude key saved yet');
    assert.equal((await settings({provider: 'gemini', anthropicKey: OKEY})).status, 400);
    assert.equal((await settings({provider: 'anthropic', anthropicKey: OKEY, model: 'gpt-6-astra'})).status, 400, 'not a Claude model id');
    assert.equal(await readFile(join(dir, 'settings.env'), 'utf8').catch(() => ''), '', 'nothing saved by failed requests');
    const ok = await settings({provider: 'anthropic', anthropicKey: OKEY, model: 'claude-sonnet-5-5'});
    assert.equal(ok.status, 200);
    assert.equal(ok.j.provider, 'anthropic'); assert.equal(ok.j.configured, true); assert.equal(ok.j.model, 'claude-sonnet-5-5');
    assert.equal(ok.j.keyHint, 'sk-…0000'); assert.equal(ok.j.providers.openai.configured, false);
    assert.equal(await readFile(join(dir, 'settings.env'), 'utf8'), `ANTHROPIC_API_KEY=${OKEY}\nPROVIDER=anthropic\nANTHROPIC_MODEL=claude-sonnet-5-5\n`);
    assert.equal(log.filter(l => l.anthropic && l.path.startsWith('/v1/models') && l.key === OKEY).length, 1);
  });

  await t.test('model lists', async () => {
    const m = await call('GET', '/api/models');
    assert.deepEqual(m.j, {provider: 'anthropic', models: ['claude-opus-5-5', 'claude-sonnet-5-5'], current: 'claude-sonnet-5-5'});
    assert.equal((await call('GET', '/api/models?provider=openai')).status, 503);
    assert.equal((await call('GET', '/api/models?provider=x')).status, 400);
  });

  let pid, paperChat, projectChat, paperId;
  await t.test('paper chat with Claude', async () => {
    pid = (await call('POST', '/api/projects', {name: 'P'})).j.id;
    const paper = (await call('POST', `/api/projects/${pid}/papers`, makePdf(['Momentum observers detect collisions in robot arms.', 'Friction is modelled as viscous.']), {'content-type': 'application/pdf', 'x-filename': 'a.pdf'})).j;
    paperId = paper.id;
    paperChat = (await call('POST', `/api/projects/${pid}/chats`, {paperId: paper.id})).j.id;
    const pages = [{page: 1, text: 'Momentum observers detect collisions in robot arms.'}];
    const r = await call('POST', `/api/projects/${pid}/chats/${paperChat}/messages`, {question: 'What is detected?', pages});
    assert.equal(r.status, 200);
    assert.equal(r.j.messages[1].content, 'Claude answer'); assert.equal(r.j.messages[1].model, 'claude-sonnet-5-5');
    assert(!('sources' in r.j.messages[1]));
    const req = messages().at(-1);
    assert.equal(req.path, '/v1/messages'); assert(!('betas' in req.body)); assert.equal(req.beta, 'server-side-fallback-2026-07-01'); assert.equal(req.key, OKEY);
    assert.equal(req.body.model, 'claude-sonnet-5-5'); assert.equal(req.body.fallbacks, 'default');
    assert.match(req.body.system[0].text, /^You are a careful robotics paper tutor/);
    assert.equal(req.body.messages[0].content[0].text, 'SOURCE DOCUMENT\n[PDF PAGE 1]\nMomentum observers detect collisions in robot arms.');
    assert.deepEqual(req.body.messages[0].content[0].cache_control, {type: 'ephemeral'});

    const img = 'data:image/png;base64,iVBORw0KGgo=';
    const r2 = await call('POST', `/api/projects/${pid}/chats/${paperChat}/messages`, {question: 'And this? PAUSE', pages, image: img, web: true});
    assert.equal(r2.status, 200);
    assert.equal(r2.j.messages[1].content, 'first part, resumed');
    assert.deepEqual(r2.j.messages[1].sources, [{url: 'https://example.org/r', title: 'R'}]);
    const [first, resumed] = messages().slice(-2);
    assert.match(first.body.system[0].text, /WEB SEARCH/);
    assert.deepEqual(first.body.tools, [{type: 'web_search_20260209', name: 'web_search', max_uses: 5}]);
    assert.deepEqual(first.body.messages.slice(1).map(m => m.role), ['user', 'assistant', 'user']);
    assert.deepEqual(first.body.messages[2], {role: 'assistant', content: 'Claude answer'});
    assert.deepEqual(first.body.messages[3].content[0], {type: 'image', source: {type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo='}});
    assert.equal(resumed.body.messages.length, first.body.messages.length + 1);
    assert.equal(resumed.body.messages.at(-1).role, 'assistant');

    const r3 = await call('POST', `/api/projects/${pid}/chats/${paperChat}/messages`, {question: 'REFUSE', pages});
    assert.equal(r3.status, 502); assert.match(r3.j.error, /declined/);
  });

  await t.test('paper chat: equation index and crops in the cached block; later changes as updates', async () => {
    const chat = (await call('POST', `/api/projects/${pid}/chats`, {paperId})).j.id;
    const pages = [{page: 1, text: 'Momentum observers detect collisions in robot arms.'}];
    const IMG = n => 'data:image/png;base64,iVBORw0KGgo' + 'A'.repeat(n) + '=';
    const eqs = [{label: '1', page: 1, box: {x0: 0.1, y0: 0.2, x1: 0.9, y1: 0.25}, text: 'r = K ( p − p̂ ) (1)'},
      {label: '2', page: 1, box: {x0: 0.1, y0: 0.3, x1: 0.9, y1: 0.35}, text: '', image: IMG(4)}];
    const ask = (question, equations) => call('POST', `/api/projects/${pid}/chats/${chat}/messages`, {question, pages, equations});
    assert.equal((await ask('Eq?', [{...eqs[0], label: 'x y'}])).status, 400, 'bad label');
    assert.equal((await ask('Eq?', [{...eqs[0], box: {x0: 0.5, y0: 0, x1: 0.2, y1: 1}}])).status, 400, 'bad box');
    assert.equal((await ask('Eq?', [{...eqs[0], page: 2}])).status, 400, 'page beyond the document');
    assert.equal((await ask('Eq?', [{...eqs[1], image: 'data:image/gif;base64,AAAA'}])).status, 400, 'bad image');
    assert.equal((await ask('Eq?', Array(401).fill(eqs[0]))).status, 400, 'too many entries');
    assert.equal((await ask('Explain Eq. 2', eqs)).status, 200);
    const one = messages().at(-1).body, src = one.messages[0].content;
    assert.equal(src[0].text, 'SOURCE DOCUMENT\n[PDF PAGE 1]\nMomentum observers detect collisions in robot arms.\n\n' +
      'EQUATION INDEX (the numbered equations of this paper as framed in the reader: found automatically, framed by the user, or labelled with AI and accepted; this list is authoritative for equation numbers and their pages. Text is what the PDF text layer holds inside each frame, which often garbles maths; where an image is attached it shows the equation as printed.)\n' +
      'Eq. (1) · page 1 · text: "r = K ( p − p̂ )"\nEq. (2) · page 1 · image attached');
    assert.deepEqual(src.slice(1), [{type: 'text', text: 'Image of Eq. (2) · page 1'}, {type: 'image', source: {type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoAAAA='}, cache_control: {type: 'ephemeral'}}]);
    assert.match(one.system[0].text, /EQUATION INDEX after the paper text is the authoritative list/);
    assert.match(one.system[0].text, /NOTATION\. Unless the user asks for different notation, use the paper.s exact notation[^]*take the notation from the attached equation images/);
    // An unchanged list: the same block, byte for byte.
    assert.equal((await ask('And then?', eqs)).status, 200);
    const two = messages().at(-1).body;
    assert.equal(JSON.stringify(two.messages[0]), JSON.stringify(one.messages[0]));
    assert.equal(JSON.stringify(two.messages.at(-1).content), JSON.stringify([{type: 'text', text: 'And then?', cache_control: {type: 'ephemeral'}}]));
    // A new poor-text equation: the block stays, the change goes with the question, with its image.
    const eqs3 = [...eqs, {label: '3', page: 1, box: {x0: 0.1, y0: 0.4, x1: 0.9, y1: 0.45}, text: '', image: IMG(8)}];
    assert.equal((await ask('What about (3)?', eqs3)).status, 200);
    const three = messages().at(-1).body, last = three.messages.at(-1).content;
    assert.equal(JSON.stringify(three.messages[0]), JSON.stringify(one.messages[0]));
    assert.deepEqual(last.map(b => b.type), ['text', 'image', 'text']);
    assert.equal(last[0].text, 'Image of Eq. (3) · page 1');
    assert.match(last[2].text, /^EQUATION UPDATES SINCE YOUR LAST ANSWER .*\nAdded: Eq\. \(3\) · page 1 · image attached\n\nWhat about \(3\)\?$/s);
    // Next turn: the update stays in the history as text (no image), the block is still the same.
    assert.equal((await ask('Thanks', eqs3)).status, 200);
    const four = messages().at(-1).body;
    assert.equal(JSON.stringify(four.messages[0]), JSON.stringify(one.messages[0]));
    assert.match(four.messages.at(-2 - 1).content, /^EQUATION UPDATES SINCE YOUR LAST ANSWER[^]*What about \(3\)\?$/);
    assert.equal(four.messages.at(-1).content.length, 1);
    // The chat as the app reads it: no equation state, the user message keeps its update.
    const c = (await call('GET', `/api/projects/${pid}/chats/${chat}`)).j;
    assert(!('eq' in c)); assert.match(c.messages[4].eqUpdate, /Added: Eq\. \(3\)/); assert.equal(c.messages[4].content, 'What about (3)?');
    // Many entries changed (at least REBUILD_MIN, more than a quarter): the block is rebuilt with the current list.
    const moved = [10, 11, 12, 13, 14, 15].map((n, i) => ({label: String(n), page: 1, box: {x0: 0.1, y0: 0.1 * i, x1: 0.9, y1: 0.1 * i + 0.05}, text: 'x + y = z + w(t)'}));
    assert.equal((await ask('Rebuilt?', moved)).status, 200);
    const five = messages().at(-1).body;
    assert.notEqual(JSON.stringify(five.messages[0]), JSON.stringify(one.messages[0]));
    assert.match(five.messages[0].content[0].text, /\nEq\. \(10\) · page 1 · text: "x \+ y = z \+ w\(t\)"\n/);
    assert(!five.messages[0].content[0].text.includes('Eq. (3)'));
    assert.equal(five.messages.at(-1).content[0].text, 'Rebuilt?');
  });

  await t.test('project chat with Claude only uses keyword search', async () => {
    projectChat = (await call('POST', `/api/projects/${pid}/chats`, {scope: 'project'})).j.id;
    const r = await call('POST', `/api/projects/${pid}/chats/${projectChat}/messages`, {question: 'How are collisions detected?'});
    assert.equal(r.status, 200);
    assert.equal(r.j.messages[1].retrieval.mode, 'keywords'); assert(r.j.messages[1].retrieval.passages >= 1);
    assert.equal(log.filter(l => l.path.startsWith('/v1/embeddings')).length, 0);
    const req = messages().at(-1);
    assert.match(req.body.system[0].text, /^You are a careful robotics research tutor/);
    assert.deepEqual(req.body.system[0].cache_control, {type: 'ephemeral'});
    assert.match(req.body.system[0].text, /NOTATION\.[^]*name each paper.s symbol and keep each paper.s notation/);
    assert.match(req.body.messages[0].content[0].text, /Momentum observers detect collisions/);
    assert(!JSON.stringify(req.body.messages).includes('cache_control'));
    assert(!req.body.messages[0].content[0].text.includes('EQUATION INDEX'), 'no equations framed yet');
  });

  await t.test('project chat: equations of the retrieved pages, crops rendered by the server', async () => {
    // A frame over the first line of the paper (prose, no formula: its text cannot stand in for the equation).
    assert.equal((await call('PATCH', `/api/papers/${paperId}`, {overrides: {'5': {page: 1, box: {x0: 0.1, y0: 0.07, x1: 0.8, y1: 0.1}, source: 'user'}}})).status, 200);
    const r = await call('POST', `/api/projects/${pid}/chats/${projectChat}/messages`, {question: 'How are collisions detected?'});
    assert.equal(r.status, 200);
    const src = messages().at(-1).body.messages[0].content;
    assert.match(src[0].text, /\n\nEQUATION INDEX \(per paper[^\n]*\n\n\[paper [0-9a-f]{8} · [^\]]+\]\nEq\. \(5\) · page 1 · image attached$/);
    assert.equal(src[1].text.startsWith('Image of Eq. (5) · page 1 of paper '), true);
    assert.equal(src[2].type, 'image'); assert.equal(src[2].source.media_type, 'image/png');
    const png = Buffer.from(src[2].source.data, 'base64');
    assert.equal(png.readUInt32BE(16), 800 + 12, 'the frame at 800 px plus the padding');
    assert(!JSON.stringify(src).includes('cache_control'));
  });

  await t.test('adding an OpenAI key brings embeddings back while Claude answers', async () => {
    const s = await settings({apiKey: 'sk-test-openai-000000000000000000'});
    assert.equal(s.j.provider, 'anthropic'); assert.equal(s.j.embeddings, 'openai'); assert.equal(s.j.providers.openai.configured, true);
    const r = await call('POST', `/api/projects/${pid}/chats/${projectChat}/messages`, {question: 'And friction?'});
    assert.equal(r.j.messages[1].retrieval.mode, 'embeddings'); assert.equal(r.j.messages[1].content, 'Claude answer');
    assert(log.some(l => l.path.startsWith('/v1/embeddings')));
  });

  await t.test('switching back to OpenAI', async () => {
    const s = await settings({provider: 'openai'});
    assert.equal(s.j.provider, 'openai'); assert.equal(s.j.model, 'gpt-6-astra');
    const r = await call('POST', `/api/projects/${pid}/chats/${paperChat}/messages`, {question: 'Again?', pages: [{page: 1, text: 'x'}]});
    assert.equal(r.j.messages[1].content, 'OpenAI answer'); assert.equal(r.j.messages[1].model, 'gpt-6-astra');
    const req = log.filter(l => l.path === '/v1/responses').at(-1);
    assert.deepEqual(Object.keys(req.body), ['model', 'store', 'max_output_tokens', 'instructions', 'input']);
  });

  await t.test('unreachable model list falls back to a fixed Claude list; key saved anyway', async () => {
    const s = await settings({anthropicKey: 'sk-ant-down-000000000000000000000'});
    assert.equal(s.status, 200); assert.equal(s.j.providers.anthropic.keyHint, 'sk-…0000');
    const m = await call('GET', '/api/models?provider=anthropic');
    assert.equal(m.status, 200); assert.equal(m.j.fallback, true); assert(m.j.models.includes('claude-opus-5-5'));
  });
});
