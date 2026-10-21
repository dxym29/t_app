// Preserve the Google GenAI SDK request payload.
// The SDK serializes supported config fields itself. Injecting a top-level
// "config" property into the REST JSON body causes HTTP 400 Unknown name "config".
const originalFetch = globalThis.fetch;

function isGeminiGenerateRequest(url) {
  return /generativelanguage\.googleapis\.com\/.*:generateContent(?:\?|$)/i.test(String(url || ''));
}

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input?.url || '';
  const method = String(init?.method || input?.method || 'GET').toUpperCase();

  if (method === 'POST' && isGeminiGenerateRequest(url)) {
    return originalFetch(input, init);
  }

  return originalFetch(input, init);
};

console.log('Gemini request compatibility wrapper enabled.');
