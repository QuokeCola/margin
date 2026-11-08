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
  const late = []; // constructed links, tried only after the page's own links
  if (/(^|\.)sciencedirect\.com$/.test(host)) {
    add(meta('citation_pdf_url')); // only the page's own signed link: constructed pdfft links are rejected
  }
  add(meta('citation_pdf_url'));
  add(meta('eprints.document_url'));
  for (const el of document.querySelectorAll('iframe[src], embed[src], object[data]')) {
    const u = el.src || el.data;
    if (/\.pdf\b|getPDF|stampPDF|pdfft|\/pdf\//i.test(u || '')) add(u);
  }
  // Links: only ones that clearly belong to this article. A bare ".pdf" link must point at the article's
  // DOI or id; links in page chrome (header, footer, navigation, sidebars) and flyers/guides are ignored.
  // Identifiers of this article: DOI suffix, ScienceDirect PII, last path segment. Links must carry one,
  // so "recommended articles" and other papers' PDF links on the page are never used.
  const keys = [doi && doi.split('/').pop(), (path.match(/\/pii\/([A-Z0-9]+)/i) || [])[1], path.split('/').filter(Boolean).pop()]
    .filter(k => k && k.length >= 4).map(k => k.toLowerCase());
  const own = href => !keys.length || keys.some(k => decodeURIComponent(href).toLowerCase().includes(k));
  for (const a of document.querySelectorAll('a[href]')) {
    if (a.closest('header, footer, nav, aside, [role="navigation"], [role="banner"], [role="contentinfo"]')) continue;
    const text = (a.textContent || '').trim().toLowerCase(), href = a.getAttribute('href') || '';
    if (/flyer|brochure|guide|instruction|template|poster|catalog|policy|terms|licen[cs]e/i.test(href + ' ' + text)) continue;
    if (/^https?:\/\/([^/]*\.)?(google|scholar\.google|bing|semanticscholar)\./i.test(abs(href) || '')) continue; // redirectors, not the PDF
    const saysPdf = /^(download|view|get|open)?\s*(full[- ]text\s*|article\s*)?pdf\b|download (article|paper)|^pdf$/.test(text);
    const pdfLike = /\.pdf($|\?)|\/pdf(\/|$|\?)|pdfft/i.test(href);
    if ((saysPdf || pdfLike) && own(href)) add(href);
    if (c.length > 12) break;
  }
  late.forEach(add);
  const isPdf = document.contentType === 'application/pdf';
  return {url: location.href, doi, title, candidates: isPdf ? [location.href] : c, isPdf};
}
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === 'collect') reply(collect());
  if (msg?.type === 'banner') { banner(msg.text); reply({ok: true}); }
  // Open a PDF link from inside the page, so the request carries this page as its referrer, the way a
  // click on the site's own "View PDF" does (some publishers reject the link opened from outside).
  if (msg?.type === 'open-from-page') {
    const link = [...document.querySelectorAll('a[href]')].find(a => a.href === msg.url);
    if (link) { link.removeAttribute('target'); link.click(); } else location.assign(msg.url);
    reply({ok: true, via: link ? 'link' : 'location'});
  }
});
chrome.runtime.sendMessage({type: 'page', info: collect()}).catch(() => {});
// Some sites (IEEE, ScienceDirect) fill in links after load: report again shortly after.
for (const ms of [2500, 6000]) setTimeout(() => chrome.runtime.sendMessage({type: 'page', info: collect()}).catch(() => {}), ms);

// Shown when Margin is waiting for this paper but the PDF has to be opened by hand.
function banner(text) {
  if (document.getElementById('margin-connector-banner')) return;
  const b = document.createElement('div');
  b.id = 'margin-connector-banner';
  b.textContent = text;
  Object.assign(b.style, {position: 'fixed', zIndex: 2147483647, right: '16px', bottom: '16px', maxWidth: '360px', padding: '10px 14px', background: '#203c39', color: '#f4f6f1', font: '13px/1.45 system-ui, sans-serif', borderRadius: '10px', boxShadow: '0 10px 30px rgba(0,0,0,.25)', cursor: 'pointer'});
  b.onclick = () => b.remove();
  document.documentElement.append(b);
}
})();
