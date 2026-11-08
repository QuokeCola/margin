// Search index for project chats, kept next to each stored PDF:
//   papers/<id>/text.json     page text extracted with pdf.js  ({v, pdf: {size, mtimeMs}, pages: [{page, text}]})
//   papers/<id>/chunks.json   passages + embedding info         ({v, pdf, chunk, model, dim, chunks: [{page, text}]})
//   papers/<id>/vectors.f32   one float32 embedding per passage, in chunk order
// Everything is rebuilt when the PDF file, the passage settings or the embedding model change.
import {join} from 'node:path';
import {readFile, writeFile, rename, stat} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {availableParallelism} from 'node:os';
import {Worker} from 'node:worker_threads';
import {chunkPages, cosineRows, rowNorms, lexicalScoresFromStats, termStats, rankPassages, CHUNK} from './retrieval.mjs';
import {runJob} from './pdf-text.mjs';

export const EMBED_MODEL = 'text-embedding-3-small';
const TEXT_V = 1, INDEX_V = 1, LAYOUT_V = 1;
const BATCH = 96;
// PDFs read at once (each in its own worker thread) and embedding requests in flight at once.
export const EXTRACT_THREADS = Math.max(1, Math.min(2, availableParallelism() - 1));
export const EMBED_CONCURRENCY = 4;

async function writeAtomic(file, data) {
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, data, {mode: 0o600});
  await rename(tmp, file);
}
const readJson = f => readFile(f, 'utf8').then(JSON.parse).catch(() => null);
const samePdf = (a, b) => a && b && a.size === b.size && a.mtimeMs === b.mtimeMs;

// At most `n` calls of fn running at once; the rest wait in order.
export function limiter(n) {
  let active = 0;
  const queue = [];
  const next = () => { if (active < n && queue.length) { active++; queue.shift()(); } };
  return fn => new Promise((resolve, reject) => {
    queue.push(() => Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; next(); }));
    next();
  });
}

// Worker threads for pdf.js text extraction, started on first use and stopped after `idleMs` without work,
// so a large PDF never blocks the server's event loop. When a worker cannot start at all (for example a
// packaging problem), PDFs are extracted in-process as before; a worker that dies during a job fails that job.
export function createExtractPool(size = EXTRACT_THREADS, {idleMs = 30000} = {}) {
  const idle = [], waiting = [];
  let live = 0, jobs = 0, unavailable = false;
  function spawn() {
    const w = new Worker(new URL('./extract-worker.mjs', import.meta.url));
    w.pending = new Map(); live++;
    w.on('online', () => { w.online = true; });
    w.on('message', ({job, ok, err}) => { const p = w.pending.get(job); w.pending.delete(job); if (p) err ? p.reject(new Error(err)) : p.resolve(ok); });
    const gone = e => {
      if (w.gone) return; w.gone = true; live--; clearTimeout(w.timer);
      const i = idle.indexOf(w); if (i >= 0) idle.splice(i, 1);
      if (!w.online && !unavailable) { unavailable = true; console.warn('PDF text worker could not start; extracting in-process:', e?.message || e); }
      for (const p of w.pending.values()) w.online ? p.reject(e) : p.fallback();
      w.pending.clear();
    };
    w.on('error', gone);
    w.on('exit', code => gone(new Error(`PDF text worker stopped (exit code ${code}).`)));
    return w;
  }
  function acquire() {
    const w = idle.pop();
    if (w) { clearTimeout(w.timer); return Promise.resolve(w); }
    if (unavailable && !live) return Promise.resolve(null);
    if (live < size && !unavailable) return Promise.resolve(spawn());
    return new Promise(r => waiting.push(r));
  }
  function release(w) {
    const r = waiting.shift();
    if (w.gone) { if (r) acquire().then(r); return; }
    if (r) return r(w);
    w.unref(); idle.push(w);
    w.timer = setTimeout(() => { const i = idle.indexOf(w); if (i >= 0) { idle.splice(i, 1); w.terminate(); } }, idleMs);
    w.timer.unref();
  }
  // kind: 'text' (page text), 'layout' (text items and equation detections) or 'crops' (args: [{page, box}]).
  async function run(kind, file, args) {
    const w = await acquire();
    if (!w) return runJob(kind, file, args);
    w.ref();
    try {
      return await new Promise((resolve, reject) => {
        const job = ++jobs;
        w.pending.set(job, {resolve, reject, fallback: () => runJob(kind, file, args).then(resolve, reject)});
        w.postMessage({job, kind, file, args});
      });
    } finally { release(w); }
  }
  const extract = file => run('text', file);
  const close = () => Promise.all(idle.splice(0).map(w => { clearTimeout(w.timer); return w.terminate(); }));
  return {extract, run, close};
}

