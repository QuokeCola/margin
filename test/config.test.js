import {test} from 'node:test';
import assert from 'node:assert/strict';
import {updateEnvText, isTextModel, keyHint, cleanName, chatTitle, KEY_PATTERN} from '../lib/config.mjs';
import {clampZoom, wheelZoomFactor} from '../src/zoom.js';
test('env update keeps other lines and replaces in place', () => {
  assert.equal(updateEnvText('# c\nOPENAI_API_KEY=old\nPORT=4317\n', {OPENAI_API_KEY: 'new', OPENAI_MODEL: 'gpt-x'}), '# c\nOPENAI_API_KEY=new\nPORT=4317\nOPENAI_MODEL=gpt-x\n');
  assert.equal(updateEnvText('', {OPENAI_MODEL: 'm'}), 'OPENAI_MODEL=m\n');
});
test('model filter keeps text models only', () => {
  assert(isTextModel('gpt-5.2') && isTextModel('o4-mini') && isTextModel('gpt-6-astra'));
  assert(!isTextModel('gpt-4o-realtime-preview') && !isTextModel('text-embedding-3-large') && !isTextModel('gpt-image-1') && !isTextModel('whisper-1') && !isTextModel('gpt-4o-mini-tts'));
});
test('key handling', () => {
  assert.equal(keyHint('sk-proj-abcdefgh1234'), 'sk-…1234');
  assert(KEY_PATTERN.test('sk-proj-AbC_d-123456789012345') && !KEY_PATTERN.test('sk-abc def ghi jkl mno pqr') && !KEY_PATTERN.test('sk-x\nOPENAI_MODEL=evil-model-name'));
});
test('names and titles', () => {
  assert.equal(cleanName(' a\nb '), 'a b'); assert.equal(cleanName(''), 'Untitled paper');
  assert.equal(chatTitle('x'.repeat(80)).length, 58);
});
test('zoom limits', () => {
  assert.equal(clampZoom(10), 3); assert.equal(clampZoom(0.1), 0.5); assert.equal(clampZoom(NaN), 1);
  assert(wheelZoomFactor(-5) > 1 && wheelZoomFactor(5) < 1);
  assert.equal(wheelZoomFactor(1000), wheelZoomFactor(20));
});
test('chat titles use the question, not the attachment header', () => {
  assert.equal(chatTitle('**About Eq. (9), PDF page 3** (image of the equation attached)\n\nWhat does C_c select?'), 'Eq. (9): What does Cc select?');
  assert.equal(chatTitle('> some passage\n>\n> — PDF page 7\n\nWhy is this true?'), 'Passage: Why is this true?');
});
test('chat title for a marked area', () => {
  assert.equal(chatTitle('**About a marked area on PDF page 4** (upper left of the page, x 10–40%, y 20–30%; image attached)\n\n> text\n\nWhat is this?'), 'Area p. 4: What is this?');
});
