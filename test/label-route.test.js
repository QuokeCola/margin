// End to end: "Label equations with AI" (POST /api/papers/:id/label-equations) and the equation-frame
// format of PATCH/GET /api/papers/:id, on a Margin server with temporary data, talking to a local fake
// OpenAI/Anthropic API (base URLs overridden), never to the real services.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const log = [];
let fake, server, dir, base, token, reply = '{"equations": []}', delay = 0;

function makePdf() { // one-page text PDF with a correct xref table
  const body = 'BT /F1 11 Tf 72 720 Td (x = A y + B u          \\(1\\)) Tj ET';
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [4 0 R] /Count 1 >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>',
    `<< /Length ${Buffer.byteLength(body)} >>\nstream\n${body}\nendstream`];
  let out = '%PDF-1.4\n';
  const offsets = objs.map((o, i) => { const at = Buffer.byteLength(out); out += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  return Buffer.from(out + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`, 'latin1');
}

// The fake answers every vision request with `reply` (the model's text) after `delay` ms.
function startFake() {
  return new Promise(resolve => {
    const s = http.createServer(async (req, res) => {
      let body = ''; for await (const c of req) body += c;
      const anthropic = !!req.headers['anthropic-version'], j = body ? JSON.parse(body) : {};
      const key = req.headers['x-api-key'] || String(req.headers.authorization || '').replace(/^Bearer /, '');
      const entry = {anthropic, path: req.url, beta: req.headers['anthropic-beta'] || null, key, body: j, aborted: false};
      log.push(entry); res.on('close', () => { if (!res.writableEnded) entry.aborted = true; });
      const send = (o, code = 200) => { if (res.destroyed) return; res.writeHead(code, {'content-type': 'application/json'}); res.end(JSON.stringify(o)); };
      if (key.includes('bad')) return send({type: 'error', error: {type: 'authentication_error', message: 'invalid key'}}, 401);
      if (req.url.startsWith('/v1/models')) return send(anthropic ? {data: [{type: 'model', id: 'claude-opus-5-5', display_name: 'Opus', created_at: '2026-09-01T00:00:00Z'}], has_more: false, first_id: null, last_id: null}
        : {object: 'list', data: [{id: 'gpt-6-astra', object: 'model', created: 1}]});
      await new Promise(r => setTimeout(r, delay));
      if (anthropic && req.url.startsWith('/v1/messages')) return send({id: 'msg', type: 'message', role: 'assistant', model: j.model, stop_reason: 'end_turn', stop_sequence: null,
        content: [{type: 'thinking', thinking: '', signature: 's'}, {type: 'text', text: reply}], usage: {input_tokens: 3000, output_tokens: 400, cache_read_input_tokens: 0, cache_creation_input_tokens: 0}});
      if (!anthropic && req.url.startsWith('/v1/responses')) return send({id: 'r', object: 'response', created_at: 1, status: 'completed', model: j.model,
        output: [{type: 'message', id: 'm', role: 'assistant', status: 'completed', content: [{type: 'output_text', text: reply, annotations: []}]}], usage: {input_tokens: 900, output_tokens: 300}});
      send({error: 'not found'}, 404);
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}
const freePort = () => new Promise(r => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

before(async () => {
  fake = await startFake();
  dir = await mkdtemp(join(tmpdir(), 'margin-label-'));
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
const IMG = 'data:image/png;base64,iVBORw0KGgo=';
const vision = () => log.filter(l => l.path.startsWith('/v1/messages') || l.path.startsWith('/v1/responses'));

test('label equations route and equation frames', async t => {
  const pid = (await call('POST', '/api/projects', {name: 'P'})).j.id;
  const paper = (await call('POST', `/api/projects/${pid}/papers`, makePdf(), {'content-type': 'application/pdf', 'x-filename': 'a.pdf'})).j;
  const label = body => call('POST', `/api/papers/${paper.id}/label-equations`, body);
  const ok = {page: 1, pages: 1, image: IMG, width: 1237, height: 1600};

  await t.test('without a key: 503, marked fatal; nothing sent', async () => {
    const r = await label(ok);
    assert.equal(r.status, 503); assert.equal(r.j.fatal, true);
    assert.equal(vision().length, 0);
  });

  await t.test('OpenAI: Responses API request with the page image and a strict JSON schema', async () => {
    assert.equal((await call('POST', '/api/settings', {apiKey: 'sk-test-openai-000000000000000000000000'})).status, 200);
    reply = '{"equations":[{"label":"(1)","box":{"x0":0.1,"y0":0.08,"x1":0.6,"y1":0.1}},{"label":"2a","box":{"x0":0.1,"y0":0.5,"x1":0.9,"y1":0.55}}]}';
    const r = await label(ok);
    assert.equal(r.status, 200);
    assert.deepEqual(r.j.equations, [{label: '1', box: {x0: 0.1, y0: 0.08, x1: 0.6, y1: 0.1}}, {label: '2a', box: {x0: 0.1, y0: 0.5, x1: 0.9, y1: 0.55}}]);
    assert.deepEqual(r.j.usage, {input: 900, output: 300, cacheRead: null, cacheWrite: null});
    assert.equal(r.j.provider, 'openai'); assert.equal(r.j.model, 'gpt-6-astra');
    const req = vision().at(-1);
    assert.equal(req.path, '/v1/responses'); assert.equal(req.key, 'sk-test-openai-000000000000000000000000');
    assert.equal(req.body.store, false); assert.equal(req.body.model, 'gpt-6-astra');
    assert.match(req.body.instructions, /untrusted/);
    assert.deepEqual(req.body.text.format.type, 'json_schema'); assert.equal(req.body.text.format.strict, true);
    assert.deepEqual(req.body.text.format.schema.required, ['equations']);
    const [txt, img] = req.body.input[0].content;
    assert.equal(txt.type, 'input_text'); assert.match(txt.text, /PDF page 1 of 1 .* 1237 x 1600 pixels/); assert.match(txt.text, /Only numbered display equations/);
    assert.deepEqual(img, {type: 'input_image', image_url: IMG, detail: 'high'});
    assert.ok(!('reasoning' in req.body), 'model default effort');
  });

  await t.test('Anthropic: Messages API request with an image block, JSON schema output and the fallback beta', async () => {
    assert.equal((await call('POST', '/api/settings', {provider: 'anthropic', anthropicKey: 'sk-ant-api03-test-000000000000000000000'})).status, 200);
    reply = 'Sure!\n```json\n{"equations": [{"label": "3", "box": [100, 200, 500, 300]}]}\n```';
    const r = await label({...ok, page: 1});
    assert.equal(r.status, 200);
    assert.deepEqual(r.j.equations, [{label: '3', box: {x0: 100 / 1237, y0: 0.125, x1: 500 / 1237, y1: 0.1875}}].map(e => ({...e, box: Object.fromEntries(Object.entries(e.box).map(([k, v]) => [k, Math.round(v * 1e5) / 1e5]))})), 'pixel coordinates of the image');
    assert.deepEqual(r.j.usage, {input: 3000, output: 400, cacheRead: 0, cacheWrite: 0});
    const req = vision().at(-1);
    assert.equal(req.path, '/v1/messages'); assert.equal(req.beta, 'server-side-fallback-2026-07-01'); assert.equal(req.body.fallbacks, 'default');
    assert.equal(req.body.model, 'claude-opus-5-5'); assert.equal(req.body.max_tokens, 16000);
    assert.match(req.body.system, /untrusted/);
    assert.deepEqual(req.body.output_config.format.type, 'json_schema');
    assert.ok(!('effort' in req.body.output_config));
    const [img, txt] = req.body.messages[0].content;
    assert.deepEqual(img, {type: 'image', source: {type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo='}});
    assert.equal(txt.type, 'text'); assert.match(txt.text, /without the parentheses/);
  });

  await t.test('answers that are not a list of equations: 502 with usage; junk entries dropped', async () => {
    reply = 'I cannot see any equations.';
    const r = await label(ok);
    assert.equal(r.status, 502); assert.match(r.j.error, /did not return a list/); assert.equal(r.j.usage.output, 400);
    reply = '[{"label": "Figure 2", "box": [0,0,1,1]}, {"label": "4", "box": [0.2, 0.3, 0.8, 0.35]}]';
    assert.deepEqual((await label(ok)).j.equations, [{label: '4', box: {x0: 0.2, y0: 0.3, x1: 0.8, y1: 0.35}}]);
  });

  await t.test('invalid requests are refused before anything is sent', async () => {
    const n = vision().length;
    for (const bad of [{...ok, page: 0}, {...ok, page: 2, pages: 1}, {...ok, image: 'data:image/gif;base64,AAAA'}, {...ok, image: 'x'.repeat(10)}, {...ok, width: 50}, {...ok, height: 1.5}])
      assert.equal((await label(bad)).status, 400, JSON.stringify(bad).slice(0, 80));
    assert.equal((await call('POST', `/api/papers/${'0'.repeat(64)}/label-equations`, ok)).status, 404);
    assert.equal(vision().length, n);
  });

  await t.test('a cancelled request is aborted upstream', async () => {
    delay = 400;
    const ac = new AbortController();
    const p = fetch(base + `/api/papers/${paper.id}/label-equations`, {method: 'POST', signal: ac.signal, headers: {'x-session-token': token, 'content-type': 'application/json'}, body: JSON.stringify(ok)}).catch(e => e.name);
    await new Promise(r => setTimeout(r, 150)); ac.abort();
    assert.equal(await p, 'AbortError');
    await new Promise(r => setTimeout(r, 450));
    assert.equal(vision().at(-1).aborted, true);
    delay = 0;
  });

  await t.test('frames: new format saved, old {page, y} converted, invalid refused, stored old ones migrated on read', async () => {
    const frames = {12: {page: 1, box: {x0: 0.1, y0: 0.2, x1: 0.9, y1: 0.25}, source: 'user', accepted: true}, 3: {page: 1, box: {x0: 0.1, y0: 0.3, x1: 0.9, y1: 0.35}, source: 'ai', accepted: false}, 7: {deleted: true, pages: [1]}};
    const r = await call('PATCH', `/api/papers/${paper.id}`, {overrides: frames});
    assert.equal(r.status, 200); assert.deepEqual(r.j.overrides, frames);
    const old = await call('PATCH', `/api/papers/${paper.id}`, {overrides: {61: {page: 1, y: 0.5}}});
    assert.deepEqual(old.j.overrides, {61: {page: 1, box: {x0: 0.04, y0: 0.47, x1: 0.96, y1: 0.54}, source: 'user', accepted: true}});
    for (const bad of [{1: {page: 1, box: {x0: 0.5, y0: 0, x1: 0.4, y1: 1}}}, {'bad label': {deleted: true}}, {1: {page: 1, y: 7}}, [1]])
      assert.equal((await call('PATCH', `/api/papers/${paper.id}`, {overrides: bad})).status, 400);
    const file = join(dir, 'data', 'papers', paper.id, 'paper.json');
    const stored = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(stored.overrides[61].box, {x0: 0.04, y0: 0.47, x1: 0.96, y1: 0.54});
    await writeFile(file, JSON.stringify({...stored, overrides: {9: {page: 1, y: 0.25}}}));
    assert.deepEqual((await call('GET', `/api/papers/${paper.id}`)).j.overrides, {9: {page: 1, box: {x0: 0.04, y0: 0.22, x1: 0.96, y1: 0.29}, source: 'user', accepted: true}});
  });
});
