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

const primaryAiTranslate=new GoogleGenAI({apiKey:process.env.GEMINI_API_KEY});
const primaryAiGlossary=new GoogleGenAI({apiKey:process.env.GEMINI_GLOSSARY_API_KEY||process.env.GEMINI_API_KEY_2});
const primaryAiPolish=new GoogleGenAI({apiKey:process.env.GEMINI_POLISH_API_KEY||process.env.GEMINI_API_KEY_3});
const backupApiKeys=[
 process.env.GEMINI_BACKUP_API_KEY_1||process.env.GEMINI_FALLBACK_API_KEY_1,
 process.env.GEMINI_BACKUP_API_KEY_2||process.env.GEMINI_FALLBACK_API_KEY_2,
 process.env.GEMINI_BACKUP_API_KEY_3||process.env.GEMINI_FALLBACK_API_KEY_3
].map(x=>String(x||'').trim()).filter(Boolean);
const backupAiClients=backupApiKeys.map(apiKey=>new GoogleGenAI({apiKey}));
const supabase=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
const MODELS=['gemini-3.1-flash-lite','gemini-3.5-flash-lite'];
const MODEL_TIMEOUT=45000;

function id(){return crypto.randomUUID()}
function fail(res,e){console.error(e);return res.status(500).json({error:e.message||'Server error'})}
async function q(promise){const {data,error}=await promise;if(error)throw new Error(error.message);return data}
function sleep(ms){return new Promise(r=>setTimeout(r,ms))}
function isQuotaExceeded(error){
 const message=String(error?.message||error||'');
 return /quota.?exceeded|resource.?exhausted|rate.?limit.?exceeded|requests.?per.?day|requests.?per.?minute|tokens.?per.?minute|429|billing.?not.?enabled/i.test(message);
}
async function generateModel(ai,prompt,model,jsonMode=false){
 const started=Date.now();
 console.log('Trying model: '+model);
 const response=await ai.models.generateContent({model,contents:prompt,config:{temperature:jsonMode?0.2:0.7,maxOutputTokens:65536,automaticContinuation:false,...(jsonMode?{responseMimeType:'application/json'}:{}),httpOptions:{timeout:MODEL_TIMEOUT}}});
 const text=String(response.text||'');
 const candidates=response.candidates||[];
 const finishReasons=candidates.map(c=>c.finishReason||'unknown');
 const promptFeedback=response.promptFeedback?.blockReason||null;
 console.log('MODEL RESPONSE: '+model+' ('+(Date.now()-started)+'ms; outputChars='+text.length+'; finishReason='+(finishReasons.join(',')||'no-candidates')+(promptFeedback?'; blockReason='+promptFeedback:'')+')');
 if(!text.trim())throw new Error('Empty model output from '+model+'; finishReason='+(finishReasons.join(',')||'no-candidates')+(promptFeedback?'; blockReason='+promptFeedback:''));
 if(finishReasons.some(x=>['MAX_TOKENS','SAFETY','RECITATION'].includes(String(x).toUpperCase())))throw new Error('Incomplete or blocked model output from '+model+'; finishReason='+finishReasons.join(','));
 return {text,model,finishReasons,promptFeedback};
}
async function runTwoModelTask(primaryAi,prompt,tag){
 const jsonMode=tag==='GLOSSARY'||tag==='GLOSSARY_AUTO';
 const clients=[{ai:primaryAi,label:'primary'},...backupAiClients.map((ai,index)=>({ai,label:'backup-'+(index+1)}))];
 let lastError;
 for(let keyIndex=0;keyIndex<clients.length;keyIndex++){
  const client=clients[keyIndex];
  const sequence=[MODELS[0],MODELS[1],MODELS[0],MODELS[1]];
  let quotaHit=false;
  for(let attempt=0;attempt<sequence.length;attempt++){
   const model=sequence[attempt];
   try{
    const result=await generateModel(client.ai,prompt,model,jsonMode);
    return {...result,apiKeyPool:client.label};
   }catch(error){
    lastError=error;
    const quota=isQuotaExceeded(error);
    console.warn(tag+': '+client.label+' '+model+' failed ('+(attempt+1)+'/4; quota='+quota+'): '+String(error?.message||error));
    if(quota){quotaHit=true;break;}
    if(attempt<sequence.length-1)await sleep(3000);
   }
  }
  if(!quotaHit){
   const failure=new Error(tag+': '+client.label+' failed all four model attempts without a quota response. '+String(lastError?.message||'Unknown model error.'));
   failure.cause=lastError;throw failure;
  }
  if(keyIndex<clients.length-1){
   console.warn(tag+': quota exceeded for '+client.label+'; switching automatically to '+clients[keyIndex+1].label+'.');
   await sleep(3000);
  }
 }
 const failure=new Error(tag+': quota exceeded on primary and all '+backupAiClients.length+' configured backup API keys. '+String(lastError?.message||'No API key has remaining quota.'));
 failure.code='QUOTA_EXHAUSTED';failure.cause=lastError;throw failure;
}
async function runPolishTask(prompt,tag){return runTwoModelTask(primaryAiPolish,prompt,tag)}

