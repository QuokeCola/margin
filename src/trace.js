// The floating "where does this citation come from" card. A click on a reference marker whose paper is in
// the project asks the server where in that paper the citing sentence comes from
// (POST /api/papers/:id/trace-citation, lib/citation-trace.mjs) and shows the answer here: the cited paper,
// the verdict with its note, and for each quote the words, their page and a picture of that part of the page
// with the words highlighted. The cited PDF is opened as a second pdf.js document only for those pictures
// and freed when the card closes.
import {textBoxes} from './layout.js';
import {preparePage, locateQuote} from './quote.js';

// The part of a page shown around highlighted words, in page fractions. rects: the highlight rectangles.
export const PREVIEW = {padX: 0.03, padY: 0.03, minWidth: 0.5, maxHeight: 0.4, maxScale: 4, maxRatio: 2};
export function previewCrop(rects) {
  const c = v => Math.min(1, Math.max(0, v));
  let x0 = Math.min(...rects.map(r => r.x0)) - PREVIEW.padX, x1 = Math.max(...rects.map(r => r.x1)) + PREVIEW.padX;
  if (x1 - x0 < PREVIEW.minWidth) { const mid = (x0 + x1) / 2; x0 = mid - PREVIEW.minWidth / 2; x1 = mid + PREVIEW.minWidth / 2; }
  if (x0 < 0) { x1 -= x0; x0 = 0; }
  if (x1 > 1) { x0 -= x1 - 1; x1 = 1; }
  const y0 = c(Math.min(...rects.map(r => r.y0)) - PREVIEW.padY);
  const y1 = c(Math.min(Math.max(...rects.map(r => r.y1)) + PREVIEW.padY, y0 + PREVIEW.maxHeight)); // a long quote: its start
  return {x0: c(x0), y0, x1: c(x1), y1};
}
// Where a card of w × h goes next to the rectangle `near` (the reference card) in a window of W × H without
// covering it: right of it, else left, else below, else above (with the height left there), else the top right corner.
export const CARD = {gap: 10, edge: 8, minSlot: 220};
export function placeCard(near, w, h, W, H) {
  const {gap, edge, minSlot} = CARD, top = Math.max(edge, Math.min(near.top, H - h - edge));
  if (near.right + gap + w <= W - edge) return {left: near.right + gap, top};
  if (near.left - gap - w >= edge) return {left: near.left - gap - w, top};
  const left = Math.max(edge, Math.min(near.left, W - w - edge));
  if (H - edge - near.bottom - gap >= minSlot) return {left, top: near.bottom + gap, maxHeight: H - edge - near.bottom - gap};
  if (near.top - gap - edge >= minSlot) { const room = near.top - gap - edge, used = Math.min(h, room); return {left, top: near.top - gap - used, maxHeight: room, above: true}; }
  return {left: Math.max(edge, W - w - edge), top: edge};
}

const STATUS = {
  found: ['ok', 'Source found'], general: ['plain', 'Cited as a whole'], none: ['plain', 'No matching passage'],
  unverified: ['warn', 'Not checked'], error: ['warn', 'Could not trace'],
};

