// End to end: change events (GET /api/events) from a Margin server on a free port with temporary data,
// for papers added by the window and by the browser extension, and the extension's target project.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = 'test-pairing-code-0123456789';
let server, dir, base, token;
const pdf = s => Buffer.from(`%PDF-1.4\n% ${s}\n`);
const freePort = () => new Promise(r => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'margin-events-'));
  const port = await freePort();
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(OPENAI_|ANTHROPIC_|PROVIDER$|MARGIN_)/.test(k)));
  Object.assign(env, {PORT: String(port), MARGIN_PRODUCTION: '1', MARGIN_DATA_DIR: join(dir, 'data'), MARGIN_ENV_FILE: join(dir, 'settings.env'), MARGIN_EXT_TOKEN: EXT});
  server = spawn(process.execPath, ['server.mjs', '--production'], {cwd: root, env, stdio: ['ignore', 'pipe', 'inherit']});
  await new Promise((resolve, reject) => { server.stdout.on('data', d => { if (String(d).includes('Margin:')) resolve(); }); server.on('exit', reject); });
  base = `http://127.0.0.1:${port}`;
  token = (await (await fetch(base + '/api/status')).json()).token;
});
after(async () => { server?.kill(); if (dir) await rm(dir, {recursive: true, force: true}); });

async function call(method, path, body, headers = {}) {
  const r = await fetch(base + path, {method, headers: {'x-session-token': token, ...(body && !Buffer.isBuffer(body) ? {'content-type': 'application/json'} : {}), ...headers},
    body: body ? (Buffer.isBuffer(body) ? body : JSON.stringify(body)) : undefined});
  return {status: r.status, j: await r.json().catch(() => null)};
}
const ext = (path, body, headers = {}) => fetch(base + path, {method: 'POST', headers: {'x-margin-ext': EXT, ...headers}, body}).then(async r => ({status: r.status, j: await r.json().catch(() => null)}));

// A reader of the event stream: next(pred) resolves with the next event matching pred.
async function listen() {
  const abort = new AbortController();
  const r = await fetch(base + '/api/events', {headers: {'x-session-token': token}, signal: abort.signal});
  assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /^text\/event-stream/);
  const events = [], waiting = [];
  (async () => {
    let buf = '';
    try {
      for await (const chunk of r.body.pipeThrough(new TextDecoderStream())) {
        buf += chunk;
        for (let i; (i = buf.indexOf('\n\n')) >= 0;) {
          const data = buf.slice(0, i).split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n'); buf = buf.slice(i + 2);
          if (!data) continue;
          events.push(JSON.parse(data));
          for (const w of [...waiting]) { const e = events.find(w.pred); if (e) { events.splice(events.indexOf(e), 1); waiting.splice(waiting.indexOf(w), 1); w.resolve(e); } }
        }
      }
    } catch {}
  })();
  const next = (pred = () => true, ms = 3000) => new Promise((resolve, reject) => {
    const e = events.find(pred); if (e) { events.splice(events.indexOf(e), 1); return resolve(e); }
    const w = {pred, resolve: x => { clearTimeout(t); resolve(x); }}; waiting.push(w);
    const t = setTimeout(() => { waiting.splice(waiting.indexOf(w), 1); reject(new Error('no matching event')); }, ms);
  });
  return {next, close: () => abort.abort()};
}

