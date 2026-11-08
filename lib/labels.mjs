// Short names for papers, shared by the server (prompt context) and the app (citation chips).
// A paper is referred to in project chats by an 8-character prefix of its id and an author-year label.

export const SHORT_ID_LENGTH = 8;
export const shortId = id => String(id || '').slice(0, SHORT_ID_LENGTH);

// "Kingma 2015", "Kingma & Ba 2015", "Srivastava et al. 2012"; without details, the first words of the name.
export function authorYear(p) {
  const m = p?.meta, authors = m?.authors || [];
  const count = m?.authorCount ?? authors.length;
  const last = a => String(a).trim().split(/\s+/).pop();
  if (authors.length) {
    const who = count > 2 ? `${last(authors[0])} et al.` : count === 2 && authors[1] ? `${last(authors[0])} & ${last(authors[1])}` : last(authors[0]);
    return m.year ? `${who} ${m.year}` : who;
  }
  const words = String(m?.title || p?.name || 'Untitled paper').split(/\s+/).filter(Boolean);
  return words.slice(0, 4).join(' ') + (words.length > 4 ? '…' : '');
}

// Labels for all papers of a project, in project order; equal labels get a, b, c… suffixes.
export function paperLabels(papers) {
  const base = papers.map(authorYear), count = new Map(), seen = new Map(), out = new Map();
  for (const b of base) count.set(b, (count.get(b) || 0) + 1);
  papers.forEach((p, i) => {
    const b = base[i];
    if (count.get(b) === 1) { out.set(p.id, b); return; }
    const n = seen.get(b) || 0; seen.set(b, n + 1);
    out.set(p.id, b + String.fromCharCode(97 + Math.min(n, 25)));
  });
  return out;
}

// The project paper a citation's id prefix points to (null when it is unknown or ambiguous).
export function resolvePaper(prefix, papers) {
  const k = String(prefix || '').toLowerCase();
  if (k.length < 6) return null;
  const hits = papers.filter(p => p.id.startsWith(k));
  return hits.length === 1 ? hits[0] : null;
}