function buildNameLocks(g){const locks=[];let n=1;for(const [type,arr] of Object.entries(g||{}))for(const x of arr||[]){const original=String(x.original||'').trim(),translation=String(x.translation||'').trim();if(!original||!translation)continue;locks.push({type,original,translation,token:`[[NAMELOCK_${String(n++).padStart(3,'0')}]]`})}locks.sort((a,b)=>b.original.length-a.original.length);return locks}
function filterGlossaryToSource(g,source){const text=String(source||'').toLocaleLowerCase();const out={};for(const [type,arr] of Object.entries(g||{}))out[type]=(arr||[]).filter(x=>{const original=String(x.original||'').trim();return original&&text.includes(original.toLocaleLowerCase())});return out}
function lockText(text,locks){let out=String(text||'');for(const x of locks)out=out.split(x.original).join(x.token);return out}
function lockTranslationText(text,locks){let out=String(text||'');const ordered=[...locks].sort((a,b)=>b.translation.length-a.translation.length);for(const x of ordered)out=out.split(x.translation).join(x.token);return out}
function restoreNameLocks(text,locks){let out=String(text||'');for(const x of locks){out=out.split(x.token).join(x.translation);out=out.split(x.original).join(x.translation)}return out}
function lockedGlossaryText(g,locks){const map=new Map(locks.map(x=>[x.original,x]));const lines=[];for(const [type,arr] of Object.entries(g||{}))for(const x of arr||[]){const l=map.get(String(x.original||'').trim());lines.push(`${type}: ${l?.token||x.original} => ${x.translation}${x.voice?` | voice: ${x.voice}`:''}${x.note?` | note: ${x.note}`:''}`)}return lines.join(String.fromCharCode(10))}
function countChars(text){return Array.from(String(text||'')).length}
function countSentenceFinalYa(text){return (String(text||'').match(/၏[ \\t]*(?=[။.!?…]|(?:\\r?\\n)|$)/gu)||[]).length}
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
function polishPrompt(source,forceEdit=false,novelStyle='',previousContext='',yaTarget=0){return `You are a senior Myanmar literary editor specializing in natural, publication-quality Burmese web novels.

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
- For unfamiliar foods, objects, customs, or titles, use the established glossary form. If none exists, first use a genuine, established Burmese word or a clear natural Burmese description. If no suitable Burmese equivalent exists, transliterate the original term naturally into Myanmar script.
- STRICT VOCABULARY RULE: Never coin, fabricate, or introduce a new Burmese-looking word, phrase, compound, or literal calque that has no clear, established meaning in real Burmese usage. Do not combine Burmese words arbitrarily to imitate a foreign term. Do not guess at terminology or create a phrase merely because it sounds literary.
- Transliteration is allowed when a genuine Burmese equivalent does not exist, especially for personal names, place names, cultural terms, objects, and other specific foreign concepts. Keep the original identity and meaning accurate; do not disguise an invented word as a transliteration.
- When uncertain whether a Burmese expression is genuine and naturally used, prefer a simple, clear description or faithful Myanmar-script transliteration over an invented expression.

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
- Narration must read like it was written and edited by a native Burmese literary editor, not generated by an AI or translated sentence by sentence. Use authentic Burmese idiom, natural collocations, familiar vocabulary, and the flow expected in a professionally edited Myanmar novel.
- Avoid AI-like habits: repetitive sentence templates, over-explaining, unnatural synonym substitutions, inflated wording, mechanical transitions, stiff phrasing, and sentences that are technically understandable but no Burmese novelist would naturally write.
- Do not force ornate or archaic language. Match the novel's period, genre, narrator, and established voice while keeping the Burmese genuinely idiomatic.
- Dialogue should sound like real Burmese speech and reflect each speaker's personality, relationship, age/status, and emotion.

SENTENCE ENDINGS AND RHYTHM:
- Do NOT make every narration sentence end mechanically with “သည်”.
- Vary sentence endings naturally according to grammar, narrative voice, and context. Suitable forms may include “သည်”, “၏”, “တယ်”, “ပါ”, “ခဲ့သည်”, “လာသည်”, “ဖြစ်သည်”, and other natural Burmese constructions.
- Use “၏” naturally and correctly in narration sentence endings where Burmese grammar permits it; never use it ungrammatically or mechanically replace every “သည်” with “၏”.
- When a narration sentence uses the future ending “မည်”, add “၏” after it as “မည်၏” when using the formal sentence-final “၏” style; do not leave “မည်” alone in those sentences.
- CHAPTER-LEVEL VALIDATION REQUIREMENT: This chapter must contain at least 13 narration sentences ending with “၏”. The complete chapter's minimum is ${yaTarget}. Meet the assigned minimum with grammatical narration sentences; dialogue and possessive “၏” inside a sentence do not count.
- Count a sentence-final “၏” when it is followed by Myanmar/English sentence punctuation, a line break, or the end of the chapter. Do not treat a possessive marker followed by more words as sentence-final.
- Keep sentence endings varied and natural while meeting the assigned minimum; do not put “၏” at the end of every sentence.
- Keep dialogue endings natural to the speaker; do not impose the narration's “၏” style on spoken dialogue.
- Vary rhythm while maintaining a consistent Myanmar literary voice.

INNER THOUGHTS AND PUNCTUATION:
- Never use asterisks (*) to mark inner thoughts or internal monologue.
- When the supplied text clearly presents a character's inner thought, use single quotation marks ('...') for that thought.
- Do not turn ordinary narration or spoken dialogue into inner thoughts.
- Preserve meaningful dialogue punctuation and paragraph breaks. Do not add decorative symbols.

MYANMAR-ONLY OUTPUT:
- Output must use Myanmar script for all language content. Convert every foreign-language word or phrase into accurate, natural Myanmar-script wording or transliteration.
- Do not leave Latin, Chinese, Japanese, Korean, or other non-Myanmar script in the output, except an exact character name that is already written in that script in the input. Preserve such character names exactly.
- Prefer natural Myanmar-script wording for ordinary foreign terms when appropriate, but do not force changes that damage meaning.
- CHARACTER NAMES ARE IMMUTABLE: preserve every personal/character name exactly as it appears in the supplied input. Do not translate, transliterate, respell, normalize, shorten, expand, or otherwise edit a character name. This rule applies even when a name contains Latin or another script.
- Preserve all names and their spelling consistently; do not introduce any technical placeholder or token.
- Myanmar punctuation and necessary ordinary numerals may be retained.

NOVEL STYLE REFERENCE:
${novelStyle}
Treat this as guidance for voice and literary tone only. It must never override story fidelity, exact character-name preservation, or the glossary.

CONTINUITY CONTEXT — REFERENCE ONLY:
${previousContext}
Use this only to maintain continuity of names, tone, and sentence flow. Do not repeat it or include it in the output.

FINAL SELF-CHECK:
1. Every sentence sounds natural when read by a Burmese novel reader.
2. Every character name is preserved exactly as it appears in the input.
3. No fabricated Burmese words, meaningless compounds, literal calques, or unnatural AI-like expressions; use established Burmese vocabulary, a clear Burmese description, or accurate Myanmar-script transliteration where needed.
4. Inner thoughts use single quotation marks, never asterisks.
5. The complete chapter contains at least ${yaTarget} narration sentences ending with sentence-final “၏”.
6. No foreign-script words remain, except exact character names preserved from the input.
7. No story detail, name, relationship, action, or intention has been added, lost, or changed.
8. No technical placeholder or token is added to the output.

${forceEdit?'- This is a corrective editorial pass. Improve awkward phrasing, rhythm, particles, and vocabulary wherever safe. Correct every listed validation issue, but preserve exactly the same story information.\n':''}
Return ONLY the polished Myanmar text. No preface, labels, notes, or explanation.

INPUT:
${source}`}

