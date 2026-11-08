// Page text of a PDF with pdf.js, laid out the way the reader builds it in the app, so quotes match
// what it highlights. Runs in a worker thread (lib/extract-worker.mjs) or, as a fallback, in-process.
import {readFile} from 'node:fs/promises';

export const MAX_PAGES = 300, MAX_PAGE_CHARS = 30000, MAX_CHARS = 600000;

export async function extractPages(file) {
  const {getDocument} = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({data: new Uint8Array(await readFile(file)), isEvalSupported: false, verbosity: 0});
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
