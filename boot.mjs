import fs from 'node:fs/promises';
import { fileURLToPath } from 'url';
import path from 'path';

const root=path.dirname(fileURLToPath(import.meta.url));
const sourcePath=path.join(root,'server.mjs');
const runtimePath=path.join(root,'server.runtime.mjs');
let source=await fs.readFile(sourcePath,'utf8');

// Preserve the existing Excel template patch.
const start=source.indexOf('async function buildTemplateWorkbook');
const end=source.indexOf("\napp.get('/api/export/template/:id'",start);
if(start<0||end<0)throw new Error('Excel export function could not be patched safely.');
const replacement=`async function buildTemplateWorkbook(novelId){
  const novel=await q(supabase.from('novels').select('*').eq('id',novelId).single());
  const glossary=await q(supabase.from('glossary_terms').select('*').eq('novel_id',novelId).order('created_at'));
  const episodes=(await q(supabase.from('episodes').select('*').eq('novel_id',novelId))).sort((a,b)=>Number(a.number)-Number(b.number));
  const wb=new ExcelJS.Workbook();
  wb.creator='MM Novel workbook';
  const purple='FF4338CA',white='FFFFFFFF';
  const headerStyle={font:{bold:true,color:{argb:white}},fill:{type:'pattern',pattern:'solid',fgColor:{argb:purple}},alignment:{horizontal:'center',vertical:'middle',wrapText:true}};
  const bodyStyle={alignment:{vertical:'top',wrapText:true}};
  const guide=wb.addWorksheet('Guide');
  guide.addRows([
    ['MM Novel workbook','Guidance'],
    ['Novel sheet','Keep the field/value columns. Add one value per field. Slug must use Latin letters. Existing genre names may be separated with |.'],
    ['Chapters sheet','One chapter per row. Keep chapterNo unique. Enter sourceContent, translatedContent, or both. Set publishImmediately to TRUE only when the Burmese translation is ready to publish.'],
    ['Glossary sheet','One term per row. sourceTerm and translatedTerm are required; add character voice, cultivation level, realm, or notes in the other columns.'],
    ['Import','Use .xlsx files. Keep all sheet names and column headers unchanged. Import creates a new novel; it will not overwrite an existing novel.']
  ]);
  guide.getColumn(1).width=25;guide.getColumn(2).width=115;guide.freezePane='A2';guide.getRow(1).eachCell(c=>Object.assign(c,headerStyle));
  for(let r=2;r<=5;r++){guide.getRow(r).height=38;guide.getCell(r,1).font={bold:true};guide.getCell(r,2).alignment={vertical:'top',wrapText:true}}
  const ns=wb.addWorksheet('Novel');
  ns.addRow(['field','value']);
  const fields=[['title',excelValue(novel.name)],['slug',slugify(novel.name)],['originalTitle',''],['author',''],['description',''],['coverUrl',''],['sourceLanguage','zh'],['translationGenre','general'],['translationTone','natural'],['translationNamePolicy','consistent'],['translationInstructions',excelValue(novel.style)],['status','ONGOING'],['isPublished','false'],['genres','']];
  for(const row of fields)ns.addRow(row);
  ns.getColumn(1).width=30;ns.getColumn(2).width=70;ns.freezePane='A2';ns.autoFilter='A1:B1';ns.getRow(1).height=28;ns.getRow(1).eachCell(c=>Object.assign(c,headerStyle));for(let r=2;r<=ns.rowCount;r++)ns.getRow(r).eachCell(c=>Object.assign(c,bodyStyle));
  const cs=wb.addWorksheet('Chapters');
  cs.addRow(['chapterNo','title','sourceLanguage','sourceContent','translatedTitle','translatedContent','publishImmediately']);
  const usedChapterNumbers=new Set();let nextChapterNo=1;for(const e of episodes){let chapterNo=Number(e.number);if(!Number.isSafeInteger(chapterNo)||chapterNo<=0||usedChapterNumbers.has(chapterNo)){while(usedChapterNumbers.has(nextChapterNo))nextChapterNo++;chapterNo=nextChapterNo;}usedChapterNumbers.add(chapterNo);if(chapterNo>=nextChapterNo)nextChapterNo=chapterNo+1;cs.addRow([chapterNo,excelValue(e.title),'zh',excelValue(e.source),excelValue(e.title),excelValue(e.translation),Boolean(String(e.translation||'').trim())]);}
  [14,28,18,72,28,72,22].forEach((w,i)=>cs.getColumn(i+1).width=w);cs.freezePane='A2';cs.autoFilter='A1:G1';cs.getRow(1).height=28;cs.getRow(1).eachCell(c=>Object.assign(c,headerStyle));for(let r=2;r<=cs.rowCount;r++)cs.getRow(r).eachCell(c=>Object.assign(c,bodyStyle));
  const gs=wb.addWorksheet('Glossary');gs.addRow(['sourceTerm','translatedTerm','termType','note','characterVoice']);for(const x of glossary)gs.addRow([excelValue(x.original),excelValue(x.translation),excelValue(x.type),excelValue(x.note),excelValue(x.voice)]);[28,32,20,48,42].forEach((w,i)=>gs.getColumn(i+1).width=w);gs.freezePane='A2';gs.autoFilter='A1:E1';gs.getRow(1).height=28;gs.getRow(1).eachCell(c=>Object.assign(c,headerStyle));for(let r=2;r<=gs.rowCount;r++)gs.getRow(r).eachCell(c=>Object.assign(c,bodyStyle));
  return wb;
}`;
source=source.slice(0,start)+replacement+source.slice(end);

