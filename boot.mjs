import fs from 'node:fs/promises';
import { fileURLToPath } from 'url';
import path from 'path';

const root=path.dirname(fileURLToPath(import.meta.url));
const sourcePath=path.join(root,'server.mjs');
const runtimePath=path.join(root,'server.runtime.mjs');
let source=await fs.readFile(sourcePath,'utf8');

const start=source.indexOf('async function buildTemplateWorkbook');
const end=source.indexOf("\napp.get('/api/export/template/:id'",start);
if(start<0||end<0)throw new Error('Excel export function could not be patched safely.');

const replacement=`async function buildTemplateWorkbook(novelId){
  const novel=await q(supabase.from('novels').select('*').eq('id',novelId).single());
  const glossary=await q(supabase.from('glossary_terms').select('*').eq('novel_id',novelId).order('created_at'));
  const episodes=(await q(supabase.from('episodes').select('*').eq('novel_id',novelId))).sort((a,b)=>Number(a.number)-Number(b.number));
  const wb=new ExcelJS.Workbook();
  wb.creator='MM Novel workbook';

  const purple='FF4338CA';
  const white='FFFFFFFF';
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
  guide.getColumn(1).width=25;guide.getColumn(2).width=115;guide.freezePane='A2';
  guide.getRow(1).eachCell(c=>Object.assign(c,headerStyle));
  for(let r=2;r<=5;r++){guide.getRow(r).height=38;guide.getCell(r,1).font={bold:true};guide.getCell(r,2).alignment={vertical:'top',wrapText:true}}

  const ns=wb.addWorksheet('Novel');
  ns.addRow(['field','value']);
  const fields=[
    ['title',excelValue(novel.name)],['slug',slugify(novel.name)],['originalTitle',''],['author',''],['description',''],['coverUrl',''],
    ['sourceLanguage','zh'],['translationGenre','general'],['translationTone','natural'],['translationNamePolicy','consistent'],
    ['translationInstructions',excelValue(novel.style)],['status','ONGOING'],['isPublished','false'],['genres','']
  ];
  for(const row of fields)ns.addRow(row);
  ns.getColumn(1).width=30;ns.getColumn(2).width=70;ns.freezePane='A2';ns.autoFilter='A1:B1';ns.getRow(1).height=28;ns.getRow(1).eachCell(c=>Object.assign(c,headerStyle));
  for(let r=2;r<=ns.rowCount;r++)ns.getRow(r).eachCell(c=>Object.assign(c,bodyStyle));

  const cs=wb.addWorksheet('Chapters');
  cs.addRow(['chapterNo','title','sourceLanguage','sourceContent','translatedTitle','translatedContent','publishImmediately']);
  const usedChapterNumbers=new Set();let nextChapterNo=1;for(const e of episodes){let chapterNo=Number(e.number);if(!Number.isSafeInteger(chapterNo)||chapterNo<=0||usedChapterNumbers.has(chapterNo)){while(usedChapterNumbers.has(nextChapterNo))nextChapterNo++;chapterNo=nextChapterNo;}usedChapterNumbers.add(chapterNo);if(chapterNo>=nextChapterNo){nextChapterNo=chapterNo+1;}cs.addRow([chapterNo,excelValue(e.title),'zh',excelValue(e.source),excelValue(e.title),excelValue(e.translation),Boolean(String(e.translation||'').trim())]);}
  [14,28,18,72,28,72,22].forEach((w,i)=>cs.getColumn(i+1).width=w);cs.freezePane='A2';cs.autoFilter='A1:G1';cs.getRow(1).height=28;cs.getRow(1).eachCell(c=>Object.assign(c,headerStyle));
  for(let r=2;r<=cs.rowCount;r++)cs.getRow(r).eachCell(c=>Object.assign(c,bodyStyle));

  const gs=wb.addWorksheet('Glossary');
  gs.addRow(['sourceTerm','translatedTerm','termType','note','characterVoice']);
  for(const x of glossary)gs.addRow([excelValue(x.original),excelValue(x.translation),excelValue(x.type),excelValue(x.note),excelValue(x.voice)]);
  [28,32,20,48,42].forEach((w,i)=>gs.getColumn(i+1).width=w);gs.freezePane='A2';gs.autoFilter='A1:E1';gs.getRow(1).height=28;gs.getRow(1).eachCell(c=>Object.assign(c,headerStyle));
  for(let r=2;r<=gs.rowCount;r++)gs.getRow(r).eachCell(c=>Object.assign(c,bodyStyle));

  return wb;
}`;
source=source.slice(0,start)+replacement+source.slice(end);

const translateKey=`const aiTranslate=new GoogleGenAI({apiKey:process.env.GEMINI_API_KEY});`;
const fallbackKey=`const aiTranslateFallbackKey=process.env.GEMINI_TRANSLATE_FALLBACK_API_KEY||'';
const aiTranslateFallback=aiTranslateFallbackKey?new GoogleGenAI({apiKey:aiTranslateFallbackKey}):null;
const TRANSLATE_FALLBACK_MODEL=process.env.GEMINI_TRANSLATE_FALLBACK_MODEL||'gemini-3.5-flash-lite';`;
if(!source.includes(translateKey))throw new Error('Primary translation client was not found.');
source=source.replace(translateKey,fallbackKey+'\n'+translateKey);

