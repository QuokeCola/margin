// Pure helpers shared by the server and tests.

export const KEY_PATTERN = /^[A-Za-z0-9_-]{20,400}$/;
export const MODEL_PATTERN = /^[A-Za-z0-9._:-]{1,100}$/;
export const PAPER_ID = /^[0-9a-f]{64}$/;
export const CHAT_ID = /^[0-9a-f]{16}$/;

// Replace or append KEY=value lines, keeping every other line (comments, PORT, ...).
export function updateEnvText(text, updates) {
  const lines = text ? text.replace(/\r\n/g, '\n').split('\n') : [];
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (const [key, value] of Object.entries(updates)) {
    const line = `${key}=${value}`;
    const i = lines.findIndex(l => l.startsWith(key + '='));
    if (i >= 0) lines[i] = line; else lines.push(line);
  }
  return lines.join('\n') + '\n';
}

// Models from /v1/models that can answer text through the Responses API.
// The list endpoint has no capability field, so this is a name-based filter.
export function isTextModel(id) {
  return /^(gpt-|o\d|chatgpt-)/.test(id) &&
    !/(audio|realtime|transcribe|tts|image|embedding|moderation|search|instruct|diarize)/.test(id);
}

export function keyHint(key) {
  return key ? `${key.slice(0, 3)}…${key.slice(-4)}` : null;
}

export function cleanName(name, fallback = 'Untitled paper') {
  const s = String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200);
  return s || fallback;
}

// Title from the user's own words: the last paragraph, without Markdown, prefixed with the attachment kind.
export function chatTitle(question) {
  const eq = question.match(/^\*\*About Eq\. \(([^)]+)\)/);
  let s = question.split(/\n\s*\n/).pop().replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim();
  if (eq) s = `Eq. (${eq[1]}): ${s}`; else if (question.startsWith('>')) s = `Passage: ${s}`;
  return s.length > 60 ? s.slice(0, 57) + '…' : s;
}
