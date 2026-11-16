// Export: a copy of a PDF with Margin's annotations written in as real PDF annotations (pdf-lib), the way
// Acrobat stores them: /Highlight with /QuadPoints, /Text sticky notes, and replies as /Text annotations
// that point at their parent with /IRT and /RT /R. Every annotation gets an appearance stream, so viewers
// that do not draw their own (pdf.js, Preview, Chrome) show it too. The input bytes are never changed.
//
//   annotatePdf(bytes, {items, importedPdfIds}) -> {pdf: Uint8Array, written, skipped} | {error: 'encrypted' | 'unreadable'}
//
// The annotations of the file listed in importedPdfIds (pdf.js ids: "123R", "123R2") were taken over by
// Margin and are written back from its copy, so the originals are left out, with their replies and pop-ups.
import pdfLib from 'pdf-lib';
import {PDF_ANNOT_ID} from './annotations.mjs';

const {PDFDocument, PDFName, PDFRef, PDFDict, PDFArray, PDFString, PDFHexString} = pdfLib;

export const AUTHOR = 'Margin';          // /T of annotations made in Margin (there is no user name setting)
export const HIGHLIGHT_OPACITY = 0.5;    // /CA and the appearance's fill opacity (blend mode Multiply)
export const NOTE_SIZE = 20;             // note icon, points
// Annotation flags: Print (4); replies also NoZoom (8) and NoRotate (16), as Acrobat writes them.
const F_PRINT = 4, F_REPLY = 28;

const N = s => PDFName.of(s);
const num = v => +(+v).toFixed(3);
const rgb = hex => [1, 3, 5].map(i => num(parseInt(hex.slice(i, i + 2), 16) / 255));
const validColor = c => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c : '#ffd400';
const idOf = ref => `${ref.objectNumber}R${ref.generationNumber || ''}`;
const dateOf = (v, fallback = new Date()) => { const t = Date.parse(v); return Number.isFinite(t) ? new Date(t) : fallback; };
const textOf = v => v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : '';

// The page as viewers display it: the crop box (inside the media box) turned by /Rotate.
// toPdf(u, v) maps a point normalised to the displayed page (origin top-left) to PDF user space.
export function pageGeometry(page) {
  const box = b => ({x0: Math.min(b.x, b.x + b.width), y0: Math.min(b.y, b.y + b.height), x1: Math.max(b.x, b.x + b.width), y1: Math.max(b.y, b.y + b.height)});
  const media = box(page.getMediaBox());
  let crop = box(page.getCropBox());
  crop = {x0: Math.max(crop.x0, media.x0), y0: Math.max(crop.y0, media.y0), x1: Math.min(crop.x1, media.x1), y1: Math.min(crop.y1, media.y1)};
  if (!(crop.x1 > crop.x0 && crop.y1 > crop.y0)) crop = media; // a crop box outside the page: viewers fall back to the media box
  const {x0, y0} = crop, w = crop.x1 - x0, h = crop.y1 - y0;
  const rot = ((Math.round(page.getRotation().angle / 90) * 90) % 360 + 360) % 360;
  const toPdf = rot === 90 ? (u, v) => [x0 + v * w, y0 + u * h]
    : rot === 180 ? (u, v) => [x0 + (1 - u) * w, y0 + v * h]
    : rot === 270 ? (u, v) => [x0 + (1 - v) * w, y0 + (1 - u) * h]
    : (u, v) => [x0 + u * w, y0 + (1 - v) * h];
  const sideways = rot === 90 || rot === 270;
  return {rot, W: sideways ? h : w, H: sideways ? w : h, toPdf};
}
const bounds = pts => { const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]); return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map(num); };