test('change events and the extension target project', async t => {
  assert.equal((await fetch(base + '/api/events')).status, 403, 'needs the session token');
  const s = await listen();
  assert.equal((await s.next()).type, 'hello');
  const a = (await call('POST', '/api/projects', {name: 'A'})).j, b = (await call('POST', '/api/projects', {name: 'B'})).j;

  await t.test('upload from a window names that window', async () => {
    const r = await call('POST', `/api/projects/${a.id}/papers`, pdf('up'), {'content-type': 'application/pdf', 'x-filename': 'up.pdf', 'x-margin-client': 'window12345'});
    const e = await s.next(e => e.type === 'paper-added');
    assert.equal(e.projectId, a.id); assert.equal(e.projectName, 'A'); assert.equal(e.paper.id, r.j.id); assert.equal(e.isNew, true);
    assert.equal(e.via, 'upload'); assert.equal(e.client, 'window12345'); assert.equal(e.papers, 1);
    await call('POST', `/api/projects/${a.id}/papers`, pdf('up'), {'content-type': 'application/pdf'});
    const again = await s.next(e => e.type === 'paper-added');
    assert.equal(again.isNew, false); assert.equal(again.client, null, 'no or invalid client id: null');
  });

  await t.test('extension "Send this PDF" goes to the active project, not the one loaded last', async () => {
    assert.equal((await call('POST', '/api/active-project', {projectId: 'nope'})).status, 400);
    assert.equal((await call('POST', '/api/active-project', {projectId: b.id})).status, 200);
    await call('GET', `/api/projects/${a.id}`); // e.g. the delete dialog reads other projects
    const r = await ext('/api/ext/pdf', pdf('popup'), {'content-type': 'application/pdf', 'x-filename': 'popup'});
    assert.equal(r.status, 200); assert.equal(r.j.project, 'B');
    const e = await s.next(e => e.type === 'paper-added');
    assert.equal(e.projectId, b.id); assert.equal(e.via, 'extension'); assert.equal(e.client, null); assert.equal(e.paper.id, r.j.paper.id);
  });

  await t.test('a fetch request answered by the extension', async () => {
    const {id} = (await call('POST', '/api/fetch-requests', {projectId: a.id, title: 'T', landing: 'https://example.org/paper'})).j;
    assert.equal((await ext(`/api/ext/requests/${id}/pdf`, pdf('req'), {'content-type': 'application/pdf'})).status, 200);
    const e = await s.next(e => e.type === 'paper-added');
    assert.equal(e.projectId, a.id); assert.equal(e.via, 'extension-request'); assert.equal(e.requestId, id); assert.equal(e.isNew, true);
    const {id: id2} = (await call('POST', '/api/fetch-requests', {projectId: b.id, title: 'T2', landing: 'https://example.org/paper2'})).j;
    const file = join(dir, 'download.pdf'); await writeFile(file, pdf('file'));
    assert.equal((await ext(`/api/ext/requests/${id2}/file`, JSON.stringify({path: file}), {'content-type': 'application/json'})).status, 200);
    const e2 = await s.next(e => e.type === 'paper-added');
    assert.equal(e2.projectId, b.id); assert.equal(e2.requestId, id2);
  });

  await t.test('every open stream gets the event', async () => {
    const s2 = await listen(); await s2.next(e => e.type === 'hello');
    await ext('/api/ext/pdf', pdf('two'), {'content-type': 'application/pdf'});
    const [x, y] = await Promise.all([s.next(e => e.type === 'paper-added'), s2.next(e => e.type === 'paper-added')]);
    assert.equal(x.paper.id, y.paper.id);
    s2.close();
  });

  await t.test('removals', async () => {
    const paperId = (await call('GET', `/api/projects/${a.id}`)).j.papers[0].id;
    assert.equal((await call('DELETE', `/api/projects/${a.id}/papers/${paperId}`)).status, 204);
    assert.deepEqual(await s.next(e => e.type === 'paper-removed').then(e => [e.projectId, e.paperId]), [a.id, paperId]);
    assert.equal((await call('DELETE', `/api/projects/${b.id}`, undefined, {'x-margin-client': 'window12345'})).status, 204);
    const e = await s.next(e => e.type === 'project-deleted');
    assert.equal(e.projectId, b.id); assert.equal(e.client, 'window12345');
    // The active project is gone: the extension falls back to the project loaded last (A).
    const r = await ext('/api/ext/pdf', pdf('fallback'), {'content-type': 'application/pdf'});
    assert.equal(r.j.project, 'A');
  });
  s.close();
});
