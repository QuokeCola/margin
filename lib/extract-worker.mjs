// Worker thread for lib/project-index.mjs: extracts page text so pdf.js never blocks the server's event loop.
import {parentPort} from 'node:worker_threads';
import {extractPages} from './pdf-text.mjs';

parentPort.on('message', async ({job, file}) => {
  try { parentPort.postMessage({job, ok: await extractPages(file)}); }
  catch (e) { parentPort.postMessage({job, err: String(e?.message || e)}); }
});
