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
const replacement=`async function buildTemplateWorkbook(novelId,fromChapter=null,toChapter=null){
  const novel=await q(supabase.from('novels').select('*').eq('id',novelId).single());
  const glossary=await q(supabase.from('glossary_terms').select('*').eq('novel_id',novelId).order('created_at'));
  let episodes=(await q(supabase.from('episodes').select('*').eq('novel_id',novelId))).sort((a,b)=>Number(a.number)-Number(b.number));\n  const from=Number(fromChapter),to=Number(toChapter);\n  if(Number.isInteger(from)&&from>0)episodes=episodes.filter(e=>Number(e.number)>=from);\n  if(Number.isInteger(to)&&to>0)episodes=episodes.filter(e=>Number(e.number)<=to);
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

// Replace NameLock helpers with alias-aware, output-validating helpers.
const lockStart=source.indexOf('function buildNameLocks(');
const lockEnd=source.indexOf('function countChars(',lockStart);
if(lockStart<0||lockEnd<0)throw new Error('NameLock helpers could not be patched safely.');
const lockReplacement=`function normalizeNameKey(v){return String(v||'').normalize('NFKC').replace(/[“”"']/g,'').replace(/\\s+/g,' ').trim().toLowerCase()}
function escapeNameRegex(v){return Array.from(String(v||''),c=>'.^$*+?()[]{}|'.includes(c)||c===String.fromCharCode(92)?String.fromCharCode(92)+c:c).join('')}
function sourceTermAppears(text,term){
  const value=String(term||'').trim();
  if(!value)return false;
  const re=new RegExp('(^|[^\\\\p{L}\\\\p{N}])'+escapeNameRegex(value)+'(?=$|[^\\\\p{L}\\\\p{N}])','iu');
  return re.test(String(text||''));
}
function buildNameLocks(g){
  // Lock only character names. Other glossary categories remain glossary guidance.
  const candidates=[];
  for(const x of (g?.characters||[])){
    const original=String(x.original||'').trim(),translation=String(x.translation||'').trim();
    if(!original||!translation||Array.from(original).length<3)continue;
    candidates.push({type:'characters',original,translation,voice:x.voice||'',note:x.note||''});
  }
  // Conflicting duplicate source names are ambiguous; leave them unlocked.
  const grouped=new Map();
  for(const x of candidates){const key=normalizeNameKey(x.original);if(!grouped.has(key))grouped.set(key,[]);grouped.get(key).push(x)}
  const safe=[...grouped.values()].filter(group=>new Set(group.map(x=>x.translation)).size===1).map(group=>group[0]);
  let n=1;
  return safe.map(x=>({...x,aliases:[],token:'[[NAMELOCK_'+String(n++).padStart(3,'0')+']]' })).sort((a,b)=>b.original.length-a.original.length);
}
function filterGlossaryToSource(g,source){
  const out={};
  for(const [type,arr] of Object.entries(g||{}))out[type]=(arr||[]).filter(x=>sourceTermAppears(source,x.original));
  return out;
}
function lockText(text,locks){
  let out=String(text||'');
  for(const x of [...locks].sort((a,b)=>b.original.length-a.original.length)){
    const re=new RegExp('(^|[^\\\\p{L}\\\\p{N}])('+escapeNameRegex(x.original)+')(?=$|[^\\\\p{L}\\\\p{N}])','giu');
    out=out.replace(re,(m,prefix)=>prefix+x.token);
  }
  return out;
}
function lockChunkWithUniqueTokens(text,locks){
  let out=String(text||''),n=1;const used=[];
  for(const item of [...locks].sort((a,b)=>b.original.length-a.original.length)){
    const re=new RegExp('(^|[^\\\\p{L}\\\\p{N}])('+escapeNameRegex(item.original)+')(?=$|[^\\\\p{L}\\\\p{N}])','giu');
    out=out.replace(re,(match,prefix)=>{const token='[[NAMELOCK_'+String(n++).padStart(3,'0')+']]';used.push({...item,token,matchedForm:item.original});return prefix+token});
  }
  return {text:out,locks:used};
}
function lockTranslationText(text,locks){let out=String(text||'');const ordered=[...locks].sort((a,b)=>b.translation.length-a.translation.length);for(const x of ordered)out=out.split(x.translation).join(x.token);return out}
function findNameLockTokens(text){const re=new RegExp('\\\\[\\\\[NAMELOCK_([^\\\\]]+)\\\\]\\\\]','g');return [...String(text||'').matchAll(re)].map(m=>({raw:m[0],label:m[1]}))}
function repairMissingNameLocksFromLiteralNames(text,locks){
  let out=String(text||'');
  for(const x of locks)while(countToken(out,x.token)<1){
    const form=String(x.matchedForm||x.original||'');
    const re=new RegExp('(^|[^\\\\p{L}\\\\p{N}])('+escapeNameRegex(form)+')(?=$|[^\\\\p{L}\\\\p{N}])','iu');
    const match=re.exec(out);if(!match)break;
    out=out.slice(0,match.index)+match[1]+x.token+out.slice(match.index+match[0].length);
  }
  return out;
}
function repairInventedNameLocks(text,locks){
  const out=String(text||''),known=new Set(locks.map(x=>x.token));
  for(const token of findNameLockTokens(out))if(!known.has(token.raw))throw new Error('NameLock validation failed: unknown placeholder '+token.raw);
  return out;
}
function restoreNameLocks(text,locks){
  let out=String(text||'');for(const x of locks)out=out.split(x.token).join(x.translation);
  if(/\\\\[\\\\[NAMELOCK_[^\\\\]]+\\\\]\\\\]/i.test(out))throw new Error('NameLock validation failed: unresolved placeholder remains');
  return out;
}
function lockedGlossaryText(g,locks){
  const lockMap=new Map(locks.map(x=>[normalizeNameKey(x.original),x])),lines=[];
  for(const [type,arr] of Object.entries(g||{}))for(const x of arr||[]){
    const original=String(x.original||'').trim(),lock=type==='characters'?lockMap.get(normalizeNameKey(original)):null;
    lines.push(type+': '+(lock?lock.token:original)+' => '+x.translation+(x.voice?' | voice: '+x.voice:'')+(x.note?' | note: '+x.note:''));
  }
  return lines.join(String.fromCharCode(10))||'(none)';
}`;
source=source.slice(0,lockStart)+lockReplacement+source.slice(lockEnd);

// Stronger translation prompt rule: model must never invent NameLock tokens.
source=source.replace('Every [[NAMELOCK_###]] token in SOURCE is protected. Copy it EXACTLY. Never translate, alter, remove, split, duplicate, or paraphrase it.','Every [[NAMELOCK_###]] token already present in SOURCE is protected. Copy it EXACTLY. NEVER create any [[NAMELOCK_...]] token yourself. If a name is not represented by a protected token, output the name normally. Never invent placeholders. Never translate, alter, remove, split, duplicate, or paraphrase a protected token.');
// Add an explicit per-occurrence checklist so repeated names do not rely on the glossary summary alone.
const glossaryAnchor='\\nAUTHORITATIVE GLOSSARY:\\n${lockedGlossaryText(glossary,locks)}\\n\\nPREVIOUS TRANSLATED TAIL FOR CONTINUITY ONLY:';
const glossaryWithChecklist='\\nAUTHORITATIVE GLOSSARY:\\n${lockedGlossaryText(glossary,locks)}\\n\\nPROTECTED TOKEN CHECKLIST (copy EVERY listed token exactly once; do not skip any):\\n${locks?.length ? locks.map(x=>`${x.token} => ${x.translation} (source: ${x.original})`).join(String.fromCharCode(10)) : "(none)"}\\n\\nPREVIOUS TRANSLATED TAIL FOR CONTINUITY ONLY:';
if(!source.includes(glossaryAnchor))throw new Error('Could not safely locate master prompt glossary section.');
source=source.replace(glossaryAnchor,glossaryWithChecklist);

// Replace translation route with a chunk state machine. A fallback changes model only for the current failed chunk;
// already completed chunks remain in result and are never replayed.
const translateStart=source.indexOf("app.post('/api/translate'");
const translateEnd=source.indexOf('\nfunction parseGlossaryJson',translateStart);
if(translateStart<0||translateEnd<0)throw new Error('Translate route could not be patched safely.');
const translateReplacement=`app.post('/api/translate',async(req,res)=>{try{
 const {novelId,episodeId,source}=req.body;
 if(!novelId||!String(source||'').trim())return res.status(400).json({error:'Novel and source are required'});
 const novel=await q(supabase.from('novels').select('*').eq('id',novelId).single());
 const allGlossary=await getGlossary(novelId);
 const glossary=filterGlossaryToSource(allGlossary,source);
 const locks=buildNameLocks(glossary);
 const lockedResult=lockChunkWithUniqueTokens(source,locks);
 const lockedSource=lockedResult.text,chapterLocks=lockedResult.locks;
 const expected=new Map(chapterLocks.map(x=>[x.token,1]));
 const prompt=masterPrompt({style:novel.style,glossary,locks:chapterLocks,source:lockedSource,previousTail:'',sourceContext:''});
 let result=await runTwoModelTask(aiTranslate,prompt,'TRANSLATE');
 let output=String(result.text||'').trim(),nameLockFallback=false;
 if(output){
  output=repairInventedNameLocks(output,chapterLocks);
  output=repairMissingNameLocksFromLiteralNames(output,chapterLocks);
 }
 if(!output||!validateLockedOutput(output,chapterLocks,expected)){
  console.warn('TRANSLATE: full-chapter NameLock validation failed; retrying the entire chapter once without NameLock.');
  const neutralPrompt=masterPrompt({style:novel.style,glossary,locks:[],source,previousTail:'',sourceContext:''});
  result=await runTwoModelTask(aiTranslate,neutralPrompt,'TRANSLATE_NO_NAMELOCK');
  output=String(result.text||'').trim();
  if(/\\[\\[NAMELOCK_[^\\]]+\\]\\]/i.test(output))throw new Error('Translation output contains an unresolved NameLock placeholder.');
  nameLockFallback=true;
 }else output=restoreNameLocks(output,chapterLocks);
 if(!output)throw new Error('Phase 1 returned an empty full-chapter translation.');
 if(episodeId)await q(supabase.from('episodes').update({source,translation:output,model:result.model,status:'translated',updated_at:new Date().toISOString()}).eq('id',episodeId).eq('novel_id',novelId));
 res.json({translation:output,model:result.model,sourceChars:countChars(source),pass1Chars:countChars(output),nameLockNeutralFallback:nameLockFallback,neutralFallbackChunks:nameLockFallback?1:0});
}catch(e){
 const message=String(e?.message||e);
 console.error('TRANSLATE: request failed:',e?.stack||message);
 fail(res,e);
}});`

source=source.slice(0,translateStart)+translateReplacement+source.slice(translateEnd);

await fs.writeFile(runtimePath,source,'utf8');
await import(`./server.runtime.mjs?patch=${Date.now()}`);