async function getGlossary(novelId){const rows=await q(supabase.from('glossary_terms').select('*').eq('novel_id',novelId).order('created_at'));const g={characters:[],items:[],locations:[],organizations:[],skills:[],other:[]};for(const r of rows)(g[r.type]??g.other).push(r);return g}
function validateGlossaryObject(x){return x&&typeof x==='object'&&['characters','items','organizations','locations','skills','other'].every(k=>Array.isArray(x[k]))}
function validateLockedOutput(text,locks,expectedCounts){for(const x of locks){const expected=expectedCounts.get(x.token);if(expected===undefined)continue;const actual=countToken(text,x.token);if(actual!==expected)return false}return true}
function maskExactTerms(text,terms=[]){
 let out=String(text||'');
 for(const term of [...new Set((terms||[]).map(x=>String(x||'').trim()).filter(Boolean))].sort((a,b)=>b.length-a.length))out=out.split(term).join(' '.repeat(term.length));
 return out;
}
function getForeignScriptFragments(text,allowedNames=[]){
 const masked=maskExactTerms(text,allowedNames),matches=[];
 for(const match of masked.matchAll(/[\\p{L}\\p{M}]+/gu)){
  const token=match[0];
  if(/[\\p{L}]/u.test(token)&&!/[\\p{Script=Myanmar}]/u.test(token))matches.push(token);
 }
 return [...new Set(matches)].slice(0,30);
}
function validatePolishOutput(text,source,finishReasons=[],options={}){
 const out=String(text||'').trim(),input=String(source||'').trim(),issues=[];
 if(!out)issues.push('empty output');
 const reasons=(finishReasons||[]).map(x=>String(x||'').toUpperCase());
 if(reasons.some(x=>['MAX_TOKENS','SAFETY','RECITATION'].includes(x)))issues.push('model finish reason: '+reasons.join(','));
 const a=countChars(input),b=countChars(out);
 if(a>=600&&b<a*.55)issues.push('output too short: '+b+'/'+a+' characters');
 const ip=input.split(/\\n\\s*\\n/).filter(x=>x.trim()).length,op=out.split(/\\n\\s*\\n/).filter(x=>x.trim()).length;
 if(ip>=8&&op<Math.ceil(ip*.35))issues.push('paragraph count reduced: '+op+'/'+ip);
 const yaTarget=Math.max(0,Number(options.yaTarget)||0),yaCount=countSentenceFinalYa(out);
 if(yaCount<yaTarget)issues.push('sentence-final “၏” count below minimum: '+yaCount+'/'+yaTarget+'; add grammatical narration sentence endings with “၏”, not possessive markers or dialogue');
 const foreign=getForeignScriptFragments(out,options.allowedNames||[]);
 if(foreign.length)issues.push('foreign-script words remain: '+foreign.join(', ')+'; convert these to Myanmar script, but preserve exact character names');
 const asterisks=(out.match(/\\*/g)||[]).length;
 if(asterisks)issues.push('asterisk thought/formatting markers remain: '+asterisks+'; replace inner-thought *...* markers with single quotation marks and remove all asterisks');
 return issues;
}
function polishValidationRetryPrompt(currentDraft,issues,novelStyle='',previousContext='',originalSource='',yaTarget=13){
 const source=String(originalSource||currentDraft||''),draft=String(currentDraft||'');
 const p=polishPrompt(source,true,novelStyle,previousContext,yaTarget),anchor='Return ONLY the polished Myanmar text. No preface, labels, notes, or explanation.';
 if(!p.includes(anchor))throw new Error('Could not construct Phase 2 corrective prompt.');
 const rules=[
  'THIS IS THE ONLY CORRECTIVE PASS. Deliver a complete, publication-ready final version of the ENTIRE chapter now.',
  'Treat the CURRENT PHASE 2 DRAFT as the working manuscript. Preserve all good edits already made, but do not protect any awkward, incorrect, repetitive, or machine-like sentence.',
  'Use the ORIGINAL INPUT as the definitive source of story facts. Compare it against the entire current draft and restore any omitted details without adding anything unsupported.',
  'Fix EVERY validation issue listed below in this single pass. Do not leave any listed issue for a later pass, and do not merely explain or acknowledge an issue.',
  'Perform a full-chapter editorial sweep: inspect every paragraph and sentence for unnatural Burmese syntax, literal translation patterns, awkward particles, repeated wording, weak verbs, inconsistent voice, and poor sentence rhythm. Rewrite weak passages decisively while preserving exact meaning.',
  'Preserve every character name exactly as it appears in the original input. Never translate, transliterate, respell, normalize, shorten, expand, or otherwise alter a character name.',
  'Meet the complete chapter sentence-final “၏” minimum with grammatically correct narration sentences. Never force “၏” into dialogue or use it as a possessive marker to satisfy the count. For narration sentences using the future ending “မည်”, use “မည်၏” when that formal ending is intended.',
  'Convert all foreign-script words to accurate natural Myanmar-script wording or transliteration, except exact character names that must remain unchanged.',
  'Replace every asterisk used as an inner-thought or formatting marker with single quotation marks. Remove all stray asterisks.',
  'Keep the complete chapter from its first sentence to its final sentence. Do not summarize, shorten, omit, duplicate, add headings, or return a partial answer.',
  'Before responding, silently check the entire final chapter against every listed validation issue and every rule above. Return only the corrected chapter.'
 ];
 const corrective='ONE FINAL CORRECTIVE PASS — COMPLETE CHAPTER REPAIR:\n- '+rules.join('\n- ')+'\n\nVALIDATION ISSUES THAT MUST ALL BE FIXED:\n- '+issues.join('\n- ')+'\n\nCURRENT PHASE 2 DRAFT — WORKING MANUSCRIPT:\n'+draft+'\n\nORIGINAL PHASE 1 INPUT — STORY FIDELITY SOURCE:\n'+source+'\n';
 return p.replace(anchor,corrective+anchor);
}

