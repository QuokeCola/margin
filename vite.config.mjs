import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
// KaTeX's stylesheet lists each font as woff2, woff and ttf; every browser Margin runs in
// (Electron's Chromium, current Chrome/Edge/Firefox/Safari) uses woff2, so only those are shipped.
const katexWoff2Only = {
  name: 'katex-woff2-only',
  enforce: 'pre',
  transform(code, id) {
    if (!/katex(\.min)?\.css(\?|$)/.test(id)) return null;
    return {code: code.replace(/,\s*url\([^)]*\.woff\) format\("woff"\)/g, '').replace(/,\s*url\([^)]*\.ttf\) format\("truetype"\)/g, ''), map: null};
  },
};
// pdf.js decodes JBIG2 and CCITT fax images (common in scanned papers), JPEG 2000 images and
// ICC colour with WebAssembly modules it loads at run time from `wasmUrl`. Ship them under a
// fixed folder name (pdf.js asks for these exact file names) and serve them in development too.
const WASM_DIR = 'pdfjs-wasm/';
const wasmSrc = fileURLToPath(new URL('node_modules/pdfjs-dist/wasm/', import.meta.url));
const wasmFiles = readdirSync(wasmSrc).filter(f => /\.(wasm|js)$/.test(f) && !f.startsWith('quickjs')); // quickjs: PDF scripting, unused
const pdfjsWasm = {
  name: 'pdfjs-wasm',
  configureServer(server) {
    server.middlewares.use('/' + WASM_DIR, (req, res, next) => {
      const name = decodeURIComponent((req.url || '').split('?')[0].replace(/^\//, ''));
      if (!wasmFiles.includes(name)) return next();
      res.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
      res.end(readFileSync(join(wasmSrc, name)));
    });
  },
  generateBundle() {
    for (const f of wasmFiles) this.emitFile({type: 'asset', fileName: WASM_DIR + f, source: readFileSync(join(wasmSrc, f))});
  },
};
export default {plugins: [katexWoff2Only, pdfjsWasm]};