// Separate translation fallback API.
const translateKey=`const aiTranslate=new GoogleGenAI({apiKey:process.env.GEMINI_API_KEY});`;
const fallbackKey=`const aiTranslateFallbackKey=process.env.GEMINI_TRANSLATE_FALLBACK_API_KEY||'';
const aiTranslateFallback=aiTranslateFallbackKey?new GoogleGenAI({apiKey:aiTranslateFallbackKey}):null;
const TRANSLATE_FALLBACK_MODEL=process.env.GEMINI_TRANSLATE_FALLBACK_MODEL||'gemini-3.1-flash-lite';
const aiTranslateFallbackKey2=process.env.GEMINI_TRANSLATE_FALLBACK_API_KEY_2||'';
const aiTranslateFallback2=aiTranslateFallbackKey2?new GoogleGenAI({apiKey:aiTranslateFallbackKey2}):null;
const TRANSLATE_FALLBACK_MODEL_2=process.env.GEMINI_TRANSLATE_FALLBACK_MODEL_2||'gemini-3.1-flash-lite';`;
if(!source.includes(translateKey))throw new Error('Primary translation client was not found.');
source=source.replace(translateKey,fallbackKey+'\n'+translateKey);

// Replace NameLock helpers with alias-aware, output-validating helpers.
const lockStart=source.indexOf('function buildNameLocks(');
const lockEnd=source.indexOf('function countChars(',lockStart);
if(lockStart<0||lockEnd<0)throw new Error('NameLock helpers could not be patched safely.');
const lockReplacement=`function normalizeNameKey(v){return String(v||'').normalize('NFKC').replace(/[“”"']/g,'').replace(/\s+/g,' ').trim().toLowerCase()}
function buildNameLocks(g){
  const raw=[];
  for(const [type,arr] of Object.entries(g||{}))for(const x of arr||[]){
    const original=String(x.original||'').trim(),translation=String(x.translation||'').trim();
    if(!original||!translation)continue;
    raw.push({type,original,translation,voice:x.voice||'',note:x.note||''});
  }
  const aliasOwners=new Map(),originalKeys=new Set(raw.map(x=>normalizeNameKey(x.original)));
  for(const x of raw){
    if(x.type!=='characters')continue;
    const parts=x.original.split(/\s+/).filter(Boolean);
    if(parts.length<3)continue;
    const alias=parts.slice(-2).join(' '),key=normalizeNameKey(alias);
    if(!key||key===normalizeNameKey(x.original))continue;
    if(!aliasOwners.has(key))aliasOwners.set(key,[]);
    aliasOwners.get(key).push(x.original);
  }
  let n=1;
  return raw.map(x=>{
    const parts=x.original.split(/\s+/).filter(Boolean);
    const alias=x.type==='characters'&&parts.length>=3?parts.slice(-2).join(' '):'';
    const aliasKey=normalizeNameKey(alias);
    const safeAlias=alias&&!originalKeys.has(aliasKey)&&(aliasOwners.get(aliasKey)||[]).length===1?alias:'';
    return {...x,aliases:safeAlias?[safeAlias]:[],token:'[[NAMELOCK_'+String(n++).padStart(3,'0')+']]'};
  }).sort((a,b)=>b.original.length-a.original.length);
}
function termAppears(text,term){const t=String(text||'').toLowerCase(),q=String(term||'').trim().toLowerCase();return !!q&&t.includes(q)}
function filterGlossaryToSource(g,source){const text=String(source||'');const all=buildNameLocks(g);const active=new Set(all.filter(x=>termAppears(text,x.original)||(x.aliases||[]).some(a=>termAppears(text,a))).map(x=>normalizeNameKey(x.original)));const out={};for(const [type,arr] of Object.entries(g||{}))out[type]=(arr||[]).filter(x=>active.has(normalizeNameKey(String(x.original||'').trim())));return out}
function lockText(text,locks){let out=String(text||'');const terms=[];for(const x of locks){terms.push({term:x.original,token:x.token});for(const a of x.aliases||[])terms.push({term:a,token:x.token})}terms.sort((a,b)=>b.term.length-a.term.length);for(const x of terms)out=out.split(x.term).join(x.token);return out}
function lockTranslationText(text,locks){let out=String(text||'');const ordered=[...locks].sort((a,b)=>b.translation.length-a.translation.length);for(const x of ordered)out=out.split(x.translation).join(x.token);return out}
function findNameLockTokens(text){const re=new RegExp('\\\\[\\\\[NAMELOCK_([^\\\\]]+)\\\\]\\\\]','g');return [...String(text||'').matchAll(re)].map(m=>({raw:m[0],label:m[1]}))}
function repairInventedNameLocks(text,locks){let out=String(text||'');const byLabel=new Map();for(const x of locks){byLabel.set(normalizeNameKey(x.original),x.token);for(const a of x.aliases||[])byLabel.set(normalizeNameKey(a),x.token)}for(const m of findNameLockTokens(out)){if(locks.some(x=>x.token===m.raw))continue;const mapped=byLabel.get(normalizeNameKey(String(m.label||'').replace(/[_-]+/g,' ')));if(!mapped)throw new Error('NameLock validation failed: unknown placeholder '+m.raw);out=out.split(m.raw).join(mapped)}return out}
function restoreNameLocks(text,locks){let out=String(text||'');for(const x of locks){out=out.split(x.token).join(x.translation);for(const a of x.aliases||[])out=out.split(a).join(x.translation);out=out.split(x.original).join(x.translation)}if(/\[\[NAMELOCK_[^\]]+\]\]/i.test(out))throw new Error('NameLock validation failed: unresolved placeholder remains');return out}
function lockedGlossaryText(g,locks){const map=new Map(locks.map(x=>[x.original,x]));const lines=[];for(const [type,arr] of Object.entries(g||{}))for(const x of arr||[]){const l=map.get(String(x.original||'').trim());const forms=l&&l.aliases&&l.aliases.length?' | source forms: '+[x.original,...l.aliases].join(' / '):'';lines.push(type+': '+(l?.token||x.original)+' => '+x.translation+forms+(x.voice?' | voice: '+x.voice:'')+(x.note?' | note: '+x.note:''))}return lines.join('\\n')||'(none)'}
`;
source=source.slice(0,lockStart)+lockReplacement+source.slice(lockEnd);