// opts: {h, api, pdfjs, wasmUrl, openAt(paperId, page, quote)}
export function createTraceCard({h, api, pdfjs, wasmUrl, openAt}) {
  let card = null, run = null; // run: {abort, docs: Map(paper id -> Promise<doc>), tasks: [pdf.js loading tasks], queue}

  const clamp = () => {
    if (!card) return;
    // offset sizes, not the bounding rectangle: that one is scaled while the card's opening animation runs
    card.style.left = Math.max(CARD.edge, Math.min(card.offsetLeft, innerWidth - card.offsetWidth - CARD.edge)) + 'px';
    card.style.top = Math.max(CARD.edge, Math.min(card.offsetTop, innerHeight - card.offsetHeight - CARD.edge)) + 'px';
  };
  const resized = new ResizeObserver(() => { if (card?.dataset.above && !card.dataset.moved) card.style.top = Number(card.dataset.bottom) - card.offsetHeight + 'px'; clamp(); });
  addEventListener('resize', clamp);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });

  function close() {
    const r = run; run = null;
    if (r) { r.abort.abort(); for (const t of r.tasks) t.destroy().catch(() => {}); } // stops the request and frees the cited PDFs
    if (card) { resized.disconnect(); card.remove(); card = null; }
  }

  // The cited paper as a second pdf.js document, loaded once per card.
  function docOf(r, id) {
    if (!r.docs.has(id)) r.docs.set(id, (async () => {
      const bytes = await api(`/api/papers/${id}/pdf`, {binary: true, signal: r.abort.signal});
      if (r.abort.signal.aborted) throw Error('closed');
      const task = pdfjs.getDocument({data: bytes, wasmUrl});
      r.tasks.push(task);
      return task.promise;
    })());
    return r.docs.get(id);
  }
  // A picture of the part of the page that holds `words`, with them highlighted; pictures are drawn one at a time.
  function preview(r, holder, id, pageNum, words) {
    r.queue = r.queue.then(async () => {
      if (r.abort.signal.aborted) return;
      try {
        const doc = await docOf(r, id), page = await doc.getPage(pageNum), base = page.getViewport({scale: 1});
        const items = (await page.getTextContent()).items.filter(t => typeof t.str === 'string');
        const found = locateQuote([{page: pageNum, prepared: preparePage(textBoxes(items, base, pdfjs.Util)), W: base.width, H: base.height}], pageNum, words);
        if (r.abort.signal.aborted) return;
        if (!found) { holder.replaceChildren(h('small', {className: 'hint', textContent: 'The words could not be located on the page picture.'})); return; }
        const crop = previewCrop(found.rects), wPts = (crop.x1 - crop.x0) * base.width, hPts = (crop.y1 - crop.y0) * base.height;
        const scale = Math.min(PREVIEW.maxScale, (holder.clientWidth || 400) * Math.min(devicePixelRatio || 1, PREVIEW.maxRatio) / wPts);
        const vp = page.getViewport({scale, offsetX: -crop.x0 * base.width * scale, offsetY: -crop.y0 * base.height * scale});
        const canvas = h('canvas', {width: Math.round(wPts * scale), height: Math.round(hPts * scale), className: 'trace-shot'}), c = canvas.getContext('2d');
        await page.render({canvasContext: c, viewport: vp}).promise;
        if (r.abort.signal.aborted) return;
        c.globalCompositeOperation = 'multiply';
        c.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--hl-text').trim() || 'rgba(246,216,95,.45)';
        for (const q of found.rects) c.fillRect((q.x0 - crop.x0) * base.width * scale, (q.y0 - crop.y0) * base.height * scale, (q.x1 - q.x0) * base.width * scale, (q.y1 - q.y0) * base.height * scale);
        canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', `Part of page ${pageNum} with the words highlighted`);
        holder.replaceChildren(canvas);
      } catch (e) {
        if (!r.abort.signal.aborted) holder.replaceChildren(h('small', {className: 'hint', textContent: 'The page picture could not be drawn.'}));
      }
    });
  }

  // One quote (or, unverified, one search match): picture, words, page, and the way to that spot.
  function spot(r, target, {page, words, verified}) {
    const shot = h('div', {className: 'trace-shot-box'}, h('small', {className: 'hint', textContent: 'Drawing the page…'}));
    const el = h('div', {className: 'trace-spot' + (verified ? '' : ' unverified')}, shot,
      h('blockquote', {className: 'trace-quote', textContent: words}),
      h('div', {className: 'trace-row'}, h('span', {className: 'trace-page', textContent: `p. ${page}`}),
        h('button', {className: 'small', type: 'button', textContent: 'Open at this spot', title: 'Opens the cited paper here and highlights these words', onclick: () => openAt(target.id, page, words.replace(/…$/, ''))})));
    preview(r, shot, target.id, page, words.replace(/…$/, ''));
    return el;
  }

  function show(r, section, target, cite, res) {
    const [tone, label] = STATUS[res.status] || STATUS.error, kids = [];
    kids.push(h('div', {className: 'trace-state'}, h('span', {className: 'trace-badge ' + tone, textContent: label}), h('span', {className: 'trace-note', textContent: res.note || ''})));
    for (const q of res.quotes || []) kids.push(spot(r, target, {page: q.page, words: q.quote, verified: true}));
    if (res.matches?.length) {
      kids.push(h('p', {className: 'trace-warn', textContent: `Closest search matches (by ${res.mode === 'embeddings' ? 'meaning' : 'shared words'}). Not checked against the sentence: they may not be its source.`}));
      for (const m of res.matches) kids.push(spot(r, target, {page: m.page, words: m.text, verified: false}));
    }
    const how = res.status === 'error' ? '' : res.verified ? `${res.model || 'Model'} · quotes checked against the paper's text${res.cached ? ' · saved answer' : ''}` : 'No model answer';
    kids.push(h('div', {className: 'trace-row trace-foot'}, h('small', {className: 'hint', textContent: how}),
      h('button', {className: 'small', type: 'button', textContent: 'Retry', title: 'Ask again, ignoring the saved answer', onclick: () => trace(r, section, target, cite, true)})));
    section.querySelector('.trace-result').replaceChildren(...kids);
  }

  async function trace(r, section, target, cite, retry = false) {
    if (r !== run) return;
    section.querySelector('.trace-result').replaceChildren(h('div', {className: 'trace-state'}, h('span', {className: 'trace-badge busy', textContent: 'Looking…'}), h('span', {className: 'trace-note', textContent: 'Searching the cited paper for this sentence.'})));
    let res;
    try {
      res = await api(`/api/papers/${r.paperId}/trace-citation`, {body: {targetId: target.id, refNum: target.n, sentence: cite.sentence, context: {before: cite.before, after: cite.after}, ...(retry ? {retry: true} : {})}, signal: r.abort.signal});
    } catch (e) { if (r.abort.signal.aborted) return; res = {status: 'error', note: e.message}; }
    if (r === run && !r.abort.signal.aborted) show(r, section, target, cite, res);
  }

  // paperId: the open (citing) paper; targets: [{n, id, title}] cited papers that are in the project;
  // cite: {sentence, before, after} or null when the sentence could not be read; near: the reference card's rectangle.
  function open({paperId, targets, cite, near}) {
    close();
    const r = run = {paperId, abort: new AbortController(), docs: new Map(), tasks: [], queue: Promise.resolve()};
    const head = h('div', {className: 'trace-head', title: 'Drag to move'}, h('span', {textContent: 'Where this comes from'}),
      h('button', {className: 'icon', type: 'button', textContent: '×', title: 'Close (Esc)', ariaLabel: 'Close', onclick: close}));
    const body = h('div', {className: 'trace-body'});
    if (cite) body.append(h('blockquote', {className: 'trace-sentence', title: 'The citing sentence that was traced', textContent: cite.sentence}));
    const sections = targets.map(t => h('section', {className: 'trace-target'},
      h('div', {className: 'ref-head'}, h('span', {className: 'ref-num', textContent: `[${t.n}]`}), h('span', {className: 'ref-title', textContent: t.title})),
      h('div', {className: 'trace-result'})));
    body.append(...sections);
    card = h('div', {id: 'trace-card'}, head, body);
    card.setAttribute('role', 'dialog'); card.setAttribute('aria-label', 'Source of the citation');
    document.body.append(card);
    const p = placeCard(near, card.offsetWidth, card.offsetHeight, innerWidth, innerHeight);
    card.style.left = p.left + 'px'; card.style.top = p.top + 'px';
    if (p.maxHeight) card.style.maxHeight = p.maxHeight + 'px';
    if (p.above) { card.dataset.above = '1'; card.dataset.bottom = p.top + card.offsetHeight; } // grows upwards, away from the reference card
    resized.observe(card);

    // Drag by the header; the card stays inside the window.
    head.addEventListener('pointerdown', e => {
      if (e.button !== 0 || e.target.closest('button')) return;
      const dx = e.clientX - card.offsetLeft, dy = e.clientY - card.offsetTop;
      card.dataset.moved = '1'; card.style.maxHeight = '';
      head.setPointerCapture(e.pointerId); e.preventDefault();
      const move = ev => {
        card.style.left = Math.max(CARD.edge, Math.min(ev.clientX - dx, innerWidth - card.offsetWidth - CARD.edge)) + 'px';
        card.style.top = Math.max(CARD.edge, Math.min(ev.clientY - dy, innerHeight - card.offsetHeight - CARD.edge)) + 'px';
      };
      const up = () => { head.removeEventListener('pointermove', move); head.removeEventListener('pointerup', up); head.removeEventListener('pointercancel', up); };
      head.addEventListener('pointermove', move); head.addEventListener('pointerup', up); head.addEventListener('pointercancel', up);
    });

    if (!cite) { for (const s of sections) s.querySelector('.trace-result').append(h('p', {className: 'trace-warn', textContent: 'The sentence around this marker could not be read from the page text.'})); return; }
    sections.forEach((s, i) => trace(r, s, targets[i], cite));
  }

  return {open, close};
}
