// Visuals in chat answers. A fenced ```visual block (self-contained HTML that may run scripts) or
// ```svg block (a static diagram) is shown rendered, in a sandboxed iframe, instead of as code;
// ```html and every other language stay code. Pure helpers here (no DOM), used by main.js and tests.

export const VISUAL_KINDS = ['visual', 'svg'];

// The visual may load libraries from three CDNs but cannot send data anywhere: no fetch/XHR/WebSocket,
// no external images or forms. The sandbox (allow-scripts only) gives it an opaque origin besides.
export const VISUAL_CSP = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com; style-src 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com; img-src data: blob:; font-src data: https://cdn.jsdelivr.net; connect-src 'none'; form-action 'none'; base-uri 'none'";

// Rendered height of a visual in the chat (px): the iframe reports its document height, clamped here.
export const VISUAL_MIN_HEIGHT = 80, VISUAL_MAX_HEIGHT = 900, VISUAL_START_HEIGHT = 200;
export const clampVisualHeight = h => Number.isFinite(h) ? Math.round(Math.min(VISUAL_MAX_HEIGHT, Math.max(VISUAL_MIN_HEIGHT, h))) : VISUAL_START_HEIGHT;

// CSS variables a visual can use (named in the tutor instructions) and the app tokens they come from.
export const THEME_TOKENS = {'--fg': '--text', '--bg': '--bg', '--surface': '--surface', '--muted': '--subtitle', '--line': '--line',
  '--code-bg': '--code-bg', '--accent': '--accent-text', '--accent-2': '--ref-frame', '--accent-3': '--map-cite-stroke', '--accent-4': '--eq-ai'};
// read(token) returns the current value of an app token, e.g. from getComputedStyle.
export const themeVars = (read, font) => ({...Object.fromEntries(Object.entries(THEME_TOKENS).map(([k, src]) => [k, String(read(src) ?? '').trim()])), '--font': font || 'system-ui,sans-serif'});

export const visualPlaceholder = i => `VISUALPH${i}END`;

// Replace each ```visual / ```svg fenced block with a placeholder paragraph (VISUALPH0END, …) so that
// Markdown, maths and citation handling never touch its source. Other fenced blocks are skipped whole,
// so a visual fence shown inside, say, a ````markdown example stays code. A block without a closing
// fence (an answer cut off mid-visual) runs to the end of the text and has complete: false.
export function extractVisuals(text) {
  const lines = String(text).split('\n'), out = [], visuals = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([ \t]*)(`{3,}|~{3,})[ \t]*([^\s`]*)[^`]*$/);
    if (!m) { out.push(lines[i]); continue; }
    const [, indent, fence, info] = m;
    const close = new RegExp(`^[ \\t]*${fence[0] === '`' ? '`' : '~'}{${fence.length},}[ \\t]*$`);
    let j = i + 1;
    while (j < lines.length && !close.test(lines[j])) j++;
    const kind = info.toLowerCase();
    if (!VISUAL_KINDS.includes(kind)) { out.push(...lines.slice(i, j + 1)); i = j; continue; }
    const source = lines.slice(i + 1, j).map(l => l.startsWith(indent) ? l.slice(indent.length) : l.replace(/^[ \t]+/, '')).join('\n');
    visuals.push({kind, source, complete: j < lines.length});
    out.push('', indent + visualPlaceholder(visuals.length - 1), '');
    i = j;
  }
  return {text: out.join('\n'), visuals};
}
// The text without its visuals' sources (for finding citations: a script's "p." or "Eq." is not one).
export const stripVisuals = text => extractVisuals(text).text.replace(/VISUALPH\d+END/g, '');

// Script added to every visual: reports the document height to the app (when id is a number) and
// applies theme changes the app posts. Only messages from the parent window are accepted.
const bridge = id => `<script>(()=>{const d=document.documentElement;${typeof id === 'number' ? `let last=0;const post=()=>{const b=document.body,h=Math.ceil(Math.max(d.getBoundingClientRect().height,b?b.scrollHeight:0));if(h!==last){last=h;parent.postMessage({marginVisual:${id},height:h},'*')}};const ro=new ResizeObserver(post);ro.observe(d);addEventListener('DOMContentLoaded',()=>{ro.observe(document.body);post()});addEventListener('load',post);` : ''}addEventListener('message',e=>{const t=e.source===parent&&e.data&&e.data.marginTheme;if(!t)return;for(const k in t.vars)if(/^--[\\w-]+$/.test(k))d.style.setProperty(k,String(t.vars[k]));if(t.scheme)d.style.colorScheme=t.scheme})})()</script>`;

// The document shown in the iframe (or saved): CSP first, then theme variables and base styles,
// the bridge script, then the visual's own source as the body (a full document works too: the
// parser merges its <html>/<body> attributes and keeps its <style> and <script> elements).
export function buildSrcdoc(source, {kind = 'visual', id = null, vars = {}, scheme = 'light'} = {}) {
  const safe = v => String(v).replace(/[<>;{}]/g, '');
  const root = Object.entries(vars).filter(([k]) => /^--[\w-]+$/.test(k)).map(([k, v]) => `${k}:${safe(v)}`).join(';');
  const css = `:root{color-scheme:${scheme === 'dark' ? 'dark' : 'light'};${root}}html,body{margin:0;background:transparent}body{padding:8px;color:var(--fg);font:14px/1.5 var(--font);overflow-wrap:anywhere}`
    + (kind === 'svg' ? 'svg{display:block;max-width:100%;height:auto;margin:0 auto}' : 'canvas,svg,img{max-width:100%}canvas,img{height:auto}');
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${VISUAL_CSP}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style>${bridge(id)}</head><body>${String(source).replace(/^\s*<!doctype[^>]*>/i, '')}</body></html>`;
}

// File name for a saved visual: its <title> (or SVG <title>) if it has one.
export function visualFileName(source, kind = 'visual') {
  const t = String(source).match(/<title[^>]*>([^<]{1,120})<\/title>/i)?.[1] ?? '';
  const slug = t.toLowerCase().normalize('NFKD').replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return `${slug || 'margin-visual'}.${kind === 'svg' ? 'svg' : 'html'}`;
}