// Stronger translation prompt rule: model must never invent NameLock tokens.
source=source.replace('Every [[NAMELOCK_###]] token in SOURCE is protected. Copy it EXACTLY. Never translate, alter, remove, split, duplicate, or paraphrase it.','Every [[NAMELOCK_###]] token already present in SOURCE is protected. Copy it EXACTLY. NEVER create any [[NAMELOCK_...]] token yourself. If a name is not represented by a protected token, output the name normally. Never invent placeholders. Never translate, alter, remove, split, duplicate, or paraphrase a protected token.');

// Replace translation route with a chunk state machine. A fallback changes model only for the current failed chunk;
// already completed chunks remain in result and are never replayed.
const translateStart=source.indexOf("app.post('/api/translate'");
const translateEnd=source.indexOf('\nfunction parseGlossaryJson',translateStart);
if(translateStart<0||translateEnd<0)throw new Error('Translate route could not be patched safely.');
const translateReplacement=`app.post('/api/translate',async(req,res)=>{try{
  const {novelId,episodeId,source}=req.body;
  if(!novelId||!source?.trim())return res.status(400).json({error:'Novel and source are required'});
  const novel=await q(supabase.from('novels').select('*').eq('id',novelId).single());
  const allGlossary=await getGlossary(novelId);
  const glossary=filterGlossaryToSource(allGlossary,source);
  const locks=buildNameLocks(glossary);
  const chunks=splitText(source,7000);
  const stages=[
    {name:'primary',ai:aiTranslate,model:'gemini-3.1-flash-lite'},
    {name:'primary',ai:aiTranslate,model:'gemini-3.5-flash-lite'},
    {name:'fallback-1',ai:aiTranslateFallback,model:TRANSLATE_FALLBACK_MODEL||'gemini-3.1-flash-lite'},
    {name:'fallback-2',ai:aiTranslateFallback2,model:TRANSLATE_FALLBACK_MODEL_2||'gemini-3.1-flash-lite'}
  ];
  const isQuota=e=>/429|RESOURCE_EXHAUSTED|quota exceeded|quota exhausted|rate.?limit|GenerateRequestsPerDayPerModel|retryDelay/i.test(String(e?.message||e));
  const isBlocked=e=>/PROHIBITED_CONTENT|prompt.?block|safety.?block|blocked by Gemini safety filter/i.test(String(e?.message||e));
  const isLock=e=>/NameLock validation|NameLock placeholder/i.test(String(e?.message||e));
  let stageIndex=0,modelUsed='gemini-3.1-flash-lite',providerUsed='primary',nameLockFallback=false;
  const runChunks=async(useLocks)=>{
    let result='';
    const workChunks=splitText(source,7000);
    for(let i=0;i<workChunks.length;i++){
      const chunk=workChunks[i],previousSource=i>0?workChunks[i-1].slice(-CONTEXT_OVERLAP):'';
      const lockedChunk=useLocks?lockText(chunk,locks):chunk;
      const lockedPrevious=useLocks?lockText(previousSource,locks):previousSource;
      const expected=new Map(locks.map(x=>[x.token,countToken(lockedChunk,x.token)]));
      let done=false,lastError;
      while(!done){
        if(stageIndex>=stages.length){const exhausted=new Error('SKIP_CHAPTER: all configured translation APIs/models are out of quota.');exhausted.code='QUOTA_EXHAUSTED';throw exhausted;}
        const stage=stages[stageIndex];
        if(!stage.ai){
          console.warn('TRANSLATE: '+stage.name+' is not configured; skipping to next API stage.');
          stageIndex++;
          continue;
        }
        try{
          const r=await generateModel(stage.ai,masterPrompt({
            style:novel.style,glossary,locks:useLocks?locks:[],source:lockedChunk,
            previousTail:result.slice(-5000),sourceContext:lockedPrevious
          }),stage.model);
          let output=String(r.text||'').trim();
          if(!output)throw new Error('Translation model returned empty output.');
          if(useLocks){
            output=repairInventedNameLocks(output,locks);
            let valid=validateLockedOutput(output,locks,expected);
            if(!valid){
              for(let check=1;check<=3&&!valid;check++){
                console.warn('TRANSLATE: NameLock validation failed for chunk '+(i+1)+'/'+workChunks.length+'; check '+check+'/3, retrying validation in 3s without another API call.');
                await sleep(3000);
                valid=validateLockedOutput(output,locks,expected);
              }
            }
            if(!valid)throw new Error('NameLock validation failed after 3 checks.');
            output=restoreNameLocks(output,locks);
          }else if(/\\[\\[NAMELOCK_[^\\]]+\\]\\]/i.test(output)){
            throw new Error('Translation output unexpectedly contains a NameLock placeholder.');
          }
          result+=(result?'\\n\\n':'')+output;
          modelUsed=r.model;providerUsed=stage.name;done=true;
          console.log('TRANSLATE: '+(useLocks?'':'no-NameLock ')+'chunk '+(i+1)+'/'+workChunks.length+' succeeded with '+stage.name+' / '+stage.model+'.');
        }catch(e){
          lastError=e;
          if(isBlocked(e)){
            const msg='SKIP_CHAPTER: Gemini safety filter blocked chapter content at chunk '+(i+1)+'/'+workChunks.length+' using '+stage.name+' / '+stage.model+'.';
            console.warn('TRANSLATE: '+msg);
            const blocked=new Error(msg);blocked.code='CONTENT_BLOCKED';throw blocked;
          }
          if(isLock(e)&&useLocks)throw e;
          if(isQuota(e)){
            console.warn('TRANSLATE: '+stage.name+' / '+stage.model+' quota exceeded; moving to next configured model/API stage.');
            stageIndex++;
            continue;
          }
          console.error('TRANSLATE: '+stage.name+' / '+stage.model+' chunk '+(i+1)+'/'+workChunks.length+' failed: '+String(e?.message||e)+'. Retrying same model in 3s because error is not quota-related.');
          await sleep(3000);
        }
      }
    }
    return result;
  };
  let result='';
  try{
    result=await runChunks(true);
  }catch(e){
    if(!isLock(e))throw e;
    nameLockFallback=true;
    console.warn('TRANSLATE: NameLock validation failed after 3 checks. Discarding partial chapter and restarting whole chapter without NameLock.');
    result=await runChunks(false);
  }
  if(episodeId){
    try{
      await q(supabase.from('episodes').update({source,translation:result,model:modelUsed,status:'translated',updated_at:new Date().toISOString()}).eq('id',episodeId).eq('novel_id',novelId));
    }catch(saveError){
      console.error('TRANSLATE: translation completed but database save failed:',String(saveError?.message||saveError));
    }
  }
  res.json({translation:result,model:modelUsed,sourceChars:countChars(source),pass1Chars:countChars(result),fallbackUsed:providerUsed!=='primary',providerUsed,nameLockFallback});
}catch(e){
  const message=String(e?.message||e);
  if(e?.code==='CONTENT_BLOCKED'||message.startsWith('SKIP_CHAPTER:'))return res.status(422).json({error:message,code:'CONTENT_BLOCKED'});
  console.error('TRANSLATE: request failed:',e?.stack||message);
  fail(res,e);
}});`

source=source.slice(0,translateStart)+translateReplacement+source.slice(translateEnd);

await fs.writeFile(runtimePath,source,'utf8');
await import(`./server.runtime.mjs?patch=${Date.now()}`);
