import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm, readdir} from 'node:fs/promises';
import {existsSync, readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createExtractPool, createIndexer, limiter} from '../lib/project-index.mjs';
import {extractPages} from '../lib/pdf-text.mjs';
import {cosine, cosineRows, rowNorms, lexicalScores, lexicalScoresFromStats, termStats} from '../lib/retrieval.mjs';

// A small text PDF (Helvetica, several lines per page) with a correct xref table.
function makePdf(pages) {
  const objs = [];
  const add = s => { objs.push(s); return objs.length; };
  const catalog = add(null), tree = add(null), font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids = pages.map(lines => {
    const body = 'BT /F1 11 Tf 14 TL 72 720 Td ' + lines.map(l => `(${l.replace(/[()\\]/g, '\\$&')}) Tj T*`).join(' ') + ' ET';
    const content = add(`<< /Length ${Buffer.byteLength(body)} >>\nstream\n${body}\nendstream`);
    return add(`<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`);
  });
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${tree} 0 R >>`;
  objs[tree - 1] = `<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n';
  const offsets = objs.map((o, i) => { const at = Buffer.byteLength(out); out += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
const PAGES = [
  ['Momentum observers estimate external joint torques.', 'They need no acceleration measurement (see Eq. 3).', 'A residual r = K(p - p0) converges to tau_ext.'],
  ['Friction is identified with a Stribeck model;', 'the parameters come from constant-velocity runs.'],
  [],
  ['References', '[1] A. De Luca, Collision detection, 2006.'],
];

test('worker extraction gives exactly the in-process text (and survives several PDFs at once)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'margin-x-'));
  const files = [];
  for (let i = 0; i < 5; i++) { const f = join(dir, `${i}.pdf`); await writeFile(f, makePdf(PAGES.map(p => p.map(l => `${l} #${i}`)))); files.push(f); }
  const pool = createExtractPool(2);
  try {
    const viaWorkers = await Promise.all(files.map(f => pool.extract(f)));
    for (const [i, f] of files.entries()) {
      const direct = await extractPages(f);
      assert.deepEqual(viaWorkers[i], direct);
      assert.equal(direct.numPages, 4);
      assert.match(direct.pages[0].text, /Momentum observers estimate external joint torques\. #\d/);
    }
    await assert.rejects(pool.extract(join(dir, 'missing.pdf')), 'a failing PDF rejects; the pool keeps working');
    assert.deepEqual(await pool.extract(files[0]), viaWorkers[0]);
  } finally { await pool.close(); await rm(dir, {recursive: true, force: true}); }
});

// Optional: the equation corpus used to check that the extracted text did not change (skipped when absent).
const CORPUS = '/home/quokecola/Projects/margin-eq-corpus/papers';
test('worker extraction matches in-process extraction on corpus PDFs', {skip: !existsSync(CORPUS) && 'corpus not present'}, async () => {
  const files = readdirSync(CORPUS).map(d => join(CORPUS, d, 'paper.pdf')).filter(existsSync).sort().slice(0, 12);
  const pool = createExtractPool(2);
  try {
    const got = await Promise.all(files.map(f => pool.extract(f)));
    for (const [i, f] of files.entries()) assert.deepEqual(got[i], await extractPages(f), f);
  } finally { await pool.close(); }
});

test('flat cosine and cached keyword statistics give the same scores as before', () => {
  const dim = 7, rows = 5, flat = new Float32Array(rows * dim);
  for (let i = 0; i < flat.length; i++) flat[i] = Math.sin(i * 1.7) * (i % 3 ? 1 : -0.5);
  const q = Array.from({length: dim}, (_, i) => Math.cos(i));
  const want = Array.from({length: rows}, (_, r) => cosine(q, flat.subarray(r * dim, (r + 1) * dim)));
  assert.deepEqual(cosineRows(q, flat, dim, rowNorms(flat, dim)), want);
  assert.deepEqual(cosineRows(q, new Float32Array(dim), dim, rowNorms(new Float32Array(dim), dim)), [0]);
  const texts = ['Momentum observer for contact torque', 'friction model identification', 'momentum momentum torque', ''];
  const query = 'How is the momentum observer friction identified?';
  assert.deepEqual(lexicalScoresFromStats(query, texts.map(termStats)), lexicalScores(query, texts));
});

test('indexer: keyword retrieval, cached first page, embedding requests capped', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'margin-i-'));
  const ids = ['a', 'b', 'c'];
  for (const id of ids) { await mkdir(join(dir, id)); await writeFile(join(dir, id, 'paper.pdf'), makePdf(PAGES)); }
  const store = {pdfPath: id => ({root: join(dir, id), file: 'paper.pdf'})};
  let active = 0, peak = 0;
  const client = {embeddings: {create: async ({input}) => {
    const arr = Array.isArray(input) ? input : [input];
    active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 5)); active--;
    return {data: arr.map((t, index) => ({index, embedding: Array.from({length: 4}, (_, i) => (t.length % (i + 2)) + 1)}))};
  }}};
  const indexer = createIndexer(store, {pool: createExtractPool(1), embedConcurrency: 2});
  try {
    const kw = await indexer.retrieve(ids, 'Stribeck friction parameters', null);
    assert.equal(kw.mode, 'keywords');
    assert.ok(kw.passages.length >= 1 && kw.passages.every(p => p.page === 2));
    assert.deepEqual(kw, await indexer.retrieve(ids, 'Stribeck friction parameters', null), 'cached statistics give the same result');
    assert.match(await indexer.firstPage('a'), /^Momentum observers/);
    const em = await indexer.retrieve(ids, 'momentum observer', client);
    assert.equal(em.mode, 'embeddings');
    assert.ok(peak <= 2, `at most 2 embedding requests at once (saw ${peak})`);
    assert.ok((await readdir(join(dir, 'a'))).includes('vectors.f32'));
    // A fresh indexer reads the saved vectors and ranks the same way.
    const again = createIndexer(store, {pool: createExtractPool(1)});
    assert.deepEqual((await again.retrieve(ids, 'momentum observer', client)).passages, em.passages);
    await again.close();
  } finally { await indexer.close(); await rm(dir, {recursive: true, force: true}); }
});

