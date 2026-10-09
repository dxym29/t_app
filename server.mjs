import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';
import { GoogleGenAI } from '@google/genai';
import { createClient } from '@supabase/supabase-js';

const app=express();
const PORT=process.env.PORT||3000;
app.use(express.json({limit:'20mb'}));
app.use(express.static('public'));

const ai=new GoogleGenAI({apiKey:process.env.GEMINI_API_KEY});
const supabase=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
const MODELS=[
 'gemini-3.8-flash','gemini-3.7-flash','gemini-3.6-flash',
 'gemini-3.5-flash','gemini-3.5-flash-lite','gemini-3.1-flash-lite','gemini-2.5-flash-lite'
];

function id(){return crypto.randomUUID()}
function fail(res,e){console.error(e);return res.status(500).json({error:e.message||'Server error'})}
async function q(promise){const {data,error}=await promise;if(error)throw new Error(error.message);return data}
function retryable(e){const s=String(e?.message||e);return /429|quota|RESOURCE_EXHAUSTED|503|UNAVAILABLE|overloaded|timeout|temporar/i.test(s)}
function sleep(ms){return new Promise(r=>setTimeout(r,ms))}
async function generateWithFallback(prompt){
  let last;
  for(const model of MODELS){
    try{
      console.log(`Trying model: ${model}`);
      const response=await ai.models.generateContent({model,contents:prompt,config:{temperature:0.55,maxOutputTokens:32768}});
      console.log(`SUCCESS: ${model}`);
      return {text:response.text||'',model};
    }catch(e){
      last=e; console.error(`FAILED: ${model}`,e?.message||e);
      if(!retryable(e)) break;
      await sleep(600);
    }
  }
  throw last||new Error('All Gemini models failed');
}
function splitText(text,max=18000){
  const paras=text.split(/\n\s*\n/); const out=[]; let cur='';
  for(const p of paras){
    if((cur+p).length<=max){cur+=(cur?'\n\n':'')+p;continue}
    if(cur)out.push(cur);
    if(p.length<=max)cur=p;
    else for(let i=0;i<p.length;i+=max)out.push(p.slice(i,i+max));
  }
  if(cur)out.push(cur); return out;
}
function glossaryText(g){
  const lines=[];
  for(const [type,arr] of Object.entries(g||{})) for(const x of arr||[]){
    lines.push(`${type}: ${x.original} => ${x.translation}${x.voice?` | voice: ${x.voice}`:''}${x.note?` | note: ${x.note}`:''}`);
  }
  return lines.join('\n')||'(none)';
}
function masterPrompt({style,glossary,source,previousTail}){
return `You are a professional Myanmar webnovel translator.

TASK:
Translate the COMPLETE SOURCE into natural, polished Myanmar literary prose.

ABSOLUTE RULES:
- NEVER summarize, shorten, condense, skip, merge away, or omit source content.
- Translate every action, description, thought, emotion, reaction, relationship, setting detail, and dialogue.
- Do not invent facts, actions, motives, dialogue, names, items, events, or explanations.
- Keep the exact story order and cause/effect.
- Preserve paragraph and scene structure when practical.
- Narration must read as smooth Myanmar literary prose, not awkward word-for-word translation.
- Dialogue must sound like spoken Myanmar and reflect the speaker's personality, relationship, social status, and current emotion.
- Do not make every character speak with the same voice.
- Angry, frightened, sarcastic, cold, gentle, embarrassed, arrogant, playful, and desperate moods should sound different.
- Narration and dialogue should feel stylistically distinct where appropriate.
- The glossary below is authoritative. If a name/term is established there, use EXACTLY that Myanmar form.
- Preserve titles, ranks, relationships, organizations, skills, items, and place names consistently.
- Do not add translator notes, explanations, summaries, headings, or comments.
- Return ONLY the Myanmar translation.
- Accuracy before elegance, but the final Myanmar must be natural.

NOVEL-LEVEL STYLE:
${style||'(No extra style rules.)'}

AUTHORITATIVE GLOSSARY:
${glossaryText(glossary)}

PREVIOUS TRANSLATED TAIL FOR CONTINUITY ONLY:
${previousTail||'(none)'}

SOURCE:
${source}`;
}

async function getGlossary(novelId){
  const rows=await q(supabase.from('glossary_terms').select('*').eq('novel_id',novelId).order('created_at'));
  const g={characters:[],items:[],locations:[],organizations:[],skills:[],other:[]};
  for(const r of rows) (g[r.type]??g.other).push(r);
  return g;
}

app.get('/api/health',(_,res)=>res.json({ok:true}));
app.get('/api/novels',async(_,res)=>{try{res.json(await q(supabase.from('novels').select('*').order('created_at')))}catch(e){fail(res,e)}});
app.post('/api/novels',async(req,res)=>{try{const data=await q(supabase.from('novels').insert({name:req.body.name||'New Novel',style:req.body.style||''}).select().single());res.json(data)}catch(e){fail(res,e)}});
app.put('/api/novels/:id',async(req,res)=>{try{const data=await q(supabase.from('novels').update({name:req.body.name,style:req.body.style,updated_at:new Date().toISOString()}).eq('id',req.params.id).select().single());res.json(data)}catch(e){fail(res,e)}});
app.delete('/api/novels/:id',async(req,res)=>{try{await q(supabase.from('novels').delete().eq('id',req.params.id));res.json({ok:true})}catch(e){fail(res,e)}});

