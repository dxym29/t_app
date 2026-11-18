import fs from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const originalPath = path.join(root, 'boot.mjs');
const patchedPath = path.join(root, '.boot.optimized.runtime.mjs');

let source = await fs.readFile(originalPath, 'utf8');

const bootReadLine = `let source=await fs.readFile(sourcePath,'utf8');`;
if(!source.includes(bootReadLine))throw new Error('Could not locate boot.mjs source loader.');

// Batch cleaning is a separate stage. Fetch stays fast/pure; batch calls
// /api/clean-chapter only when it reaches a chapter.
// Primary: AI #2 glossary API. Fallback: the same API/client used by
// Myanmar -> Myanmar polishing (AI #3), including its own fallback API.
const rawCleanHelper = `
function rawCleanPrompt(raw){return "You are a careful web-novel text extractor.\nThe input may contain chapter-story text mixed with website navigation, advertisements, page controls, URLs, scripts, and other page noise.\n\nYOUR ONLY JOB:\nRemove content that is clearly part of the website interface and keep the complete chapter text.\n\nREMOVE ONLY CLEAR WEBSITE NOISE:\n- Navigation menus, login/register prompts, buttons, page controls, URLs, advertisements, repeated headers/footers, and recommendation links.\n- HTML, CSS, JavaScript, tracking snippets, and obvious website scripts.\n- Repeated website labels such as previous/next chapter controls when they are not part of the story.\n\nPRESERVE THE STORY EXACTLY IN MEANING AND ORDER:\n- Keep every story paragraph, sentence, dialogue line, inner thought, scene, and ending.\n- Keep all character names, pronouns, relationships, titles, ranks, numbers, dates, places, and terminology unchanged.\n- Keep foreign-language words or sentences that appear in the story.\n- Keep author notes or translator notes when they are included as part of the chapter.\n- Keep unusual, awkward, or grammatically incorrect English if it may be part of the source story. Do not rewrite or polish it.\n\nSTRICT RULES:\n- Do not summarize, shorten, paraphrase, translate, correct grammar, improve style, or invent missing text.\n- Do not remove a sentence merely because it looks strange or unrelated; if unsure whether text is story content, PRESERVE IT.\n- Keep the original paragraph order and preserve the beginning and ending of the chapter.\n- You may fix only obvious extraction damage such as broken spacing or line breaks, without changing wording.\n\nOUTPUT:\nReturn only the complete chapter text with clearly identifiable website noise removed.\n\nRAW TEXT:\n"+String(raw||'')}
async function cleanFetchedRawText(raw){
  const prompt=rawCleanPrompt(String(raw||''));
  const r=await runTwoModelTask(primaryAiGlossary,prompt,'RAW_CLEAN');
  const text=String(r.text||'').trim();
  if(!text)throw new Error('Raw cleaning AI returned empty output.');
  return text;
}
`;
const fetchMarker=`app.post('/api/fetch-chapter',async(req,res)=>{try{const {url}=req.body;if(!url?.trim())return res.status(400).json({error:'Chapter URL is required'});const result=await fetchNovelPingChapter(url.trim());res.json(result)}catch(e){fail(res,e)}});`;
const cleanMarker=`app.post('/api/clean-chapter',async(req,res)=>{try{const {source}=req.body;if(!source?.trim())return res.status(400).json({error:'Source text is required'});const cleanedSource=await cleanFetchedRawText(String(source));res.json({source:cleanedSource,sourceChars:countChars(cleanedSource),rawSourceChars:countChars(String(source)),cleaned:true})}catch(e){fail(res,e)}});`;
source = source.replace(bootReadLine, bootReadLine+'\n'+`source=source.replace(${JSON.stringify(fetchMarker)},${JSON.stringify(rawCleanHelper+'\n'+fetchMarker+'\n'+cleanMarker)});`);

// NameLock validation/recovery is maintained in boot.mjs itself. Do not patch
// stale signatures here: boot.mjs builds the runtime from the current server source.

// Website Excel export: allow an optional ?toChapter=N limit. Default remains
// the whole novel when the field is blank.
const workbookSignature=`async function buildTemplateWorkbook(novelId){`;
const workbookSignaturePatched=`async function buildTemplateWorkbook(novelId,fromChapter=null,toChapter=null){`;
if(source.includes(workbookSignature)){
  source=source.replace(workbookSignature,workbookSignaturePatched);
  const episodesLoad=`const episodes=(await q(supabase.from('episodes').select('*').eq('novel_id',novelId))).sort((a,b)=>Number(a.number)-Number(b.number));`;
  const episodesLoadPatched=`let episodes=(await q(supabase.from('episodes').select('*').eq('novel_id',novelId))).sort((a,b)=>Number(a.number)-Number(b.number));\n  const chapterStart=Number(fromChapter),chapterEnd=Number(toChapter);\n  if(Number.isInteger(chapterStart)&&chapterStart>0)episodes=episodes.filter(e=>Number(e.number)>=chapterStart);\n  if(Number.isInteger(chapterEnd)&&chapterEnd>0)episodes=episodes.filter(e=>Number(e.number)<=chapterEnd);`;
  if(!source.includes(episodesLoad))throw new Error('Excel episode query could not be patched safely.');
  source=source.replace(episodesLoad,episodesLoadPatched);
  const workbookCall='buildTemplateWorkbook(req.params.id)';
  if(source.includes(workbookCall))source=source.replace(workbookCall,'buildTemplateWorkbook(req.params.id,req.query.fromChapter,req.query.toChapter)');
}else{
  console.warn('Excel workbook builder not found; existing export behavior preserved.');
}

await fs.writeFile(patchedPath, source, 'utf8');
await import(pathToFileURL(patchedPath).href + `?optimized=${Date.now()}`);
