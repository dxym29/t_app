import fs from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const originalPath = path.join(root, 'boot.mjs');
const patchedPath = path.join(root, '.boot.optimized.runtime.mjs');

let source = await fs.readFile(originalPath, 'utf8');

// Keep translation chunks at 12,000 characters for both translation models.
source = source.replaceAll('splitText(source,7000)', 'splitText(source,12000)');

const oldServerChunkPatch = `const CHUNK_SIZES={'gemini-3.1-flash-lite':10000,'gemini-3.5-flash-lite':10000};\nconst TRANSLATE_CHUNK_SIZE=10000;`;
const serverChunkPatch = `const CHUNK_SIZES={'gemini-3.1-flash-lite':12000,'gemini-3.5-flash-lite':12000};\nconst TRANSLATE_CHUNK_SIZE=12000;`;
const serverPatchInjection = `source=source.replace(${JSON.stringify(oldServerChunkPatch)},${JSON.stringify(serverChunkPatch)});`;
const bootReadLine = `let source=await fs.readFile(sourcePath,'utf8');`;
if(!source.includes(bootReadLine))throw new Error('Could not locate boot.mjs source loader.');

// Batch cleaning is a separate stage. Fetch stays fast/pure; batch calls
// /api/clean-chapter only when it reaches a chapter.
// Primary: AI #2 glossary API. Fallback: the same API/client used by
// Myanmar -> Myanmar polishing (AI #3), including its own fallback API.
const rawCleanHelper = `
function rawCleanPrompt(raw){return \`You are a professional web novel editor.
Below is a raw text extracted from a web novel site. It contains unwanted site scripts, watermarks, navigation buttons, ads, and broken English MTL.
YOUR TASKS:
1. REMOVE all non-story noise (e.g., website URLs, chapter buttons, "read at...", code snippets, script tags, translated site system texts).
2. FIX broken grammar, weird character names/pronouns, and sentence flow to turn it into clean, natural English prose.
3. DO NOT summarize or skip any actual story content. Keep the scene-by-scene narrative intact.

OUTPUT FORMAT:
Return ONLY the cleaned and polished English story text.

RAW TEXT:
\${raw}\`}
async function cleanFetchedRawText(raw){
  const prompt=rawCleanPrompt(String(raw||''));
  try{
    const r=await runTwoModelTask(aiGlossary,prompt,'RAW_CLEAN');
    const text=String(r.text||'').trim();
    if(!text)throw new Error('Raw cleaning AI returned empty output.');
    return text;
  }catch(primaryError){
    console.warn('RAW_CLEAN: AI #2 cleaning failed. Switching to the Myanmar-polish API/fallback API.',primaryError?.message||primaryError);
    const r=await runPolishTask(prompt,'RAW_CLEAN_FALLBACK');
    const text=String(r.text||'').trim();
    if(!text)throw new Error('Raw cleaning fallback returned empty output.');
    return text;
  }
}
`;
const fetchMarker=`app.post('/api/fetch-chapter',async(req,res)=>{try{const {url}=req.body;if(!url?.trim())return res.status(400).json({error:'Chapter URL is required'});const result=await fetchNovelPingChapter(url.trim());res.json(result)}catch(e){fail(res,e)}});`;
const cleanMarker=`app.post('/api/clean-chapter',async(req,res)=>{try{const {source}=req.body;if(!source?.trim())return res.status(400).json({error:'Source text is required'});const cleanedSource=await cleanFetchedRawText(String(source));res.json({source:cleanedSource,sourceChars:countChars(cleanedSource),rawSourceChars:countChars(String(source)),cleaned:true})}catch(e){fail(res,e)}});`;
source = source.replace(bootReadLine, bootReadLine+'\n'+serverPatchInjection+'\n'+`source=source.replace(${JSON.stringify(fetchMarker)},${JSON.stringify(rawCleanHelper+'\n'+fetchMarker+'\n'+cleanMarker)});`);

// NameLock recovery: retry ONLY the failed chunk without placeholder tokens.
// The recovery still receives the authoritative glossary, and the master
// prompt explicitly tells the model to preserve every glossary name mapping.
const masterSignature=`function masterPrompt({style,glossary,locks,source,previousTail,sourceContext})`;
const masterSignaturePatched=`function masterPrompt({style,glossary,locks,source,previousTail,sourceContext,nameLockFallback=false})`;
if(!source.includes(masterSignature))throw new Error('Could not locate masterPrompt signature.');
source=source.replace(masterSignature,masterSignaturePatched);
const nameLockDisabledLine='- NAME LOCK is DISABLED for this chapter. Translate names naturally and consistently using the glossary. Do not output any placeholder token such as [[NAMELOCK_001]].';
const nameLockDisabledPatched=`- NAME LOCK is DISABLED for this chapter. Translate names naturally and consistently using the glossary. Do not output any placeholder token such as [[NAMELOCK_001]].\n${'${nameLockFallback ? \'- IMPORTANT NAME-CONSISTENCY RECOVERY: NameLock validation failed for this chunk. Carefully read the AUTHORITATIVE GLOSSARY before translating. Preserve every glossary original → Myanmar translation mapping exactly. Do NOT rename, re-spell, replace, transliterate differently, or invent alternative names. If a person/place/item/organization appears in the glossary, use its established Myanmar translation consistently throughout this chunk.\' : \'\n\''}`;
if(!source.includes(nameLockDisabledLine))throw new Error('Could not locate masterPrompt NameLock instruction.');
source=source.replace(nameLockDisabledLine,nameLockDisabledPatched);

