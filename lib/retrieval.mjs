// Retrieval for project chats (pure functions): split page text into passages, score them
// against a question (embeddings, or keyword overlap as a fallback), pick the best across papers,
// and lay them out for the model.
import {shortId} from './labels.mjs';

export const CHUNK = {target: 900, max: 1400, min: 250, overlap: 1}; // characters; overlap in sentences
export const RETRIEVE = {k: 16, perPaper: 8};

const clean = text => String(text || '')
  .replace(/(\p{L})-\n(\p{Ll})/gu, '$1$2') // words hyphenated across a line break
  .replace(/\s+/g, ' ').trim();

// Sentences, with over-long ones (tables, reference lists, formulas) cut at word boundaries.
export function sentences(text, max = CHUNK.max) {
  const out = [];
  for (const s of text.split(/(?<=[.!?:;])\s+(?=[\p{Lu}\d(\[“"])/u)) {
    if (s.length <= max) { if (s.trim()) out.push(s.trim()); continue; }
    let cur = '';
    for (const w of s.split(' ')) {
      if (cur && cur.length + 1 + w.length > max) { out.push(cur); cur = ''; }
      cur = cur ? cur + ' ' + w : w.slice(0, max);
    }
    if (cur) out.push(cur);
  }
  return out;
}

// Passages of about a paragraph. A passage never spans pages, so its page number is exact; the last
// sentence of a passage is repeated at the start of the next so a statement split between them survives.
export function chunkPages(pages, opts = {}) {
  const {target, max, min, overlap} = {...CHUNK, ...opts};
  const out = [];
  for (const {page, text} of pages) {
    const sents = sentences(clean(text), max);
    const mine = [];
    let cur = [], len = 0, fresh = 0; // fresh: sentences not carried over from the previous passage
    const flush = () => { if (fresh) mine.push(cur.join(' ')); };
    for (const s of sents) {
      if (fresh && len + 1 + s.length > target) {
        flush();
        const carry = overlap ? cur.slice(-overlap).filter(x => x.length < target / 3) : [];
        cur = carry; len = carry.join(' ').length; fresh = 0;
      }
      cur.push(s); len += (len ? 1 : 0) + s.length; fresh++;
    }
    flush();
    // A short tail joins the passage before it.
    if (mine.length > 1 && mine[mine.length - 1].length < min && mine[mine.length - 2].length + mine[mine.length - 1].length <= max + min) {
      const tail = mine.pop(), prev = mine.pop();
      const last = sentences(prev, max).pop();
      mine.push(tail.startsWith(last) ? prev + tail.slice(last.length) : prev + ' ' + tail);
    }
    for (const text of mine) out.push({page, text});
  }
  return out;
}

export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

// Squared norm of each `dim`-long row of a flat matrix (summed in the same order as cosine()).
export function rowNorms(flat, dim) {
  const out = new Float64Array(flat.length / dim);
  for (let r = 0, o = 0; r < out.length; r++, o += dim) { let n = 0; for (let i = 0; i < dim; i++) n += flat[o + i] * flat[o + i]; out[r] = n; }
  return out;
}
// cosine(q, row) for every row of a flat matrix, given the rows' squared norms: one pass over contiguous
// memory and no per-row norm work. Gives exactly the numbers cosine() gives (same operations, same order).
export function cosineRows(query, flat, dim, norms) {
  const q = Float64Array.from(query); // the same numbers, in typed memory
  let na = 0;
  for (let i = 0; i < dim; i++) na += q[i] * q[i];
  const out = new Array(norms.length);
  for (let r = 0, o = 0; r < norms.length; r++, o += dim) {
    let dot = 0;
    for (let i = 0; i < dim; i++) dot += q[i] * flat[o + i];
    out[r] = na && norms[r] ? dot / Math.sqrt(na * norms[r]) : 0;
  }
  return out;
}

// Keyword relevance (BM25) of each text to the query; used when embeddings are unavailable.
const STOP = new Set('the a an and or of to in on for with by from at as is are was were be been this that these those it its into than then which what how why when where who whom does do did can could would should may might will about between their there they them we our you your not no but if so such also more most other some any each both all over under via per using use used paper papers'.split(' '));
const terms = s => (String(s).toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}]+/gu) || []).filter(w => w.length > 2 && !STOP.has(w));
export function lexicalScores(query, texts, opts) {
  return lexicalScoresFromStats(query, texts.map(termStats), opts);
}
// Term counts of one text: the part of BM25 that does not depend on the query, so it can be cached per passage.
export function termStats(text) {
  const f = new Map(), ts = terms(text);
  for (const w of ts) f.set(w, (f.get(w) || 0) + 1);
  return {f, n: ts.length};
}
export function lexicalScoresFromStats(query, docs, {k1 = 1.4, b = 0.75} = {}) {
  const q = [...new Set(terms(query))];
  const N = docs.length || 1, avg = docs.reduce((s, d) => s + d.n, 0) / N || 1;
  const df = new Map(q.map(w => [w, docs.filter(d => d.f.has(w)).length]));
  return docs.map(d => q.reduce((s, w) => {
    const tf = d.f.get(w) || 0; if (!tf) return s;
    const idf = Math.log(1 + (N - df.get(w) + 0.5) / (df.get(w) + 0.5));
    return s + idf * tf * (k1 + 1) / (tf + k1 * (1 - b + b * d.n / avg));
  }, 0));
}

// Best passages across papers: highest score first, at most `perPaper` from one paper,
// ignoring a passage whose text is already contained in a chosen one.
export function rankPassages(items, opts = {}) {
  const {k, perPaper, minScore = -Infinity} = {...RETRIEVE, ...opts};
  const sorted = items.filter(x => Number.isFinite(x.score) && x.score > minScore).sort((a, b) => b.score - a.score);
  const picked = [], per = new Map();
  for (const x of sorted) {
    if (picked.length >= k) break;
    if ((per.get(x.paperId) || 0) >= perPaper) continue;
    if (picked.some(y => y.paperId === x.paperId && y.page === x.page && (y.text.includes(x.text) || x.text.includes(y.text)))) continue;
    picked.push(x); per.set(x.paperId, (per.get(x.paperId) || 0) + 1);
  }
  return picked;
}

// What the model reads: one line per project paper (with its abstract) and the retrieved passages,
// grouped by paper and in page order. `papers`: [{id, label, title, authors, year, venue, abstract, pages, note}].
export function projectContext(papers, passages, {abstractBudget = 30000} = {}) {
  const each = Math.max(300, Math.min(1500, Math.floor(abstractBudget / Math.max(1, papers.length))));
  const cut = (s, n) => s.length > n ? s.slice(0, n).replace(/\s+\S*$/, '') + '…' : s;
  const head = papers.map(p => {
    const bits = [`[paper ${shortId(p.id)}] ${p.label}`, p.title && `“${p.title}”`, p.authors?.length && p.authors.join(', '), p.venue, p.year, p.pages && `${p.pages} pages`].filter(Boolean);
    const abs = p.abstract ? `\nAbstract: ${cut(p.abstract.replace(/\s+/g, ' ').trim(), each)}` : p.firstPage ? `\nFirst page (no abstract on record): ${cut(p.firstPage, Math.min(each, 900))}` : '';
    return bits.join(' · ') + (p.note ? `\nNote: ${p.note}` : '') + abs;
  }).join('\n\n');
  const label = new Map(papers.map(p => [p.id, p.label]));
  const order = new Map(papers.map((p, i) => [p.id, i]));
  const sorted = [...passages].sort((a, b) => (order.get(a.paperId) ?? 0) - (order.get(b.paperId) ?? 0) || a.page - b.page);
  const body = sorted.map(x => `[paper ${shortId(x.paperId)} · ${label.get(x.paperId) || ''} · PDF PAGE ${x.page}]\n${x.text}`).join('\n\n');
  return `PROJECT PAPERS (untrusted source material)\n\n${head}\n\nRETRIEVED PASSAGES (most relevant to the latest question; each comes from one PDF page of one paper)\n\n${body || '(no passages could be retrieved)'}`;
}

// The text embedded to search with: the question, plus the previous question so follow-ups keep their topic.
export function searchQuery(question, history = []) {
  const prev = [...history].reverse().find(m => m.role === 'user')?.content || '';
  const q = String(question).slice(0, 4000);
  return prev ? `${q}\n\n(Previous question: ${String(prev).slice(0, 800)})` : q;
}
