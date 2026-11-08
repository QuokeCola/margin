// The chat provider as the app shows it: names, where data is sent, and what Settings saves.
// `status` is GET /api/status: {configured, model, provider, providers: {openai, anthropic}, embeddings}.
export const PROVIDERS = ['openai', 'anthropic'];
export const LABEL = {openai: 'OpenAI', anthropic: 'Claude'}; // the choice in Settings and the header
export const COMPANY = {openai: 'OpenAI', anthropic: 'Anthropic'}; // where the data goes and the key comes from
export const providerOf = status => status?.provider === 'anthropic' ? 'anthropic' : 'openai';
const savedKey = (status, p) => !!status?.providers?.[p]?.configured;

// Header status: whether the selected provider has a key.
export function connectionText(status) {
  if (!status) return '○ Server offline';
  const p = providerOf(status);
  return status.configured ? `● Connected · ${LABEL[p]}` : `○ ${COMPANY[p]} API key needed`;
}

// Composer hint. A project chat with Claude and an OpenAI key also sends the papers and the question to
// OpenAI to embed them for passage search (without that key the search is by keywords, on this computer).
export function composeHint(status, projectChat) {
  const p = providerOf(status), to = COMPANY[p];
  const keys = 'Enter to send · Ctrl+Enter for a new line. ';
  if (!projectChat) return `${keys}Paper text + this chat are sent to ${to}.`;
  const embedOpenAI = p === 'anthropic' && status?.embeddings === 'openai';
  return `${keys}Passages from this project's papers + this chat are sent to ${to}${embedOpenAI ? '; papers and questions also go to OpenAI for passage search' : ''}.`;
}

export const webTitle = status => `Let the answer search the web (${COMPANY[providerOf(status)]} web search, billed per search). Off by default.`;

// The line under the provider choice in Settings about how project chats find passages, or null.
export function searchNote(selected, status) {
  if (selected !== 'anthropic') return null;
  return savedKey(status, 'openai')
    ? {kind: 'info', text: 'Project chats find passages with your OpenAI key (embeddings billed to OpenAI).'}
    : {kind: 'keywords', text: 'Project chats use keyword search. Add an OpenAI key for semantic search (embeddings billed to OpenAI).'};
}

// Saved-key line for one provider in Settings.
export function keyHint(status, p) {
  const s = status?.providers?.[p];
  return s?.configured ? `A key is saved (${s.keyHint}). Leave blank to keep it.` : 'No key saved yet.';
}

// The POST /api/settings body for the Settings form, or null when nothing changed.
// keys: {openai, anthropic} typed into the form; model: the picked or typed model for `selected`.
export function settingsBody({status, selected, keys = {}, model = '', proxyPrefix}) {
  const body = {};
  if (keys.openai) body.apiKey = keys.openai;
  if (keys.anthropic) body.anthropicKey = keys.anthropic;
  if (selected !== providerOf(status)) body.provider = selected;
  if (model && model !== status?.providers?.[selected]?.model) body[selected === 'anthropic' ? 'anthropicModel' : 'openaiModel'] = model;
  if (proxyPrefix !== undefined && proxyPrefix !== (status?.proxyPrefix || '')) body.proxyPrefix = proxyPrefix;
  return Object.keys(body).length ? body : null;
}

// "Checking the key with …" while saving.
export function savingText(body) {
  const checking = [body.apiKey && 'OpenAI', body.anthropicKey && 'Anthropic'].filter(Boolean);
  return checking.length ? `Checking the key${checking.length > 1 ? 's' : ''} with ${checking.join(' and ')}…` : 'Saving…';
}
