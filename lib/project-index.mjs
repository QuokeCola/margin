// Search index for project chats, kept next to each stored PDF:
//   papers/<id>/text.json     page text extracted with pdf.js  ({v, pdf: {size, mtimeMs}, pages: [{page, text}]})
//   papers/<id>/chunks.json   passages + embedding info         ({v, pdf, chunk, model, dim, chunks: [{page, text}]})
//   papers/<id>/vectors.f32   one float32 embedding per passage, in chunk order
// Everything is rebuilt when the PDF file, the passage settings or the embedding model change.
import {join} from 'node:path';
import {readFile, writeFile, rename, stat} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {chunkPages, cosine, lexicalScores, rankPassages, CHUNK} from './retrieval.mjs';

export const EMBED_MODEL = 'text-embedding-3-small';
const TEXT_V = 1, INDEX_V = 1;
const MAX_PAGES = 300, MAX_PAGE_CHARS = 30000, MAX_CHARS = 600000, BATCH = 96;

async function writeAtomic(file, data) {
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, data, {mode: 0o600});
  await rename(tmp, file);
}
const readJson = f => readFile(f, 'utf8').then(JSON.parse).catch(() => null);
const samePdf = (a, b) => a && b && a.size === b.size && a.mtimeMs === b.mtimeMs;

// Same text layout as the reader builds in the app, so quotes match what it highlights.
async function extractPages(file) {
  const {getDocument} = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({data: new Uint8Array(await readFile(file)), isEvalSupported: false, verbosity: 0});
  try {
    const doc = await task.promise, pages = [];
    let total = 0;
    for (let n = 1; n <= Math.min(doc.numPages, MAX_PAGES); n++) {
      const content = await (await doc.getPage(n)).getTextContent();
      let text = content.items.filter(t => typeof t.str === 'string').map(t => t.str + (t.hasEOL ? '\n' : ' ')).join('').slice(0, MAX_PAGE_CHARS);
      text = text.slice(0, Math.max(0, MAX_CHARS - total)); total += text.length;
      pages.push({page: n, text});
    }
    return {pages, numPages: doc.numPages};
  } finally { await task.destroy().catch(() => {}); }
}

export function createIndexer(store) {
  const dirOf = id => store.pdfPath(id).root;
  const pdfInfo = async id => { const s = await stat(join(dirOf(id), 'paper.pdf')); return {size: s.size, mtimeMs: Math.round(s.mtimeMs)}; };
  const inflight = new Map(), memory = new Map(); // id -> promise; id -> {key, chunks, vectors}
  const once = (key, fn) => { if (!inflight.has(key)) inflight.set(key, fn().finally(() => inflight.delete(key))); return inflight.get(key); };

  // Page text, extracted once per PDF.
  const pageText = id => once('text:' + id, async () => {
    const pdf = await pdfInfo(id), file = join(dirOf(id), 'text.json');
    const cached = await readJson(file);
    if (cached?.v === TEXT_V && samePdf(cached.pdf, pdf)) return cached;
    const {pages, numPages} = await extractPages(join(dirOf(id), 'paper.pdf'));
    const out = {v: TEXT_V, pdf, numPages, pages};
    await writeAtomic(file, JSON.stringify(out));
    return out;
  });

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
        const flat = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
        const vectors = meta.chunks.map((_, i) => flat.subarray(i * meta.dim, (i + 1) * meta.dim));
        const out = {key, chunks: meta.chunks, vectors, numPages: meta.numPages};
        memory.set(id, out); return out;
      }
    }
    const text = await pageText(id);
    const chunks = chunkPages(text.pages);
    if (!client || !chunks.length) return {key, chunks, vectors: chunks.length ? null : [], numPages: text.numPages};
    const vectors = [];
    for (let i = 0; i < chunks.length; i += BATCH) {
      const r = await client.embeddings.create({model: EMBED_MODEL, input: chunks.slice(i, i + BATCH).map(c => c.text)});
      for (const d of r.data.sort((a, b) => a.index - b.index)) vectors.push(Float32Array.from(d.embedding));
    }
    const dim = vectors[0].length, flat = new Float32Array(vectors.length * dim);
    vectors.forEach((v, i) => flat.set(v, i * dim));
    await writeAtomic(join(dir, 'vectors.f32'), Buffer.from(flat.buffer));
    await writeAtomic(join(dir, 'chunks.json'), JSON.stringify({v: INDEX_V, pdf, chunk: CHUNK, model: EMBED_MODEL, dim, numPages: text.numPages, chunks}));
    const out = {key, chunks, vectors, numPages: text.numPages};
    memory.set(id, out); return out;
  });

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
    const items = ok.flatMap(({id, x}) => x.chunks.map((c, i) => ({paperId: id, page: c.page, text: c.text, i, v: x.vectors?.[i]})));
    const scores = mode === 'embeddings' ? items.map(it => cosine(qv, it.v)) : lexicalScores(query, items.map(it => it.text));
    // Keyword scores of 0 mean no shared word: such passages are left out.
    const passages = rankPassages(items.map((it, j) => ({paperId: it.paperId, page: it.page, text: it.text, score: scores[j]})), mode === 'keywords' ? {minScore: 0, ...opts} : opts);
    return {passages, mode, failed, numPages: Object.fromEntries(ok.map(r => [r.id, r.x.numPages])), empty: ok.filter(r => !r.x.chunks.length).map(r => r.id)};
  }

  // Start indexing in the background (e.g. when a project chat is created); errors are ignored here.
  const warm = (paperIds, client) => { for (const id of paperIds) paperIndex(id, client).catch(() => {}); };
  const firstPage = async id => (await pageText(id).catch(() => null))?.pages?.[0]?.text || '';

  return {pageText, paperIndex, retrieve, warm, firstPage};
}
