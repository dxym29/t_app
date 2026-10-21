import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';
import ExcelJS from 'exceljs';
import { GoogleGenAI } from '@google/genai';
import { createClient } from '@supabase/supabase-js';
import { fetchNovelPingChapter } from './fetcher.mjs';

const app=express();
const PORT=process.env.PORT||3000;
app.use(express.json({limit:'20mb'}));
app.use(express.static('public'));

const aiTranslate=new GoogleGenAI({apiKey:process.env.GEMINI_API_KEY});
const aiGlossary=new GoogleGenAI({apiKey:process.env.GEMINI_GLOSSARY_API_KEY||process.env.GEMINI_API_KEY_2});
const aiPolish=new GoogleGenAI({apiKey:process.env.GEMINI_POLISH_API_KEY||process.env.GEMINI_API_KEY_3});
const aiPolishFallbackKey=process.env.GEMINI_POLISH_FALLBACK_API_KEY||'';
const aiPolishFallback=aiPolishFallbackKey?new GoogleGenAI({apiKey:aiPolishFallbackKey}):null;
const POLISH_FALLBACK_MODEL=process.env.GEMINI_POLISH_FALLBACK_MODEL||'gemini-3.1-flash-lite';
const supabase=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
const MODELS=['gemini-3.1-flash-lite','gemini-3.5-flash-lite'];
const CHUNK_SIZES={'gemini-3.1-flash-lite':10000,'gemini-3.5-flash-lite':10000};
const TRANSLATE_CHUNK_SIZE=10000;
const CONTEXT_OVERLAP=200;
const MODEL_TIMEOUT=45000;
const MAX_RETRIES_PER_MODEL=2;
const RETRY_DELAY=5000;

