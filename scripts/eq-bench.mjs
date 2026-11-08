// Equation-detection benchmark against ground truth (development tool; the corpus is not part of the repo).
// Usage: node scripts/eq-bench.mjs [corpus_dir] [--pdfs dir_without_ground_truth] [--detail] [--only key,key] [--json out.json] [--impl other/layout.js]
// (--impl runs another copy of layout.js, e.g. the previous version, for before/after numbers.)
// The corpus dir holds manifest.json ([{key, expected: ["1","2a",...], numbering, two_column, ...}])
// and papers/<key>/paper.pdf. Expected labels come from the LaTeX source, so matching is by label:
// recall = expected labels found, precision = detected labels that are real (multiset matching).
// Frames are checked where possible without positions: the frame holds its number, is not empty,
// does not overlap another frame, and is not implausibly tall/wide or full of prose (as eq-eval).
import * as pdfjs from '../node_modules/pdfjs-dist/legacy/build/pdf.mjs';
import {readFileSync, writeFileSync, existsSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {pathToFileURL} from 'node:url';

const args = process.argv.slice(2);
const flag = n => args.includes(n);
const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const corpus = args.find((a, i) => !a.startsWith('--') && !['--only', '--json', '--impl', '--pdfs'].includes(args[i - 1])) ?? join(homedir(), 'Projects/margin-eq-corpus');
const detail = flag('--detail'), only = opt('--only')?.split(','), jsonOut = opt('--json');
const {textBoxes, detectEquations, normParens} = await import(opt('--impl') ? pathToFileURL(opt('--impl')).href : '../src/layout.js');
const manifest = opt('--pdfs') ? [] : JSON.parse(readFileSync(join(corpus, 'manifest.json'), 'utf8')).filter(p => !p.why && p.expected && (!only || only.includes(p.key)));

const MATH = new Set('sin cos tan exp log max min sup inf det diag sgn sign arg mod rank trace span tanh sinh cosh rms var std ext int tot ref des act est obs nom eff err cmd dyn rel abs fric meas init'.split(' '));
const words = s => (s.match(/\b[a-z]{3,}\b/g) || []).filter(w => /[aeiouy]/.test(w) && !MATH.has(w)).length;
const key = l => String(l).replace(/\s+/g, '').toLowerCase();
const plainLabel = l => /^\d+[a-z]?$/i.test(key(l));

function frameFlags(e, eqs, boxes, W, H) {
  const b = e.box, lb = e.labelBox, flags = [];
  if (b.y1 - b.y0 > 0.15) flags.push('tall');
  if (b.x1 - b.x0 > 0.9) flags.push('wide');
  if (!(lb.x0 >= b.x0 - 0.002 && lb.x1 <= b.x1 + 0.002 && lb.y0 >= b.y0 - 0.002 && lb.y1 <= b.y1 + 0.002)) flags.push('label-outside');
  const inside = boxes.filter(t => t.s.trim() && t.x0 / W >= b.x0 - 0.005 && t.x1 / W <= b.x1 + 0.005 && t.y0 / H >= b.y0 - 0.005 && t.y1 / H <= b.y1 + 0.005);
  if (words(inside.map(t => t.s).join(' ')) >= 10) flags.push('prose');
  if (inside.filter(t => !/^\(?\s*\d+[a-z]?\s*\)?$/.test(normParens(t.s).trim())).length === 0) flags.push('empty');
  for (const o of eqs) if (o !== e && o.box.x0 < b.x1 && o.box.x1 > b.x0) {
    const ov = Math.min(o.box.y1, b.y1) - Math.max(o.box.y0, b.y0);
    if (ov > 0.3 * Math.min(o.box.y1 - o.box.y0, b.y1 - b.y0)) { flags.push('overlap'); break; }
  }
  return flags;
}

// Text of the visual line holding a box (for describing misses and false hits).
function lineText(boxes, b) {
  const c = (b.y0 + b.y1) / 2, h = b.y1 - b.y0;
  return boxes.filter(t => Math.abs((t.y0 + t.y1) / 2 - c) < 0.4 * h).sort((a, z) => a.x0 - z.x0).map(t => t.s).join(' ').replace(/\s+/g, ' ').trim();
}

async function detectAll(file) {
  let doc;
  try { doc = await pdfjs.getDocument({data: new Uint8Array(readFileSync(file)), verbosity: 0}).promise; }
  catch (e) { return null; }
  const dets = [], pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n), vp = page.getViewport({scale: 1}), tc = await page.getTextContent();
    const boxes = textBoxes(tc.items, vp, pdfjs.Util), W = vp.width, H = vp.height;
    pages.push({boxes, W, H});
    const eqs = detectEquations(boxes, W, H);
    for (const e of eqs) dets.push({page: n, label: e.label, box: e.box, labelBox: e.labelBox, flags: frameFlags(e, eqs, boxes, W, H),
      line: lineText(boxes, {y0: e.labelBox.y0 * H, y1: e.labelBox.y1 * H})});
  }
  return {dets, pages};
}

