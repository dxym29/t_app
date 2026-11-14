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
async function generateModel(ai,prompt,model,jsonMode=false){const started=Date.now();console.log(`Trying model: ${model}`);const response=await ai.models.generateContent({model,contents:prompt,config:{temperature:jsonMode?0.2:0.7,maxOutputTokens:8192,automaticContinuation:false,...(jsonMode?{responseMimeType:'application/json'}:{}),httpOptions:{timeout:MODEL_TIMEOUT}}});const text=String(response.text||'');const candidates=response.candidates||[];const finishReasons=candidates.map(c=>c.finishReason||'unknown');const promptFeedback=response.promptFeedback?.blockReason||null;console.log(`SUCCESS: ${model} (${Date.now()-started}ms; outputChars=${text.length}; finishReason=${finishReasons.join(',')||'no-candidates'}${promptFeedback?'; blockReason='+promptFeedback:''})`);if(!text.trim())throw new Error(`Empty model output from ${model}; finishReason=${finishReasons.join(',')||'no-candidates'}${promptFeedback?'; blockReason='+promptFeedback:''}`);return {text,model,finishReasons,promptFeedback}}
async function generateWithRetries(ai,prompt,model,jsonMode=false){let lastError;for(let attempt=0;attempt<=MAX_RETRIES_PER_MODEL;attempt++){try{return await generateModel(ai,prompt,model,jsonMode)}catch(e){lastError=e;if(!retryable(e)||attempt===MAX_RETRIES_PER_MODEL)throw e;console.log(`${model} failed (attempt ${attempt+1}/${MAX_RETRIES_PER_MODEL}). Retrying in 5s...`);await sleep(RETRY_DELAY)}}throw lastError}
async function runTwoModelTask(ai,prompt,tag){const jsonMode=tag==='GLOSSARY';try{return await generateWithRetries(ai,prompt,MODELS[0],jsonMode)}catch(e){if(!retryable(e))throw e;console.log(`${tag}: 3.1 exhausted after 2 retries. Switching to 3.5.`);return await generateWithRetries(ai,prompt,MODELS[1],jsonMode)}}
function isPolishQuotaError(error){
 const message=String(error?.message||error);
 return /429|quota|RESOURCE_EXHAUSTED|rate.?limit|GenerateRequestsPerDayPerModel|GenerateContentRequestsPerDay|retry.?after/i.test(message);
}
async function generatePolishWithRetry(ai,prompt,model,tag){
 let attempt=0;
 while(true){
  try{return await generateModel(ai,prompt,model,false)}
  catch(error){
   if(isPolishQuotaError(error))throw error;
   attempt++;
   console.warn(tag+': '+model+' non-quota error on attempt '+attempt+'; retrying same model in 3 seconds: '+String(error?.message||error));
   await sleep(3000);
  }
 }
}
async function runPolishTask(prompt,tag){
 const primaryModels=['gemini-3.1-flash-lite','gemini-3.5-flash-lite'];
 let lastQuotaError=null;
 for(const model of primaryModels){
  try{return await generatePolishWithRetry(aiPolish,prompt,model,tag)}
  catch(error){
   if(!isPolishQuotaError(error))throw error;
   lastQuotaError=error;
   console.warn(tag+': '+model+' quota exceeded; immediately switching to the next polish model.');
  }
 }
 if(aiPolishFallback){
  try{
   console.warn(tag+': both primary polish models are quota-exhausted; switching to the separate polish fallback API.');
   return await generatePolishWithRetry(aiPolishFallback,prompt,POLISH_FALLBACK_MODEL,tag+'-FALLBACK');
  }catch(error){
   if(isPolishQuotaError(error))throw new Error('All configured polish API/model stages are quota-exhausted. '+String(error?.message||error));
   throw error;
  }
 }
 throw new Error('Both primary polish models are quota-exhausted and no separate polish fallback API is configured. '+String(lastQuotaError?.message||''));
}