const oldLockBlock = `if(!valid){\n              const mismatches=chunkLocks.map(x=>({token:x.token,expected:1,actual:countToken(output,x.token),sourceTerm:x.original})).filter(x=>x.actual!==1);\n              nameLockAttempts++;\n              console.warn('TRANSLATE: NameLock token mismatch for chunk '+(i+1)+'/'+workChunks.length+': '+JSON.stringify(mismatches));\n              if(nameLockAttempts<3){\n                console.warn('TRANSLATE: NameLock validation failed for chunk '+(i+1)+'/'+workChunks.length+'; real retry '+nameLockAttempts+'/3 in 3s.');\n                await sleep(3000);\n                continue;\n              }\n              throw new Error('NameLock validation failed after 3 actual translation attempts.');\n            }\n            output=restoreNameLocks(output,chunkLocks);`;
const newLockBlock = `if(!valid){\n              const mismatches=chunkLocks.map(x=>({token:x.token,expected:1,actual:countToken(output,x.token),sourceTerm:x.original})).filter(x=>x.actual!==1);\n              console.warn('TRANSLATE: NameLock validation failed for chunk '+(i+1)+'/'+workChunks.length+': '+JSON.stringify(mismatches)+'; re-running ONLY this chunk without NameLock.');\n              const natural=await generateModel(stage.ai,masterPrompt({\n                style:novel.style,glossary:chunkGlossary,locks:[],source:chunk,\n                previousTail:result.slice(-5000),sourceContext:previousSource,nameLockFallback:true\n              }),stage.model);\n              output=String(natural.text||'').trim();\n              if(!output)throw new Error('Translation model returned empty output during no-NameLock fallback.');\n              if(/\\[\\[NAMELOCK_[^\\]]+\\]\\]/i.test(output))throw new Error('Translation output unexpectedly contains a NameLock placeholder during no-NameLock fallback.');\n              modelUsed=natural.model;\n              providerUsed=stage.name;\n              console.warn('TRANSLATE: chunk '+(i+1)+'/'+workChunks.length+' recovered with glossary-guided natural translation without NameLock.');\n            }else{\n              output=restoreNameLocks(output,chunkLocks);\n            }`;
if(!source.includes(oldLockBlock))throw new Error('Could not locate the existing NameLock validation block in boot.mjs. No runtime changes were made.');
source = source.replace(oldLockBlock, newLockBlock);

const oldChapterFallback = `  let result='';\n  try{\n    result=await runChunks(true);\n  }catch(e){\n    if(!isLock(e))throw e;\n    nameLockFallback=true;\n    console.warn('TRANSLATE: NameLock validation failed after 3 checks. Discarding partial chapter and restarting whole chapter without NameLock.');\n    result=await runChunks(false);\n  }`;
const newChapterFallback = `  let result='';\n  result=await runChunks(true);`;
if(!source.includes(oldChapterFallback))throw new Error('Could not locate the existing whole-chapter NameLock fallback in boot.mjs. No runtime changes were made.');
source = source.replace(oldChapterFallback, newChapterFallback);

// Website Excel export: allow an optional ?toChapter=N limit. Default remains
// the whole novel when the field is blank.
const workbookSignature=`async function buildTemplateWorkbook(novelId){`;
const workbookSignaturePatched=`async function buildTemplateWorkbook(novelId,toChapter=null){`;
if(source.includes(workbookSignature)){
  source=source.replace(workbookSignature,workbookSignaturePatched);
  const episodesLoad=`const episodes=(await q(supabase.from('episodes').select('*').eq('novel_id',novelId))).sort((a,b)=>Number(a.number)-Number(b.number));`;
  const episodesLoadPatched=`let episodes=(await q(supabase.from('episodes').select('*').eq('novel_id',novelId))).sort((a,b)=>Number(a.number)-Number(b.number));\n  const chapterLimit=Number(toChapter);\n  if(Number.isInteger(chapterLimit)&&chapterLimit>0)episodes=episodes.filter(e=>Number(e.number)<=chapterLimit);`;
  if(!source.includes(episodesLoad))throw new Error('Excel episode query could not be patched safely.');
  source=source.replace(episodesLoad,episodesLoadPatched);
  const workbookCall='buildTemplateWorkbook(req.params.id)';
  if(source.includes(workbookCall))source=source.replace(workbookCall,'buildTemplateWorkbook(req.params.id,req.query.toChapter)');
}else{
  console.warn('Excel workbook builder not found; existing export behavior preserved.');
}

await fs.writeFile(patchedPath, source, 'utf8');
await import(pathToFileURL(patchedPath).href + `?optimized=${Date.now()}`);
