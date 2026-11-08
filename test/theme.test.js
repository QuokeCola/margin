import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolveTheme} from '../src/theme.js';

test('theme: system follows the OS, explicit choices win, anything else means system', () => {
  assert.equal(resolveTheme('system', true), 'dark');
  assert.equal(resolveTheme('system', false), 'light');
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme('dark', false), 'dark');
  assert.equal(resolveTheme(null, true), 'dark');
  assert.equal(resolveTheme('purple', false), 'light');
});

// Every colour in the stylesheet goes through a token, and every token has a light and a dark value.
test('stylesheet: colours are tokens with light and dark values', () => {
  const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');
  const block = sel => Object.fromEntries(css.match(new RegExp(sel.replace(/[[\]]/g, '\\$&') + '\\{([^}]*)\\}'))[1].split(';').map(d => d.split(':')).map(([k, ...v]) => [k, v.join(':')]));
  const light = block(':root'), dark = block(':root[data-theme=dark]');
  delete dark['color-scheme'];
  assert.deepEqual(Object.keys(dark).sort(), Object.keys(light).filter(k => k !== 'color-scheme').sort());
  for (const m of css.matchAll(/var\((--[\w-]+)\)/g)) assert.ok(m[1] in light || /^--(ease-out|quick|soft|total-scale-factor|min-font-size|text-scale-factor|min-font-size-inv|font-height|scale-x|rotate|scale-round-x|scale-round-y)$/.test(m[1]), m[1]);
  // outside the token blocks, colour literals appear only in the dark-only rules
  const rest = css.replace(/:root(\[data-theme=dark\])?\{--[^}]*\}/g, '').replace(/:root\[data-theme=dark\][^{]*\{[^}]*\}/g, '');
  assert.deepEqual(rest.match(/#[0-9a-f]{3,8}\b|:white\b/gi) || [], []);
});
