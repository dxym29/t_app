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

async function fetchGemini(url, init, json) {
  json.safetySettings = safetySettings;
  countGeminiApiCall();
  const headers = new Headers(init?.headers || (typeof Request !== 'undefined' && init?.body === undefined ? undefined : undefined));
  headers.set('content-type', 'application/json');
  return originalFetch(url, { ...init, method: 'POST', headers, body: JSON.stringify(json) });
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
  return fetchGemini(url, init, json);
};

console.log('Gemini request compatibility wrapper enabled.');
console.log('Gemini requests are sent as supplied; no request chunking or prohibited-content splitting is performed.');
console.log(`Gemini API usage counter initialized for ${usageDayKey()} (Asia/Bangkok).`);
