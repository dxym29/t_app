// Gemini REST compatibility wrapper.
// Keep the SDK's generated config untouched; REST safety settings belong at
// the request body's top level, not inside a "config" object.
const originalFetch = globalThis.fetch;
const safetySettings = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
];

const PROHIBITED_MIN_CHARS = 1000;
const PROHIBITED_MAX_SPLIT_DEPTH = 3;

// In-memory Gemini API request counter. No database/storage is used.
// The counter is keyed to Asia/Bangkok calendar days and resets automatically
// when the first request/status check after 00:00 detects a new day.
function usageDayKey(){
  return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Bangkok',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
}
if(!globalThis.__geminiApiUsage)globalThis.__geminiApiUsage={day:usageDayKey(),count:0};
function getGeminiApiUsage(){
  const day=usageDayKey();
  if(globalThis.__geminiApiUsage.day!==day)globalThis.__geminiApiUsage={day,count:0};
  return globalThis.__geminiApiUsage;
}
function countGeminiApiCall(){
  const usage=getGeminiApiUsage();
  usage.count+=1;
  return usage.count;
}
globalThis.getGeminiApiUsage=getGeminiApiUsage;

function isGeminiGenerateRequest(url) {
  return /generativelanguage\.googleapis\.com\/.*:generateContent(?:\?|$)/i.test(String(url || ''));
}

async function readBody(input, init) {
  if (init?.body !== undefined) return init.body;
  if (typeof Request !== 'undefined' && input instanceof Request) return await input.clone().text();
  return undefined;
}

function isTranslationPrompt(json) {
  const text = String(json?.contents?.[0]?.parts?.[0]?.text || '');
  return text.includes('You are a professional Myanmar webnovel translator.') && text.includes('\nSOURCE:\n');
}

function getSourceText(json) {
  const text = String(json?.contents?.[0]?.parts?.[0]?.text || '');
  const marker = '\nSOURCE:\n';
  const index = text.lastIndexOf(marker);
  if (index < 0) return null;
  return { prefix: text.slice(0, index + marker.length), source: text.slice(index + marker.length) };
}

function splitSource(source) {
  const text = String(source || '');
  if (text.length < PROHIBITED_MIN_CHARS * 2) {
    const mid = Math.floor(text.length / 2);
    const paragraphBoundary = text.lastIndexOf('\n\n', mid);
    const cut = paragraphBoundary >= PROHIBITED_MIN_CHARS ? paragraphBoundary : mid;
    if (cut <= 0 || cut >= text.length) return null;
    return [text.slice(0, cut), text.slice(cut)];
  }

  const mid = Math.floor(text.length / 2);
  const paragraphBoundary = text.lastIndexOf('\n\n', mid);
  const cut = paragraphBoundary >= PROHIBITED_MIN_CHARS ? paragraphBoundary : mid;
  if (cut <= 0 || cut >= text.length) return null;
  return [text.slice(0, cut), text.slice(cut)];
}

function responseIsProhibited(json) {
  if (String(json?.promptFeedback?.blockReason || '').toUpperCase() === 'PROHIBITED_CONTENT') return true;
  return (json?.candidates || []).some(c => String(c?.finishReason || '').toUpperCase() === 'PROHIBITED_CONTENT');
}

function extractText(json) {
  const parts = [];
  for (const candidate of json?.candidates || []) {
    for (const part of candidate?.content?.parts || []) {
      if (typeof part?.text === 'string') parts.push(part.text);
    }
  }
  return parts.join('');
}

function makeCombinedResponse(baseJson, text) {
  const candidate = {
    ...(baseJson?.candidates?.[0] || {}),
    content: {
      ...(baseJson?.candidates?.[0]?.content || {}),
      parts: [{ text }]
    },
    finishReason: 'STOP'
  };
  const combined = {
    ...baseJson,
    promptFeedback: undefined,
    candidates: [candidate]
  };
  delete combined.promptFeedback;
  return combined;
}

async function fetchGemini(url, init, json) {
  json.safetySettings = safetySettings;
  countGeminiApiCall();
  const headers = new Headers(init?.headers || (typeof Request !== 'undefined' && init?.body === undefined ? undefined : undefined));
  headers.set('content-type', 'application/json');
  return originalFetch(url, { ...init, method: 'POST', headers, body: JSON.stringify(json) });
}

async function readJsonResponse(response) {
  try {
    return await response.clone().json();
  } catch {
    return null;
  }
}

async function translateWithProhibitedSplit(url, init, json) {
  // Exactly one request per model/API stage. A PROHIBITED_CONTENT response is
  // passed through unchanged so the translation route can skip the chapter.
  return fetchGemini(url, init, json);
}

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input?.url || '';
  const method = String(init?.method || input?.method || 'GET').toUpperCase();
  if (method !== 'POST' || !isGeminiGenerateRequest(url)) return originalFetch(input, init);

  const body = await readBody(input, init);
  if (typeof body !== 'string') return originalFetch(input, init);

  let json;
  try {
    json = JSON.parse(body);
  } catch (error) {
    console.error('Gemini request wrapper could not parse request JSON:', error?.message || error);
    return originalFetch(input, init);
  }
  // Do not resend a request if the network/API call itself throws.
  return translateWithProhibitedSplit(url, init, json);
};

console.log('Gemini request compatibility wrapper enabled.');
console.log('Phase 1 sends one full chapter per translation request; PROHIBITED_CONTENT is returned without splitting or retrying.');
console.log(`Gemini API usage counter initialized for ${usageDayKey()} (Asia/Bangkok).`);
