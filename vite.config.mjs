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
export default {plugins: [katexWoff2Only]};
