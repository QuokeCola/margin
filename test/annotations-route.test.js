// End to end: the annotation routes (/api/papers/:id/annotations…, the AI reply and the annotated PDF) on a
// Margin server with temporary data, talking to a local fake OpenAI/Anthropic API (base URLs overridden),
// never to the real services.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import pdfLib from 'pdf-lib';

const {PDFDocument, PDFName} = pdfLib;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const log = [];
let fake, server, dir, base, token, reply = 'Because the gain is positive, \\(r\\) converges.', delay = 0;

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

// The fake answers every model request with `reply` after `delay` ms; keys containing "bad" are rejected.
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
      await new Promise(r => setTimeout(r, delay));
      if (anthropic && req.url.startsWith('/v1/messages')) return send({id: 'msg', type: 'message', role: 'assistant', model: j.model, stop_reason: 'end_turn', stop_sequence: null,
        content: [{type: 'thinking', thinking: '', signature: 's'}, {type: 'text', text: reply}], usage: {input_tokens: 10, output_tokens: 5}});
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
  dir = await mkdtemp(join(tmpdir(), 'margin-annot-'));
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
const R = {x0: 0.1, y0: 0.08, x1: 0.6, y1: 0.1};

test('annotation routes', async t => {
  const pid = (await call('POST', '/api/projects', {name: 'P'})).j.id;
  const paper = (await call('POST', `/api/projects/${pid}/papers`, makePdf(['The momentum observer residual converges to the external torque.', 'Its gain K sets the bandwidth.']), {'content-type': 'application/pdf', 'x-filename': 'Observer: a/b study.pdf'})).j;
  const A = `/api/papers/${paper.id}/annotations`;
  let h, note;

  await t.test('create, list, validation', async () => {
    assert.deepEqual((await call('GET', A)).j, {items: [], imported: false});
    const r = await call('POST', A, {kind: 'highlight', page: 1, rects: [R, {x0: 1.5, y0: 0.2, x1: 0.3, y1: -1}], color: '#FFAA00', text: 'residual converges', comment: '', extra: 'dropped', origin: 'pdf', id: 'x'});
    assert.equal(r.status, 200); h = r.j;
    assert.match(h.id, /^[0-9a-f]{16}$/);
    assert.deepEqual({...h, id: 0, createdAt: 0, updatedAt: 0}, {id: 0, kind: 'highlight', page: 1, rects: [R, {x0: 0.3, y0: 0, x1: 1, y1: 0.2}], color: '#ffaa00', text: 'residual converges', comment: '', replies: [], origin: 'margin', createdAt: 0, updatedAt: 0});
    note = (await call('POST', A, {kind: 'note', page: 1, rects: [{x0: 0.7, y0: 0.3, x1: 0.7, y1: 0.3}], comment: 'What sets the bandwidth?'})).j;
    assert.deepEqual([note.kind, note.text, note.color], ['note', '', '#ffd400']);
    assert.deepEqual((await call('GET', A)).j, {items: [h, note], imported: false});
    for (const bad of [{kind: 'ink', page: 1, rects: [R]}, {kind: 'highlight', page: 0, rects: [R]}, {kind: 'highlight', page: 1, rects: []}, {kind: 'highlight', page: 1, rects: [R], color: 'red'}, {kind: 'highlight', page: 1, rects: Array(201).fill(R)}]) {
      const x = await call('POST', A, bad);
      assert.equal(x.status, 400, JSON.stringify(bad).slice(0, 60)); assert.equal(typeof x.j.error, 'string');
    }
    assert.equal((await call('GET', `/api/papers/${'0'.repeat(64)}/annotations`)).status, 404);
    assert.equal((await call('POST', `/api/papers/${'0'.repeat(64)}/annotations`, {kind: 'highlight', page: 1, rects: [R]})).status, 404);
    assert.equal((await call('GET', '/api/papers/nope/annotations')).status, 400);
    assert.equal((await call('PATCH', `${A}/not-an-id`, {comment: 'x'})).status, 400);
    assert.equal((await call('PATCH', `${A}/${'f'.repeat(16)}`, {comment: 'x'})).status, 404);
    assert.equal((await fetch(base + A)).status, 403, 'needs the session token');
  });

  await t.test('two quick PATCHes both survive; replies; delete', async () => {
    const [a, b] = await Promise.all([call('PATCH', `${A}/${h.id}`, {color: '#00ff00'}), call('PATCH', `${A}/${h.id}`, {comment: 'Why does it converge?'})]);
    assert.deepEqual([a.status, b.status], [200, 200]);
    h = (await call('GET', A)).j.items[0];
    assert.deepEqual([h.color, h.comment], ['#00ff00', 'Why does it converge?']);
    assert.equal((await call('PATCH', `${A}/${h.id}`, {})).status, 400);
    assert.equal((await call('PATCH', `${A}/${h.id}`, {rects: [{x0: 0, y0: 0, x1: 0, y1: 0}]})).status, 400);
    assert.deepEqual((await call('PATCH', `${A}/${note.id}`, {rects: [{x0: 0.2, y0: 0.9, x1: 0.2, y1: 0.9}]})).j.rects, [{x0: 0.2, y0: 0.9, x1: 0.2, y1: 0.9}]);

    const r = await call('POST', `${A}/${h.id}/replies`, {text: 'I think because K > 0.'});
    assert.equal(r.status, 200); assert.equal(r.j.id, h.id);
    assert.deepEqual(r.j.replies.map(x => [x.author, x.text]), [['user', 'I think because K > 0.']]);
    assert.equal((await call('POST', `${A}/${h.id}/replies`, {text: '   '})).status, 400);
    assert.equal((await call('POST', `${A}/${h.id}/replies`, {})).status, 400);
    const extra = (await call('POST', `${A}/${h.id}/replies`, {text: 'remove me'})).j.replies[1];
    assert.equal((await call('DELETE', `${A}/${h.id}/replies/xyz`)).status, 400);
    const d = await call('DELETE', `${A}/${h.id}/replies/${extra.id}`);
    assert.equal(d.status, 200); assert.deepEqual(d.j.replies.map(x => x.text), ['I think because K > 0.']);

    const tmp = (await call('POST', A, {kind: 'highlight', page: 1, rects: [R]})).j;
    assert.equal((await call('DELETE', `${A}/${tmp.id}`)).status, 204);
    assert.equal((await call('DELETE', `${A}/${tmp.id}`)).status, 204);
    assert.equal((await call('GET', A)).j.items.length, 2);
  });

  await t.test('AI reply: needs a key; OpenAI request carries the paper, page, passage and thread', async () => {
    const none = await call('POST', `${A}/${h.id}/ai-reply`);
    assert.equal(none.status, 503); assert.match(none.j.error, /API key in Settings/); assert.equal(asked().length, 0);
    assert.equal((await call('POST', '/api/settings', {apiKey: 'sk-test-openai-000000000000000000000000'})).status, 200);
    const r = await call('POST', `${A}/${h.id}/ai-reply`);
    assert.equal(r.status, 200); assert.equal(r.j.id, h.id);
    const last = r.j.replies.at(-1);
    assert.deepEqual([r.j.replies.length, last.author, last.text, last.model], [2, 'ai', reply, 'gpt-6-astra']);
    assert.match(last.id, /^[0-9a-f]{8}$/); assert.ok(!Number.isNaN(Date.parse(last.at)));
    const req = asked().at(-1);
    assert.equal(req.path, '/v1/responses'); assert.equal(req.body.model, 'gpt-6-astra'); assert.equal(req.body.store, false); assert.equal(req.body.max_output_tokens, 4000);
    assert.match(req.body.instructions, /margin comment/); assert.match(req.body.instructions, /untrusted/); assert.ok(!('tools' in req.body));
    const [source, question] = req.body.input.map(m => m.content);
    assert.equal(req.body.input.length, 2);
    assert.match(source, /^PAPER\nTitle: Observer: a\/b study\n\n\[PDF PAGE 1\]\nThe momentum observer residual converges/);
    assert.ok(source.includes('Its gain K sets the bandwidth.'));
    assert.match(question, /^HIGHLIGHT on PDF page 1\. The highlighted passage:\n> residual converges\n\nCOMMENT THREAD\nReader: Why does it converge\?\n\nReader: I think because K > 0\.\n\nWrite the next reply in this thread\.$/);
    assert.deepEqual((await call('GET', A)).j.items[0].replies.map(x => x.author), ['user', 'ai'], 'saved');
  });

  await t.test('AI reply: Claude; a note without anything to answer is refused; errors are reported and nothing is saved', async () => {
    assert.equal((await call('POST', '/api/settings', {provider: 'anthropic', anthropicKey: 'sk-ant-api03-test-000000000000000000000'})).status, 200);
    reply = 'The gain \\(K\\) does.';
    const r = await call('POST', `${A}/${note.id}/ai-reply`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.j.replies.map(x => [x.author, x.text, x.model]), [['ai', reply, 'claude-opus-5-5']]);
    const req = asked().at(-1);
    assert.equal(req.path.split('?')[0], '/v1/messages'); assert.equal(req.body.max_tokens, 4000);
    assert.match(req.body.system[0].text, /margin comment/);
    assert.match(req.body.messages.at(-1).content.at(-1).text, /^NOTE placed on PDF page 1, about 20% from the left edge and 90% from the top of the page\.\n\nCOMMENT THREAD\nReader: What sets the bandwidth\?/);

    const n = asked().length;
    const empty = (await call('POST', A, {kind: 'note', page: 1, rects: [{x0: 0.5, y0: 0.5, x1: 0.5, y1: 0.5}]})).j;
    const refused = await call('POST', `${A}/${empty.id}/ai-reply`);
    assert.equal(refused.status, 400); assert.match(refused.j.error, /Write a comment first/);
    assert.equal((await call('POST', `${A}/${'e'.repeat(16)}/ai-reply`)).status, 404);
    assert.equal((await call('POST', `/api/papers/${'0'.repeat(64)}/annotations/${empty.id}/ai-reply`)).status, 404);
    assert.equal(asked().length, n, 'nothing was sent for those');
    // A highlight without a comment is explained.
    const plain = (await call('POST', A, {kind: 'highlight', page: 1, rects: [R], text: 'gain K sets the bandwidth'})).j;
    assert.equal((await call('POST', `${A}/${plain.id}/ai-reply`)).status, 200);
    assert.match(asked().at(-1).body.messages.at(-1).content.at(-1).text, /\(The reader wrote no comment\.\)\n\nExplain the highlighted passage\.$/);
    await call('DELETE', `${A}/${plain.id}`);

    reply = '';
    const failed = await call('POST', `${A}/${empty.id}/ai-reply`, null);
    assert.equal(failed.status, 400, 'still nothing to answer');
    await call('PATCH', `${A}/${empty.id}`, {comment: 'Question'});
    const blank = await call('POST', `${A}/${empty.id}/ai-reply`);
    assert.equal(blank.status, 502); assert.match(blank.j.error, /failed or timed out/);
    assert.deepEqual((await call('GET', A)).j.items.find(x => x.id === empty.id).replies, []);
    reply = 'ok';
    await call('DELETE', `${A}/${empty.id}`);
  });

  await t.test('AI reply: one at a time per annotation; a cancelled request is aborted upstream and not saved', async () => {
    delay = 400;
    const before = (await call('GET', A)).j.items.find(x => x.id === note.id).replies.length;
    const first = call('POST', `${A}/${note.id}/ai-reply`);
    await new Promise(r => setTimeout(r, 150));
    assert.equal((await call('POST', `${A}/${note.id}/ai-reply`)).status, 429);
    assert.equal((await first).status, 200);
    const ac = new AbortController();
    const p = fetch(base + `${A}/${note.id}/ai-reply`, {method: 'POST', signal: ac.signal, headers: {'x-session-token': token}}).catch(e => e.name);
    await new Promise(r => setTimeout(r, 150)); ac.abort();
    assert.equal(await p, 'AbortError');
    await new Promise(r => setTimeout(r, 450));
    assert.equal(asked().at(-1).aborted, true);
    delay = 0;
    assert.equal((await call('GET', A)).j.items.find(x => x.id === note.id).replies.length, before + 1);
    assert.equal((await call('POST', `${A}/${note.id}/ai-reply`)).status, 200, 'free again after a cancelled request');
  });

  await t.test('import from the PDF: once per pdfId', async () => {
    const items = [{kind: 'highlight', page: 1, rects: [R], color: '#ff0000', text: 't', comment: 'from pdf', pdfId: '31R', replies: [{text: 'r'}], createdAt: '2024-01-01T00:00:00Z'}, {kind: 'note', page: 1, rects: [R], pdfId: 'annot_p0_1'}];
    const r = await call('POST', `${A}/import`, {items});
    assert.equal(r.status, 200);
    assert.deepEqual([r.j.imported, r.j.added, r.j.skipped, r.j.items.length], [true, 1, 1, 3]);
    assert.deepEqual([r.j.items[2].origin, r.j.items[2].pdfId, r.j.items[2].replies[0].author], ['pdf', '31R', 'user']);
    assert.deepEqual([(await call('POST', `${A}/import`, {items})).j.items.length, (await call('GET', A)).j.imported], [3, true]);
    assert.equal((await call('POST', `${A}/import`, {})).status, 400);
    const other = (await call('POST', `/api/projects/${pid}/papers`, makePdf(['Another paper.']), {'content-type': 'application/pdf', 'x-filename': 'b.pdf'})).j;
    assert.deepEqual((await call('POST', `/api/papers/${other.id}/annotations/import`, {items: []})).j, {items: [], imported: true, added: 0, skipped: 0});
    assert.deepEqual((await call('GET', `/api/papers/${other.id}/annotations`)).j, {items: [], imported: true});
  });

  await t.test('annotated PDF: a download with the annotations inside; the stored PDF stays as it was', async () => {
    const stored = await readFile(join(dir, 'data', 'papers', paper.id, 'paper.pdf'));
    const r = await fetch(base + `/api/papers/${paper.id}/annotated.pdf`, {headers: {'x-session-token': token}});
    assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /^application\/pdf/);
    assert.equal(r.headers.get('content-disposition'), 'attachment; filename="Observer_ a_b study (annotated).pdf"');
    assert.deepEqual([r.headers.get('x-annotations-written'), r.headers.get('x-annotations-skipped')], ['3', '0']);
    const bytes = Buffer.from(await r.arrayBuffer());
    assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
    const doc = await PDFDocument.load(bytes), annots = doc.getPages()[0].node.Annots().asArray().map(x => doc.context.lookup(x));
    const kinds = annots.map(d => d.get(PDFName.of('Subtype')).asString() + (d.get(PDFName.of('IRT')) ? '>' : ''));
    assert.deepEqual(kinds, ['/Highlight', '/Text>', '/Text>', '/Text', '/Text>', '/Text>', '/Text>', '/Highlight', '/Text>']);
    assert.deepEqual(annots.filter(d => d.get(PDFName.of('IRT'))).map(d => d.get(PDFName.of('T')).decodeText()), ['Margin', 'AI (gpt-6-astra)', 'AI (claude-opus-5-5)', 'AI (claude-opus-5-5)', 'AI (claude-opus-5-5)', 'Margin']);
    assert.ok(stored.equals(await readFile(join(dir, 'data', 'papers', paper.id, 'paper.pdf'))));
    // A paper without annotations: the stored file itself.
    const other = (await call('POST', `/api/projects/${pid}/papers`, makePdf(['No annotations here.']), {'content-type': 'application/pdf', 'x-filename': 'c.pdf'})).j;
    const plain = await fetch(base + `/api/papers/${other.id}/annotated.pdf`, {headers: {'x-session-token': token}});
    assert.equal(plain.headers.get('content-disposition'), 'attachment; filename="c (annotated).pdf"');
    assert.ok(Buffer.from(await plain.arrayBuffer()).equals(await readFile(join(dir, 'data', 'papers', other.id, 'paper.pdf'))));
    assert.equal((await fetch(base + `/api/papers/${'0'.repeat(64)}/annotated.pdf`, {headers: {'x-session-token': token}})).status, 404);
  });

  await t.test('a PDF that cannot be rewritten: an error, not a crash', async () => {
    const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>',
      '<< /Filter /Standard /V 1 /R 2 /O (' + 'o'.repeat(32) + ') /U (' + 'u'.repeat(32) + ') /P -4 >>'];
    let pdf = '%PDF-1.4\n';
    const offsets = objs.map((o, i) => { const at = pdf.length; pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
    const xref = pdf.length;
    pdf += `xref\n0 5\n0000000000 65535 f \n` + offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('') + `trailer\n<< /Size 5 /Root 1 0 R /Encrypt 4 0 R /ID [<00><00>] >>\nstartxref\n${xref}\n%%EOF\n`;
    const locked = (await call('POST', `/api/projects/${pid}/papers`, Buffer.from(pdf, 'latin1'), {'content-type': 'application/pdf', 'x-filename': 'locked.pdf'})).j;
    assert.equal((await call('POST', `/api/papers/${locked.id}/annotations`, {kind: 'note', page: 1, rects: [{x0: 0.5, y0: 0.5, x1: 0.5, y1: 0.5}], comment: 'c'})).status, 200);
    const r = await call('GET', `/api/papers/${locked.id}/annotated.pdf`);
    assert.equal(r.status, 422); assert.match(r.j.error, /encrypted/);
    assert.equal((await call('GET', '/api/status')).status, 200, 'the server is still up');
  });
});