export function createIndexer(store, {pool = createExtractPool(), embedConcurrency = EMBED_CONCURRENCY} = {}) {
  const dirOf = id => store.pdfPath(id).root;
  // A stored PDF never changes (its id is its SHA-256), so its size/mtime are read once per process;
  // forget() drops them when a paper is removed.
  const info = new Map();
  const pdfInfo = id => {
    if (!info.has(id)) info.set(id, stat(join(dirOf(id), 'paper.pdf')).then(s => ({size: s.size, mtimeMs: Math.round(s.mtimeMs)}), e => { info.delete(id); throw e; }));
    return info.get(id);
  };
  const inflight = new Map(), memory = new Map(), first = new Map(), layouts = new Map(), cropCache = new Map(); // id -> promise; id -> {key, chunks, vectors, ...}; id -> {key, text}
  const once = (key, fn) => { if (!inflight.has(key)) inflight.set(key, fn().finally(() => inflight.delete(key))); return inflight.get(key); };
  const embedSlot = limiter(embedConcurrency);

  // Page text, extracted once per PDF.
  const pageText = id => once('text:' + id, async () => {
    const pdf = await pdfInfo(id), file = join(dirOf(id), 'text.json');
    const cached = await readJson(file);
    if (cached?.v === TEXT_V && samePdf(cached.pdf, pdf)) return cached;
    const {pages, numPages} = await pool.extract(join(dirOf(id), 'paper.pdf'));
    const out = {v: TEXT_V, pdf, numPages, pages};
    await writeAtomic(file, JSON.stringify(out));
    return out;
  });

  // In memory, vectors are one flat Float32Array (`flat`, `dim`) with each row's squared norm, and
  // `vectors[i]` views into it; keyword statistics are computed on first keyword search and kept.
  const withFlat = (out, flat, dim) => Object.assign(out, {flat, dim, norms: rowNorms(flat, dim),
    vectors: out.chunks.map((_, i) => flat.subarray(i * dim, (i + 1) * dim))});

  // Passages and (when an OpenAI client is given) their embeddings. Without a client, or when the
  // embedding request fails, the passages come back without vectors and nothing is cached as embedded.
  const paperIndex = (id, client) => once(`index:${id}:${client ? 1 : 0}`, async () => {
    const pdf = await pdfInfo(id), key = JSON.stringify({pdf, chunk: CHUNK, model: EMBED_MODEL, v: INDEX_V});
    const mem = memory.get(id);
    if (mem?.key === key && (mem.vectors || !client)) return mem;
    const dir = dirOf(id), meta = await readJson(join(dir, 'chunks.json'));
    if (meta?.v === INDEX_V && samePdf(meta.pdf, pdf) && JSON.stringify(meta.chunk) === JSON.stringify(CHUNK) && meta.model === EMBED_MODEL) {
      const buf = await readFile(join(dir, 'vectors.f32')).catch(() => null);
      if (buf && buf.length === meta.chunks.length * meta.dim * 4) {
        let flat;
        if (buf.byteOffset % 4 === 0) flat = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
        else { flat = new Float32Array(buf.length / 4); new Uint8Array(flat.buffer).set(buf); } // unaligned Buffer: copy
        const out = withFlat({key, chunks: meta.chunks, numPages: meta.numPages}, flat, meta.dim);
        memory.set(id, out); return out;
      }
    }
    const text = await pageText(id);
    const chunks = chunkPages(text.pages);
    if (!client || !chunks.length) {
      const out = {key, chunks, vectors: chunks.length ? null : [], numPages: text.numPages};
      if (!mem?.vectors || mem.key !== key) memory.set(id, out); // keep passages (and their keyword stats) without vectors
      return out;
    }
    const batches = [];
    for (let i = 0; i < chunks.length; i += BATCH) batches.push(chunks.slice(i, i + BATCH).map(c => c.text));
    const results = await Promise.all(batches.map(input => embedSlot(() => client.embeddings.create({model: EMBED_MODEL, input}))));
    const vectors = [];
    for (const r of results) for (const d of r.data.sort((a, b) => a.index - b.index)) vectors.push(Float32Array.from(d.embedding));
    const dim = vectors[0].length, flat = new Float32Array(vectors.length * dim);
    vectors.forEach((v, i) => flat.set(v, i * dim));
    await writeAtomic(join(dir, 'vectors.f32'), Buffer.from(flat.buffer));
    await writeAtomic(join(dir, 'chunks.json'), JSON.stringify({v: INDEX_V, pdf, chunk: CHUNK, model: EMBED_MODEL, dim, numPages: text.numPages, chunks}));
    const out = withFlat({key, chunks, numPages: text.numPages}, flat, dim);
    memory.set(id, out); return out;
  });
  const statsOf = x => x.stats ??= x.chunks.map(c => termStats(c.text));

  // Top passages across the given papers for a query. Returns {passages, mode, indexed, failed}:
  // mode is 'embeddings', or 'keywords' when any embedding was unavailable.
  async function retrieve(paperIds, query, client, opts = {}) {
    const results = await Promise.all(paperIds.map(id => paperIndex(id, client).then(x => ({id, x}), e => ({id, e}))));
    let mode = client ? 'embeddings' : 'keywords', qv = null;
    const ok = results.filter(r => r.x), failed = results.filter(r => r.e).map(r => r.id);
    if (results.some(r => r.e)) for (const r of results) if (r.e) console.warn('Index failed for', r.id.slice(0, 8), r.e.message);
    if (ok.some(r => r.x.chunks.length && !r.x.vectors)) mode = 'keywords';
    if (mode === 'embeddings') {
      try { qv = (await client.embeddings.create({model: EMBED_MODEL, input: query.slice(0, 8000)})).data[0].embedding; }
      catch (e) { console.warn('Query embedding failed:', e.message); mode = 'keywords'; }
    }
    const items = ok.flatMap(({id, x}) => x.chunks.map((c, i) => ({paperId: id, page: c.page, text: c.text})));
    const scores = mode === 'embeddings' ? ok.flatMap(({x}) => x.chunks.length ? cosineRows(qv, x.flat, x.dim, x.norms) : [])
      : lexicalScoresFromStats(query, ok.flatMap(({x}) => statsOf(x)));
    // Keyword scores of 0 mean no shared word: such passages are left out.
    const passages = rankPassages(items.map((it, j) => ({paperId: it.paperId, page: it.page, text: it.text, score: scores[j]})), mode === 'keywords' ? {minScore: 0, ...opts} : opts);
    return {passages, mode, failed, numPages: Object.fromEntries(ok.map(r => [r.id, r.x.numPages])), empty: ok.filter(r => !r.x.chunks.length).map(r => r.id)};
  }

  // Text items and automatic equation detections per page (papers/<id>/layout.json), for project chats'
  // equation index. Extracted on first use.
  const pageLayout = id => once('layout:' + id, async () => {
    const pdf = await pdfInfo(id), file = join(dirOf(id), 'layout.json');
    const mem = layouts.get(id);
    if (mem && samePdf(mem.pdf, pdf)) return mem;
    let out = await readJson(file);
    if (!(out?.v === LAYOUT_V && samePdf(out.pdf, pdf))) {
      const {pages, numPages} = await pool.run('layout', join(dirOf(id), 'paper.pdf'));
      out = {v: LAYOUT_V, pdf, numPages, pages};
      await writeAtomic(file, JSON.stringify(out));
    }
    layouts.set(id, out);
    if (layouts.size > 20) layouts.delete(layouts.keys().next().value);
    return out;
  });
  // Equation crops of a paper ([{page, box}] -> data URLs or null), rendered in a worker; kept in memory.
  const crops = async (id, list) => {
    const key = c => `${id}:${c.page}:${JSON.stringify(c.box)}`;
    const missing = list.filter(c => !cropCache.has(key(c)));
    if (missing.length) {
      const urls = await pool.run('crops', join(dirOf(id), 'paper.pdf'), missing).catch(e => { console.warn('Equation crops failed:', e.message); return missing.map(() => null); });
      missing.forEach((c, i) => cropCache.set(key(c), urls[i]));
      while (cropCache.size > 300) cropCache.delete(cropCache.keys().next().value);
    }
    return list.map(c => cropCache.get(key(c)) ?? null);
  };

  // Start indexing in the background (e.g. when a project chat is created); errors are ignored here.
  const warm = (paperIds, client) => { for (const id of paperIds) paperIndex(id, client).catch(() => {}); };
  // The first page's text (for papers without an abstract), kept per PDF.
  const firstPage = async id => {
    const key = await pdfInfo(id).then(JSON.stringify, () => null);
    const hit = first.get(id);
    if (key && hit?.key === key) return hit.text;
    const text = (await pageText(id).catch(() => null))?.pages?.[0]?.text || '';
    if (key && text) first.set(id, {key, text});
    return text;
  };
  // Drop what is remembered about papers that were removed (their files are gone).
  const forget = ids => { for (const id of ids) { info.delete(id); memory.delete(id); first.delete(id); layouts.delete(id); } };

  return {pageText, paperIndex, retrieve, warm, firstPage, forget, pageLayout, crops, close: pool.close};
}
