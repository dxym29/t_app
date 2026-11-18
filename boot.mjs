import fs from 'node:fs/promises';
import { fileURLToPath } from 'url';
import path from 'path';

const root=path.dirname(fileURLToPath(import.meta.url));
const sourcePath=path.join(root,'server.mjs');
const runtimePath=path.join(root,'server.runtime.mjs');
let source=await fs.readFile(sourcePath,'utf8');

// Excel export is maintained directly in server.mjs; do not replace its paginated builder.

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

await fs.writeFile(runtimePath,source,'utf8');
await import(`./server.runtime.mjs?patch=${Date.now()}`);