// Group without LaTeX ground truth (publisher PDFs): a weaker reference from numbering continuity.
// Numbers mentioned in the text ("Eq. (5)", "Eqs. (3)-(7)", "Equation (2)") and detected numbers
// are pooled per prefix ("", "A.", "2."); N is the largest n for which at least 60% of 1..n are in
// that pool (so one stray "(87)" does not stretch the range). Expected = 1..N per prefix, by base
// number (5a, 5b count as 5).
// "Extra" = detected labels outside 1..N or repeating a base number already found (suspect false hits).
if (opt('--pdfs')) {
  const dir = opt('--pdfs');
  const files = readdirSync(dir).filter(f => f.toLowerCase().endsWith('.pdf')).sort();
  const S = {papers: 0, exp: 0, found: 0, det: 0, extra: 0, frames: 0, flagged: 0, flags: {}, dotted: 0};
  const out = [];
  for (const f of files) {
    const r = await detectAll(join(dir, f));
    if (!r) { console.log(`${f.slice(0, 50)} unreadable`); continue; }
    const {dets, pages} = r;
    // Labels split into prefix + number: "12b" -> ("", 12), "A.3" -> ("A.", 3), "2.4" -> ("2.", 4).
    const parse = l => { const m = String(l).match(/^(.*?)(\d+)[a-z]?$/i); return m ? [m[1].toUpperCase(), +m[2]] : null; };
    const pools = new Map(), add = (pre, n) => { if (!pools.has(pre)) pools.set(pre, new Set()); pools.get(pre).add(n); };
    const LBL = '((?:[A-Z]\\.?)?\\d{1,3}(?:\\.\\d{1,3})?)[a-z]?';
    const mention = new RegExp(`\\b(?:Eqs?|Equations?)\\s*\\.?\\s*\\(\\s*${LBL}\\s*\\)(?:\\s*(?:[-\\u2013\\u2014,]|to|and)\\s*\\(\\s*${LBL}\\s*\\))?`, 'g');
    for (const {boxes} of pages) {
      const text = normParens(boxes.map(b => b.s).join(' ')).replace(/\s+/g, ' ');
      for (const m of text.matchAll(mention)) {
        const a = parse(m[1]), b = m[2] ? parse(m[2]) : a;
        if (!a) continue;
        if (b && b[0] === a[0]) for (let k = a[1]; k <= Math.min(b[1], a[1] + 30); k++) add(a[0], k); else add(a[0], a[1]);
      }
    }
    for (const d of dets) { const q = parse(d.label); if (q) add(...q); }
    const Ns = new Map();
    for (const [pre, pool] of pools) { let N = 0; for (const n of [...pool].sort((a, b) => a - b)) { let c = 0; for (let k = 1; k <= n; k++) if (pool.has(k)) c++; if (c >= 0.6 * n) N = n; } Ns.set(pre, N); }
    const seen = new Set(), extra = [];
    for (const d of dets) {
      const q = parse(d.label);
      if (!q || q[1] < 1 || q[1] > (Ns.get(q[0]) || 0)) { extra.push(d); continue; }
      const k = key(d.label);
      if (seen.has(k)) extra.push(d); else seen.add(k);
    }
    const found = new Set(dets.filter(d => !extra.includes(d)).map(d => parse(d.label).join('')));
    const missing = []; let N = 0;
    for (const [pre, n] of Ns) { N += n; for (let k = 1; k <= n; k++) if (!found.has(pre + k)) missing.push(pre + k); }
    const good = dets.filter(d => !extra.includes(d)), flagged = good.filter(d => d.flags.length);
    S.papers++; S.exp += N; S.found += N - missing.length; S.det += dets.length; S.extra += extra.length; S.frames += good.length; S.flagged += flagged.length;
    S.dotted += dets.filter(d => d.label.includes('.')).length;
    for (const d of good) for (const fl of d.flags) S.flags[fl] = (S.flags[fl] || 0) + 1;
    out.push({file: f, N, det: dets.length, missing, extra: extra.map(d => ({page: d.page, label: d.label, line: d.line.slice(-90)})), flagged: flagged.map(d => ({page: d.page, label: d.label, flags: d.flags}))});
    console.log(`${f.slice(0, 56).padEnd(56)} N ${String(N).padStart(3)} det ${String(dets.length).padStart(3)} missing ${missing.length ? (missing.length > 12 ? missing.length + ' (' + missing.slice(0, 8).join(',') + ',...)' : missing.join(',')) : '-'}  extra ${extra.length}  flagged ${flagged.length}`);
    if (detail) {
      for (const e of extra) console.log(`    EXTRA p${e.page} (${e.label}) | ${e.line.slice(-90)}`);
      for (const d of flagged) console.log(`    FRAME p${d.page} (${d.label}) ${d.flags.join(',')}`);
    }
  }
  const pc = (a, b) => b ? (100 * a / b).toFixed(1) + '%' : '-';
  console.log(`\nPDFS ${S.papers}  numbers 1..N expected ${S.exp}  found ${S.found} (${pc(S.found, S.exp)})  detected ${S.det}  extra ${S.extra} (${pc(S.extra, S.det)} of detections)  dotted labels ${S.dotted}`);
  console.log(`frames flagged ${S.flagged}/${S.frames} (${pc(S.flagged, S.frames)})  ${JSON.stringify(S.flags)}`);
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify({totals: S, results: out}, null, 1));
  process.exit(0);
}