function id(){return crypto.randomUUID()}
function fail(res,e){console.error(e);return res.status(500).json({error:e.message||'Server error'})}
async function q(promise){const {data,error}=await promise;if(error)throw new Error(error.message);return data}
function retryable(e){const s=String(e?.message||e);return /429|quota|RESOURCE_EXHAUSTED|503|UNAVAILABLE|overloaded|timeout|temporar/i.test(s)}
function sleep(ms){return new Promise(r=>setTimeout(r,ms))}
async function generateModel(ai,prompt,model,jsonMode=false){const started=Date.now();console.log(`Trying model: ${model}`);const response=await ai.models.generateContent({model,contents:prompt,config:{temperature:jsonMode?0.2:0.7,maxOutputTokens:8192,automaticContinuation:false,...(jsonMode?{responseMimeType:'application/json'}:{}),httpOptions:{timeout:MODEL_TIMEOUT}}});console.log(`SUCCESS: ${model} (${Date.now()-started}ms)`);return {text:response.text||'',model}}
async function generateWithRetries(ai,prompt,model,jsonMode=false){let lastError;for(let attempt=0;attempt<=MAX_RETRIES_PER_MODEL;attempt++){try{return await generateModel(ai,prompt,model,jsonMode)}catch(e){lastError=e;if(!retryable(e)||attempt===MAX_RETRIES_PER_MODEL)throw e;console.log(`${model} failed (attempt ${attempt+1}/${MAX_RETRIES_PER_MODEL}). Retrying in 5s...`);await sleep(RETRY_DELAY)}}throw lastError}
async function runTwoModelTask(ai,prompt,tag){const jsonMode=tag==='GLOSSARY';try{return await generateWithRetries(ai,prompt,MODELS[0],jsonMode)}catch(e){if(!retryable(e))throw e;console.log(`${tag}: 3.1 exhausted after 2 retries. Switching to 3.5.`);return await generateWithRetries(ai,prompt,MODELS[1],jsonMode)}}
async function runPolishTask(prompt,tag){try{return await runTwoModelTask(aiPolish,prompt,tag)}catch(e){if(!retryable(e)||!aiPolishFallback)throw e;console.log(`${tag}: primary polish API exhausted. Switching to separate polish fallback API.`);return await generateWithRetries(aiPolishFallback,prompt,POLISH_FALLBACK_MODEL,false)}}
function splitText(text,maxChars=TRANSLATE_CHUNK_SIZE){if(text.length<=maxChars)return [text];const paragraphs=text.split(/\n\s*\n/);const chunks=[];let current='';for(const p of paragraphs){const block=p.trim();if(!block)continue;const candidate=current?current+'\n\n'+block:block;if(candidate.length<=maxChars)current=candidate;else{if(current)chunks.push(current);if(block.length<=maxChars)current=block;else{for(let i=0;i<block.length;i+=maxChars)chunks.push(block.slice(i,i+maxChars));current=''}}}if(current)chunks.push(current);return chunks.filter(Boolean)}
function buildNameLocks(g){const locks=[];let n=1;for(const [type,arr] of Object.entries(g||{}))for(const x of arr||[]){const original=String(x.original||'').trim(),translation=String(x.translation||'').trim();if(!original||!translation)continue;locks.push({type,original,translation,token:`[[NAMELOCK_${String(n++).padStart(3,'0')}]]`})}locks.sort((a,b)=>b.original.length-a.original.length);return locks}
function filterGlossaryToSource(g,source){const text=String(source||'');const out={};for(const [type,arr] of Object.entries(g||{}))out[type]=(arr||[]).filter(x=>{const original=String(x.original||'').trim();return original&&text.includes(original)});return out}
function lockText(text,locks){let out=String(text||'');for(const x of locks)out=out.split(x.original).join(x.token);return out}
function lockTranslationText(text,locks){let out=String(text||'');const ordered=[...locks].sort((a,b)=>b.translation.length-a.translation.length);for(const x of ordered)out=out.split(x.translation).join(x.token);return out}
function restoreNameLocks(text,locks){let out=String(text||'');for(const x of locks){out=out.split(x.token).join(x.translation);out=out.split(x.original).join(x.translation)}return out}
function lockedGlossaryText(g,locks){const map=new Map(locks.map(x=>[x.original,x]));const lines=[];for(const [type,arr] of Object.entries(g||{}))for(const x of arr||[]){const l=map.get(String(x.original||'').trim());lines.push(`${type}: ${l?.token||x.original} => ${x.translation}${x.voice?` | voice: ${x.voice}`:''}${x.note?` | note: ${x.note}`:''}`)}return lines.join(String.fromCharCode(10))}
function countChars(text){return Array.from(String(text||'')).length}
function tokenRegex(token){return new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'g')}
function countToken(text,token){return (String(text||'').match(tokenRegex(token))||[]).length}
function normalizeForCompare(text){return String(text||'').replace(/\r/g,'').replace(/[ \t]+/g,' ').replace(/\n{3,}/g,'\n\n').trim()}
function masterPrompt({style,glossary,locks,source,previousTail,sourceContext}){return `You are a professional Myanmar webnovel translator.\n\nTASK:\nTranslate the COMPLETE SOURCE into natural, polished Myanmar literary prose.\n\nABSOLUTE RULES:\n- NEVER summarize, shorten, condense, skip, merge away, or omit source content.\n- Translate every action, description, thought, emotion, reaction, relationship, setting detail, and dialogue.\n- Do not invent facts, actions, motives, dialogue, names, items, events, or explanations.\n- Keep the exact story order and cause/effect.\n- Preserve paragraph and scene structure when practical.\n- Narration must read as smooth Myanmar literary prose, not awkward word-for-word translation.\n- Dialogue must sound like spoken Myanmar and reflect personality, relationship, social status, and current emotion.\n- Do not make every character speak with the same voice.\n- The glossary is authoritative.\n- NAME LOCK is active. Every [[NAMELOCK_###]] token in SOURCE is protected. Copy it EXACTLY. Never translate, alter, remove, split, duplicate, or paraphrase it.\n- Preserve titles, ranks, relationships, organizations, skills, items, and place names consistently.\n- CONTEXT sections are continuity only. Translate ONLY SOURCE.\n- Do not add notes, explanations, summaries, headings, or comments.\n- Return ONLY Myanmar translation.\n\nNOVEL-LEVEL STYLE:\n${style||'(No extra style rules.)'}\n\nAUTHORITATIVE GLOSSARY:\n${lockedGlossaryText(glossary,locks)}\n\nPREVIOUS TRANSLATED TAIL FOR CONTINUITY ONLY:\n${previousTail||'(none)'}\n\nSOURCE CONTEXT OVERLAP FOR CONTINUITY ONLY:\n${sourceContext||'(none)'}\n\nSOURCE:\n${source}`}
function glossaryPrompt(source){return `You are a web-novel terminology extraction specialist. Extract ONLY named entities and important story terms that appear in the SOURCE.\n\nExtract these categories:\n1. Character\n2. Item\n3. Organization\n4. Location\n\nRULES:\n- Only extract terms actually present in the SOURCE.\n- Do not invent, infer, or add terms that are not present.\n- Keep each original term exactly as it appears in the source when practical.\n- If the same entity appears multiple times, output it once.\n- Do not translate the story.\n- Do not summarize the chapter.\n- Suggested Myanmar names must be concise and natural, but they are suggestions only.\n- Return exactly one valid JSON object with no Markdown fences or explanations.\n- Use double quotes for all keys and string values; correctly escape quotes, backslashes, and line breaks inside strings.\n- Use an empty array when a category has no entries.\n- Each entry must contain only the string fields original and suggested.\n- Return JSON only.\n\nFORMAT:\n{\n  "characters":[{"original":"...","suggested":"..."}],\n  "items":[{"original":"...","suggested":"..."}],\n  "organizations":[{"original":"...","suggested":"..."}],\n  "locations":[{"original":"...","suggested":"..."}]\n}\n\nSOURCE:\n${source}`}
function polishPrompt(source,forceEdit=false){return `You are a Myanmar web-novel editor and literary polishing specialist.\n\nYour task is ONLY to polish the provided Myanmar translation into smooth, natural, readable Myanmar web-novel prose. You are NOT a translator.\n\nSTRICT RULES:\n- Preserve the complete meaning and every piece of story information.\n- NEVER add facts, events, actions, thoughts, motives, emotions, relationships, characters, items, locations, organizations, skills, powers, or dialogue.\n- NEVER remove, merge away, summarize, shorten, or condense information.\n- Do not change event order or who did/said something.\n- Do not reinterpret the story.\n- Preserve established names, titles, ranks, organizations, items, locations, skills, and terminology exactly.\n- Improve grammar, particles, sentence structure, word choice, punctuation, and unnatural phrasing only when meaning stays unchanged.\n- Narration should be smooth Myanmar literary prose.\n- Dialogue should sound naturally spoken and reflect personality, relationship, status, and emotion.\n- Keep different character voices distinct.\n- Keep narration and dialogue stylistically distinct where appropriate.\n- Preserve emotional intensity without exaggerating or weakening it.\n- Preserve paragraph and scene structure whenever practical.\n${forceEdit?'- IMPORTANT: This is a second polishing attempt because the previous result was effectively identical to the input. Do NOT return the input verbatim. Actively revise sentence flow, particles, word choice, punctuation, and awkward phrasing wherever a safe improvement is possible. Make genuine editorial changes while preserving exactly the same information and meaning.\n':''}- Do not add headings, notes, explanations, comments, or summaries.\n\nNAME LOCK:\nProtected tokens such as [[NAMELOCK_001]] are immutable. Copy every token exactly. Never translate, alter, delete, duplicate, split, or move a protected token.\n\nReturn ONLY the polished Myanmar text.\n\nINPUT:\n${source}`}
async function getGlossary(novelId){const rows=await q(supabase.from('glossary_terms').select('*').eq('novel_id',novelId).order('created_at'));const g={characters:[],items:[],locations:[],organizations:[],skills:[],other:[]};for(const r of rows)(g[r.type]??g.other).push(r);return g}
function validateGlossaryObject(x){return x&&typeof x==='object'&&['characters','items','organizations','locations'].every(k=>Array.isArray(x[k]))}
function validateLockedOutput(text,locks,expectedCounts){for(const x of locks){const expected=expectedCounts.get(x.token);if(expected===undefined)continue;const actual=countToken(text,x.token);if(actual!==expected)return false}return true}

