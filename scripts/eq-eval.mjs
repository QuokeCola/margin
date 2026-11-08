// Equation-detection report for a set of PDFs (development tool; PDFs are not part of the repo).
// Usage: node scripts/eq-eval.mjs [--detail] file.pdf ...
// Equation numbers should run 1..N, so gaps suggest misses and duplicates suggest false hits.
// Frames are flagged when implausible: very tall/wide, overlapping, covering prose, or empty.
import * as pdfjs from '../node_modules/pdfjs-dist/legacy/build/pdf.mjs';
import {readFileSync} from 'node:fs';
import {basename} from 'node:path';
import {textBoxes, detectEquations} from '../src/layout.js';

const detail = process.argv.includes('--detail');
const files = process.argv.slice(2).filter(a => !a.startsWith('--'));
// Same notion of "word" as the detector: lowercase, has a vowel, not a math name.
const MATH = new Set('sin cos tan exp log max min sup inf det diag sgn sign arg mod rank trace span tanh sinh cosh rms var std ext int tot ref des act est obs nom eff err cmd dyn rel abs fric meas init'.split(' '));
const words = s => (s.match(/\b[a-z]{3,}\b/g) || []).filter(w => /[aeiouy]/.test(w) && !MATH.has(w)).length;
let totals = {eqs: 0, missing: 0, dups: 0, flags: 0};

for (const file of files) {
  const doc = await pdfjs.getDocument({data: new Uint8Array(readFileSync(file)), verbosity: 0}).promise;
  const all = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n), vp = page.getViewport({scale: 1}), tc = await page.getTextContent();
    const boxes = textBoxes(tc.items, vp, pdfjs.Util), W = vp.width, H = vp.height;
    const eqs = detectEquations(boxes, W, H);
    for (const e of eqs) {
      const b = e.box, flags = [];
      if (b.y1 - b.y0 > 0.15) flags.push(`tall ${((b.y1 - b.y0) * 100).toFixed(0)}%`);
      if (b.x1 - b.x0 > 0.9) flags.push('wide');
      const inside = boxes.filter(t => t.s.trim() && t.x0 / W >= b.x0 - 0.005 && t.x1 / W <= b.x1 + 0.005 && t.y0 / H >= b.y0 - 0.005 && t.y1 / H <= b.y1 + 0.005);
      const w = words(inside.map(t => t.s).join(' '));
      if (w >= 10) flags.push(`prose ${w}w`);
      if (inside.filter(t => !/^\(?\s*\d+[a-z]?\s*\)?$/.test(t.s.trim())).length === 0) flags.push('empty');
      for (const o of eqs) if (o !== e && o.box.x0 < b.x1 && o.box.x1 > b.x0) {
        const ov = Math.min(o.box.y1, b.y1) - Math.max(o.box.y0, b.y0);
        if (ov > 0.3 * Math.min(o.box.y1 - o.box.y0, b.y1 - b.y0)) { flags.push(`overlaps (${o.label})`); break; }
      }
      all.push({page: n, ...e, flags, text: inside.map(t => t.s).join(' ').replace(/\s+/g, ' ').slice(0, 70)});
    }
  }
  const nums = all.map(e => parseInt(e.label)).filter(Number.isFinite);
  const max = Math.max(0, ...nums), seen = new Set(nums);
  const missing = []; for (let i = 1; i <= max; i++) if (!seen.has(i)) missing.push(i);
  const counts = {}; all.forEach(e => counts[e.label] = (counts[e.label] || 0) + 1);
  const dups = Object.entries(counts).filter(([, c]) => c > 1).map(([l, c]) => `${l}×${c}`);
  const flagged = all.filter(e => e.flags.length);
  totals.eqs += all.length; totals.missing += missing.length; totals.dups += dups.length; totals.flags += flagged.length;
  console.log(`${basename(file).slice(0, 58).padEnd(58)} ${String(all.length).padStart(3)} eqs  max ${String(max).padStart(3)}  missing ${missing.length ? missing.join(',') : '-'}  dups ${dups.length ? dups.join(',') : '-'}  flagged ${flagged.length}`);
  if (detail) for (const e of flagged) console.log(`    p${e.page} (${e.label}) ${e.flags.join(', ')} | ${e.text}`);
}
console.log(`TOTAL ${totals.eqs} equations, ${totals.missing} missing numbers, ${totals.dups} duplicated labels, ${totals.flags} flagged frames`);
