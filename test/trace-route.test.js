// End to end: POST /api/papers/:id/trace-citation on a Margin server with temporary data, talking to a local
// fake OpenAI/Anthropic API (base URLs overridden; chat and embedding requests), never to the real services.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {TRACE, TRACE_V} from '../lib/citation-trace.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const log = [];
let fake, server, dir, base, token, reply = '', delay = 0, embedFails = false;

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
// A made-up embedding: word counts hashed into 16 numbers.
function vec(text) {
  const v = new Float32Array(16);
  for (const w of String(text).toLowerCase().match(/[a-z]+/g) || []) { let k = 0; for (const c of w) k = (k * 31 + c.charCodeAt(0)) % 16; v[k] += 1; }
  return v;
}

// The fake answers chat requests with `reply` after `delay` ms and embedding requests with vec(); keys containing "bad" are rejected.
function startFake() {
  return new Promise(resolve => {
    const s = http.createServer(async (req, res) => {
      let body = ''; for await (const c of req) body += c;
      const anthropic = !!req.headers['anthropic-version'], j = body ? JSON.parse(body) : {};
      const key = req.headers['x-api-key'] || String(req.headers.authorization || '').replace(/^Bearer /, '');
      const entry = {anthropic, path: req.url, key, body: j, aborted: false};
      log.push(entry); res.on('close', () => { if (!res.writableEnded) entry.aborted = true; });
      const send = (o, code = 200) => { if (res.destroyed) return; res.writeHead(code, {'content-type': 'application/json'}); res.end(JSON.stringify(o)); };
      if (key.includes('bad')) return send({type: 'error', error: {type: 'authentication_error', message: 'invalid key'}}, 401);
      if (req.url.startsWith('/v1/models')) return send(anthropic ? {data: [{type: 'model', id: 'claude-opus-5-5', display_name: 'Opus', created_at: '2026-09-01T00:00:00Z'}], has_more: false, first_id: null, last_id: null}
        : {object: 'list', data: [{id: 'gpt-6-astra', object: 'model', created: 1}]});
      if (req.url.startsWith('/v1/embeddings')) {
        if (embedFails) return send({error: {message: 'no embeddings today'}}, 400);
        const inputs = Array.isArray(j.input) ? j.input : [j.input];
        return send({object: 'list', model: j.model, usage: {prompt_tokens: 1, total_tokens: 1}, data: inputs.map((t, index) => {
          const v = vec(t); return {object: 'embedding', index, embedding: j.encoding_format === 'base64' ? Buffer.from(v.buffer).toString('base64') : [...v]};
        })});
      }
      await new Promise(r => setTimeout(r, delay));
      if (anthropic && req.url.startsWith('/v1/messages')) return send({id: 'msg', type: 'message', role: 'assistant', model: j.model, stop_reason: 'end_turn', stop_sequence: null,
        content: [{type: 'text', text: reply}], usage: {input_tokens: 10, output_tokens: 5}});
      if (!anthropic && req.url.startsWith('/v1/responses')) return send({id: 'r', object: 'response', created_at: 1, status: 'completed', model: j.model,
        output: [{type: 'message', id: 'm', role: 'assistant', status: 'completed', content: [{type: 'output_text', text: reply, annotations: []}]}], usage: {input_tokens: 10, output_tokens: 5}});
      send({error: 'not found'}, 404);
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}
const freePort = () => new Promise(r => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

before(async () => {
  fake = await startFake();
  dir = await mkdtemp(join(tmpdir(), 'margin-trace-'));
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
const asked = () => log.filter(l => l.path.startsWith('/v1/messages') || l.path.startsWith('/v1/responses'));
const embedded = () => log.filter(l => l.path.startsWith('/v1/embeddings'));
const answer = (status, quotes = [], note = 'A note.') => JSON.stringify({status, quotes, note});

const CITED = ['The momentum observer residual converges to the external', 'torque. Its gain K sets the band-', 'width of the filtered estimate.', 'No acceleration measurement is needed for collision detection.',
  'The detection threshold is tuned by hand on the real robot.'];
const REAL = 'Its gain K sets the bandwidth of the filtered estimate.'; // the paper has it hyphenated over a line break
const S1 = 'The bandwidth of the estimate is set by the observer gain [3].';

test('trace-citation route', async t => {
  const pid = (await call('POST', '/api/projects', {name: 'P'})).j.id;
  const add = async (lines, name) => (await call('POST', `/api/projects/${pid}/papers`, makePdf(lines), {'content-type': 'application/pdf', 'x-filename': name})).j;
  const citing = await add(['Collisions are detected with a momentum observer [3].', S1], 'citing.pdf');
  const cited = await add(CITED, 'Momentum observers.pdf');
  const T = `/api/papers/${citing.id}/trace-citation`;
  const cacheFile = join(dir, 'data', 'papers', citing.id, 'citation-sources.json');
  const cache = async () => JSON.parse(await readFile(cacheFile, 'utf8').catch(() => 'null'));

  await t.test('validation', async () => {
    for (const body of [{}, {targetId: 'nope', sentence: S1}, {targetId: cited.id}, {targetId: cited.id, sentence: 'Too short'}, {targetId: cited.id, sentence: 'x'.repeat(1001)}, {targetId: cited.id, sentence: S1, refNum: 0}, {targetId: cited.id, sentence: S1, refNum: '3'}]) {
      const r = await call('POST', T, body);
      assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80)); assert.equal(typeof r.j.error, 'string');
    }
    assert.equal((await call('POST', '/api/papers/nope/trace-citation', {targetId: cited.id, sentence: S1})).status, 400);
    assert.equal((await call('POST', `/api/papers/${'0'.repeat(64)}/trace-citation`, {targetId: cited.id, sentence: S1})).status, 404);
    const gone = await call('POST', T, {targetId: '0'.repeat(64), sentence: S1});
    assert.equal(gone.status, 404); assert.match(gone.j.error, /cited paper/);
    assert.equal((await fetch(base + T, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({targetId: cited.id, sentence: S1})})).status, 403, 'needs the session token');
    assert.equal(asked().length + embedded().length, 0);
  });

  await t.test('no API key: the closest passages by keywords, marked unverified, nothing asked or saved', async () => {
    const r = await call('POST', T, {targetId: cited.id, refNum: 3, sentence: S1, context: {before: 'Collisions are detected with a momentum observer [3].', after: ''}});
    assert.equal(r.status, 200);
    assert.deepEqual({...r.j, matches: 0, note: 0}, {status: 'unverified', note: 0, reason: 'no-key', quotes: [], matches: 0, verified: false, cached: false, mode: 'keywords', target: {id: cited.id, title: 'Momentum observers'}});
    assert.match(r.j.note, /API key in Settings/);
    assert.ok(r.j.matches.length >= 1 && r.j.matches.length <= TRACE.matches);
    assert.deepEqual(r.j.matches[0], {page: 1, text: 'The momentum observer residual converges to the external torque. Its gain K sets the bandwidth of the filtered estimate. No acceleration measurement is needed for collision detection. The detection threshold is tuned by hand on the real robot.'});
    assert.equal(asked().length + embedded().length, 0); assert.equal(await cache(), null);
  });

  await t.test('found: the verbatim quote is kept, the invented one dropped; the request is small; a second click is free; Retry asks again', async () => {
    assert.equal((await call('POST', '/api/settings', {apiKey: 'sk-test-openai-000000000000000000000000'})).status, 200);
    reply = answer('found', [{page: 1, quote: 'The observer is provably optimal for every robot.'}, {page: 4, quote: REAL}], 'The cited paper states that K sets the bandwidth.');
    const body = {targetId: cited.id, refNum: 3, sentence: S1, context: {before: 'Collisions are detected with a momentum observer [3].', after: 'After it.'}};
    const r = await call('POST', T, body);
    assert.equal(r.status, 200);
    assert.ok(!Number.isNaN(Date.parse(r.j.at)));
    assert.deepEqual({...r.j, at: 0}, {status: 'found', note: 'The cited paper states that K sets the bandwidth.', quotes: [{page: 1, quote: REAL}], mode: 'embeddings', model: 'gpt-6-astra', at: 0, verified: true, cached: false, target: {id: cited.id, title: 'Momentum observers'}});
    assert.equal(embedded().length, 2, 'the cited paper\'s passages once, then the sentence');
    assert.equal(embedded()[0].body.model, 'text-embedding-3-small');
    assert.equal(embedded()[1].body.input, 'Collisions are detected with a momentum observer . The bandwidth of the estimate is set by the observer gain .');
    const req = asked().at(-1);
    assert.equal(asked().length, 1); assert.equal(req.path, '/v1/responses'); assert.equal(req.body.model, 'gpt-6-astra'); assert.equal(req.body.store, false);
    assert.equal(req.body.max_output_tokens, TRACE.maxTokens); assert.ok(!('tools' in req.body));
    assert.match(req.body.instructions, /trace citations/); assert.match(req.body.instructions, /untrusted/); assert.match(req.body.instructions, /character for character/);
    const [source, question] = req.body.input.map(m => m.content);
    assert.equal(req.body.input.length, 2);
    assert.match(source, /^CITED PAPER\nTitle: Momentum observers\nFirst page \(no abstract on record\): The momentum observer/);
    assert.match(source, /\[PDF PAGE 1\]\nThe momentum observer residual converges to the external torque\. Its gain K sets the bandwidth/);
    assert.match(question, /^CITING SENTENCE \(the cited paper is reference \[3\] there\)\nThe bandwidth of the estimate is set by the observer gain \[3\]\.\n\nThe sentence before it:\nCollisions are detected with a momentum observer \[3\]\.\n\nThe sentence after it:\nAfter it\./);
    assert.ok(source.length + question.length + req.body.instructions.length < 12000, 'a small prompt');

    // Saved next to the citing paper; the same sentence (however spaced or cased) is answered from there.
    const saved = await cache();
    assert.equal(saved.v, TRACE_V); assert.deepEqual(Object.keys(saved.items).map(k => /^[0-9a-f]{32}$/.test(k)), [true]);
    const entry = Object.values(saved.items)[0];
    assert.deepEqual([entry.status, entry.quotes, entry.targetId, entry.refNum, entry.sentence, entry.dropped], ['found', [{page: 1, quote: REAL}], cited.id, 3, S1.toLowerCase(), 1]);
    const again = await call('POST', T, {targetId: cited.id, sentence: '  the BANDWIDTH of the estimate is set by\n the observer gain [3]. '});
    assert.deepEqual(again.j, {...r.j, cached: true});
    assert.deepEqual([asked().length, embedded().length], [1, 2], 'no model or embedding request');

    reply = answer('found', [{page: 1, quote: 'No acceleration measurement is needed for collision detection.'}], 'Second answer.');
    const retried = await call('POST', T, {...body, retry: true});
    assert.deepEqual([retried.j.cached, retried.j.note, retried.j.quotes[0].quote, asked().length], [false, 'Second answer.', 'No acceleration measurement is needed for collision detection.', 2]);
    assert.equal(embedded().length, 3, 'only the sentence is embedded again');
    assert.deepEqual([Object.keys((await cache()).items).length, (await call('POST', T, body)).j.note], [1, 'Second answer.'], 'the saved answer was replaced');
  });

  await t.test('only invented quotes: "none", with the search matches marked as such; cached as that', async () => {
    reply = answer('found', [{page: 1, quote: 'The observer is provably optimal for every robot.'}, {page: 1, quote: 'Its gain K sets the latency of the estimate.'}], 'It says so.');
    const r = await call('POST', T, {targetId: cited.id, sentence: 'Momentum observers are provably optimal [3].'});
    assert.equal(r.status, 200);
    assert.deepEqual([r.j.status, r.j.quotes, r.j.verified, r.j.cached], ['none', [], true, false]);
    assert.match(r.j.note, /does not occur in the cited paper/); assert.ok(!JSON.stringify(r.j).includes('provably optimal for every robot'));
    assert.ok(r.j.matches.length >= 1 && r.j.matches.every(m => m.page === 1 && typeof m.text === 'string'));
    const n = asked().length;
    assert.deepEqual((await call('POST', T, {targetId: cited.id, sentence: 'Momentum observers are provably optimal [3].'})).j, {...r.j, cached: true});
    assert.equal(asked().length, n); assert.equal(Object.keys((await cache()).items).length, 2);
  });

  await t.test('general and none: as the model says, without quotes', async () => {
    reply = '```json\n' + answer('general', [], 'The sentence points to the paper as a survey of the method.') + '\n```';
    const g = await call('POST', T, {targetId: cited.id, sentence: 'See [3] for a survey of momentum observers.'});
    assert.deepEqual([g.j.status, g.j.quotes, g.j.note, g.j.verified, 'matches' in g.j], ['general', [], 'The sentence points to the paper as a survey of the method.', true, false]);
    reply = answer('general', [{page: 1, quote: 'A sentence that the paper does not contain at all.'}], 'Whole work.');
    assert.deepEqual((await call('POST', T, {targetId: cited.id, sentence: 'Observers are reviewed in [3] and elsewhere.'})).j.quotes, [], 'an invented quote is dropped here too');
    reply = answer('none', [{page: 1, quote: REAL}], 'The passages do not mention friction.');
    const none = await call('POST', T, {targetId: cited.id, sentence: 'Friction is identified online as in [3].'});
    assert.deepEqual([none.j.status, none.j.quotes, none.j.note], ['none', [], 'The passages do not mention friction.']); assert.ok(none.j.matches.length >= 1);
  });

  await t.test('the model fails or answers in another form: unverified search matches, nothing saved', async () => {
    const items = Object.keys((await cache()).items).length;
    reply = '';
    const empty = await call('POST', T, {targetId: cited.id, sentence: 'A sentence that was not traced before [3].'});
    assert.equal(empty.status, 200);
    assert.deepEqual([empty.j.status, empty.j.reason, empty.j.verified, empty.j.quotes], ['unverified', 'model-failed', false, []]);
    assert.match(empty.j.note, /failed or timed out/); assert.ok(empty.j.matches.length >= 1);
    reply = 'The source is on page 1, I think.';
    const prose = await call('POST', T, {targetId: cited.id, sentence: 'A sentence that was not traced before [3].'});
    assert.deepEqual([prose.j.status, prose.j.reason], ['unverified', 'bad-answer']);
    assert.equal(Object.keys((await cache()).items).length, items);
    reply = answer('found', [{page: 1, quote: REAL}]);
    assert.equal((await call('POST', T, {targetId: cited.id, sentence: 'A sentence that was not traced before [3].'})).j.status, 'found', 'asked again on the next click');
  });

  await t.test('Claude; embeddings unavailable: passages by keywords; a rejected key', async () => {
    const other = await add(['Friction is identified online with a recursive estimator.', 'The estimator runs at one kilohertz on the robot controller.'], 'Friction.pdf');
    embedFails = true;
    assert.equal((await call('POST', '/api/settings', {provider: 'anthropic', anthropicKey: 'sk-ant-api03-test-000000000000000000000'})).status, 200);
    reply = answer('found', [{page: 1, quote: 'Friction is identified online with a recursive estimator.'}], 'Stated directly.');
    const r = await call('POST', T, {targetId: other.id, sentence: 'Friction can be identified online with a recursive estimator [7].'});
    assert.deepEqual([r.j.status, r.j.mode, r.j.model, r.j.quotes], ['found', 'keywords', 'claude-opus-5-5', [{page: 1, quote: 'Friction is identified online with a recursive estimator.'}]]);
    const req = asked().at(-1);
    assert.equal(req.path.split('?')[0], '/v1/messages'); assert.equal(req.body.max_tokens, TRACE.maxTokens);
    assert.match(req.body.system[0].text, /trace citations/); assert.match(req.body.messages.at(-1).content.at(-1).text, /^CITING SENTENCE\nFriction can be identified/);
    embedFails = false;
    assert.equal((await call('POST', '/api/settings', {anthropicKey: 'sk-ant-api03-bad-0000000000000000000000'})).status, 400, 'a rejected key is not saved');
  });

  await t.test('a cancelled request is aborted upstream and not saved', async () => {
    delay = 500;
    const items = Object.keys((await cache()).items).length, ac = new AbortController();
    const p = fetch(base + T, {method: 'POST', signal: ac.signal, headers: {'x-session-token': token, 'content-type': 'application/json'}, body: JSON.stringify({targetId: cited.id, sentence: 'This request is cancelled before the model answers [3].'})}).catch(e => e.name);
    await new Promise(r => setTimeout(r, 250)); ac.abort();
    assert.equal(await p, 'AbortError');
    await new Promise(r => setTimeout(r, 500));
    assert.equal(asked().at(-1).aborted, true);
    delay = 0;
    assert.equal(Object.keys((await cache()).items).length, items);
  });
});
