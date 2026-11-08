// How well snapping restores equation frames from rough boxes (development tool; PDFs are not in the repo).
// Usage: node scripts/eq-snap-eval.mjs [--sigma 0.01,0.02] [--ink] [--seed 1] file.pdf ...
// For every automatically detected equation, each edge of its frame is moved at random (normal noise,
// sigma as a fraction of the page height; horizontal noise twice that) to imitate a model's rough box.
// The noisy box is then snapped to the page's text (snapToText) and, with --ink, to the ink of the page
// rendered by pdftoppm (snapToInk, as for scanned pages). Reported: mean IoU with the detector's frame,
// and the share of frames with IoU >= 0.8. The detector pads its frames (to the column edge on the number's
// side), so "tight" compares with the detector's frame snapped to its own text, and for ink the reference
// is the ink snap of the true frame. "same" (with --ink) compares snapBox of the noisy frame with snapBox of
// the true frame: whether snapping restores the frame it would give for a perfect answer.
import * as pdfjs from '../node_modules/pdfjs-dist/legacy/build/pdf.mjs';
import {readFileSync, mkdtempSync, rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join, basename} from 'node:path';
import {textBoxes, detectEquations} from '../src/layout.js';
import {snapToText, snapToInk, snapBox, iou} from '../lib/equations.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : d; };
const sigmas = opt('--sigma', '0.005,0.01,0.02').split(',').map(Number);
let seed = Number(opt('--seed', '1'));
const ink = args.includes('--ink'), files = args.filter(a => !a.startsWith('--'));
const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const gauss = () => Math.sqrt(-2 * Math.log(rand() || 1e-9)) * Math.cos(2 * Math.PI * rand());
const clamp = v => Math.min(1, Math.max(0, v));
function noisy(b, s) {
  const x0 = clamp(b.x0 + 2 * s * gauss()), x1 = clamp(b.x1 + 2 * s * gauss()), y0 = clamp(b.y0 + s * gauss()), y1 = clamp(b.y1 + s * gauss());
  return {x0: Math.min(x0, x1 - 0.005), x1: Math.max(x1, x0 + 0.005), y0: Math.min(y0, y1 - 0.003), y1: Math.max(y1, y0 + 0.003)};
}
function pgm(file, page, dpi = 150) { // grey page image via pdftoppm
  const dir = mkdtempSync(join(tmpdir(), 'snap-'));
  try {
    execFileSync('pdftoppm', ['-gray', '-r', String(dpi), '-f', String(page), '-l', String(page), file, join(dir, 'p')]);
    const out = readFileSync(join(dir, execFileSync('ls', [dir]).toString().trim().split('\n')[0]));
    let i = 0; const tok = () => { while (/\s/.test(String.fromCharCode(out[i]))) i++; let s = ''; while (!/\s/.test(String.fromCharCode(out[i]))) s += String.fromCharCode(out[i++]); return s; };
    tok(); const width = Number(tok()), height = Number(tok()); tok(); i++;
    return {gray: out.subarray(i, i + width * height), width, height};
  } finally { rmSync(dir, {recursive: true, force: true}); }
}

const stats = {};
const rec = (k, v) => { (stats[k] ??= []).push(v); };
for (const file of files) {
  const doc = await pdfjs.getDocument({data: new Uint8Array(readFileSync(file)), verbosity: 0}).promise;
  let n = 0;
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p), vp = page.getViewport({scale: 1}), items = textBoxes((await page.getTextContent()).items, vp, pdfjs.Util);
    const eqs = detectEquations(items, vp.width, vp.height); if (!eqs.length) continue;
    const img = ink ? pgm(file, p) : null;
    for (const e of eqs) {
      n++;
      const refInk = img ? snapToInk(img.gray, img.width, img.height, e.box) : null;
      const refText = snapToText(e.box, items, vp.width, vp.height)?.box; // the detector's frame, tightened
      const refSnap = img ? snapBox(e.box, items, vp.width, vp.height, img, e.label).box : null; // what snapping makes of the true frame
      for (const s of sigmas) {
        const b = noisy(e.box, s);
        rec(`noisy ${s}`, iou(b, e.box));
        const t = snapToText(b, items, vp.width, vp.height, e.label);
        rec(`text ${s}`, t ? iou(t.box, e.box) : iou(b, e.box)); rec(`text-miss ${s}`, t ? 0 : 1);
        if (refText) { rec(`tight-noisy ${s}`, iou(b, refText)); rec(`tight ${s}`, t ? iou(t.box, refText) : iou(b, refText)); rec(`tight-ink ${s}`, iou(snapBox(b, items, vp.width, vp.height, img, e.label).box, refText)); }
        rec(`snapBox ${s}`, iou(snapBox(b, items, vp.width, vp.height, img, e.label).box, e.box));
        if (refSnap) { rec(`same-noisy ${s}`, iou(b, refSnap)); rec(`same ${s}`, iou(snapBox(b, items, vp.width, vp.height, img, e.label).box, refSnap)); }
        if (img && refInk) {
          const k = snapToInk(img.gray, img.width, img.height, b);
          rec(`ink-noisy ${s}`, iou(b, refInk)); rec(`ink ${s}`, k ? iou(k, refInk) : iou(b, refInk));
        }
      }
    }
  }
  console.error(`${basename(file)}: ${n} equations`);
  await doc.loadingTask?.destroy();
}
const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
for (const [k, v] of Object.entries(stats)) console.log(`${k.padEnd(16)} n=${String(v.length).padStart(4)}  mean ${mean(v).toFixed(3)}${k.includes('miss') ? '' : `  >=0.8: ${(100 * v.filter(x => x >= 0.8).length / v.length).toFixed(0)}%`}`);
