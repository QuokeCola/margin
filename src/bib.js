// Numbered bibliographies ("[12] A. Author, Title, Venue, 2017") and in-text markers ("[12]",
// "[3, 7]", "[3]–[5]", "[3–5]"). Pure functions shared by the app and tests.

// Bracket look-alikes from broken font encodings (U+0001/U+0002 in old ASME PDFs, 关/兴, full-width).
// One character for one character, so positions in the text are kept.
export const normBrackets = s => s.replace(/[\u0001\u5173\uFF3B]/g, '[').replace(/[\u0002\u5174\uFF3D]/g, ']');
const STYLES = {bracket: n => `\\[\\s*${n}\\s*\\]`, dot: n => `(?:^|\\n)\\s*${n}\\.\\s`};

const HEADING = /(?:^|\n)\s*(?:\d+\.?\s*|[IVX]+\.\s*)?(references|bibliography|literature cited|reference list)\s*(?:\n|$)/gi;

// Where the reference list starts: the last "References" heading that is followed by "[1]".
export function findReferenceStart(pages) {
  for (let i = pages.length - 1; i >= 0; i--) {
    const text = pages[i].text;
    const heads = [...text.matchAll(HEADING)];
    for (let k = heads.length - 1; k >= 0; k--) {
      const at = heads[k].index + heads[k][0].length;
      const rest = normBrackets(text.slice(at) + '\n' + (pages[i + 1]?.text || '')).slice(0, 4000);
      if (/\[\s*1\s*\]/.test(rest)) return {page: pages[i].page, offset: at, style: 'bracket'};
      if (/^\s*1\.\s/.test(rest) || /\n\s*1\.\s/.test(rest.slice(0, 400))) return {page: pages[i].page, offset: at, style: 'dot'};
    }
  }
  // No heading found (some PDFs set it as an image): the first "[1]" that starts a run of [2], [3] late in the paper.
  for (let i = Math.floor(pages.length / 2); i < pages.length; i++) {
    const t = normBrackets(pages[i].text), m = t.match(/(^|\n)\s*\[\s*1\s*\]\s/);
    if (m && /\[\s*2\s*\]/.test(t.slice(m.index)) && /\[\s*3\s*\]/.test(t.slice(m.index) + normBrackets(pages[i + 1]?.text || ''))) return {page: pages[i].page, offset: m.index, style: 'bracket'};
  }
  return null;
}

// Entries n -> text, read sequentially ([1], then [2], ...) so stray brackets cannot break the order.
// The last entry is cut at a blank line or 500 characters (author biographies often follow it).
export function parseBibliography(pages) {
  const start = findReferenceStart(pages);
  if (!start) return {start: null, entries: new Map()};
  const first = pages.findIndex(p => p.page === start.page);
  const text = normBrackets(pages.slice(first).map((p, i) => i === 0 ? p.text.slice(start.offset) : p.text).join('\n'));
  const marks = [], pattern = STYLES[start.style];
  for (let n = 1, pos = 0; n <= 999; n++) {
    const re = new RegExp(pattern(n), 'g'); re.lastIndex = pos;
    const m = re.exec(text);
    if (!m || (n > 1 && m.index - pos > 3000)) break;
    marks.push({n, at: m.index, after: m.index + m[0].length}); pos = m.index + m[0].length;
  }
  const entries = new Map();
  marks.forEach((m, i) => {
    const end = marks[i + 1]?.at ?? m.after + 500;
    let body = text.slice(m.after, end);
    if (!marks[i + 1]) body = body.split(/\n\s*\n/)[0];
    const c = clean(body);
    if (c) entries.set(m.n, c);
  });
  return {start, entries};
}
const clean = s => s.replace(/-\s*\n\s*/g, '').replace(/\s+/g, ' ').trim();

// In-text markers in one text string: [{index, length, nums}] for "[12]", "[3, 7]", "[3–5]".
// Ranges written as "[3]–[5]" are returned as one marker covering 3..5.
export function findMarkers(s) {
  const out = [];
  const expand = body => body.split(/\s*,\s*/).flatMap(part => {
    const r = part.match(/^(\d+)\s*[–—-]\s*(\d+)$/);
    if (r) { const a = +r[1], b = +r[2]; return b > a && b - a <= 30 ? Array.from({length: b - a + 1}, (_, i) => a + i) : [a, b]; }
    return /^\d+$/.test(part) ? [+part] : [];
  });
  for (const m of normBrackets(s).matchAll(/\[\s*(\d+(?:\s*[,–—-]\s*\d+)*)\s*\](?:\s*[–—-]\s*\[\s*(\d+)\s*\])?/g)) {
    let nums = expand(m[1]);
    if (m[2]) { const a = nums[nums.length - 1], b = +m[2]; if (b > a && b - a <= 30) for (let k = a + 1; k <= b; k++) nums.push(k); }
    nums = [...new Set(nums)].filter(n => n > 0 && n < 1000);
    if (nums.length) out.push({index: m.index, length: m[0].length, nums});
  }
  return out;
}

// Match bibliography entries to records (from OpenAlex) by how much of each record's title appears
// in the entry text. Returns Map n -> record.
export function matchEntries(entries, records) {
  const words = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 2);
  const recs = records.map(r => ({r, w: [...new Set(words(r.title))]})).filter(x => x.w.length >= 2);
  const out = new Map(), used = new Set();
  const scored = [];
  for (const [n, text] of entries) {
    const set = new Set(words(text));
    for (const x of recs) {
      const hit = x.w.filter(w => set.has(w)).length / x.w.length;
      if (hit >= 0.75) scored.push({n, x, hit: hit + Math.min(x.w.length, 12) / 1000});
    }
  }
  scored.sort((a, b) => b.hit - a.hit);
  for (const s of scored) if (!out.has(s.n) && !used.has(s.x.r)) { out.set(s.n, s.x.r); used.add(s.x.r); }
  return out;
}