test('limiter runs at most n at once and keeps order', async () => {
  const slot = limiter(2), started = [];
  let active = 0, peak = 0;
  const out = await Promise.all([1, 2, 3, 4, 5].map(n => slot(async () => { started.push(n); active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 3)); active--; return n * 10; })));
  assert.deepEqual(out, [10, 20, 30, 40, 50]);
  assert.deepEqual(started, [1, 2, 3, 4, 5]);
  assert.equal(peak, 2);
  await assert.rejects(slot(() => { throw new Error('x'); }));
});

test('layout and crops for project chats: equations detected as in the app, crops rendered in a worker', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'margin-l-')), file = join(dir, 'p.pdf');
  // One display equation with its number at the right margin, between two lines of prose.
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [4 0 R] /Count 1 >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>'];
  const body = 'BT /F1 11 Tf 72 700 Td (The momentum observer gives a residual that converges to the torque.) Tj ET ' +
    'BT /F1 11 Tf 220 670 Td (r = K p - K p0 - integral of tau) Tj ET BT /F1 11 Tf 520 670 Td (\\(12\\)) Tj ET ' +
    'BT /F1 11 Tf 72 640 Td (where K is a diagonal gain matrix chosen by the designer of the system.) Tj ET';
  objs.push(`<< /Length ${Buffer.byteLength(body)} >>\nstream\n${body}\nendstream`);
  let out = '%PDF-1.4\n';
  const offsets = objs.map((o, i) => { const at = Buffer.byteLength(out); out += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('') + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  await writeFile(file, Buffer.from(out, 'latin1'));
  const pool = createExtractPool(1);
  try {
    const {pages} = await pool.run('layout', file);
    assert.equal(pages.length, 1); assert.equal(pages[0].W, 612);
    assert.deepEqual(pages[0].auto.map(e => e.label), ['12']);
    assert(pages[0].items.some(([s]) => s.startsWith('r = K p')));
    const [url, missing] = await pool.run('crops', file, [{page: 1, box: pages[0].auto[0].box}, {page: 9, box: pages[0].auto[0].box}]);
    assert.match(url, /^data:image\/png;base64,/); assert.equal(missing, null);
  } finally { await pool.close(); await rm(dir, {recursive: true, force: true}); }
});
