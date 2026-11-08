// Records Margin for the README: drives a running instance through Chrome DevTools.
// Usage: node docs/demo/capture.mjs <devtools-port> <app-url> <out-dir>
import {mkdirSync, writeFileSync} from 'node:fs';
const [,, dtPort, appUrl, out] = process.argv;
mkdirSync(`${out}/frames`, {recursive: true});
const sleep = ms => new Promise(r => setTimeout(r, ms));
const targets = await (await fetch(`http://127.0.0.1:${dtPort}/json`)).json();
const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 0, recording = false, n = 0;
const pending = new Map(), frames = [], errors = [];
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Page.screencastFrame') {
    send('Page.screencastFrameAck', {sessionId: m.params.sessionId});
    if (recording) { const f = `${out}/frames/f${String(++n).padStart(5, '0')}.jpg`; writeFileSync(f, Buffer.from(m.params.data, 'base64')); frames.push({f, t: m.params.metadata.timestamp}); }
  }
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description);
};
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({id: i, method, params})); });
const ev = async expr => (await send('Runtime.evaluate', {expression: expr, awaitPromise: true, returnByValue: true})).result?.result?.value;
const shot = async name => { const r = await send('Page.captureScreenshot', {format: 'png'}); writeFileSync(`${out}/${name}.png`, Buffer.from(r.result.data, 'base64')); };
const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', {type, x, y, button: 'left', clickCount: 1, ...extra});
const click = async (x, y) => { await mouse('mouseMoved', x, y, {button: 'none'}); await sleep(250); await mouse('mousePressed', x, y); await mouse('mouseReleased', x, y); };
const rect = sel => ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect(); return r && {x: r.left + r.width / 2, y: r.top + r.height / 2, l: r.left, t: r.top, w: r.width, h: r.height}; })()`);
const clickSel = async sel => { const r = await rect(sel); if (!r) throw Error('missing ' + sel); await click(r.x, r.y); };
const pause = () => { recording = false; frames.push({gap: true}); };

await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', {width: 1440, height: 900, deviceScaleFactor: 1, mobile: false});
await send('Page.navigate', {url: appUrl}); await sleep(2500);
await send('Page.startScreencast', {format: 'jpeg', quality: 88, everyNthFrame: 1});
recording = true; await sleep(900);

// 1. open the paper from the library
await clickSel('.paper-name');
for (let i = 0; i < 40 && !(await ev(`document.querySelector('#notice').textContent.startsWith('Ready')`)); i++) await sleep(250);
await sleep(1200);
// 2. ask a question (typed), Enter to send
await clickSel('#question');
const q = 'How does the momentum residual detect a collision? Show the key equations and quote the sentence that says what the residual estimates.';
for (const ch of q) { await send('Input.insertText', {text: ch}); await sleep(18); }
await sleep(500);
await send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13});
await send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13});
await sleep(2200);
pause(); // skip the wait for the model
for (let i = 0; i < 240 && await ev(`!!document.querySelector('.thinking')`); i++) await sleep(500);
await ev(`document.querySelector('#messages').scrollTop = document.querySelector('.message.assistant:last-of-type')?.offsetTop - 120`);
await sleep(1500);
recording = true; await sleep(1800);
// 3. click an equation in the answer, then a quote
await ev(`document.querySelector('.message.assistant .eq-link')?.scrollIntoView({block: 'center', behavior: 'smooth'})`); await sleep(900);
await clickSel('.message.assistant .eq-link'); await sleep(2400);
await shot('answer-equation');
if (await rect('.message.assistant .quote-link')) {
  await ev(`document.querySelector('.message.assistant .quote-link').scrollIntoView({block: 'center', behavior: 'smooth'})`); await sleep(900);
  await clickSel('.message.assistant .quote-link'); await sleep(2400);
  await shot('answer-quote');
}
// 4. pinch-zoom the PDF (Chromium sends pinches as ctrl+wheel)
const pdf = await rect('#pdf');
for (let i = 0; i < 14; i++) { await send('Input.dispatchMouseEvent', {type: 'mouseWheel', x: pdf.x, y: pdf.y - 60, deltaX: 0, deltaY: -7, modifiers: 2}); await sleep(35); }
await sleep(1400);
for (let i = 0; i < 14; i++) { await send('Input.dispatchMouseEvent', {type: 'mouseWheel', x: pdf.x, y: pdf.y - 60, deltaX: 0, deltaY: 7, modifiers: 2}); await sleep(35); }
await sleep(1200);
// 5. click an equation in the PDF and ask about it
await ev(`document.querySelector('.message.assistant .eq-link').scrollIntoView({block: 'center'})`); await sleep(500);
await clickSel('.message.assistant .eq-link'); await sleep(1800);
const eq = await rect('.pdf-page .highlight.eq');
await mouse('mouseMoved', eq.l + eq.w * 0.4, eq.y, {button: 'none'}); await sleep(700);
await click(eq.l + eq.w * 0.4, eq.y); await sleep(1100);
await shot('ask-equation');
await clickSel('#pop-ask'); await sleep(1400);
await send('Input.insertText', {text: 'Why does this make the residual a filtered torque estimate?'}); await sleep(1600);
await shot('equation-attached');
recording = false;
await send('Page.stopScreencast');
// 6. settings
await ev(`document.querySelector('#question').value = ''`);
await clickSel('#open-settings'); await sleep(600); await shot('settings');
await ev(`document.querySelector('#settings-cancel').click()`);
writeFileSync(`${out}/frames.json`, JSON.stringify(frames));
console.log(JSON.stringify({frames: frames.filter(f => f.f).length, errors}));
ws.close(); process.exit(0);
