const originalFetch = globalThis.fetch;
const key1 = process.env.GEMINI_TRANSLATE_FALLBACK_API_KEY || '';
const key2 = process.env.GEMINI_TRANSLATE_FALLBACK_API_KEY_2 || '';

function isGemini(url){return /generativelanguage\.googleapis\.com\/.*:generateContent(?:\?|$)/i.test(String(url||''))}
function isTranslation(json){const t=String(json?.contents?.[0]?.parts?.[0]?.text||'');return t.includes('You are a professional Myanmar webnovel translator.')&&t.includes('\nSOURCE:\n')}
function model(url,name){return String(url).replace(/(\/models\/)[^/:?]+(:generateContent)/i,`$1${name}$2`)}
function key(url,value){if(!value)return url;const u=new URL(url);u.searchParams.set('key',value);return u.toString()}
function quota(body,res){const s=JSON.stringify(body||{}).toUpperCase();return res.status===429||/QUOTA|RESOURCE_EXHAUSTED|RATE LIMIT|TOO MANY REQUESTS/.test(s)}
async function json(res){try{return await res.clone().json()}catch{return null}}
async function send(url,init,body){const h=new Headers(init?.headers||{});h.set('content-type','application/json');return originalFetch(url,{...init,method:'POST',headers:h,body:JSON.stringify(body)})}

globalThis.fetch=async(input,init={})=>{
 const url=typeof input==='string'?input:input?.url||'';
 const method=String(init?.method||input?.method||'GET').toUpperCase();
 if(method!=='POST'||!isGemini(url))return originalFetch(input,init);
 const raw=init?.body!==undefined?init.body:(typeof Request!=='undefined'&&input instanceof Request?await input.clone().text():undefined);
 if(typeof raw!=='string')return originalFetch(input,init);
 let body;try{body=JSON.parse(raw)}catch{return originalFetch(input,init)}
 if(!isTranslation(body))return originalFetch(input,init);
 const stages=[
  ['MAIN','gemini-3.1-flash-lite',''],
  ['MAIN','gemini-3.5-flash-lite',''],
  ['FALLBACK-1','gemini-3.1-flash-lite',key1],
  ['FALLBACK-1','gemini-3.5-flash-lite',key1],
  ['FALLBACK-2','gemini-3.1-flash-lite',key2],
  ['FALLBACK-2','gemini-3.5-flash-lite',key2]
 ];
 for(const [label,mdl,apiKey] of stages){
  if((label!=='MAIN')&&!apiKey)continue;
  const stageUrl=key(model(url,mdl),apiKey);
  const res=await send(stageUrl,init,body);
  const data=await json(res);
  if(!quota(data,res))return res;
  console.log(`Phase 1 quota exceeded: ${label} ${mdl} -> next fallback.`);
 }
 return send(key(model(url,'gemini-3.5-flash-lite'),key2||key1),init,body);
};
console.log('Phase 1 quota fallback enabled: MAIN 3.1 -> 3.5 -> FALLBACK-1 3.1 -> 3.5 -> FALLBACK-2 3.1 -> 3.5.');