app.get('/api/health',(_,res)=>res.json({ok:true}));
app.get('/api/novels',async(_,res)=>{try{res.json(await q(supabase.from('novels').select('*').order('created_at')))}catch(e){fail(res,e)}});
app.post('/api/novels',async(req,res)=>{try{res.json(await q(supabase.from('novels').insert({name:req.body.name||'New Novel',style:req.body.style||''}).select().single()))}catch(e){fail(res,e)}});
app.put('/api/novels/:id',async(req,res)=>{try{res.json(await q(supabase.from('novels').update({name:req.body.name,style:req.body.style,updated_at:new Date().toISOString()}).eq('id',req.params.id).select().single()))}catch(e){fail(res,e)}});
app.delete('/api/novels/:id',async(req,res)=>{try{await q(supabase.from('novels').delete().eq('id',req.params.id));res.json({ok:true})}catch(e){fail(res,e)}});
app.get('/api/glossary/:novelId',async(req,res)=>{try{res.json(await getGlossary(req.params.novelId))}catch(e){fail(res,e)}});
app.post('/api/glossary/:novelId',async(req,res)=>{try{res.json(await q(supabase.from('glossary_terms').upsert({novel_id:req.params.novelId,type:req.body.type,original:req.body.original,translation:req.body.translation,note:req.body.note||'',voice:req.body.voice||''},{onConflict:'novel_id,type,original'}).select().single()))}catch(e){fail(res,e)}});
app.delete('/api/glossary/:novelId/:type/:id',async(req,res)=>{try{await q(supabase.from('glossary_terms').delete().eq('novel_id',req.params.novelId).eq('id',req.params.id));res.json({ok:true})}catch(e){fail(res,e)}});
app.get('/api/episodes/:novelId',async(req,res)=>{try{res.json(await q(supabase.from('episodes').select('*').eq('novel_id',req.params.novelId).order('number')))}catch(e){fail(res,e)}});
app.get('/api/episodes/:novelId/list',async(req,res)=>{try{res.json(await q(supabase.from('episodes').select('id,novel_id,number,title,status,model,updated_at').eq('novel_id',req.params.novelId).order('number')))}catch(e){fail(res,e)}});
app.get('/api/episodes/:novelId/:id',async(req,res)=>{try{res.json(await q(supabase.from('episodes').select('*').eq('novel_id',req.params.novelId).eq('id',req.params.id).single()))}catch(e){fail(res,e)}});
app.post('/api/episodes/:novelId',async(req,res)=>{try{res.json(await q(supabase.from('episodes').insert({novel_id:req.params.novelId,number:req.body.number,title:req.body.title||'',source:req.body.source||'',translation:req.body.translation||'',status:'draft'}).select().single()))}catch(e){fail(res,e)}});
app.put('/api/episodes/:novelId/:id',async(req,res)=>{try{res.json(await q(supabase.from('episodes').update({number:req.body.number,title:req.body.title,source:req.body.source,translation:req.body.translation,status:req.body.status||'draft',updated_at:new Date().toISOString()}).eq('novel_id',req.params.novelId).eq('id',req.params.id).select().single()))}catch(e){fail(res,e)}});
app.delete('/api/episodes/:novelId/:id',async(req,res)=>{try{await q(supabase.from('episodes').delete().eq('novel_id',req.params.novelId).eq('id',req.params.id));res.json({ok:true})}catch(e){fail(res,e)}});

