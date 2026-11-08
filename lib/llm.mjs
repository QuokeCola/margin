// Chat model providers behind one interface: OpenAI (Responses API) and Anthropic Claude (Messages API).
// Both SDKs are loaded on first use (they are large and most requests never need them).
//
//   answerTurn(provider, {apiKey, model, instructions, source, history, question, image, web, cache})
//     -> {text, sources: [{url, title}], usage: {input, output, cacheRead, cacheWrite}, model}
//
// `source` is the paper text (or the project passages) sent as the first user message, `history` is
// [{role: 'user'|'assistant', content: string}], `image` an optional data:image/(png|jpeg);base64 URL, and
// `cache` says which prefix is worth caching for Claude: 'source' (a paper chat re-sends the same paper text
// every turn) or 'system' (a project chat's passages change with every question).

export const PROVIDERS = ['openai', 'anthropic'];
export const PROVIDER_NAMES = {openai: 'OpenAI', anthropic: 'Anthropic'};
export const KEY_VARS = {openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY'};
export const MODEL_VARS = {openai: 'OPENAI_MODEL', anthropic: 'ANTHROPIC_MODEL'};
export const DEFAULT_MODELS = {openai: 'gpt-6-astra', anthropic: 'claude-opus-5-5'};
// Shown when the Anthropic model list cannot be loaded (network trouble); newest first.
export const ANTHROPIC_FALLBACK_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'];
// Anthropic keys start with sk-ant- (an OpenAI key pasted into the Claude field is caught here).
export const ANTHROPIC_KEY_PATTERN = /^sk-ant-[A-Za-z0-9_-]{20,400}$/;

export const providerOf = env => env.PROVIDER === 'anthropic' ? 'anthropic' : 'openai';
export const modelOf = (provider, env) => env[MODEL_VARS[provider]] || DEFAULT_MODELS[provider];

let OpenAIClass = null, AnthropicClass = null;
export const loadOpenAI = async () => OpenAIClass ??= (await import('openai')).default;
export const loadAnthropic = async () => AnthropicClass ??= (await import('@anthropic-ai/sdk')).default;

// The SDK client for a provider. The key is always passed explicitly, so the Anthropic SDK never falls back
// to other credentials on this machine (ANTHROPIC_AUTH_TOKEN, `ant` profiles). Base URLs follow the SDKs'
// own OPENAI_BASE_URL / ANTHROPIC_BASE_URL variables (used by the tests' local fake endpoints).
export async function createClient(provider, {apiKey, timeout = 120000, maxRetries = 1}) {
  const Cls = provider === 'anthropic' ? await loadAnthropic() : await loadOpenAI();
  return new Cls({apiKey, timeout, maxRetries});
}

// Chat model ids for a key, newest first.
export async function listModels(provider, apiKey, isTextModel) {
  const client = await createClient(provider, {apiKey, timeout: 15000, maxRetries: 0});
  const all = [];
  for await (const m of client.models.list()) all.push(m);
  if (provider === 'anthropic') // every listed Claude model is a chat model; created_at is an RFC 3339 string
    return all.filter(m => /^claude-/.test(m.id)).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || a.id.localeCompare(b.id)).map(m => m.id);
  return all.filter(m => isTextModel(m.id)).sort((a, b) => b.created - a.created || a.id.localeCompare(b.id)).map(m => m.id);
}

// ---------- OpenAI (Responses API) ----------
export function openaiRequest({model, instructions, source, history, question, image, web}) {
  return {model, store: false, max_output_tokens: web ? 8000 : 5000,
    instructions,
    ...(web ? {tools: [{type: 'web_search'}]} : {}),
    input: [{role: 'user', content: source}, ...history, {role: 'user', content: image ? [{type: 'input_text', text: question}, {type: 'input_image', image_url: image, detail: 'high'}] : question}]};
}

