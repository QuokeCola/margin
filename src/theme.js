// Colour theme: 'system' (follow the OS, the default), 'light' or 'dark'. The choice is kept in this
// browser's storage; index.html applies it before the first paint, this module keeps it current.
const KEY = 'margin-theme';
export const THEMES = ['system', 'light', 'dark'];
export const resolveTheme = (pref, systemDark) => pref === 'light' || pref === 'dark' ? pref : systemDark ? 'dark' : 'light';
const media = (() => { try { return matchMedia('(prefers-color-scheme: dark)'); } catch { return null; } })();
export function getThemePref() {
  try { const v = localStorage.getItem(KEY); return THEMES.includes(v) ? v : 'system'; } catch { return 'system'; }
}
export function applyTheme(pref = getThemePref()) { document.documentElement.dataset.theme = resolveTheme(pref, !!media?.matches); }
export function setThemePref(pref) {
  try { if (pref === 'system') localStorage.removeItem(KEY); else localStorage.setItem(KEY, pref); } catch {}
  applyTheme(pref);
}
media?.addEventListener?.('change', () => applyTheme());
