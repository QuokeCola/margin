// Worker thread for lib/project-index.mjs: runs pdf.js (page text, page layout, equation crops) so it never
// blocks the server's event loop.
import {parentPort} from 'node:worker_threads';
import {runJob} from './pdf-text.mjs';

parentPort.on('message', async ({job, kind, file, args}) => {
  try { parentPort.postMessage({job, ok: await runJob(kind, file, args)}); }
  catch (e) { parentPort.postMessage({job, err: String(e?.message || e)}); }
});
