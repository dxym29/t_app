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

// NameLock validation/recovery is maintained in boot.mjs itself. Do not patch
// stale signatures here: boot.mjs builds the runtime from the current server source.

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
