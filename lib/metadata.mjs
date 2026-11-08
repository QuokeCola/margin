// Paper metadata from OpenAlex (free, no key), with Crossref as a fallback for DOIs OpenAlex lacks.
// Only a DOI or a title is sent. Requests identify the app, not the user.
const UA = 'Margin (https://github.com/QuokeCola/margin)';
const OPENALEX = 'https://api.openalex.org', CROSSREF = 'https://api.crossref.org';

export const DOI_PATTERN = /\b10\.\d{4,9}\/[^\s"<>]+/i;
export function cleanDoi(s) {
  const m = String(s || '').replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '').match(DOI_PATTERN);
  return m ? m[0].replace(/[.,;:)\]}>'"]+$/, '').toLowerCase() : null;
}

async function getJson(url, ms = 10000) {
  const r = await fetch(url, {headers: {'User-Agent': UA, Accept: 'application/json'}, signal: AbortSignal.timeout(ms)});
  if (r.status === 404) return null;
  if (!r.ok) throw Object.assign(new Error(`lookup failed (${r.status})`), {status: r.status});
  return r.json();
}

// Word-overlap similarity of two titles, 0..1.
export function titleSimilarity(a, b) {
  const words = s => new Set(String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 2));
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let common = 0; for (const w of A) if (B.has(w)) common++;
  return (2 * common) / (A.size + B.size);
}

function abstractFromIndex(inv) {
  if (!inv) return null;
  const words = [];
  for (const [w, positions] of Object.entries(inv)) for (const p of positions) words[p] = w;
  return words.filter(Boolean).join(' ') || null;
}

export function fromOpenAlex(w) {
  const short = id => String(id || '').replace('https://openalex.org/', '');
  return {
    source: 'openalex', openalexId: short(w.id), doi: cleanDoi(w.doi), title: w.title || w.display_name || null,
    authors: (w.authorships || []).map(a => a.author?.display_name).filter(Boolean),
    date: w.publication_date || null, year: w.publication_year || null,
    venue: w.primary_location?.source?.display_name || null, type: w.type || null,
    abstract: abstractFromIndex(w.abstract_inverted_index), citedBy: w.cited_by_count ?? null,
    references: (w.referenced_works || []).map(short),
    oaUrl: w.open_access?.oa_url || null, pdfUrl: w.best_oa_location?.pdf_url || null,
  };
}

function fromCrossref(m) {
  const d = m['published-print'] || m['published-online'] || m.issued;
  const parts = d?.['date-parts']?.[0] || [];
  return {
    source: 'crossref', openalexId: null, doi: cleanDoi(m.DOI), title: (m.title || [])[0] || null,
    authors: (m.author || []).map(a => [a.given, a.family].filter(Boolean).join(' ')).filter(Boolean),
    date: parts.length ? parts.map((v, i) => i ? String(v).padStart(2, '0') : v).join('-') : null, year: parts[0] || null,
    venue: (m['container-title'] || [])[0] || null, type: m.type || null,
    abstract: m.abstract ? m.abstract.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : null,
    citedBy: m['is-referenced-by-count'] ?? null, references: [], oaUrl: null, pdfUrl: null,
  };
}

// Look a paper up by DOI (preferred) or title. Returns metadata or null when nothing fits.
export async function lookupPaper({doi, title}) {
  const d = cleanDoi(doi);
  if (d) {
    const w = await getJson(`${OPENALEX}/works/doi:${encodeURIComponent(d)}`).catch(() => null);
    if (w) return fromOpenAlex(w);
    const c = await getJson(`${CROSSREF}/works/${encodeURIComponent(d)}`).catch(() => null);
    if (c?.message) return fromCrossref(c.message);
  }
  if (title && title.length >= 12) {
    const r = await getJson(`${OPENALEX}/works?search=${encodeURIComponent(title.slice(0, 250))}&per-page=5`);
    const best = (r?.results || []).map(w => ({w, s: titleSimilarity(title, w.title)})).sort((a, b) => b.s - a.s)[0];
    if (best && best.s >= 0.75) return fromOpenAlex(best.w);
  }
  return null;
}

// Short record for reference lists and cards.
export function workSummary(w) {
  const m = fromOpenAlex(w);
  return {openalexId: m.openalexId, doi: m.doi, title: m.title, authors: m.authors.slice(0, 8), authorCount: m.authors.length, year: m.year, venue: m.venue,
    citedBy: m.citedBy, abstract: m.abstract ? m.abstract.slice(0, 1200) : null, oaUrl: m.oaUrl, pdfUrl: m.pdfUrl};
}

// Several works by OpenAlex id, in batches of 50 (the API's filter limit).
export async function worksById(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50).filter(id => /^W\d+$/.test(id));
    if (!batch.length) continue;
    const r = await getJson(`${OPENALEX}/works?filter=openalex:${batch.join('|')}&per-page=50`, 15000);
    out.push(...(r?.results || []).map(workSummary));
  }
  const order = new Map(ids.map((id, i) => [id, i]));
  return out.sort((a, b) => (order.get(a.openalexId) ?? 0) - (order.get(b.openalexId) ?? 0));
}

// Free-text search (for bibliography entries OpenAlex did not link): best few matches.
export async function searchWorks(q, n = 3) {
  const r = await getJson(`${OPENALEX}/works?search=${encodeURIComponent(String(q).slice(0, 300))}&per-page=${n}`);
  return (r?.results || []).map(workSummary);
}

// Full metadata for one OpenAlex id.
export async function workById(id) {
  if (!/^W\d+$/.test(id)) return null;
  const w = await getJson(`${OPENALEX}/works/${id}`);
  return w ? fromOpenAlex(w) : null;
}

// Works that cite `id`, most-cited first.
export async function citingWorks(id, n = 15) {
  if (!/^W\d+$/.test(id)) return [];
  const r = await getJson(`${OPENALEX}/works?filter=cites:${id}&sort=cited_by_count:desc&per-page=${n}`, 15000);
  return (r?.results || []).map(workSummary);
}