// Web pages the answer cited (url_citation annotations of the Responses API), without duplicates.
export function openaiSources(response) {
  const out = new Map();
  for (const item of response.output || []) if (item.type === 'message')
    for (const part of item.content || []) for (const a of part.annotations || [])
      if (a.type === 'url_citation' && /^https?:\/\//i.test(a.url || '') && !out.has(a.url)) out.set(a.url, {url: String(a.url).slice(0, 2000), title: String(a.title || '').slice(0, 300)});
  return [...out.values()].slice(0, 30);
}

async function openaiTurn(opts) {
  const client = await createClient('openai', {apiKey: opts.apiKey});
  const response = await client.responses.create(openaiRequest(opts));
  if (!response.output_text) throw new Error('empty');
  const u = response.usage || {};
  return {text: response.output_text, sources: opts.web ? openaiSources(response) : [], model: opts.model,
    usage: {input: u.input_tokens ?? null, output: u.output_tokens ?? null, cacheRead: u.input_tokens_details?.cached_tokens ?? null, cacheWrite: null}};
}

// ---------- Anthropic (Messages API) ----------
export const ANTHROPIC_MAX_TOKENS = 16000; // includes adaptive thinking; billed only for what is generated
export const ANTHROPIC_WEB_MAX_USES = 5;    // web searches per answer
const MAX_CONTINUATIONS = 3;               // pause_turn resumptions of a long server-side web search turn
// Web search with dynamic filtering exists on these models; every other model gets the basic tool.
const DYNAMIC_WEB = /^claude-(opus-(5-5|5|4-8|4-7|4-6)|sonnet-(5-5|5|4-6))(\b|$)/;
export const webSearchTool = model => ({type: DYNAMIC_WEB.test(model) ? 'web_search_20260209' : 'web_search_20250305', name: 'web_search', max_uses: ANTHROPIC_WEB_MAX_USES});
// Server-side refusal fallback ("default" routing): a request a safety classifier declines is re-run on a
// model chosen by the API inside the same call. Offered on these models through a beta.
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5']);
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const EPHEMERAL = {type: 'ephemeral'};

export function anthropicRequest({model, instructions, source, history, question, image, web, cache = 'source'}) {
  const img = image ? /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(image) : null;
  if (image && !img) throw new Error('Unsupported image.');
  // Paper chats: the paper text is the same every turn, so it carries a cache breakpoint (tools + system +
  // paper), and so does the end of the conversation, which the next turn re-sends as its prefix.
  // Project chats: the passages change with every question, so only the instructions are cached.
  const bySource = cache === 'source';
  const question_ = [...(img ? [{type: 'image', source: {type: 'base64', media_type: img[1], data: img[2]}}] : []),
    {type: 'text', text: question, ...(bySource ? {cache_control: EPHEMERAL} : {})}];
  const body = {model, max_tokens: ANTHROPIC_MAX_TOKENS,
    system: [{type: 'text', text: instructions, ...(bySource ? {} : {cache_control: EPHEMERAL})}],
    ...(web ? {tools: [webSearchTool(model)]} : {}),
    messages: [{role: 'user', content: [{type: 'text', text: source, ...(bySource ? {cache_control: EPHEMERAL} : {})}]},
      ...history.map(m => ({role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content)})),
      {role: 'user', content: question_}]};
  if (FALLBACK_MODELS.has(model)) Object.assign(body, {betas: [FALLBACK_BETA], fallbacks: 'default'});
  return body;
}

// Text, cited web pages and usage of one or more Messages API responses (a paused turn and its continuations).
export function anthropicResult(responses) {
  let text = '';
  const out = new Map(), usage = {input: 0, output: 0, cacheRead: 0, cacheWrite: 0};
  for (const r of responses) {
    for (const b of r.content || []) if (b.type === 'text') {
      text += b.text || '';
      for (const c of b.citations || [])
        if (c.type === 'web_search_result_location' && /^https?:\/\//i.test(c.url || '') && !out.has(c.url)) out.set(c.url, {url: String(c.url).slice(0, 2000), title: String(c.title || '').slice(0, 300)});
    }
    const u = r.usage || {};
    usage.input += u.input_tokens || 0; usage.output += u.output_tokens || 0;
    usage.cacheRead += u.cache_read_input_tokens || 0; usage.cacheWrite += u.cache_creation_input_tokens || 0;
  }
  const last = responses[responses.length - 1] || {};
  return {text: text.trim() ? text : '', sources: [...out.values()].slice(0, 30), usage, model: last.model, stopReason: last.stop_reason};
}

async function anthropicTurn(opts) {
  const client = await createClient('anthropic', {apiKey: opts.apiKey, timeout: 300000});
  const body = anthropicRequest(opts), responses = [];
  const send = b => b.betas ? client.beta.messages.create(b) : client.messages.create(b);
  for (let i = 0; ; i++) {
    const r = await send(body);
    responses.push(r);
    if (r.stop_reason !== 'pause_turn' || i >= MAX_CONTINUATIONS) break;
    // A long web search turn paused server-side: send it back unchanged and the API resumes it.
    body.messages = [...body.messages, {role: 'assistant', content: r.content}];
  }
  const result = anthropicResult(responses);
  if (result.stopReason === 'refusal') throw Object.assign(new Error('refusal'), {refusal: true});
  if (!result.text) throw new Error('empty');
  delete result.stopReason;
  return result;
}

export function answerTurn(provider, opts) {
  return provider === 'anthropic' ? anthropicTurn(opts) : openaiTurn(opts);
}