app.get('/api/health',(_,res)=>res.json({ok:true}));
app.get('/api/usage',(_,res)=>res.json(globalThis.getGeminiApiUsage?globalThis.getGeminiApiUsage():{day:'',count:0,timezone:'Asia/Bangkok'}));
app.get('/api/novels',async(_,res)=>{try{res.json(await q(supabase.from('novels').select('*').order('created_at')))}catch(e){fail(res,e)}});
app.post('/api/novels',async(req,res)=>{try{res.json(await q(supabase.from('novels').insert({name:req.body.name||'New Novel',style:req.body.style||''}).select().single()))}catch(e){fail(res,e)}});
app.put('/api/novels/:id',async(req,res)=>{try{res.json(await q(supabase.from('novels').update({name:req.body.name,style:req.body.style,updated_at:new Date().toISOString()}).eq('id',req.params.id).select().single()))}catch(e){fail(res,e)}});
app.post('/api/novels/:id/auto-style',async(req,res)=>{try{
 const novel=await q(supabase.from('novels').select('id,name,style').eq('id',req.params.id).single());
 if(String(novel.style||'').trim())return res.json({style:novel.style,generated:false,existing:true});
 const episodes=await q(supabase.from('episodes').select('number,title,source').eq('novel_id',req.params.id).order('number').limit(3));
 const samples=(episodes||[]).filter(x=>String(x.source||'').trim()).map(x=>'CHAPTER '+x.number+(x.title?' — '+x.title:'')+'\n'+String(x.source).slice(0,6500));
 if(!samples.length)return res.status(400).json({error:'No source chapters are available to analyze for a novel style.'});
 const prompt=`You are a professional literary-style analyst for a Myanmar webnovel translation system.

Analyze the following ORIGINAL novel excerpts and create one concise, reusable NOVEL-LEVEL TRANSLATION STYLE PROFILE in Burmese.

Identify only what is supported by the excerpts:
- likely genre and subgenre
- overall atmosphere and emotional tone
- narration style and point of view
- dialogue style, formality, honorifics and character voice
- suitable Burmese literary register and sentence rhythm
- how to handle titles, ranks, relationships, idioms and culturally specific terms
- any genre-specific consistency rules

IMPORTANT:
- This is a style profile for translating future chapters into natural Myanmar prose, not a summary or translation.
- Do not invent plot facts, character details, ranks, or terminology.
- Do not assume every novel is cultivation or ancient Chinese fantasy. Determine the genre from the text.
- Do not force archaic language if the source is modern; do not use modern slang if the source is historical.
- Keep dialogue natural for each character's social status and relationship.
- Preserve the source's tone rather than making every novel sound alike.
- Write actionable instructions for both Phase 1 translation and Phase 2 Myanmar literary polishing.
- Keep the profile compact (about 120–220 Burmese words), specific, and stable across chapters.
- Return only the Burmese style profile. No heading, JSON, markdown, or explanation.

NOVEL TITLE: ${novel.name||'Untitled novel'}

SAMPLE EXCERPTS:
${samples.join('\n\n===== NEXT CHAPTER SAMPLE =====\n\n')}`;
 const result=await runTwoModelTask(primaryAiTranslate,prompt,'STYLE_PROFILE');
 const style=String(result.text||'').trim();
 if(!style)throw new Error('AI returned an empty novel style profile.');
 const saved=await q(supabase.from('novels').update({style,updated_at:new Date().toISOString()}).eq('id',req.params.id).select('style').single());
 console.log('AUTO NOVEL STYLE generated for '+(novel.name||req.params.id)+' using '+result.model);
 res.json({style:saved.style,generated:true,existing:false,model:result.model,sampleChapters:samples.length});
}catch(e){fail(res,e)}});
app.delete('/api/novels/:id',async(req,res)=>{try{await q(supabase.from('novels').delete().eq('id',req.params.id));res.json({ok:true})}catch(e){fail(res,e)}});
app.get('/api/glossary/:novelId',async(req,res)=>{try{res.json(await getGlossary(req.params.novelId))}catch(e){fail(res,e)}});
app.post('/api/glossary/:novelId',async(req,res)=>{try{res.json(await q(supabase.from('glossary_terms').upsert({novel_id:req.params.novelId,type:req.body.type,original:req.body.original,translation:req.body.translation,note:req.body.note||'',voice:req.body.voice||''},{onConflict:'novel_id,type,original'}).select().single()))}catch(e){fail(res,e)}});
app.delete('/api/glossary/:novelId/:type/:id',async(req,res)=>{try{await q(supabase.from('glossary_terms').delete().eq('novel_id',req.params.novelId).eq('id',req.params.id));res.json({ok:true})}catch(e){fail(res,e)}});
async function fetchEpisodeRows(novelId,columns,batchSize=200){
 const rows=[];
 for(let start=0;;start+=batchSize){
  const page=await q(supabase.from('episodes').select(columns).eq('novel_id',novelId).order('number').range(start,start+batchSize-1));
  rows.push(...page);
  if(page.length<batchSize)break;
 }
 return rows;
}
app.get('/api/episodes/:novelId/summary',async(req,res)=>{try{
 const rows=await fetchEpisodeRows(req.params.novelId,'source,translation');
 const raw=rows.filter(e=>String(e.source||'').trim()).length;
 const translated=rows.filter(e=>String(e.translation||'').trim()).length;
 res.json({total:rows.length,raw,translated,untranslated:rows.filter(e=>String(e.source||'').trim()&&!String(e.translation||'').trim()).length});
}catch(e){fail(res,e)}});
app.get('/api/episodes/:novelId/output-status',async(req,res)=>{try{const rows=await fetchEpisodeRows(req.params.novelId,'id,number,title,source,translation');res.json(rows.map(e=>({id:e.id,number:e.number,title:e.title||'',raw:!!String(e.source||'').trim(),translation:!!String(e.translation||'').trim()})))}catch(e){fail(res,e)}});
app.get('/api/episodes/:novelId',async(req,res)=>{try{res.json(await q(supabase.from('episodes').select('*').eq('novel_id',req.params.novelId).order('number')))}catch(e){fail(res,e)}});
app.get('/api/episodes/:novelId/list',async(req,res)=>{try{const rows=await fetchEpisodeRows(req.params.novelId,'id,novel_id,number,title,status,model,updated_at,source,translation');res.json(rows.map(e=>({id:e.id,novel_id:e.novel_id,number:e.number,title:e.title||'',status:e.status||'draft',model:e.model||'',updated_at:e.updated_at||'',hasRaw:!!String(e.source||'').trim(),hasTranslation:!!String(e.translation||'').trim()})))}catch(e){fail(res,e)}});
app.get('/api/episodes/:novelId/:id',async(req,res)=>{try{res.json(await q(supabase.from('episodes').select('*').eq('novel_id',req.params.novelId).eq('id',req.params.id).single()))}catch(e){fail(res,e)}});
app.post('/api/episodes/:novelId',async(req,res)=>{try{res.json(await q(supabase.from('episodes').insert({novel_id:req.params.novelId,number:req.body.number,title:req.body.title||'',source:req.body.source||'',translation:req.body.translation||'',status:'draft'}).select().single()))}catch(e){fail(res,e)}});
app.put('/api/episodes/:novelId/:id',async(req,res)=>{try{res.json(await q(supabase.from('episodes').update({number:req.body.number,title:req.body.title,source:req.body.source,translation:req.body.translation,status:req.body.status||'draft',updated_at:new Date().toISOString()}).eq('novel_id',req.params.novelId).eq('id',req.params.id).select().single()))}catch(e){fail(res,e)}});
app.delete('/api/episodes/:novelId/:id',async(req,res)=>{try{await q(supabase.from('episodes').delete().eq('novel_id',req.params.novelId).eq('id',req.params.id));res.json({ok:true})}catch(e){fail(res,e)}});