const polishStart=source.indexOf('function polishPrompt(');
const polishEnd=source.indexOf('\nasync function getGlossary',polishStart);
if(polishStart<0||polishEnd<0)throw new Error('Polish prompt could not be patched safely.');
const polishReplacement=`function polishPrompt(source,forceEdit=false){return \`You are an expert Myanmar web-novel editor. Your job is to perform a STRONG editorial cleanup of the provided Myanmar Pass 1 translation. You are NOT allowed to invent story content and you must not translate from an unseen original source.\n\nPRIMARY GOAL:\nTurn the input into fluent, natural, publication-ready Myanmar web-novel prose while preserving exactly the same story information. The input may contain literal-translation wording, incorrect Myanmar grammar, wrong particles, spelling mistakes, awkward sentence structures, or unnecessary English/Chinese/Thai/other foreign-language fragments. Fix these aggressively but safely.\n\nMEANING PRESERVATION — ABSOLUTE:\n- Preserve every event, action, thought, emotion, reaction, relationship, setting detail, dialogue, item, character, location, organization, skill, power, title, rank, and story fact already present.\n- NEVER invent a new fact, motive, event, action, character, relationship, object, place, ability, emotion, or dialogue.\n- NEVER summarize, shorten, omit, merge away, or remove story information.\n- Do not change event order, cause/effect, speaker identity, or who did what.\n- Do not reinterpret ambiguous information into a new meaning.\n\nSTRONG MYANMAR LANGUAGE CLEANUP:\n- Correct Myanmar spelling, Unicode text issues, typing mistakes, missing/incorrect particles, grammar, word order, sentence structure, punctuation, and unnatural phrasing.\n- Rewrite literal or machine-like translation structures into natural Myanmar literary prose.\n- Remove unnecessary foreign-language fragments when they are merely accidental carry-over from translation. Convert them into natural Myanmar wording without changing meaning.\n- Do NOT leave accidental English, Chinese, Thai, Korean, Japanese, or other foreign-language fragments just because they appear in the input.\n- Preserve established proper names, protected glossary terms, titles, ranks, organizations, items, locations, skills, and terminology when they are intentional and already established.\n- Do not alter a protected name/term merely to make the text look more Burmese.\n- Fix inconsistent spacing and punctuation while preserving paragraph and scene structure.\n\nLITERARY QUALITY:\n- Narration: smooth, natural Myanmar literary web-novel style.\n- Dialogue: natural spoken Myanmar that reflects personality, relationship, social status, and emotion.\n- Keep character voices distinct.\n- Keep narration and dialogue stylistically distinct where appropriate.\n- Preserve the original emotional intensity; do not exaggerate or weaken it.\n- Prefer clear, elegant, readable sentences over literal source-language syntax.\n\nFINAL CHECK BEFORE RETURNING:\n1. No accidental foreign-language fragments remain.\n2. Myanmar spelling and particles are correct.\n3. Sentences read naturally to a Myanmar web-novel reader.\n4. No story information was added or removed.\n5. Protected NAME LOCK tokens are unchanged.\n\${forceEdit?'- This is a SECOND editorial pass because the previous result was too close to the input. You MUST make genuine safe improvements wherever wording, grammar, particles, spelling, punctuation, or sentence flow can be improved. Do not return the input verbatim.\\n':''}\nNAME LOCK:\nProtected tokens such as [[NAMELOCK_001]] are immutable. Copy every token exactly. Never translate, alter, delete, duplicate, split, or move a protected token.\n\nReturn ONLY the final polished Myanmar text. No headings, notes, explanations, or comments.\n\nINPUT:\n\${source}\`;}`;
source=source.slice(0,polishStart)+polishReplacement+source.slice(polishEnd);

const translateStart=source.indexOf("app.post('/api/translate'");
const translateEnd=source.indexOf('\nfunction parseGlossaryJson',translateStart);
if(translateStart<0||translateEnd<0)throw new Error('Translate route could not be patched safely.');
const translateReplacement=`app.post('/api/translate',async(req,res)=>{try{const {novelId,episodeId,source}=req.body;if(!novelId||!source?.trim())return res.status(400).json({error:'Novel and source are required'});const novel=await q(supabase.from('novels').select('*').eq('id',novelId).single());const allGlossary=await getGlossary(novelId);const glossary=filterGlossaryToSource(allGlossary,source);const locks=buildNameLocks(glossary);let activeModel=MODELS[0],activeAI=aiTranslate,chunks=splitText(source,7000),result='',modelUsed=activeModel,usingPrimary=true;for(let i=0;i<chunks.length;i++){const chunk=chunks[i],previousSource=chunks[i-1]?chunks[i-1].slice(-CONTEXT_OVERLAP):'',lockedChunk=lockText(chunk,locks),lockedPreviousSource=lockText(previousSource,locks);try{const r=await generateWithRetries(activeAI,masterPrompt({style:novel.style,glossary,locks,source:lockedChunk,previousTail:result.slice(-5000),sourceContext:lockedPreviousSource}),activeModel);result+=(result?'\\n\\n':'')+restoreNameLocks(r.text.trim(),locks);modelUsed=r.model}catch(e){if(!retryable(e))throw e;if(usingPrimary&&activeModel===MODELS[0]){activeModel=MODELS[1];i--;continue}if(usingPrimary&&activeModel===MODELS[1]){if(!aiTranslateFallback)throw e;usingPrimary=false;activeAI=aiTranslateFallback;activeModel=TRANSLATE_FALLBACK_MODEL;console.log('TRANSLATE: primary API exhausted. Switching to separate fallback API for remaining chunks.');i--;continue}throw e}}if(episodeId)await q(supabase.from('episodes').update({source,translation:result,model:modelUsed,status:'translated',updated_at:new Date().toISOString()}).eq('id',episodeId).eq('novel_id',novelId));res.json({translation:result,model:modelUsed,sourceChars:countChars(source),pass1Chars:countChars(result),fallbackUsed:!usingPrimary})}catch(e){fail(res,e)}});`;
source=source.slice(0,translateStart)+translateReplacement+source.slice(translateEnd);

await fs.writeFile(runtimePath,source,'utf8');
await import(`./server.runtime.mjs?patch=${Date.now()}`);
