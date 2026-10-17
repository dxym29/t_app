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
  const episodes=await q(supabase.from('episodes').select('*').eq('novel_id',novelId).order('number'));
  const templatePath=new URL('./templates/mm-novel-import-template.xlsx',import.meta.url);
  const template=await fs.readFile(templatePath);
  const wb=new ExcelJS.Workbook();
  await wb.xlsx.load(template);

  const ns=wb.getWorksheet('Novel');
  const cs=wb.getWorksheet('Chapters');
  const gs=wb.getWorksheet('Glossary');
  if(!ns||!cs||!gs)throw new Error('MM Novel template sheets are missing.');

  const fields=[
    ['title',excelValue(novel.name)],
    ['slug',slugify(novel.name)],
    ['originalTitle',''],
    ['author',''],
    ['description',''],
    ['coverUrl',''],
    ['sourceLanguage','zh'],
    ['translationGenre','general'],
    ['translationTone','natural'],
    ['translationNamePolicy','consistent'],
    ['translationInstructions',excelValue(novel.style)],
    ['status','ONGOING'],
    ['isPublished','false'],
    ['genres','']
  ];
  for(let i=0;i<fields.length;i++){ns.getCell(i+2,1).value=fields[i][0];ns.getCell(i+2,2).value=fields[i][1]}

  while(cs.rowCount>1)cs.spliceRows(2,1);
  for(const e of episodes){
    cs.addRow([e.number,excelValue(e.title),'zh',excelValue(e.source),excelValue(e.title),excelValue(e.translation),Boolean(String(e.translation||'').trim())]);
  }

  while(gs.rowCount>1)gs.spliceRows(2,1);
  for(const x of glossary){
    gs.addRow([excelValue(x.original),excelValue(x.translation),excelValue(x.type),excelValue(x.note),excelValue(x.voice)]);
  }

  return wb;
}`;

let patched=source.slice(0,start)+replacement+source.slice(end);
if(!patched.startsWith("import fs from 'node:fs/promises';"))patched="import fs from 'node:fs/promises';\n"+patched;
await fs.writeFile(runtimePath,patched,'utf8');
await import(`./server.runtime.mjs?excelTemplate=${Date.now()}`);