export async function annotatePdf(bytes, {items = [], importedPdfIds = []} = {}) {
  let doc;
  try { doc = await PDFDocument.load(bytes, {updateMetadata: false}); }
  catch (e) { return {error: /encrypted/i.test(String(e?.message)) ? 'encrypted' : 'unreadable'}; }
  try {
    const ctx = doc.context, pages = doc.getPages();
    const form = (content, dict) => ctx.register(ctx.flateStream(content, {Type: 'XObject', Subtype: 'Form', FormType: 1, ...dict}));

    // ---- leave out the originals that were imported, their replies and their pop-ups ----
    const gone = new Set((Array.isArray(importedPdfIds) ? importedPdfIds : []).filter(id => typeof id === 'string' && PDF_ANNOT_ID.test(id)));
    const authors = new Map(), replyAuthors = new Map(); // pdfId -> /T; pdfId of the thread's first annotation -> [{text, author}]
    if (gone.size) {
      const all = []; // {array, ref, dict}
      for (const page of pages) {
        const array = page.node.Annots();
        if (!(array instanceof PDFArray)) continue;
        for (let i = 0; i < array.size(); i++) {
          const ref = array.get(i), dict = ref instanceof PDFRef ? ctx.lookup(ref) : null;
          if (dict instanceof PDFDict) all.push({array, ref, dict});
        }
      }
      const removed = new Map(); // id -> id of the imported annotation it belongs to
      for (const a of all) if (gone.has(idOf(a.ref))) { removed.set(idOf(a.ref), idOf(a.ref)); authors.set(idOf(a.ref), textOf(a.dict.lookup(N('T')))); }
      for (let changed = true; changed;) {
        changed = false;
        for (const a of all) {
          if (removed.has(idOf(a.ref))) continue;
          const irt = a.dict.get(N('IRT')), parent = a.dict.get(N('Parent')), popup = a.dict.get(N('Subtype')) === N('Popup');
          const to = irt instanceof PDFRef ? irt : popup && parent instanceof PDFRef ? parent : null;
          if (!to || !removed.has(idOf(to))) continue;
          const first = removed.get(idOf(to));
          removed.set(idOf(a.ref), first); changed = true;
          if (!popup) { if (!replyAuthors.has(first)) replyAuthors.set(first, []); replyAuthors.get(first).push({text: textOf(a.dict.lookup(N('Contents'))).trim(), author: textOf(a.dict.lookup(N('T')))}); }
        }
      }
      for (const a of all) {
        if (!removed.has(idOf(a.ref))) continue;
        const i = a.array.indexOf(a.ref);
        if (i >= 0) a.array.remove(i);
        ctx.delete(a.ref); // the old comment must not stay in the file as an unused object
      }
    }

    // ---- write Margin's annotations ----
    const str = s => PDFHexString.fromText(String(s ?? ''));
    const finish = (dict, {contents, author, created, modified, name, subject}) => {
      dict.set(N('Contents'), str(contents)); dict.set(N('T'), str(author)); dict.set(N('NM'), str(name)); dict.set(N('Subj'), str(subject));
      dict.set(N('CreationDate'), PDFString.fromDate(created)); dict.set(N('M'), PDFString.fromDate(modified));
      return ctx.register(dict);
    };
    let written = 0, skipped = 0;
    for (const a of Array.isArray(items) ? items : []) {
      const page = Number.isInteger(a?.page) ? pages[a.page - 1] : null, rects = Array.isArray(a?.rects) ? a.rects : [];
      if (!page || !rects.length || (a.kind !== 'highlight' && a.kind !== 'note')) { skipped++; continue; }
      const g = pageGeometry(page), color = rgb(validColor(a.color)), C = color.join(' ');
      const created = dateOf(a.createdAt), modified = dateOf(a.updatedAt, created);
      const original = a.origin === 'pdf' && authors.get(a.pdfId);
      const meta = {contents: a.comment, author: original || AUTHOR, created, modified, name: `margin-${a.id}`};
      let rect, ref;
      if (a.kind === 'highlight') {
        // One quad per text line, corners in Acrobat's order (top-left, top-right, bottom-left, bottom-right as the text reads).
        const quads = rects.map(r => [g.toPdf(r.x0, r.y0), g.toPdf(r.x1, r.y0), g.toPdf(r.x0, r.y1), g.toPdf(r.x1, r.y1)]);
        rect = bounds(quads.flat());
        const paths = quads.map(([tl, tr, bl, br]) => `${num(tl[0])} ${num(tl[1])} m ${num(tr[0])} ${num(tr[1])} l ${num(br[0])} ${num(br[1])} l ${num(bl[0])} ${num(bl[1])} l h`).join('\n');
        const ap = form(`/GS0 gs\n${C} rg\n${paths}\nf\n`, {BBox: rect,
          Resources: {ExtGState: {GS0: {Type: 'ExtGState', BM: 'Multiply', ca: HIGHLIGHT_OPACITY, CA: HIGHLIGHT_OPACITY, AIS: false}}}});
        ref = finish(ctx.obj({Type: 'Annot', Subtype: 'Highlight', Rect: rect, QuadPoints: quads.flat(2).map(num), C: color, CA: HIGHLIGHT_OPACITY, F: F_PRINT, P: page.ref, AP: {N: ap}}),
          {...meta, subject: 'Highlight'});
      } else {
        // The icon's box on the displayed page (kept inside the page), and an appearance turned so it is upright there.
        const s = Math.min(NOTE_SIZE, g.W, g.H), u = Math.min(rects[0].x0, 1 - s / g.W), v = Math.min(rects[0].y0, 1 - s / g.H);
        rect = bounds([g.toPdf(u, v), g.toPdf(u + s / g.W, v + s / g.H)]);
        const t = g.rot * Math.PI / 180, cos = Math.round(Math.cos(t)), sin = Math.round(Math.sin(t));
        const dark = color.map(c => num(c * 0.35)).join(' ');
        const icon = `q\n1 w 1 j ${dark} RG ${C} rg\n1.5 6.5 m 1.5 18.5 l 18.5 18.5 l 18.5 6.5 l 9.5 6.5 l 5 1.5 l 5 6.5 l h B\n0.8 w 4.5 15.2 m 15.5 15.2 l 4.5 12.5 m 15.5 12.5 l 4.5 9.8 m 11 9.8 l S\nQ\n`;
        const ap = form(icon, {BBox: [0, 0, NOTE_SIZE, NOTE_SIZE], Matrix: [cos, sin, -sin, cos, 0, 0]});
        ref = finish(ctx.obj({Type: 'Annot', Subtype: 'Text', Name: 'Comment', Open: false, Rect: rect, C: color, F: F_PRINT, P: page.ref, AP: {N: ap}}),
          {...meta, subject: 'Sticky Note'});
      }
      page.node.addAnnot(ref); written++;
      // Replies: /Text annotations in reply to (IRT) the annotation, drawn as nothing (empty appearance, empty box at its corner).
      const known = [...(replyAuthors.get(a.pdfId) || [])];
      let last = created.getTime();
      for (const r of Array.isArray(a.replies) ? a.replies : []) {
        if (!r || typeof r.text !== 'string') continue;
        const at = new Date(Math.max(dateOf(r.at, created).getTime(), last + 1000)); // strictly later than the one before, so the order survives
        last = at.getTime();
        const k = r.author === 'ai' ? -1 : known.findIndex(x => x.text === r.text.trim());
        const author = r.author === 'ai' ? (r.model ? `AI (${r.model})` : 'AI') : (k >= 0 && known.splice(k, 1)[0].author) || AUTHOR;
        const corner = [rect[0], rect[3], rect[0], rect[3]];
        const reply = finish(ctx.obj({Type: 'Annot', Subtype: 'Text', Name: 'Comment', Open: false, Rect: corner, C: color, F: F_REPLY, P: page.ref, IRT: ref, RT: 'R',
          AP: {N: form('', {BBox: [0, 0, 0, 0]})}}), {contents: r.text, author, created: at, modified: at, name: `margin-${a.id}-${r.id}`, subject: 'Sticky Note'});
        page.node.addAnnot(reply);
      }
    }
    return {pdf: await doc.save(), written, skipped};
  } catch (e) {
    return {error: 'unreadable', detail: String(e?.message || e).slice(0, 300)};
  }
}
