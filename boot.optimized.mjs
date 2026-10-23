import fs from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const originalPath = path.join(root, 'boot.mjs');
const patchedPath = path.join(root, '.boot.optimized.runtime.mjs');

let source = await fs.readFile(originalPath, 'utf8');

// Phase 1: use 12,000-character chunks everywhere the existing runtime patch
// hard-coded 7,000. Keep the existing paragraph-aware splitter and safety
// fallback behavior unchanged.
source = source.replaceAll('splitText(source,7000)', 'splitText(source,12000)');

// NameLock optimization: if validation fails for a chunk, do not spend two
// more NameLock attempts and do not restart the whole chapter. Re-run only
// that failed chunk once without NameLock, using the same stage/model.
const oldLockBlock = `if(!valid){\n              const mismatches=chunkLocks.map(x=>({token:x.token,expected:1,actual:countToken(output,x.token),sourceTerm:x.original})).filter(x=>x.actual!==1);\n              nameLockAttempts++;\n              console.warn('TRANSLATE: NameLock token mismatch for chunk '+(i+1)+'/'+workChunks.length+': '+JSON.stringify(mismatches));\n              if(nameLockAttempts<3){\n                console.warn('TRANSLATE: NameLock validation failed for chunk '+(i+1)+'/'+workChunks.length+'; real retry '+nameLockAttempts+'/3 in 3s.');\n                await sleep(3000);\n                continue;\n              }\n              throw new Error('NameLock validation failed after 3 actual translation attempts.');\n            }\n            output=restoreNameLocks(output,chunkLocks);`;
const newLockBlock = `if(!valid){\n              const mismatches=chunkLocks.map(x=>({token:x.token,expected:1,actual:countToken(output,x.token),sourceTerm:x.original})).filter(x=>x.actual!==1);\n              console.warn('TRANSLATE: NameLock validation failed for chunk '+(i+1)+'/'+workChunks.length+': '+JSON.stringify(mismatches)+'; re-running ONLY this chunk without NameLock.');\n              const natural=await generateModel(stage.ai,masterPrompt({\n                style:novel.style,glossary:chunkGlossary,locks:[],source:chunk,\n                previousTail:result.slice(-5000),sourceContext:previousSource\n              }),stage.model);\n              output=String(natural.text||'').trim();\n              if(!output)throw new Error('Translation model returned empty output during no-NameLock fallback.');\n              if(/\\[\\[NAMELOCK_[^\\]]+\\]\\]/i.test(output))throw new Error('Translation output unexpectedly contains a NameLock placeholder during no-NameLock fallback.');\n              modelUsed=natural.model;\n              providerUsed=stage.name;\n              console.warn('TRANSLATE: chunk '+(i+1)+'/'+workChunks.length+' recovered with natural translation without NameLock.');\n            }else{\n              output=restoreNameLocks(output,chunkLocks);\n            }`;
if(!source.includes(oldLockBlock)) {
  throw new Error('Could not locate the existing NameLock validation block in boot.mjs. No runtime changes were made.');
}
source = source.replace(oldLockBlock, newLockBlock);

// The whole-chapter NameLock restart is no longer needed. The chunk-level
// fallback above handles validation failures locally.
const oldChapterFallback = `  let result='';\n  try{\n    result=await runChunks(true);\n  }catch(e){\n    if(!isLock(e))throw e;\n    nameLockFallback=true;\n    console.warn('TRANSLATE: NameLock validation failed after 3 checks. Discarding partial chapter and restarting whole chapter without NameLock.');\n    result=await runChunks(false);\n  }`;
const newChapterFallback = `  let result='';\n  result=await runChunks(true);`;
if(!source.includes(oldChapterFallback)) {
  throw new Error('Could not locate the existing whole-chapter NameLock fallback in boot.mjs. No runtime changes were made.');
}
source = source.replace(oldChapterFallback, newChapterFallback);

await fs.writeFile(patchedPath, source, 'utf8');
await import(pathToFileURL(patchedPath).href + `?optimized=${Date.now()}`);