function splitText(text,maxChars=TRANSLATE_CHUNK_SIZE){if(text.length<=maxChars)return [text];const paragraphs=text.split(/\n\s*\n/);const chunks=[];let current='';for(const p of paragraphs){const block=p.trim();if(!block)continue;const candidate=current?current+'\n\n'+block:block;if(candidate.length<=maxChars)current=candidate;else{if(current)chunks.push(current);if(block.length<=maxChars)current=block;else{for(let i=0;i<block.length;i+=maxChars)chunks.push(block.slice(i,i+maxChars));current=''}}}if(current)chunks.push(current);return chunks.filter(Boolean)}
function buildNameLocks(g){const locks=[];let n=1;for(const [type,arr] of Object.entries(g||{}))for(const x of arr||[]){const original=String(x.original||'').trim(),translation=String(x.translation||'').trim();if(!original||!translation)continue;locks.push({type,original,translation,token:`[[NAMELOCK_${String(n++).padStart(3,'0')}]]`})}locks.sort((a,b)=>b.original.length-a.original.length);return locks}
function filterGlossaryToSource(g,source){const text=String(source||'').toLocaleLowerCase();const out={};for(const [type,arr] of Object.entries(g||{}))out[type]=(arr||[]).filter(x=>{const original=String(x.original||'').trim();return original&&text.includes(original.toLocaleLowerCase())});return out}
function lockText(text,locks){let out=String(text||'');for(const x of locks)out=out.split(x.original).join(x.token);return out}
function lockTranslationText(text,locks){let out=String(text||'');const ordered=[...locks].sort((a,b)=>b.translation.length-a.translation.length);for(const x of ordered)out=out.split(x.translation).join(x.token);return out}
function restoreNameLocks(text,locks){let out=String(text||'');for(const x of locks){out=out.split(x.token).join(x.translation);out=out.split(x.original).join(x.translation)}return out}
function lockedGlossaryText(g,locks){const map=new Map(locks.map(x=>[x.original,x]));const lines=[];for(const [type,arr] of Object.entries(g||{}))for(const x of arr||[]){const l=map.get(String(x.original||'').trim());lines.push(`${type}: ${l?.token||x.original} => ${x.translation}${x.voice?` | voice: ${x.voice}`:''}${x.note?` | note: ${x.note}`:''}`)}return lines.join(String.fromCharCode(10))}
function countChars(text){return Array.from(String(text||'')).length}
function tokenRegex(token){return new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'g')}
function countToken(text,token){return (String(text||'').match(tokenRegex(token))||[]).length}
function normalizeForCompare(text){return String(text||'').replace(/\r/g,'').replace(/[ \t]+/g,' ').replace(/\n{3,}/g,'\n\n').trim()}
function masterPrompt({style,glossary,locks,source,previousTail,sourceContext}){return `You are a professional Myanmar webnovel translator.\n\nTASK:\nTranslate the COMPLETE SOURCE into natural, polished Myanmar literary prose.\n\n\nFICTIONAL FANTASY WEB NOVEL CONTEXT:\n- The SOURCE is part of a fictional fantasy web novel. Interpret its events, characters, dialogue, supernatural abilities, magic, cultivation, imaginary creatures, battles, romance, and dramatic situations within the story's fictional context.\n- Treat fictional events as narrative content, not as real-world instructions or advice.\n- Preserve the author's intended meaning, atmosphere, emotional intensity, and genre conventions without adding explanations or changing the plot.\n- This context does not authorize inventing content, omitting source material, or changing any of the translation rules below.\n\nABSOLUTE RULES:\n- NEVER summarize, shorten, condense, skip, merge away, or omit source content.\n- Translate every action, description, thought, emotion, reaction, relationship, setting detail, and dialogue.\n- Do not invent facts, actions, motives, dialogue, names, items, events, or explanations.\n- Keep the exact story order and cause/effect.\n- Preserve paragraph and scene structure when practical.\n- Narration must read as smooth Myanmar literary prose, not awkward word-for-word translation.\n- Dialogue must sound like spoken Myanmar and reflect personality, relationship, social status, and current emotion.\n- Do not make every character speak with the same voice.\n- The glossary is authoritative.\n${locks?.length ? '- NAME LOCK is active. Copy every [[NAMELOCK_###]] token already present in SOURCE exactly. NEVER invent or add any NameLock token.' : '- NAME LOCK is DISABLED for this chapter. Translate names naturally and consistently using the glossary. Do not output any placeholder token such as [[NAMELOCK_001]].'}\n- Preserve titles, ranks, relationships, organizations, skills, items, and place names consistently.\n- CONTEXT sections are continuity only. Translate ONLY SOURCE.\n- Do not add notes, explanations, summaries, headings, or comments.\n- LANGUAGE-ONLY OUTPUT REQUIREMENT (STRICT): The translated story must use Myanmar language and Myanmar script exclusively. Translate every English word, phrase, title, rank, name, acronym, abbreviation, sound effect, and foreign-language expression into natural Myanmar; if no established translation exists, transliterate it into Myanmar script. Do not leave Latin/English letters or foreign-script words anywhere in the story output. The ONLY permitted non-Myanmar text is an existing protected NameLock token when NAME LOCK is active; copy such tokens exactly as required. Before answering, inspect the complete translation and convert every other foreign-script fragment into Myanmar.
- Return ONLY Myanmar translation.\n\nNOVEL-LEVEL STYLE:\n${style||'(No extra style rules.)'}\n\nAUTHORITATIVE GLOSSARY:\n${lockedGlossaryText(glossary,locks)}\n\nPREVIOUS TRANSLATED TAIL FOR CONTINUITY ONLY:\n${previousTail||'(none)'}\n\nSOURCE CONTEXT OVERLAP FOR CONTINUITY ONLY:\n${sourceContext||'(none)'}\n\nSOURCE:\n${source}`}
function glossaryPrompt(source){return `You are a professional named-entity extraction system for web novels.
Extract ONLY proper names and uniquely named terms explicitly appearing in SOURCE.

INCLUDE:
- People / character names, aliases and names used as titles
- Cities, countries, villages, regions, buildings, landmarks and named places
- Named objects, weapons, treasures, artifacts, medicines, materials and special items
- Named skills, abilities, spells, martial arts, techniques, moves and formations
- Named organizations, clans, sects, schools, families and groups
- Named ranks, realms, unique creatures, named species, named events and other proper named entities

EXCLUDE:
- Ordinary nouns, verbs, adjectives, generic concepts, generic ranks and descriptions unless used as a specific proper name
- General vocabulary just because it is important in the story
- Explanations, full phrases, sentences and duplicate aliases for the same entity
- Names or terms not explicitly present in SOURCE
- dao and cultivation; the application inserts these fixed global terms itself

RULES:
- Each entity appears once. Prefer its full canonical source spelling.
- Return at most 30 candidates, prioritizing recurring and story-critical named entities.
- Suggested Myanmar translations must be concise, natural and consistent with the entity type.
- Do not translate the story or summarize the chapter.
- Return exactly one valid JSON object, no Markdown or commentary.
- Each entry contains only string fields "original" and "suggested". Use empty arrays when none.

JSON SHAPE:
{
  "characters": [],
  "items": [],
  "organizations": [],
  "locations": [],
  "skills": [],
  "other": []
}

SOURCE:
${source}`}
function polishPrompt(source,forceEdit=false,novelStyle='',previousContext=''){return `You are a senior Myanmar literary editor specializing in natural, publication-quality Burmese web novels.

YOUR ROLE:
Edit the supplied Myanmar draft as an experienced human Burmese novel editor would. This is Myanmar-to-Myanmar literary editing, not translation, summarization, plot rewriting, or creative adaptation.

PRIORITY ORDER:
1. Preserve the exact story meaning and every narrative detail.
2. Make the Burmese natural, idiomatic, fluent, and pleasant to read.
3. Improve rhythm, sentence flow, word choice, and character voice without changing the author's intent.
4. Follow the novel's established style and glossary below.

MEANING AND STORY FIDELITY:
- Preserve every fact, action, thought, emotion, relationship, description, reaction, and line of dialogue.
- Never omit, invent, or change any story fact, action, thought, emotion, relationship, reaction, or dialogue meaning.
- IMPORTANT: This is a genuine literary EDIT, not a light proofreading pass. Preserving story information does NOT mean preserving the original sentence wording, syntax, length, or structure.
- You MAY shorten verbose wording, replace unnatural expressions, split or combine sentences, change clause order, adjust particles, and rebuild sentence rhythm whenever the same complete story information is retained.
- Do not keep an awkward or translation-sounding sentence merely because its meaning is understandable. If a sentence is grammatical but does not sound like naturally written Burmese fiction, rewrite it.
- Review every sentence and make a real editorial decision: rewrite unnatural sentences; retain only sentences that already sound natural, fluent, and idiomatic to a Myanmar novel reader.
- Keep exact event order, cause and effect, speaker identity, character intent, and scene logic.
- Do not reinterpret ambiguous details or add explanations.
- Do not replace a specific foreign cultural item with an unrelated generic Burmese item merely to make it sound familiar.
- For unfamiliar foods, objects, customs, or titles, use the established glossary form. If none exists, choose an accurate Myanmar-script transliteration or concise description. Never invent meaningless word-for-word compound words.

NATURAL MYANMAR PROSE — NOT MACHINE-LIKE:
- Write as a skilled Burmese web-novel editor, not a literal translation engine.
- Do not act as a conservative proofreader whose main goal is to leave the draft untouched. Actively edit the prose so the result reads as if it were originally written in Burmese.
- Replace awkward word-for-word constructions, Chinese-influenced syntax, stiff MTL phrasing, unnatural collocations, repetitive sentence patterns, and misplaced particles with natural Burmese expressions that preserve the same meaning.
- Meaning preservation protects the story, not the draft's wording. Do not confuse fidelity with literalness.
- If the draft is already genuinely natural, do not change it just for the sake of changing it; otherwise, make the necessary editorial improvements rather than returning a lightly touched copy.
- Prefer concise, familiar Burmese phrasing over unnecessarily long, stiff, bookish, or inflated expressions.
- Remove redundant connectors, repeated words, unnatural pronouns, and filler only when doing so does not remove meaning.
- Do not mechanically preserve source-language sentence structure.
- Choose verbs that fit the actual action and context. Do not add decorative descriptions or intensify an action without evidence.
- Narration should be smooth and literary but not archaic, pompous, or uniformly formal.
- Dialogue should sound like real Burmese speech and reflect each speaker's personality, relationship, age/status, and emotion.

SENTENCE ENDINGS AND RHYTHM:
- Do NOT make every narration sentence end mechanically with “သည်”.
- Vary sentence endings naturally according to grammar, narrative voice, and context. Suitable forms may include “သည်”, “၏”, “တယ်”, “ပါ”, “ခဲ့သည်”, “လာသည်”, “ဖြစ်သည်”, and other natural Burmese constructions.
- The sentence-final literary “၏” may be used occasionally in narration only when genuinely natural and appropriate to the novel's tone. Do not force it into every sentence, randomly replace “သည်” with “၏”, or use it where grammar becomes awkward.
- Use “၏” correctly as a possessive/genitive marker when required.
- Keep dialogue endings natural to the speaker; do not impose formal narration endings on spoken dialogue.
- Vary rhythm without making the prose inconsistent or artificially ornate.

INNER THOUGHTS AND PUNCTUATION:
- Never use asterisks (*) to mark inner thoughts or internal monologue.
- When the supplied text clearly presents a character's inner thought, use single quotation marks ('...') for that thought.
- Do not turn ordinary narration or spoken dialogue into inner thoughts.
- Preserve meaningful dialogue punctuation and paragraph breaks. Do not add decorative symbols.

MYANMAR-ONLY OUTPUT:
- Output must use Myanmar script for all language content.
- Do not leave Latin/English, Chinese, Japanese, Korean, or other foreign-script words in the final text.
- Use the exact Myanmar glossary equivalent for names, titles, techniques, places, organizations, items, and ranks when supplied.
- If no established Myanmar equivalent exists, express or transliterate the term naturally in Myanmar script. Never keep Latin spelling or foreign-script spelling.
- Do not output English labels, headings, explanations, or foreign-language text in parentheses.
- Protected NameLock tokens are technical markers: copy only tokens already present in the input chunk, exactly. Never invent, remove, duplicate, or alter them.
- Myanmar punctuation and necessary ordinary numerals may be retained.

NOVEL STYLE REFERENCE:
${novelStyle}
Treat this as guidance for voice and literary tone only. It must never override story fidelity, Myanmar-only output, NameLock rules, or the glossary.

PREVIOUS CHUNK CONTEXT — CONTINUITY ONLY:
${previousContext}
Use this only to maintain continuity of names, tone, and sentence flow. Do not repeat it or include it in the output.

FINAL SELF-CHECK:
1. Every sentence sounds natural when read by a Burmese novel reader.
2. Sentence endings are varied naturally; “သည်” is not repeated mechanically and “၏” is used only where it fits.
3. No meaningless invented compound words or inaccurate cultural substitutions.
4. Inner thoughts use single quotation marks, never asterisks.
5. No foreign-script words remain.
6. No story detail, name, relationship, action, or intention has been added, lost, or changed.
7. All supplied NameLock tokens remain exactly unchanged.

${forceEdit?'- This is a corrective editorial pass. Improve awkward phrasing, rhythm, particles, and vocabulary wherever safe. Correct every listed validation issue, but preserve exactly the same story information.\n':''}
Return ONLY the polished Myanmar text. No preface, labels, notes, or explanation.

INPUT:
${source}`}