app.post('/api/fetch-chapter',async(req,res)=>{try{const {url}=req.body;if(!url?.trim())return res.status(400).json({error:'Chapter URL is required'});const result=await fetchNovelPingChapter(url.trim());res.json(result)}catch(e){fail(res,e)}});

app.post('/api/translate',async(req,res)=>{try{
 const {novelId,episodeId,source,deferSave=false}=req.body;
 if(!novelId||!String(source||'').trim())return res.status(400).json({error:'Novel and source are required'});
 const novel=await q(supabase.from('novels').select('*').eq('id',novelId).single());
 const allGlossary=await getGlossary(novelId),glossary=filterGlossaryToSource(allGlossary,source),locks=buildNameLocks(glossary);
 const lockedSource=lockText(source,locks),expected=new Map();
 for(const item of locks)expected.set(item.token,countToken(lockedSource,item.token));
 let result=await runTwoModelTask(primaryAiTranslate,masterPrompt({style:novel.style,glossary,locks,source:lockedSource,previousTail:'',sourceContext:''}),'TRANSLATE');
 let output=String(result.text||'').trim(),nameLockFallback=false;
 if(!validateLockedOutput(output,locks,expected)){
  console.warn('PHASE 1: NameLock validation failed on the complete chapter; retrying once without NameLock.');
  result=await runTwoModelTask(primaryAiTranslate,masterPrompt({style:novel.style,glossary,locks:[],source,previousTail:'',sourceContext:''}),'TRANSLATE_NO_NAMELOCK');
  output=String(result.text||'').trim();
  nameLockFallback=true;
 }else output=restoreNameLocks(output,locks);
 if(!output)throw new Error('Phase 1 returned an empty full-chapter translation.');
 if(episodeId&&!deferSave)await q(supabase.from('episodes').update({source,translation:output,model:result.model,status:'translated',updated_at:new Date().toISOString()}).eq('id',episodeId).eq('novel_id',novelId));
 res.json({translation:output,model:result.model,sourceChars:countChars(source),pass1Chars:countChars(output),nameLockNeutralFallback:nameLockFallback});
}catch(e){fail(res,e)}});
function parseGlossaryJson(text){const raw=String(text||'').trim().replace(/^\uFEFF/,'').replace(/^\`\`\`(?:json)?\s*/i,'').replace(/\s*\`\`\`$/,'').trim();try{return JSON.parse(raw)}catch(firstError){const start=raw.indexOf('{');if(start<0)throw firstError;let depth=0,inString=false,escaped=false;for(let i=start;i<raw.length;i++){const ch=raw[i];if(inString){if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch==='"')inString=false;continue}if(ch==='"'){inString=true;continue}if(ch==='{')depth++;else if(ch==='}'&&--depth===0){const candidate=raw.slice(start,i+1);try{return JSON.parse(candidate)}catch{return JSON.parse(candidate.replace(/,\s*([}\]])/g,'$1'))}}}throw firstError}}
app.post('/api/extract-glossary',async(req,res)=>{try{const {source}=req.body;if(!source?.trim())return res.status(400).json({error:'Source is required'});const r=await runTwoModelTask(primaryAiGlossary,glossaryPrompt(source),'GLOSSARY');let data;try{data=parseGlossaryJson(r.text)}catch{throw new Error('Glossary AI returned invalid JSON. Please try again.')}if(!validateGlossaryObject(data))throw new Error('Glossary AI returned an invalid format.');res.json({glossary:data,model:r.model,sourceChars:countChars(source)})}catch(e){fail(res,e)}});
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
 const r=await runTwoModelTask(primaryAiGlossary,glossaryPrompt(source),'GLOSSARY_AUTO');
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
 if(!novelId||!String(translation||'').trim())return res.status(400).json({error:'Novel and translation are required'});
 const novel=await q(supabase.from('novels').select('style').eq('id',novelId).single());
 let episodeSource='';
 if(episodeId){const ep=await q(supabase.from('episodes').select('source').eq('id',episodeId).eq('novel_id',novelId).single());episodeSource=ep?.source||''}
 const allGlossary=await getGlossary(novelId),glossary=episodeSource?filterGlossaryToSource(allGlossary,episodeSource):allGlossary;
 const glossaryLines=[];
 for(const [type,arr] of Object.entries(glossary||{}))for(const item of arr||[]){
  const original=String(item.original||'').trim(),translated=String(item.translation||'').trim();
  if(original&&translated)glossaryLines.push(type+': '+original+' => '+translated);
 }
 const glossaryNote='\n\nAUTHORITATIVE NAME / TERM GLOSSARY (reference for consistency only; never alter character names already present in the input):\n'+(glossaryLines.join('\n')||'(none)');
 const allowedNames=(glossary?.characters||[]).flatMap(x=>[x.original,x.translation]).map(x=>String(x||'').trim()).filter(Boolean);
 const novelStyle=String(novel?.style||'').trim(),yaTarget=13;
 const prompt=polishPrompt(translation,false,novelStyle,'',yaTarget).replace('INPUT:',glossaryNote+'\n\nINPUT:');
 let result=await runPolishTask(prompt,'POLISH-PASS-1');
 let polished=String(result.text||'').trim();
 if(!polished)throw new Error('Phase 2 returned an empty full-chapter result.');
 let issues=validatePolishOutput(polished,translation,result.finishReasons,{yaTarget,allowedNames});
 let correctivePasses=0;
 if(issues.length){
  correctivePasses=1;
  console.warn('PHASE 2: running the single full-chapter corrective pass: '+issues.join('; '));
  const retryPrompt=polishValidationRetryPrompt(polished,issues,novelStyle,'',translation,yaTarget).replace('INPUT:',glossaryNote+'\n\nINPUT:');
  result=await runPolishTask(retryPrompt,'POLISH-CORRECTIVE-PASS-1');
  const corrected=String(result.text||'').trim();
  if(!corrected)throw new Error('Phase 2 corrective pass returned an empty full-chapter result.');
  polished=corrected;
  issues=validatePolishOutput(polished,translation,result.finishReasons,{yaTarget,allowedNames});
 }
 if(issues.length)console.warn('PHASE 2: remaining non-blocking validation warnings after the one corrective pass; accepting the complete latest output: '+issues.join('; '));
 if(episodeId)await q(supabase.from('episodes').update({translation:polished,updated_at:new Date().toISOString()}).eq('id',episodeId).eq('novel_id',novelId));
 res.json({translation:polished,model:result.model,pass1Chars:countChars(translation),pass2Chars:countChars(polished),changed:normalizeForCompare(polished)!==normalizeForCompare(translation),validated:issues.length===0,phase2OutputAccepted:true,polishFallback:false,validationWarnings:issues,correctivePasses});
}catch(e){console.error('POLISH failed:',e?.stack||e?.message||e);res.status(e?.status||502).json({error:String(e?.message||e),validated:false,polishFallback:false,phase2Failed:true})}});
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
  let episodes=await fetchExportRows('episodes','number,title,source,translation',''+novelId,'number',100);
  episodes.sort((a,b)=>Number(a.number)-Number(b.number));
  const from=Number(fromChapter),to=Number(toChapter);
  if(Number.isInteger(from)&&from>0)episodes=episodes.filter(e=>Number(e.number)>=from);
  if(Number.isInteger(to)&&to>0)episodes=episodes.filter(e=>Number(e.number)<=to);
  if(Number.isInteger(from)&&from>0&&Number.isInteger(to)&&to>=from){
    const available=new Set(episodes.map(e=>Number(e.number)));
    const missing=[];
    for(let chapter=from;chapter<=to;chapter++)if(!available.has(chapter))missing.push(chapter);
    if(missing.length){
      const preview=missing.slice(0,30).join(', ')+(missing.length>30?' ... (+'+(missing.length-30)+' more)':'');
      throw new Error('Excel export stopped: '+missing.length+' chapter record(s) are missing from the database in the selected range. Missing chapter(s): '+preview+'. No incomplete workbook was generated.');
    }
  }
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
  for(const e of episodes)cs.addRow([Number(e.number),excelValue(e.title),'zh',excelValue(e.source),'',excelValue(e.translation),'FALSE']);
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
app.get('/api/export/template/:id',async(req,res)=>{try{const fromChapter=req.query.fromChapter??null,toChapter=req.query.toChapter??null;for(const v of [fromChapter,toChapter])if(v!==null&&(!/^\d+$/.test(String(v))||Number(v)<1))return res.status(400).json({error:'Chapter range must use positive whole numbers.'});if(fromChapter!==null&&toChapter!==null&&Number(fromChapter)>Number(toChapter))return res.status(400).json({error:'Starting chapter must not be greater than ending chapter.'});const wb=await buildTemplateWorkbook(req.params.id,fromChapter,toChapter);const buffer=await wb.xlsx.writeBuffer();const novel=await q(supabase.from('novels').select('name').eq('id',req.params.id).single());res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');res.setHeader('Content-Disposition',`attachment; filename="${slugify(novel.name)}-mm-novel.xlsx"`);res.setHeader('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');res.setHeader('Pragma','no-cache');res.setHeader('Expires','0');res.setHeader('X-Workbook-Export-Version','chapter-pagination-v3');res.send(Buffer.from(buffer))}catch(e){fail(res,e)}});
async function exportNovel(novelId){const novel=await q(supabase.from('novels').select('*').eq('id',novelId).single());const glossary=await q(supabase.from('glossary_terms').select('*').eq('novel_id',novelId));const episodes=await q(supabase.from('episodes').select('*').eq('novel_id',novelId).order('number'));return {version:2,exportedAt:new Date().toISOString(),novels:[novel],glossary,episodes}}
app.get('/api/export/novel/:id',async(req,res)=>{try{res.setHeader('Content-Disposition','attachment; filename=novel-backup.json');res.json(await exportNovel(req.params.id))}catch(e){fail(res,e)}});
app.get('/api/export/all',async(_,res)=>{try{const novels=await q(supabase.from('novels').select('*').order('created_at'));const glossary=await q(supabase.from('glossary_terms').select('*'));const episodes=await q(supabase.from('episodes').select('*').order('novel_id,number'));res.setHeader('Content-Disposition','attachment; filename=webnovel-backup.json');res.json({version:2,exportedAt:new Date().toISOString(),novels,glossary,episodes})}catch(e){fail(res,e)}});
app.post('/api/import',async(req,res)=>{try{const d=req.body;if(!Array.isArray(d.novels))throw new Error('Invalid backup');let ec=0;for(const n of d.novels){const existing=await q(supabase.from('novels').select('id').eq('id',n.id).maybeSingle());if(existing)await q(supabase.from('novels').update({name:n.name,style:n.style||'',updated_at:new Date().toISOString()}).eq('id',n.id));else await q(supabase.from('novels').insert({id:n.id,name:n.name,style:n.style||''}))}if(Array.isArray(d.glossary)&&d.glossary.length)await q(supabase.from('glossary_terms').upsert(d.glossary.map(x=>({id:x.id,novel_id:x.novel_id,type:x.type,original:x.original,translation:x.translation,note:x.note||'',voice:x.voice||''})),{onConflict:'id'}));if(Array.isArray(d.episodes)&&d.episodes.length){await q(supabase.from('episodes').upsert(d.episodes.map(x=>({id:x.id,novel_id:x.novel_id,number:x.number,title:x.title||'',source:x.source||'',translation:x.translation||'',model:x.model||'',status:x.status||'draft',created_at:x.created_at||new Date().toISOString(),updated_at:x.updated_at||new Date().toISOString()})),{onConflict:'id'}));ec=d.episodes.length}res.json({novels:d.novels.length,episodes:ec})}catch(e){fail(res,e)}});
app.listen(PORT,'0.0.0.0',()=>console.log(`Webnovel Translator running on port ${PORT}`));