app.post('/api/fetch-chapter',async(req,res)=>{try{const {url}=req.body;if(!url?.trim())return res.status(400).json({error:'Chapter URL is required'});const result=await fetchNovelPingChapter(url.trim());res.json(result)}catch(e){fail(res,e)}});

app.post('/api/translate',async(req,res)=>{try{const {novelId,episodeId,source}=req.body;if(!novelId||!source?.trim())return res.status(400).json({error:'Novel and source are required'});const novel=await q(supabase.from('novels').select('*').eq('id',novelId).single());const allGlossary=await getGlossary(novelId);const glossary=filterGlossaryToSource(allGlossary,source);const locks=buildNameLocks(glossary);let activeModel=MODELS[0],chunks=splitText(source,TRANSLATE_CHUNK_SIZE),result='',modelUsed=activeModel;for(let i=0;i<chunks.length;i++){const chunk=chunks[i],previousSource=chunks[i-1]?chunks[i-1].slice(-CONTEXT_OVERLAP):'',lockedChunk=lockText(chunk,locks),lockedPreviousSource=lockText(previousSource,locks);try{const r=await generateWithRetries(aiTranslate,masterPrompt({style:novel.style,glossary,locks,source:lockedChunk,previousTail:result.slice(-5000),sourceContext:lockedPreviousSource}),activeModel);result+=(result?'\n\n':'')+restoreNameLocks(r.text.trim(),locks);modelUsed=r.model}catch(e){if(!retryable(e))throw e;if(activeModel===MODELS[0]){activeModel=MODELS[1];const remaining=chunks.slice(i).join('\n\n');chunks=chunks.slice(0,i).concat(splitText(remaining,TRANSLATE_CHUNK_SIZE));i--;continue}throw e}}if(episodeId)await q(supabase.from('episodes').update({source,translation:result,model:modelUsed,status:'translated',updated_at:new Date().toISOString()}).eq('id',episodeId).eq('novel_id',novelId));res.json({translation:result,model:modelUsed,sourceChars:countChars(source),pass1Chars:countChars(result)})}catch(e){fail(res,e)}});

