import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

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
  for(const [index,e] of episodes.entries()){const chapterNo=Number(e.number);cs.addRow([Number.isSafeInteger(chapterNo)&&chapterNo>0?chapterNo:index+1,excelValue(e.title),'zh',excelValue(e.source),excelValue(e.title),excelValue(e.translation),Boolean(String(e.translation||'').trim())]);}
  [14,28,18,72,28,72,22].forEach((w,i)=>cs.getColumn(i+1).width=w);cs.freezePane='A2';cs.autoFilter='A1:G1';cs.getRow(1).height=28;cs.getRow(1).eachCell(c=>Object.assign(c,headerStyle));
  for(let r=2;r<=cs.rowCount;r++)cs.getRow(r).eachCell(c=>Object.assign(c,bodyStyle));

  const gs=wb.addWorksheet('Glossary');
  gs.addRow(['sourceTerm','translatedTerm','termType','note','characterVoice']);
  for(const x of glossary)gs.addRow([excelValue(x.original),excelValue(x.translation),excelValue(x.type),excelValue(x.note),excelValue(x.voice)]);
  [28,32,20,48,42].forEach((w,i)=>gs.getColumn(i+1).width=w);gs.freezePane='A2';gs.autoFilter='A1:E1';gs.getRow(1).height=28;gs.getRow(1).eachCell(c=>Object.assign(c,headerStyle));
  for(let r=2;r<=gs.rowCount;r++)gs.getRow(r).eachCell(c=>Object.assign(c,bodyStyle));

  return wb;
}`;

const patched=source.slice(0,start)+replacement+source.slice(end);
await fs.writeFile(runtimePath,patched,'utf8');
await import(`./server.runtime.mjs?excelTemplate=${Date.now()}`);