function splitPolishText(text,maxChars=6000){
 const paragraphs=String(text||'').replace(/\r/g,'').split(/\n\s*\n/);
 const chunks=[];let current='';
 const flush=()=>{if(current.trim())chunks.push(current.trim());current='';};
 for(const paragraph of paragraphs){
  const value=paragraph.trim();if(!value)continue;
  const candidate=current?current+'\n\n'+value:value;
  if(candidate.length<=maxChars){current=candidate;continue;}
  flush();
  if(value.length<=maxChars){current=value;continue;}
  const sentences=value.match(/[^။!?]+[။!?]?/g)||[value];
  let piece='';
  for(const sentence of sentences){
   const part=sentence.trim();if(!part)continue;
   if(part.length>maxChars){
    if(piece){current=piece;flush();piece='';}
    let offset=0;
    while(offset<part.length){
     let end=Math.min(offset+maxChars,part.length);
     const tokenStart=part.lastIndexOf('[[NAMELOCK_',end);
     if(tokenStart>=offset&&tokenStart<end){
      const tokenEnd=part.indexOf(']]',tokenStart);
      if(tokenEnd>=end)end=tokenStart;
     }
     if(end<=offset)end=Math.min(offset+maxChars,part.length);
     const fragment=part.slice(offset,end).trim();
     if(fragment){current=fragment;flush();}
     offset=end;
    }
   }else if((piece?piece+' '+part:part).length<=maxChars){
    piece=piece?piece+' '+part:part;
   }else{
    if(piece){current=piece;flush();}
    piece=part;
   }
  }
  if(piece){current=piece;flush();}
 }
 flush();
 return chunks;
}
async function getGlossary(novelId){const rows=await q(supabase.from('glossary_terms').select('*').eq('novel_id',novelId).order('created_at'));const g={characters:[],items:[],locations:[],organizations:[],skills:[],other:[]};for(const r of rows)(g[r.type]??g.other).push(r);return g}
function validateGlossaryObject(x){return x&&typeof x==='object'&&['characters','items','organizations','locations','skills','other'].every(k=>Array.isArray(x[k]))}
function validateLockedOutput(text,locks,expectedCounts){for(const x of locks){const expected=expectedCounts.get(x.token);if(expected===undefined)continue;const actual=countToken(text,x.token);if(actual!==expected)return false}return true}
function validatePolishOutput(text,source,finishReasons=[]){
 const out=String(text||'').trim(),input=String(source||'').trim(),issues=[];
 if(!out)issues.push('empty output');
 const reasons=(finishReasons||[]).map(x=>String(x||'').toUpperCase());
 if(reasons.some(x=>['MAX_TOKENS','SAFETY','RECITATION'].includes(x)))issues.push('model finish reason: '+reasons.join(','));
 const foreign=Array.from(out).filter(ch=>/\p{L}/u.test(ch)&&!/\p{Script=Myanmar}/u.test(ch)).length;
 if(foreign>0)issues.push('foreign-script characters: '+foreign+' (Myanmar-only output required)');
 const a=countChars(input),b=countChars(out);
 if(a>=600&&b<a*.55)issues.push('output too short: '+b+'/'+a+' characters');
 const ip=input.split(/\n\s*\n/).filter(x=>x.trim()).length,op=out.split(/\n\s*\n/).filter(x=>x.trim()).length;
 if(ip>=8&&op<Math.ceil(ip*.35))issues.push('paragraph count reduced: '+op+'/'+ip);
 return issues;
}
function polishValidationRetryPrompt(source,issues,novelStyle='',previousContext=''){
 const p=polishPrompt(source,true,novelStyle,previousContext),anchor='Return ONLY the polished Myanmar text. No preface, labels, notes, or explanation.';
 if(!p.includes(anchor))throw new Error('Could not construct Polish validation retry prompt.');
 return p.replace(anchor,'Fix these validation issues: '+issues.join('; ')+'. Re-read and polish the complete input chunk without omitting any story detail. STRICT REQUIREMENT: every foreign-script word must be expressed in Myanmar script. Before responding, scan the entire output and correct all listed issues.\\n'+anchor);
}