app.get('/api/glossary/:novelId',async(req,res)=>{try{res.json(await getGlossary(req.params.novelId))}catch(e){fail(res,e)}});
app.post('/api/glossary/:novelId',async(req,res)=>{try{
  const body={novel_id:req.params.novelId,type:req.body.type,original:req.body.original,translation:req.body.translation,note:req.body.note||'',voice:req.body.voice||''};
  const data=await q(supabase.from('glossary_terms').upsert(body,{onConflict:'novel_id,type,original'}).select().single());res.json(data)
}catch(e){fail(res,e)}});
app.delete('/api/glossary/:novelId/:type/:id',async(req,res)=>{try{await q(supabase.from('glossary_terms').delete().eq('novel_id',req.params.novelId).eq('id',req.params.id));res.json({ok:true})}catch(e){fail(res,e)}});

app.get('/api/episodes/:novelId',async(req,res)=>{try{res.json(await q(supabase.from('episodes').select('*').eq('novel_id',req.params.novelId).order('number')))}catch(e){fail(res,e)}});
app.post('/api/episodes/:novelId',async(req,res)=>{try{const data=await q(supabase.from('episodes').insert({novel_id:req.params.novelId,number:req.body.number,title:req.body.title||'',source:req.body.source||'',translation:req.body.translation||'',status:'draft'}).select().single());res.json(data)}catch(e){fail(res,e)}});
app.put('/api/episodes/:novelId/:id',async(req,res)=>{try{const data=await q(supabase.from('episodes').update({number:req.body.number,title:req.body.title,source:req.body.source,translation:req.body.translation,status:req.body.status||'draft',updated_at:new Date().toISOString()}).eq('novel_id',req.params.novelId).eq('id',req.params.id).select().single());res.json(data)}catch(e){fail(res,e)}});
app.delete('/api/episodes/:novelId/:id',async(req,res)=>{try{await q(supabase.from('episodes').delete().eq('novel_id',req.params.novelId).eq('id',req.params.id));res.json({ok:true})}catch(e){fail(res,e)}});

app.post('/api/translate',async(req,res)=>{
 try{
  const {novelId,episodeId,source}=req.body;if(!novelId||!source?.trim())return res.status(400).json({error:'Novel and source are required'});
  const novel=await q(supabase.from('novels').select('*').eq('id',novelId).single());
  const glossary=await getGlossary(novelId);
  const chunks=splitText(source); let result=''; let modelUsed='';
  for(const chunk of chunks){
    const r=await generateWithFallback(masterPrompt({style:novel.style,glossary,source:chunk,previousTail:result.slice(-5000)}));
    result+=(result?'\n\n':'')+r.text.trim(); modelUsed=r.model;
  }
  if(episodeId) await q(supabase.from('episodes').update({source,translation:result,model:modelUsed,status:'translated',updated_at:new Date().toISOString()}).eq('id',episodeId).eq('novel_id',novelId));
  res.json({translation:result,model:modelUsed});
 }catch(e){fail(res,e)}
});

async function exportNovel(novelId){
 const novel=await q(supabase.from('novels').select('*').eq('id',novelId).single());
 const glossary=await q(supabase.from('glossary_terms').select('*').eq('novel_id',novelId));
 const episodes=await q(supabase.from('episodes').select('*').eq('novel_id',novelId).order('number'));
 return {version:2,exportedAt:new Date().toISOString(),novels:[novel],glossary,episodes};
}
app.get('/api/export/novel/:id',async(req,res)=>{try{res.setHeader('Content-Disposition','attachment; filename=novel-backup.json');res.json(await exportNovel(req.params.id))}catch(e){fail(res,e)}});
app.get('/api/export/all',async(_,res)=>{try{
 const novels=await q(supabase.from('novels').select('*').order('created_at'));
 const glossary=await q(supabase.from('glossary_terms').select('*'));
 const episodes=await q(supabase.from('episodes').select('*').order('novel_id,number'));
 res.setHeader('Content-Disposition','attachment; filename=webnovel-backup.json');res.json({version:2,exportedAt:new Date().toISOString(),novels,glossary,episodes});
}catch(e){fail(res,e)}});

app.post('/api/import',async(req,res)=>{try{
 const d=req.body;if(!Array.isArray(d.novels))throw new Error('Invalid backup');
 const novelMap=new Map();let ec=0;
 for(const n of d.novels){
   const existing=await q(supabase.from('novels').select('id').eq('id',n.id).maybeSingle());
   if(existing) await q(supabase.from('novels').update({name:n.name,style:n.style||'',updated_at:new Date().toISOString()}).eq('id',n.id));
   else await q(supabase.from('novels').insert({id:n.id,name:n.name,style:n.style||''}));
   novelMap.set(n.id,n.id);
 }
 if(Array.isArray(d.glossary)&&d.glossary.length) await q(supabase.from('glossary_terms').upsert(d.glossary.map(x=>({id:x.id,novel_id:x.novel_id,type:x.type,original:x.original,translation:x.translation,note:x.note||'',voice:x.voice||''})),{onConflict:'id'}));
 if(Array.isArray(d.episodes)&&d.episodes.length){await q(supabase.from('episodes').upsert(d.episodes.map(x=>({id:x.id,novel_id:x.novel_id,number:x.number,title:x.title||'',source:x.source||'',translation:x.translation||'',model:x.model||'',status:x.status||'draft',created_at:x.created_at||new Date().toISOString(),updated_at:x.updated_at||new Date().toISOString()})),{onConflict:'id'}));ec=d.episodes.length}
 res.json({novels:d.novels.length,episodes:ec});
}catch(e){fail(res,e)}});

app.listen(PORT,'0.0.0.0',()=>console.log(`Webnovel Translator running on port ${PORT}`));