function parseGlossaryJson(text){const raw=String(text||'').trim().replace(/^\uFEFF/,'').replace(/^\`\`\`(?:json)?\s*/i,'').replace(/\s*\`\`\`$/,'').trim();try{return JSON.parse(raw)}catch(firstError){const start=raw.indexOf('{');if(start<0)throw firstError;let depth=0,inString=false,escaped=false;for(let i=start;i<raw.length;i++){const ch=raw[i];if(inString){if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch==='"')inString=false;continue}if(ch==='"'){inString=true;continue}if(ch==='{')depth++;else if(ch==='}'&&--depth===0){const candidate=raw.slice(start,i+1);try{return JSON.parse(candidate)}catch{return JSON.parse(candidate.replace(/,\\s*([}\\]])/g,'$1'))}}}throw firstError}}
app.post('/api/extract-glossary',async(req,res)=>{try{const {source}=req.body;if(!source?.trim())return res.status(400).json({error:'Source is required'});const r=await runTwoModelTask(aiGlossary,glossaryPrompt(source),'GLOSSARY');let data;try{data=parseGlossaryJson(r.text)}catch{throw new Error('Glossary AI returned invalid JSON. Please try again.')}if(!validateGlossaryObject(data))throw new Error('Glossary AI returned an invalid format.');res.json({glossary:data,model:r.model,sourceChars:countChars(source)})}catch(e){fail(res,e)}});

app.post('/api/polish',async(req,res)=>{try{const {novelId,episodeId,translation}=req.body;if(!novelId||!translation?.trim())return res.status(400).json({error:'Novel and translation are required'});let episodeSource='';if(episodeId){const episode=await q(supabase.from('episodes').select('source').eq('id',episodeId).eq('novel_id',novelId).single());episodeSource=episode?.source||''}const allGlossary=await getGlossary(novelId);const glossary=episodeSource?filterGlossaryToSource(allGlossary,episodeSource):allGlossary;const locks=buildNameLocks(glossary);const locked=lockTranslationText(translation,locks);const expected=new Map();for(const x of locks)expected.set(x.token,countToken(locked,x.token));let r=await runPolishTask(polishPrompt(locked,false),'POLISH');if(!validateLockedOutput(r.text,locks,expected))throw new Error('Polish validation failed: a protected name/term changed. The original translation was not replaced.');let polished=restoreNameLocks(r.text.trim(),locks);if(normalizeForCompare(polished)===normalizeForCompare(translation)){console.log('POLISH: output unchanged after first attempt. Running one stronger editorial pass.');r=await runPolishTask(polishPrompt(locked,true),'POLISH-REVISE');if(!validateLockedOutput(r.text,locks,expected))throw new Error('Polish validation failed: a protected name/term changed during the revision pass. The original translation was not replaced.');polished=restoreNameLocks(r.text.trim(),locks)}res.json({translation:polished,model:r.model,pass1Chars:countChars(translation),pass2Chars:countChars(polished),changed:normalizeForCompare(polished)!==normalizeForCompare(translation)})}catch(e){fail(res,e)}});

function slugify(value){return String(value||'novel').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^A-Za-z0-9]+/g,'-').replace(/^-+|-+$/g,'').toLowerCase()||'novel'}
function excelValue(value){return value==null?'':String(value)}
async function fetchExportRows(table, columns, novelId, orderColumn, batchSize=25){
  const rows=[];
  for(let start=0;;start+=batchSize){
    const batch=await q(supabase.from(table).select(columns).eq('novel_id',novelId).order(orderColumn).range(start,start+batchSize-1));
    rows.push(...batch);
    if(batch.length<batchSize)break;
  }
  return rows;
}
async function buildTemplateWorkbook(novelId){
  const novel=await q(supabase.from('novels').select('id,name,style').eq('id',novelId).single());
  const glossary=await fetchExportRows('glossary_terms','original,translation,type,note,voice',''+novelId,'created_at',100);
  const episodes=(await q(supabase.from('episodes').select('number,title,source,translation').eq('novel_id',''+novelId))).sort((a,b)=>Number(a.number)-Number(b.number));
  const wb=new ExcelJS.Workbook();
  wb.creator='Webnovel Translator';
  wb.created=new Date();
  const headerFill={type:'pattern',pattern:'solid',fgColor:{argb:'FF4338CA'}};
  const headerFont={bold:true,color:{argb:'FFFFFFFF'}};
  const guide=wb.addWorksheet('Guide');
  guide.addRow(['MM Novel workbook','Guidance']);
  guide.addRow(['Novel sheet','Keep the field/value columns. Add one value per field. Slug must use Latin letters. Existing genre names may be separated with |.']);
  guide.addRow(['Chapters sheet','One chapter per row. Keep chapterNo unique. Enter sourceContent, translatedContent, or both. Set publishImmediately to TRUE only when the Burmese translation is ready to publish.']);
  guide.addRow(['Glossary sheet','One term per row. sourceTerm and translatedTerm are required; add character voice, cultivation level, realm, or notes in the other columns.']);
  guide.addRow(['Import','Use .xlsx files. Keep all sheet names and column headers unchanged. Import creates a new novel; it will not overwrite an existing novel.']);
  guide.columns=[{width:25},{width:115}];
  guide.views=[{state:'frozen',ySplit:1}];
  guide.getRow(1).eachCell(c=>{c.fill=headerFill;c.font=headerFont;});
  guide.eachRow((row,n)=>{row.height=n===1?22:34;row.eachCell((cell,col)=>{cell.alignment={vertical:'top',wrapText:true};if(n>1&&col===1)cell.font={bold:true};});});
  const ns=wb.addWorksheet('Novel');
  ns.addRow(['field','value']);
  for(const row of [['title',excelValue(novel.name)],['slug',slugify(novel.name)],['originalTitle',''],['author',''],['description',''],['coverUrl',''],['sourceLanguage','zh'],['translationGenre','general'],['translationTone','natural'],['translationNamePolicy','consistent'],['translationInstructions',excelValue(novel.style)],['status','ONGOING'],['isPublished','false'],['genres','']])ns.addRow(row);
  ns.columns=[{width:30},{width:70}];
  ns.views=[{state:'frozen',ySplit:1}];
  ns.autoFilter='A1:B1';
  const cs=wb.addWorksheet('Chapters');
  cs.addRow(['chapterNo','title','sourceLanguage','sourceContent','translatedTitle','translatedContent','publishImmediately']);
  for(const [index,e] of episodes.entries())cs.addRow([index+1,excelValue(e.title),'zh',excelValue(e.source),'',excelValue(e.translation),'FALSE']);
  cs.columns=[{width:14},{width:28},{width:18},{width:72},{width:28},{width:72},{width:22}];
  cs.views=[{state:'frozen',ySplit:1}];
  cs.autoFilter='A1:G1';
  const gs=wb.addWorksheet('Glossary');
  gs.addRow(['sourceTerm','translatedTerm','termType','note','characterVoice']);
  for(const x of glossary)gs.addRow([excelValue(x.original),excelValue(x.translation),excelValue(x.type),excelValue(x.note),excelValue(x.voice)]);
  gs.columns=[{width:28},{width:32},{width:20},{width:48},{width:42}];
  gs.views=[{state:'frozen',ySplit:1}];
  gs.autoFilter='A1:E1';
  for(const ws of [ns,cs,gs]){
    ws.getRow(1).eachCell(cell=>{cell.fill=headerFill;cell.font=headerFont;cell.alignment={vertical:'center',wrapText:true};});
    ws.getRow(1).height=24;
    ws.eachRow((row,rowNumber)=>{if(rowNumber>1)row.eachCell(cell=>{cell.alignment={vertical:'top',wrapText:true};});});
  }
  return wb;
}
app.get('/api/export/template/:id',async(req,res)=>{try{const wb=await buildTemplateWorkbook(req.params.id);const buffer=await wb.xlsx.writeBuffer();const novel=await q(supabase.from('novels').select('name').eq('id',req.params.id).single());res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');res.setHeader('Content-Disposition',`attachment; filename="${slugify(novel.name)}-mm-novel.xlsx"`);res.setHeader('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');res.setHeader('Pragma','no-cache');res.setHeader('Expires','0');res.setHeader('X-Workbook-Export-Version','chapter-sequence-v2');res.send(Buffer.from(buffer))}catch(e){fail(res,e)}});
async function exportNovel(novelId){const novel=await q(supabase.from('novels').select('*').eq('id',novelId).single());const glossary=await q(supabase.from('glossary_terms').select('*').eq('novel_id',novelId));const episodes=await q(supabase.from('episodes').select('*').eq('novel_id',novelId).order('number'));return {version:2,exportedAt:new Date().toISOString(),novels:[novel],glossary,episodes}}
app.get('/api/export/novel/:id',async(req,res)=>{try{res.setHeader('Content-Disposition','attachment; filename=novel-backup.json');res.json(await exportNovel(req.params.id))}catch(e){fail(res,e)}});
app.get('/api/export/all',async(_,res)=>{try{const novels=await q(supabase.from('novels').select('*').order('created_at'));const glossary=await q(supabase.from('glossary_terms').select('*'));const episodes=await q(supabase.from('episodes').select('*').order('novel_id,number'));res.setHeader('Content-Disposition','attachment; filename=webnovel-backup.json');res.json({version:2,exportedAt:new Date().toISOString(),novels,glossary,episodes})}catch(e){fail(res,e)}});
app.post('/api/import',async(req,res)=>{try{const d=req.body;if(!Array.isArray(d.novels))throw new Error('Invalid backup');let ec=0;for(const n of d.novels){const existing=await q(supabase.from('novels').select('id').eq('id',n.id).maybeSingle());if(existing)await q(supabase.from('novels').update({name:n.name,style:n.style||'',updated_at:new Date().toISOString()}).eq('id',n.id));else await q(supabase.from('novels').insert({id:n.id,name:n.name,style:n.style||''}))}if(Array.isArray(d.glossary)&&d.glossary.length)await q(supabase.from('glossary_terms').upsert(d.glossary.map(x=>({id:x.id,novel_id:x.novel_id,type:x.type,original:x.original,translation:x.translation,note:x.note||'',voice:x.voice||''})),{onConflict:'id'}));if(Array.isArray(d.episodes)&&d.episodes.length){await q(supabase.from('episodes').upsert(d.episodes.map(x=>({id:x.id,novel_id:x.novel_id,number:x.number,title:x.title||'',source:x.source||'',translation:x.translation||'',model:x.model||'',status:x.status||'draft',created_at:x.created_at||new Date().toISOString(),updated_at:x.updated_at||new Date().toISOString()})),{onConflict:'id'}));ec=d.episodes.length}res.json({novels:d.novels.length,episodes:ec})}catch(e){fail(res,e)}});
app.listen(PORT,'0.0.0.0',()=>console.log(`Webnovel Translator running on port ${PORT}`));