app.get('/api/health',(_,res)=>res.json({ok:true}));
app.get('/api/usage',(_,res)=>res.json(globalThis.getGeminiApiUsage?globalThis.getGeminiApiUsage():{day:'',count:0,timezone:'Asia/Bangkok'}));
app.get('/api/novels',async(_,res)=>{try{res.json(await q(supabase.from('novels').select('*').order('created_at')))}catch(e){fail(res,e)}});
app.post('/api/novels',async(req,res)=>{try{res.json(await q(supabase.from('novels').insert({name:req.body.name||'New Novel',style:req.body.style||''}).select().single()))}catch(e){fail(res,e)}});
app.put('/api/novels/:id',async(req,res)=>{try{res.json(await q(supabase.from('novels').update({name:req.body.name,style:req.body.style,updated_at:new Date().toISOString()}).eq('id',req.params.id).select().single()))}catch(e){fail(res,e)}});
app.delete('/api/novels/:id',async(req,res)=>{try{await q(supabase.from('novels').delete().eq('id',req.params.id));res.json({ok:true})}catch(e){fail(res,e)}});
app.get('/api/glossary/:novelId',async(req,res)=>{try{res.json(await getGlossary(req.params.novelId))}catch(e){fail(res,e)}});
app.post('/api/glossary/:novelId',async(req,res)=>{try{res.json(await q(supabase.from('glossary_terms').upsert({novel_id:req.params.novelId,type:req.body.type,original:req.body.original,translation:req.body.translation,note:req.body.note||'',voice:req.body.voice||''},{onConflict:'novel_id,type,original'}).select().single()))}catch(e){fail(res,e)}});
app.delete('/api/glossary/:novelId/:type/:id',async(req,res)=>{try{await q(supabase.from('glossary_terms').delete().eq('novel_id',req.params.novelId).eq('id',req.params.id));res.json({ok:true})}catch(e){fail(res,e)}});
app.get('/api/episodes/:novelId/output-status',async(req,res)=>{try{const rows=await q(supabase.from('episodes').select('id,number,title,source,translation').eq('novel_id',req.params.novelId).order('number'));res.json(rows.map(e=>({id:e.id,number:e.number,title:e.title||'',raw:!!String(e.source||'').trim(),translation:!!String(e.translation||'').trim()})))}catch(e){fail(res,e)}});
app.get('/api/episodes/:novelId',async(req,res)=>{try{res.json(await q(supabase.from('episodes').select('*').eq('novel_id',req.params.novelId).order('number')))}catch(e){fail(res,e)}});
app.get('/api/episodes/:novelId/list',async(req,res)=>{try{res.json(await q(supabase.from('episodes').select('id,novel_id,number,title,status,model,updated_at').eq('novel_id',req.params.novelId).order('number')))}catch(e){fail(res,e)}});
app.get('/api/episodes/:novelId/:id',async(req,res)=>{try{res.json(await q(supabase.from('episodes').select('*').eq('novel_id',req.params.novelId).eq('id',req.params.id).single()))}catch(e){fail(res,e)}});
app.post('/api/episodes/:novelId',async(req,res)=>{try{res.json(await q(supabase.from('episodes').insert({novel_id:req.params.novelId,number:req.body.number,title:req.body.title||'',source:req.body.source||'',translation:req.body.translation||'',status:'draft'}).select().single()))}catch(e){fail(res,e)}});
app.put('/api/episodes/:novelId/:id',async(req,res)=>{try{res.json(await q(supabase.from('episodes').update({number:req.body.number,title:req.body.title,source:req.body.source,translation:req.body.translation,status:req.body.status||'draft',updated_at:new Date().toISOString()}).eq('novel_id',req.params.novelId).eq('id',req.params.id).select().single()))}catch(e){fail(res,e)}});
app.delete('/api/episodes/:novelId/:id',async(req,res)=>{try{await q(supabase.from('episodes').delete().eq('novel_id',req.params.novelId).eq('id',req.params.id));res.json({ok:true})}catch(e){fail(res,e)}});

