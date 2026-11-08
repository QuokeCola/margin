// Margin connector — runs on web pages, reports the paper's DOI, title and likely PDF links to the
// background worker. It never reads anything else on the page and only acts for papers Margin asked for.
(() => {
function collect() {
  const meta = name => document.querySelector(`meta[name="${name}" i], meta[property="${name}" i]`)?.content?.trim() || null;
  const abs = u => { try { return new URL(u, location.href).href; } catch { return null; } };
  const cleanDoi = s => (String(s || '').match(/10\.\d{4,9}\/[^\s"<>?#]+/) || [null])[0]?.replace(/[.,;)\]]+$/, '').toLowerCase() || null;

  // DOI from the page's metadata, its address, or (IEEE and others) the visible text.
  const bodyDoi = () => (document.body?.innerText?.slice(0, 20000).match(/\b(?:doi(?:\.org\/|:\s*))(10\.\d{4,9}\/[^\s"<>]+)/i) || [])[1];
  const doi = cleanDoi(meta('citation_doi') || meta('dc.identifier') || meta('prism.doi') || meta('dc.Identifier') || decodeURIComponent(location.pathname)) || cleanDoi(bodyDoi());
  const title = meta('citation_title') || meta('dc.title') || meta('og:title') || document.title || null;

  // PDF candidates, most reliable first. Publisher rules cover sites whose generic tag points at a viewer.
  const c = [];
  const add = u => { const a = u && abs(u); if (a && /^https?:/.test(a) && !c.includes(a)) c.push(a); };
  const host = location.hostname, path = location.pathname;
  const d = doi && encodeURIComponent(doi).replace(/%2F/gi, '/');
  if (/(^|\.)ieeexplore\.ieee\.org$/.test(host)) {
    const n = (path.match(/\/document\/(\d+)/) || location.search.match(/arnumber=(\d+)/) || [])[1];
    if (n) add(`https://ieeexplore.ieee.org/stampPDF/getPDF.jsp?tp=&arnumber=${n}&ref=`);
  }
  if (/(^|\.)onlinelibrary\.wiley\.com$/.test(host) && d) add(`https://onlinelibrary.wiley.com/doi/pdfdirect/${d}?download=true`);
  if (/(^|\.)tandfonline\.com$/.test(host) && d) add(`https://www.tandfonline.com/doi/pdf/${d}?download=true`);
  if (/(^|\.)journals\.sagepub\.com$/.test(host) && d) add(`https://journals.sagepub.com/doi/pdf/${d}?download=true`);
  if (/(^|\.)dl\.acm\.org$/.test(host) && d) add(`https://dl.acm.org/doi/pdf/${d}`);
  if (/(^|\.)iopscience\.iop\.org$/.test(host) && d) add(`https://iopscience.iop.org/article/${d}/pdf`);
  if (/(^|\.)sciencedirect\.com$/.test(host)) {
    const pii = (path.match(/\/pii\/([A-Z0-9]+)/i) || [])[1];
    add(meta('citation_pdf_url'));
    if (pii) add(`https://www.sciencedirect.com/science/article/pii/${pii}/pdfft?isDTMRedir=true&download=true`);
  }
  add(meta('citation_pdf_url'));
  add(meta('eprints.document_url'));
  for (const el of document.querySelectorAll('iframe[src], embed[src], object[data]')) {
    const u = el.src || el.data;
    if (/\.pdf\b|getPDF|stampPDF|pdfft|\/pdf\//i.test(u || '')) add(u);
  }
  // Links: only ones that clearly belong to this article. A bare ".pdf" link must point at the article's
  // DOI or id; links in page chrome (header, footer, navigation, sidebars) and flyers/guides are ignored.
  const key = (doi ? doi.split('/').pop() : path.split('/').filter(Boolean).pop() || '').toLowerCase();
  for (const a of document.querySelectorAll('a[href]')) {
    if (a.closest('header, footer, nav, aside, [role="navigation"], [role="banner"], [role="contentinfo"]')) continue;
    const text = (a.textContent || '').trim().toLowerCase(), href = a.getAttribute('href') || '';
    if (/flyer|brochure|guide|instruction|template|poster|catalog|policy|terms|licen[cs]e/i.test(href + ' ' + text)) continue;
    const saysPdf = /^(download|view|get|open)?\s*(full[- ]text\s*|article\s*)?pdf\b|download (article|paper)|^pdf$/.test(text);
    const ownPdf = /\.pdf($|\?)|\/pdf(\/|$|\?)/i.test(href) && key.length >= 4 && decodeURIComponent(href).toLowerCase().includes(key);
    if (saysPdf || ownPdf) add(href);
    if (c.length > 12) break;
  }
  const isPdf = document.contentType === 'application/pdf';
  return {url: location.href, doi, title, candidates: isPdf ? [location.href] : c, isPdf};
}
chrome.runtime.onMessage.addListener((msg, _sender, reply) => { if (msg?.type === 'collect') reply(collect()); });
chrome.runtime.sendMessage({type: 'page', info: collect()}).catch(() => {});
// Some sites (IEEE, ScienceDirect) fill in links after load: report once more shortly after.
setTimeout(() => chrome.runtime.sendMessage({type: 'page', info: collect()}).catch(() => {}), 2500);
})();
