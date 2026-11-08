// Page text of a PDF with pdf.js, laid out the way the reader builds it in the app, so quotes match
// what it highlights. Runs in a worker thread (lib/extract-worker.mjs) or, as a fallback, in-process.
// Also: the text items and automatic equation detections of every page (the app's src/layout.js, run here
// for project chats, which cite papers that are not open in the app) and cropped images of equations.
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname, join} from 'node:path';
import {cropGeometry, PNG_MAX, JPEG_QUALITY, IMAGE_MAX} from './eq-context.mjs';

export const MAX_PAGES = 300, MAX_PAGE_CHARS = 30000, MAX_CHARS = 600000;

const pdfjs = () => import('pdfjs-dist/legacy/build/pdf.mjs');
// pdf.js's WebAssembly decoders (JBIG2 and JPEG 2000 images, common in scans) and standard fonts, for rendering.
let assets;
function assetDirs() {
  if (assets !== undefined) return assets;
  try {
    const root = join(dirname(createRequire(import.meta.url).resolve('pdfjs-dist/legacy/build/pdf.mjs')), '..', '..');
    assets = {wasmUrl: join(root, 'wasm') + '/', standardFontDataUrl: join(root, 'standard_fonts') + '/'};
  } catch { assets = {}; }
  return assets;
}
async function open(file, render = false) {
  const {getDocument} = await pdfjs();
  return getDocument({data: new Uint8Array(await readFile(file)), isEvalSupported: false, verbosity: 0, ...(render ? assetDirs() : {})});
}

export async function extractPages(file) {
  const task = await open(file);
  try {
    const doc = await task.promise, pages = [];
    let total = 0;
    for (let n = 1; n <= Math.min(doc.numPages, MAX_PAGES); n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      page.cleanup(); // frees the page's fonts and operator lists; the text is already collected
      let text = content.items.filter(t => typeof t.str === 'string').map(t => t.str + (t.hasEOL ? '\n' : ' ')).join('').slice(0, MAX_PAGE_CHARS);
      text = text.slice(0, Math.max(0, MAX_CHARS - total)); total += text.length;
      pages.push({page: n, text});
    }
    return {pages, numPages: doc.numPages};
  } finally { await task.destroy().catch(() => {}); }
}

// Per page: its size in points, the text items [s, x0, y0, x1, y1] (rounded to 0.1 pt) and the automatic
// equation detections [{label, box}], as the app computes them when it opens the paper.
export async function extractLayout(file) {
  const [{Util}, {textBoxes, detectEquations}] = await Promise.all([pdfjs(), import('../src/layout.js')]);
  const task = await open(file);
  const r = v => Math.round(v * 10) / 10;
  try {
    const doc = await task.promise, pages = [];
    for (let n = 1; n <= Math.min(doc.numPages, MAX_PAGES); n++) {
      const page = await doc.getPage(n), vp = page.getViewport({scale: 1});
      const items = (await page.getTextContent()).items.filter(t => typeof t.str === 'string');
      page.cleanup();
      const boxes = textBoxes(items, vp, Util);
      const auto = detectEquations(boxes, vp.width, vp.height).map(e => ({label: e.label, box: e.box}));
      pages.push({page: n, W: r(vp.width), H: r(vp.height), auto, items: boxes.filter(b => b.s.trim()).map(b => [b.s, r(b.x0), r(b.y0), r(b.x1), r(b.y1)])});
    }
    return {pages, numPages: doc.numPages};
  } finally { await task.destroy().catch(() => {}); }
}

// Crops [{page, box}] rendered as data URLs (PNG, or JPEG when the PNG would be large); null for a crop that
// failed. Needs @napi-rs/canvas (pdf.js's Node canvas); without it every crop is null.
export async function renderCrops(file, crops) {
  const task = await open(file, true);
  try {
    const doc = await task.promise, out = [];
    for (const c of crops) {
      try {
        const page = await doc.getPage(c.page), base = page.getViewport({scale: 1});
        const g = cropGeometry(c.box, base.width, base.height);
        const vp = page.getViewport({scale: g.scale, offsetX: -g.x, offsetY: -g.y});
        const {canvas, context} = doc.canvasFactory.create(g.w, g.h);
        context.fillStyle = '#fff'; context.fillRect(0, 0, g.w, g.h);
        await page.render({canvasContext: context, canvas, viewport: vp, background: '#fff'}).promise;
        let url = 'data:image/png;base64,' + canvas.toBuffer('image/png').toString('base64');
        if (url.length > PNG_MAX) url = 'data:image/jpeg;base64,' + canvas.toBuffer('image/jpeg', Math.round(JPEG_QUALITY * 100)).toString('base64');
        doc.canvasFactory.destroy({canvas, context});
        out.push(url.length <= IMAGE_MAX ? url : null);
      } catch { out.push(null); }
    }
    return out;
  } finally { await task.destroy().catch(() => {}); }
}

export function runJob(kind = 'text', file, args) {
  if (kind === 'layout') return extractLayout(file);
  if (kind === 'crops') return renderCrops(file, args);
  return extractPages(file);
}