app.post('/api/fetch-chapter',async(req,res)=>{try{const {url}=req.body;if(!url?.trim())return res.status(400).json({error:'Chapter URL is required'});const result=await fetchNovelPingChapter(url.trim());res.json(result)}catch(e){fail(res,e)}});

app.post('/api/translate',async(req,res)=>{try{const {novelId,episodeId,source}=req.body;if(!novelId||!source?.trim())return res.status(400).json({error:'Novel and source are required'});const novel=await q(supabase.from('novels').select('*').eq('id',novelId).single());const allGlossary=await getGlossary(novelId);const glossary=filterGlossaryToSource(allGlossary,source);const locks=buildNameLocks(glossary);let activeModel=MODELS[0],chunks=splitText(source,TRANSLATE_CHUNK_SIZE),result='',modelUsed=activeModel;for(let i=0;i<chunks.length;i++){const chunk=chunks[i],previousSource=chunks[i-1]?chunks[i-1].slice(-CONTEXT_OVERLAP):'',lockedChunk=lockText(chunk,locks),lockedPreviousSource=lockText(previousSource,locks);try{const r=await generateWithRetries(aiTranslate,masterPrompt({style:novel.style,glossary,locks,source:lockedChunk,previousTail:result.slice(-5000),sourceContext:lockedPreviousSource}),activeModel);result+=(result?'\n\n':'')+restoreNameLocks(r.text.trim(),locks);modelUsed=r.model}catch(e){if(!retryable(e))throw e;if(activeModel===MODELS[0]){activeModel=MODELS[1];const remaining=chunks.slice(i).join('\n\n');chunks=chunks.slice(0,i).concat(splitText(remaining,TRANSLATE_CHUNK_SIZE));i--;continue}throw e}}if(episodeId)await q(supabase.from('episodes').update({source,translation:result,model:modelUsed,status:'translated',updated_at:new Date().toISOString()}).eq('id',episodeId).eq('novel_id',novelId));res.json({translation:result,model:modelUsed,sourceChars:countChars(source),pass1Chars:countChars(result)})}catch(e){fail(res,e)}});

