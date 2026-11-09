import {test} from 'node:test';
import assert from 'node:assert/strict';
import {extractVisuals, stripVisuals, buildSrcdoc, clampVisualHeight, themeVars, visualFileName, VISUAL_CSP, THEME_TOKENS} from '../src/visuals.js';

test('visuals: ```visual and ```svg blocks become placeholders; other code stays', () => {
  const text = 'Look:\n```visual\n<div id="a">$$x$$ [[eq:1|p:2]]</div>\n<script>let p = [[1,2]];</script>\n```\nand\n```html\n<b>code</b>\n```\n```SVG\n<svg viewBox="0 0 1 1"></svg>\n```\nEnd.';
  const {text: out, visuals} = extractVisuals(text);
  assert.equal(visuals.length, 2);
  assert.deepEqual(visuals[0], {kind: 'visual', source: '<div id="a">$$x$$ [[eq:1|p:2]]</div>\n<script>let p = [[1,2]];</script>', complete: true});
  assert.deepEqual(visuals[1], {kind: 'svg', source: '<svg viewBox="0 0 1 1"></svg>', complete: true});
  assert.match(out, /^Look:\n\nVISUALPH0END\n\nand\n```html\n<b>code<\/b>\n```\n\nVISUALPH1END\n\nEnd\.$/);
  assert.doesNotMatch(out, /\$\$|eq:1/);
});

test('visuals: an unclosed block (cut-off answer, or still streaming) runs to the end and is incomplete', () => {
  const {text, visuals} = extractVisuals('Plot:\n```visual\n<canvas></canvas>\n<script>draw(');
  assert.deepEqual(visuals, [{kind: 'visual', source: '<canvas></canvas>\n<script>draw(', complete: false}]);
  assert.equal(text, 'Plot:\n\nVISUALPH0END\n');
  assert.deepEqual(extractVisuals('```visual').visuals, [{kind: 'visual', source: '', complete: false}]);
});

test('visuals: fences inside other code blocks, longer fences and indented (list) blocks', () => {
  const example = '````markdown\n```visual\n<p>example</p>\n```\n````';
  assert.deepEqual(extractVisuals(example), {text: example, visuals: []});
  const long = extractVisuals('````visual\n```\ninner\n```\n````\nafter');
  assert.deepEqual(long.visuals, [{kind: 'visual', source: '```\ninner\n```', complete: true}]);
  const list = extractVisuals('1. Step\n\n   ```svg\n   <svg>\n     <g/>\n   </svg>\n   ```\n2. Next');
  assert.equal(list.visuals[0].source, '<svg>\n  <g/>\n</svg>');
  assert.match(list.text, /\n   VISUALPH0END\n/);
  const tilde = extractVisuals('~~~visual\n<b>x</b>\n~~~');
  assert.equal(tilde.visuals[0].source, '<b>x</b>');
  assert.equal(extractVisuals('```visualise\nx\n```').visuals.length, 0); // only the exact language names
  assert.equal(extractVisuals('```visual title\nx\n```').visuals.length, 1); // extra info words are allowed
});

test('visuals: stripVisuals drops the sources (citations inside scripts are not citations)', () => {
  assert.equal(stripVisuals('See Eq. (3).\n```visual\n<p>Eq. (9) on p. 4</p>\n```\nDone.'), 'See Eq. (3).\n\n\n\nDone.');
});

test('visuals: srcdoc puts the CSP first, keeps the source, adds theme and the height bridge', () => {
  const src = '<!DOCTYPE html><html><body><canvas id="c"></canvas><script>c.getContext("2d")</script></body></html>';
  const doc = buildSrcdoc(src, {id: 7, vars: {'--fg': '#123', '--accent': 'red;}</style><script>x', 'bad name': '1'}, scheme: 'dark'});
  assert.ok(doc.startsWith('<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' + VISUAL_CSP + '">'));
  assert.ok(doc.includes('<body><html><body><canvas id="c"></canvas><script>c.getContext("2d")</script></body></html></body>'));
  assert.match(doc, /color-scheme:dark;--fg:#123;--accent:red\/stylescriptx/);
  assert.doesNotMatch(doc, /bad name/);
  assert.ok(doc.includes('marginVisual:7'));
  assert.ok(doc.indexOf('Content-Security-Policy') < doc.indexOf('<script>'));
  assert.doesNotMatch(buildSrcdoc('<p>x</p>'), /marginVisual/); // no id (saved file, larger view): no height reports
  assert.match(buildSrcdoc('<svg></svg>', {kind: 'svg'}), /svg\{display:block;max-width:100%/);
});

test('visuals: the CSP blocks every request except scripts and styles from the three CDNs', () => {
  const d = Object.fromEntries(VISUAL_CSP.split(';').map(s => s.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));
  assert.deepEqual(d['default-src'], ["'none'"]);
  assert.deepEqual(d['connect-src'], ["'none'"]);
  assert.deepEqual(d['script-src'], ["'unsafe-inline'", "'unsafe-eval'", 'https://cdn.jsdelivr.net', 'https://cdnjs.cloudflare.com', 'https://unpkg.com']);
  assert.ok(!VISUAL_CSP.includes('*') && !/\bhttp:/.test(VISUAL_CSP));
  assert.ok(!VISUAL_CSP.includes('"'));
});

test('visuals: height clamp, theme variables and file names', () => {
  assert.equal(clampVisualHeight(10), 80);
  assert.equal(clampVisualHeight(5000), 900);
  assert.equal(clampVisualHeight(312.4), 312);
  assert.equal(clampVisualHeight(NaN), 200);
  const vars = themeVars(t => ` ${t}-value `, 'Inter');
  assert.equal(vars['--fg'], '--text-value');
  assert.equal(vars['--font'], 'Inter');
  assert.deepEqual(Object.keys(vars), [...Object.keys(THEME_TOKENS), '--font']);
  assert.equal(visualFileName('<title>Step response: ζ = 0.5</title>'), 'step-response-0-5.html');
  assert.equal(visualFileName('<svg></svg>', 'svg'), 'margin-visual.svg');
});

// Every app token a visual's colours come from exists in the stylesheet.
test('visuals: theme tokens exist in the stylesheet', async () => {
  const css = (await import('node:fs')).readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');
  const light = css.match(/:root\{(--[^}]*)\}/)[1];
  for (const t of Object.values(THEME_TOKENS)) assert.ok(light.includes(t + ':'), t);
});
