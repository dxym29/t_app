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

function isGeminiGenerateRequest(url) {
  return /generativelanguage\.googleapis\.com\/.*:generateContent(?:\?|$)/i.test(String(url || ''));
}

async function readBody(input, init) {
  if (init?.body !== undefined) return init.body;
  if (typeof Request !== 'undefined' && input instanceof Request) return await input.clone().text();
  return undefined;
}

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input?.url || '';
  const method = String(init?.method || input?.method || 'GET').toUpperCase();
  if (method !== 'POST' || !isGeminiGenerateRequest(url)) return originalFetch(input, init);

  const body = await readBody(input, init);
  if (typeof body !== 'string') return originalFetch(input, init);

  try {
    const json = JSON.parse(body);
    json.safetySettings = safetySettings;
    const headers = new Headers(init?.headers || (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined));
    headers.set('content-type', 'application/json');
    return await originalFetch(url, { ...init, method: 'POST', headers, body: JSON.stringify(json) });
  } catch (error) {
    console.error('Gemini request wrapper error:', error?.message || error);
    return originalFetch(input, init);
  }
};

console.log('Gemini request compatibility wrapper enabled.');