function parseGlossaryJson(text){const raw=String(text||'').trim().replace(/^\uFEFF/,'').replace(/^\`\`\`(?:json)?\s*/i,'').replace(/\s*\`\`\`$/,'').trim();try{return JSON.parse(raw)}catch(firstError){const start=raw.indexOf('{');if(start<0)throw firstError;let depth=0,inString=false,escaped=false;for(let i=start;i<raw.length;i++){const ch=raw[i];if(inString){if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch==='"')inString=false;continue}if(ch==='"'){inString=true;continue}if(ch==='{')depth++;else if(ch==='}'&&--depth===0){const candidate=raw.slice(start,i+1);try{return JSON.parse(candidate)}catch{return JSON.parse(candidate.replace(/,\s*([}\]])/g,'$1'))}}}throw firstError}}
app.post('/api/extract-glossary',async(req,res)=>{try{const {source}=req.body;if(!source?.trim())return res.status(400).json({error:'Source is required'});const r=await runTwoModelTask(aiGlossary,glossaryPrompt(source),'GLOSSARY');let data;try{data=parseGlossaryJson(r.text)}catch{throw new Error('Glossary AI returned invalid JSON. Please try again.')}if(!validateGlossaryObject(data))throw new Error('Glossary AI returned an invalid format.');res.json({glossary:data,model:r.model,sourceChars:countChars(source)})}catch(e){fail(res,e)}});
function normalizeGlossaryKey(value){return String(value||'').normalize('NFKC').replace(/[“”"'’]/g,'').replace(/\s+/g,' ').trim().toLowerCase()}
function glossaryLimitForChapter(chapterNo){const n=Math.max(1,Number(chapterNo)||1);if(n<=100)return 30;if(n<=200)return 55;return 70}
async function addAutoGlossaryForChapter(novelId,chapterNo,source){
 const existing=await q(supabase.from('glossary_terms').select('id,type,original,translation').eq('novel_id',novelId).order('created_at'));
 const seenOriginal=new Set(existing.map(x=>normalizeGlossaryKey(x.original)).filter(Boolean));
 const seenTranslation=new Set(existing.map(x=>normalizeGlossaryKey(x.translation)).filter(Boolean));
 const limit=glossaryLimitForChapter(chapterNo);let added=0;
 const fixed=[{type:'other',original:'dao',translation:'တာအို',note:'Global fixed glossary term'},{type:'other',original:'cultivation',translation:'ကျင့်ကြံခြင်း',note:'Global fixed glossary term'}];
 for(const item of fixed){
  const key=normalizeGlossaryKey(item.original),translationKey=normalizeGlossaryKey(item.translation);
  const old=existing.find(x=>normalizeGlossaryKey(x.original)===key);
  if(old){
   if(old.translation!==item.translation)await q(supabase.from('glossary_terms').update({translation:item.translation,note:'Global fixed glossary term'}).eq('id',old.id).eq('novel_id',novelId));
   seenOriginal.add(key);seenTranslation.add(translationKey);continue;
  }
  if(existing.length+added>=limit)break;
  if(seenTranslation.has(translationKey))continue;
  await q(supabase.from('glossary_terms').insert({novel_id:novelId,...item,voice:''}).select().single());
  seenOriginal.add(key);seenTranslation.add(translationKey);added++;
 }
 if(existing.length+added>=limit)return {added,total:existing.length+added,limit,stoppedAtLimit:true};
 const r=await runTwoModelTask(aiGlossary,glossaryPrompt(source),'GLOSSARY_AUTO');
 let data;try{data=parseGlossaryJson(r.text)}catch{throw new Error('Automatic glossary extraction returned invalid JSON.')}
 if(!validateGlossaryObject(data))throw new Error('Automatic glossary extraction returned an invalid format.');
 for(const category of ['characters','items','organizations','locations','skills','other']){
  for(const candidate of data[category]||[]){
   if(existing.length+added>=limit)break;
   const original=String(candidate?.original||'').replace(/\s+/g,' ').trim();
   const translation=String(candidate?.suggested||'').replace(/\s+/g,' ').trim();
   if(!original||!translation)continue;
   const originalKey=normalizeGlossaryKey(original),translationKey=normalizeGlossaryKey(translation);
   if(!originalKey||!translationKey||seenOriginal.has(originalKey)||seenTranslation.has(translationKey))continue;
   await q(supabase.from('glossary_terms').insert({novel_id:novelId,type:category,original,translation,note:'Auto-added from chapter '+chapterNo,voice:''}).select().single());
   seenOriginal.add(originalKey);seenTranslation.add(translationKey);added++;
  }
  if(existing.length+added>=limit)break;
 }
 return {added,total:existing.length+added,limit,stoppedAtLimit:existing.length+added>=limit,model:r.model};
}
app.post('/api/auto-glossary',async(req,res)=>{try{const {novelId,chapterNo,source}=req.body;if(!novelId||!source?.trim())return res.status(400).json({error:'Novel and source are required'});const n=Number(chapterNo);if(!Number.isSafeInteger(n)||n<1)return res.status(400).json({error:'A valid chapter number is required.'});res.json({...await addAutoGlossaryForChapter(novelId,n,String(source)),chapterNo:n})}catch(e){fail(res,e)}});

app.post('/api/polish',async(req,res)=>{try{
 const {novelId,episodeId,translation}=req.body;
 if(!novelId||!translation?.trim())return res.status(400).json({error:'Novel and translation are required'});
 const novel=await q(supabase.from('novels').select('style').eq('id',novelId).single());
 let episodeSource='';
 if(episodeId){const ep=await q(supabase.from('episodes').select('source').eq('id',episodeId).eq('novel_id',novelId).single());episodeSource=ep?.source||''}
 const allGlossary=await getGlossary(novelId),glossary=episodeSource?filterGlossaryToSource(allGlossary,episodeSource):allGlossary;
 const locks=buildNameLocks({characters:glossary.characters||[]});
 const glossaryLines=[];
 for(const [type,arr] of Object.entries(glossary||{}))for(const item of arr||[]){
  const original=String(item.original||'').trim(),translated=String(item.translation||'').trim();
  if(original&&translated)glossaryLines.push(type+': '+original+' => '+translated);
 }
 const glossaryNote='\n\nAUTHORITATIVE MYANMAR NAME / TERM GLOSSARY (use these exact Myanmar forms consistently):\n'+(glossaryLines.join('\n')||'(none)');
 const novelStyle=String(novel?.style||'').trim();
 const chunks=splitPolishText(translation,6000);
 const polishedChunks=[];
 for(let index=0;index<chunks.length;index++){
  const chunk=chunks[index];
  const locked=lockTranslationText(chunk,locks),expected=new Map();
  for(const item of locks)expected.set(item.token,countToken(locked,item.token));
  const previousContext=index>0?polishedChunks[index-1].slice(-700):'';
  const prompt=polishPrompt(locked,false,novelStyle,previousContext).replace('INPUT:',glossaryNote+'\n\nINPUT:');
  let result=await runPolishTask(prompt,'POLISH-CHUNK-'+(index+1)+'/'+chunks.length);
  let raw=String(result.text||'').trim();
  let lockValid=validateLockedOutput(raw,locks,expected);
  let polished=lockValid?restoreNameLocks(raw,locks):'';
  let issues=lockValid?validatePolishOutput(polished,chunk,result.finishReasons):['protected character-name token mismatch'];
  if(normalizeForCompare(polished||raw)===normalizeForCompare(chunk)&&!issues.length)issues.push('output unchanged; no editing was performed');
  if(issues.length){
   console.warn('POLISH chunk '+(index+1)+' requires one corrective pass: '+issues.join('; '));
   const retryBase=polishValidationRetryPrompt(locked,issues,novelStyle,previousContext);
   const retryPrompt=retryBase.replace('INPUT:',glossaryNote+'\n\nINPUT:');
   result=await runPolishTask(retryPrompt,'POLISH-CHUNK-RETRY-'+(index+1)+'/'+chunks.length);
   raw=String(result.text||'').trim();
   lockValid=validateLockedOutput(raw,locks,expected);
   if(lockValid){polished=restoreNameLocks(raw,locks);issues=validatePolishOutput(polished,chunk,result.finishReasons)}
   else issues=['protected character-name token mismatch after corrective pass'];
   if(normalizeForCompare(polished||raw)===normalizeForCompare(chunk)&&!issues.length)issues.push('output unchanged after corrective pass');
  }
  if(issues.length){
   console.warn('POLISH failed validation for chunk '+(index+1)+'; preserving the complete Pass 1 translation: '+issues.join('; '));
   return res.json({translation,model:result.model,pass1Chars:countChars(translation),pass2Chars:countChars(translation),changed:false,validated:false,polishFallback:true,validationWarnings:issues,failedChunk:index+1,totalChunks:chunks.length});
  }
  polishedChunks.push(polished);
 }
 const polished=polishedChunks.join('\n\n').trim();
 if(!polished){
  return res.json({translation,model:'none',pass1Chars:countChars(translation),pass2Chars:countChars(translation),changed:false,validated:false,polishFallback:true,validationWarnings:['empty combined polish output']});
 }
 if(episodeId)await q(supabase.from('episodes').update({translation:polished,updated_at:new Date().toISOString()}).eq('id',episodeId).eq('novel_id',novelId));
 res.json({translation:polished,model:'gemini-3.1-flash-lite / gemini-3.5-flash-lite',pass1Chars:countChars(translation),pass2Chars:countChars(polished),changed:normalizeForCompare(polished)!==normalizeForCompare(translation),validated:true,polishFallback:false,validationWarnings:[],totalChunks:chunks.length});
}catch(e){
 console.error('POLISH: preserving Pass 1 after Pass 2 failure:',e?.stack||e?.message||e);
 const original=String(req.body?.translation||'');
 if(original.trim())return res.json({translation:original,model:'Pass 1 fallback',pass1Chars:countChars(original),pass2Chars:countChars(original),changed:false,validated:false,polishFallback:true,validationWarnings:[String(e?.message||e)]});
 fail(res,e);
}});

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
async function buildTemplateWorkbook(novelId,fromChapter=null,toChapter=null){
  const novel=await q(supabase.from('novels').select('id,name,style').eq('id',novelId).single());
  const glossary=await fetchExportRows('glossary_terms','original,translation,type,note,voice',''+novelId,'created_at',100);
  let episodes=(await q(supabase.from('episodes').select('number,title,source,translation').eq('novel_id',''+novelId))).sort((a,b)=>Number(a.number)-Number(b.number));\n  const from=Number(fromChapter),to=Number(toChapter);\n  if(Number.isInteger(from)&&from>0)episodes=episodes.filter(e=>Number(e.number)>=from);\n  if(Number.isInteger(to)&&to>0)episodes=episodes.filter(e=>Number(e.number)<=to);
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
app.get('/api/export/template/:id',async(req,res)=>{try{const fromChapter=req.query.fromChapter??null,toChapter=req.query.toChapter??null;for(const v of [fromChapter,toChapter])if(v!==null&&(!/^\d+$/.test(String(v))||Number(v)<1))return res.status(400).json({error:'Chapter range must use positive whole numbers.'});if(fromChapter!==null&&toChapter!==null&&Number(fromChapter)>Number(toChapter))return res.status(400).json({error:'Starting chapter must not be greater than ending chapter.'});const wb=await buildTemplateWorkbook(req.params.id,fromChapter,toChapter);const buffer=await wb.xlsx.writeBuffer();const novel=await q(supabase.from('novels').select('name').eq('id',req.params.id).single());res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');res.setHeader('Content-Disposition',`attachment; filename="${slugify(novel.name)}-mm-novel.xlsx"`);res.setHeader('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');res.setHeader('Pragma','no-cache');res.setHeader('Expires','0');res.setHeader('X-Workbook-Export-Version','chapter-sequence-v2');res.send(Buffer.from(buffer))}catch(e){fail(res,e)}});
async function exportNovel(novelId){const novel=await q(supabase.from('novels').select('*').eq('id',novelId).single());const glossary=await q(supabase.from('glossary_terms').select('*').eq('novel_id',novelId));const episodes=await q(supabase.from('episodes').select('*').eq('novel_id',novelId).order('number'));return {version:2,exportedAt:new Date().toISOString(),novels:[novel],glossary,episodes}}
app.get('/api/export/novel/:id',async(req,res)=>{try{res.setHeader('Content-Disposition','attachment; filename=novel-backup.json');res.json(await exportNovel(req.params.id))}catch(e){fail(res,e)}});
app.get('/api/export/all',async(_,res)=>{try{const novels=await q(supabase.from('novels').select('*').order('created_at'));const glossary=await q(supabase.from('glossary_terms').select('*'));const episodes=await q(supabase.from('episodes').select('*').order('novel_id,number'));res.setHeader('Content-Disposition','attachment; filename=webnovel-backup.json');res.json({version:2,exportedAt:new Date().toISOString(),novels,glossary,episodes})}catch(e){fail(res,e)}});
app.post('/api/import',async(req,res)=>{try{const d=req.body;if(!Array.isArray(d.novels))throw new Error('Invalid backup');let ec=0;for(const n of d.novels){const existing=await q(supabase.from('novels').select('id').eq('id',n.id).maybeSingle());if(existing)await q(supabase.from('novels').update({name:n.name,style:n.style||'',updated_at:new Date().toISOString()}).eq('id',n.id));else await q(supabase.from('novels').insert({id:n.id,name:n.name,style:n.style||''}))}if(Array.isArray(d.glossary)&&d.glossary.length)await q(supabase.from('glossary_terms').upsert(d.glossary.map(x=>({id:x.id,novel_id:x.novel_id,type:x.type,original:x.original,translation:x.translation,note:x.note||'',voice:x.voice||''})),{onConflict:'id'}));if(Array.isArray(d.episodes)&&d.episodes.length){await q(supabase.from('episodes').upsert(d.episodes.map(x=>({id:x.id,novel_id:x.novel_id,number:x.number,title:x.title||'',source:x.source||'',translation:x.translation||'',model:x.model||'',status:x.status||'draft',created_at:x.created_at||new Date().toISOString(),updated_at:x.updated_at||new Date().toISOString()})),{onConflict:'id'}));ec=d.episodes.length}res.json({novels:d.novels.length,episodes:ec})}catch(e){fail(res,e)}});
app.listen(PORT,'0.0.0.0',()=>console.log(`Webnovel Translator running on port ${PORT}`));
