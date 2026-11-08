// Small line drawings beside the setup steps in Settings. Each one plays the steps in a 12 s loop
// (step 1, 2, 3 = first, second, last third) and the matching step in the list is highlighted in step
// with it (guides.css). The resting state of every shape is the final frame, so with reduced motion
// (all animations off, see style.css) a still picture of the finished setup is shown.
const cursor = cls => `<g class="g-cursor ${cls}"><path d="M0 0V11.5l3-2.7 2.1 4.7 2-.9-2.1-4.6h4.1z"/></g>`;
const ripples = (cls, points) => points.map(([x, y], i) => `<circle class="g-ripple ${cls}${i + 1}" cx="${x}" cy="${y}" r="6"/>`).join('');
const mBadge = (x, y, s = 9) => `<rect class="g-m" x="${x}" y="${y}" width="${s}" height="${s}" rx="2.5"/><text class="g-m-text" x="${x + s / 2}" y="${y + s * .76}" font-size="${s * .9}">m</text>`;
const chrome = (w, h, addr) => `<rect class="g-win" x="3" y="3" width="${w}" height="${h}" rx="7"/><path class="g-frame" d="M3 16H${w + 3}"/>
<circle class="g-dot" cx="10" cy="9.5" r="1.5"/><circle class="g-dot" cx="15" cy="9.5" r="1.5"/><circle class="g-dot" cx="20" cy="9.5" r="1.5"/>
<rect class="g-addr" x="27" y="6.5" width="${addr}" height="6" rx="3"/><path class="g-text thin" d="M31 9.5H${27 + addr * .55}"/>`;

// Browser extension: Developer mode on → Load unpacked (a folder becomes the Margin card) → the
// Margin icon in the toolbar opens its popup and the pairing code is pasted.
export const EXT_ART = `<svg class="guide-art" viewBox="0 0 150 96" aria-hidden="true" focusable="false"><g class="g-scene">
${chrome(144, 88, 66)}
<path class="g-icon" d="M115 7h3a1.6 1.6 0 0 1 3.2 0h3v3a1.6 1.6 0 0 1 0 3.2v3h-9.2z"/>
<g class="ext-pin">${mBadge(130.5, 5, 9)}</g>
<path class="g-text strong" d="M11 26H38"/><path class="g-text" d="M100 26H116"/>
<rect class="g-track ext-track" x="121" y="22" width="17" height="8" rx="4"/><circle class="g-knob ext-knob" cx="134" cy="26" r="2.7"/>
<g class="ext-devbar"><rect class="g-btn" x="11" y="35" width="33" height="9" rx="3"/><path class="g-text accent" d="M16 39.5H39"/>
<rect class="g-btn ghost" x="48" y="35" width="22" height="9" rx="3"/><rect class="g-btn ghost" x="74" y="35" width="22" height="9" rx="3"/></g>
<path class="g-frame faint" d="M3 50H147"/>
<g class="ext-card"><rect class="g-card" x="11" y="56" width="64" height="28" rx="4"/>${mBadge(16, 61, 10)}
<path class="g-text strong" d="M31 63H56"/><path class="g-text" d="M31 69H66"/><rect class="g-track" x="60" y="75.5" width="10" height="5" rx="2.5"/><circle class="g-knob" cx="67.5" cy="78" r="1.6"/></g>
<g class="ext-folder"><path class="g-folder" d="M0 2.5A1.5 1.5 0 0 1 1.5 1h4l1.6 2h6.4A1.5 1.5 0 0 1 15 4.5v7a1.5 1.5 0 0 1-1.5 1.5h-12A1.5 1.5 0 0 1 0 11.5z"/></g>
<g class="ext-popup"><path class="g-pop" d="M97 23h31l7.5-6 7.5 6a3 3 0 0 1 3 3v33a3 3 0 0 1-3 3h-46a3 3 0 0 1-3-3v-33a3 3 0 0 1 3-3z"/>
${mBadge(99, 28, 8)}<path class="g-text strong" d="M111 32H130"/><path class="g-text" d="M99 42H122"/>
<rect class="g-input ext-input" x="99" y="46" width="42" height="10" rx="3"/><path class="g-code ext-code" d="M104 51H125"/>
<g class="g-check ext-check"><circle cx="135.5" cy="51" r="3.4"/><path d="M134 51l1.1 1.1 2-2.2"/></g></g>
${ripples('ext-r', [[129.5, 26], [27.5, 39.5], [135, 9.5], [118, 51]])}
${cursor('ext-cursor')}</g></svg>`;

// OpenAI key: Create new secret key and copy it → Billing, add credit → paste into Margin's key
// field and Save.
export const KEY_ART = `<svg class="guide-art" viewBox="0 0 150 96" aria-hidden="true" focusable="false"><g class="g-scene">
${chrome(106, 74, 54)}
<path class="g-frame faint" d="M30 16V77"/>
<rect class="g-nav key-nav" x="6" y="21.5" width="21" height="7" rx="2.5"/>
<path class="g-text" d="M10 25H24M10 32H22M10 39H24"/>
<g class="key-pageA"><path class="g-text strong" d="M36 24H62"/>
<rect class="g-primary" x="36" y="29" width="40" height="9" rx="3"/><path class="g-on-primary" d="M41 33.5H44M42.5 32V35M48 33.5H71"/>
<g class="key-row"><rect class="g-card" x="36" y="42" width="66" height="12" rx="3"/>
<circle class="g-key" cx="42" cy="48" r="2.4"/><path class="g-key" d="M44.4 48H51V50.2M48.6 48V49.8"/><path class="g-code" d="M56 48H80"/>
<g class="key-copy"><rect class="g-icon-line" x="88" y="44.5" width="5.5" height="6.5" rx="1.2"/><path class="g-icon-line" d="M91 44.5V43.2a1 1 0 0 1 1-1h4.3a1 1 0 0 1 1 1v5.2a1 1 0 0 1-1 1h-2.8"/></g>
<path class="g-tick key-copied" d="M86.5 48l2 2 3.5-4"/></g></g>
<g class="key-pageB"><rect class="g-card" x="36" y="21" width="24" height="15" rx="2.5"/><path class="g-text" d="M36 25.5H60"/><path class="g-text thin" d="M40 31.5H47"/>
<rect class="g-btn" x="64" y="24" width="27" height="9" rx="3"/><path class="g-text accent" d="M68.5 28.5H71.5M70 27V30M74.5 28.5H87"/>
<rect class="g-track" x="36" y="41" width="56" height="4" rx="2"/><rect class="g-fill key-fill" x="36" y="41" width="38" height="4" rx="2"/></g>
<g class="key-margin"><rect class="g-shadow" x="61" y="48" width="86" height="46" rx="7"/><rect class="g-sheet" x="60" y="46" width="86" height="46" rx="7"/>
${mBadge(66, 51, 9)}<path class="g-text strong" d="M80 55.5H106"/><path class="g-text" d="M66 63H92"/>
<rect class="g-input key-input" x="66" y="66" width="74" height="10" rx="3"/><path class="g-code key-code" d="M71 71H112"/>
<g class="g-check key-check"><circle cx="106" cy="84" r="3.4"/><path d="M104.5 84l1.1 1.1 2-2.2"/></g>
<g class="key-save"><rect class="g-primary" x="114" y="80" width="26" height="8" rx="3"/><path class="g-on-primary" d="M120 84H134"/></g></g>
${ripples('key-r', [[56, 33.5], [91, 46], [16, 32], [77.5, 28.5], [100, 71], [127, 84]])}
${cursor('key-cursor')}</g></svg>`;