const results = [];
const T = {exp: 0, det: 0, tp: 0, expPlain: 0, tpPlain: 0, frames: 0, flagged: 0, flags: {}, papers: 0};
for (const p of manifest) {
  const file = join(corpus, 'papers', p.key, 'paper.pdf');
  if (!existsSync(file)) continue;
  const run = await detectAll(file);
  if (!run) { console.log(`${p.key} unreadable`); continue; }
  const {dets, pages} = run;
  // Multiset matching by label.
  const pool = new Map(); for (const l of p.expected) pool.set(key(l), (pool.get(key(l)) || 0) + 1);
  const matched = [];
  for (const d of dets) { const k = key(d.label), c = pool.get(k) || 0; d.ok = c > 0; if (c > 0) { pool.set(k, c - 1); matched.push(k); } }
  const missed = []; for (const [k, c] of pool) for (let i = 0; i < c; i++) missed.push(k);
  // Where do missed labels appear in the text? "(n)" as its own item, at the end of an item, or not at all.
  const missInfo = missed.map(k => {
    const re = new RegExp(`\\(\\s*${k.replace(/[.]/g, '\\.')}\\s*\\)`, 'i');
    for (let n = 0; n < pages.length; n++) {
      const {boxes} = pages[n];
      const own = boxes.find(b => normParens(b.s).trim().toLowerCase().replace(/\s+/g, '') === `(${k})`);
      if (own) return {label: k, page: n + 1, where: 'item', line: lineText(boxes, own).slice(-90)};
    }
    for (let n = 0; n < pages.length; n++) {
      const {boxes} = pages[n];
      const inside = boxes.find(b => re.test(normParens(b.s)));
      if (inside) return {label: k, page: n + 1, where: 'inside-item', line: inside.s.slice(-90)};
    }
    return {label: k, page: 0, where: 'absent', line: ''};
  });
  const exp = p.expected.length, det = dets.length, tp = matched.length;
  const expPlain = p.expected.filter(plainLabel).length, tpPlain = matched.filter(plainLabel).length;
  const real = dets.filter(d => d.ok), flagged = real.filter(d => d.flags.length);
  T.exp += exp; T.det += det; T.tp += tp; T.expPlain += expPlain; T.tpPlain += tpPlain; T.frames += real.length; T.flagged += flagged.length; T.papers++;
  for (const d of real) for (const f of d.flags) T.flags[f] = (T.flags[f] || 0) + 1;
  const r = {key: p.key, cls: p.documentclass, twoCol: p.two_column, numbering: p.numbering, exp, det, tp, expPlain, tpPlain,
    recall: exp ? tp / exp : 1, precision: det ? tp / det : 1,
    false: dets.filter(d => !d.ok).map(d => ({page: d.page, label: d.label, line: d.line.slice(-90), x: +d.labelBox.x1.toFixed(3)})),
    missed: missInfo, flagged: flagged.map(d => ({page: d.page, label: d.label, flags: d.flags}))};
  results.push(r);
  const pct = x => (100 * x).toFixed(0).padStart(3) + '%';
  console.log(`${p.key.padEnd(18)} ${String(p.documentclass).slice(0, 10).padEnd(10)} ${p.two_column ? '2col' : '1col'} ${String(p.numbering).padEnd(7)} exp ${String(exp).padStart(3)} det ${String(det).padStart(3)} R ${pct(r.recall)} P ${pct(r.precision)} frames flagged ${flagged.length}`);
  if (detail) {
    for (const f of r.false) console.log(`    FALSE p${f.page} (${f.label}) x1=${f.x} | ${f.line}`);
    for (const m of r.missed) console.log(`    MISS (${m.label}) ${m.where}${m.page ? ' p' + m.page : ''} | ${m.line}`);
    for (const f of r.flagged) console.log(`    FRAME p${f.page} (${f.label}) ${f.flags.join(',')}`);
  }
}
const pct = (a, b) => b ? (100 * a / b).toFixed(1) + '%' : '-';
console.log(`\nPAPERS ${T.papers}  expected ${T.exp}  detected ${T.det}  matched ${T.tp}`);
console.log(`recall ${pct(T.tp, T.exp)}  (plain-numbered labels only: ${pct(T.tpPlain, T.expPlain)})  precision ${pct(T.tp, T.det)}`);
console.log(`frames of matched equations flagged ${T.flagged}/${T.frames} (${pct(T.flagged, T.frames)})  ${JSON.stringify(T.flags)}`);
const miss = {}; results.forEach(r => r.missed.forEach(m => miss[m.where] = (miss[m.where] || 0) + 1));
console.log(`missed by text form: ${JSON.stringify(miss)}`);
for (const sub of [['1col', r => !r.twoCol], ['2col', r => r.twoCol]]) {
  const rs = results.filter(sub[1]); const s = k => rs.reduce((a, r) => a + r[k], 0);
  console.log(`  ${sub[0]}: papers ${rs.length} recall ${pct(s('tp'), s('exp'))} plain ${pct(s('tpPlain'), s('expPlain'))} precision ${pct(s('tp'), s('det'))}`);
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({totals: T, results}, null, 1));
