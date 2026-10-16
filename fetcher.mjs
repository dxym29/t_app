import * as cheerio from 'cheerio';

function cleanText(s=''){
  return String(s).replace(/\u00a0/g,' ').replace(/[ \t]+/g,' ').replace(/\n[ \t]+/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
}
function sleep(ms){return new Promise(r=>setTimeout(r,ms))}
function looksLikeNovelPing(url){try{const u=new URL(url);return u.hostname==='novelping.com'||u.hostname.endsWith('.novelping.com')}catch{return false}}
function isChapterUrl(url){return /\/chapter-/i.test(new URL(url).pathname)}
function chapterNumberFromUrl(url){const m=String(url).match(/\/chapter-(\d+)/i);return m?Number(m[1]):null}
function extractHtml(html){
  const $=cheerio.load(html);
  const title=cleanText($('h1').first().text())||cleanText($('title').text());
  const selectors=['#chr-content','.chapter-content','.chapter__content','.chapter-text','.reading-content','.entry-content','.post-content','.text-content','[class*="chapter-content"]','[id*="chapter-content"]','article'];
  let best=null,bestLen=0;
  for(const selector of selectors)$(selector).each((_,node)=>{const len=cleanText($(node).text()).length;if(len>bestLen){bestLen=len;best=$(node)}});
  if(!best)return{title,source:''};
  best.find('script,style,noscript,nav,header,footer,button,form,aside,iframe,.js-ad-slot,.ads,.advertisement,[class*="ad-"]').remove();
  const ps=[];
  best.find('p').each((_,el)=>{const t=cleanText($(el).text());if(t.length>=2)ps.push(t)});
  const source=(ps.length>=2?ps.join('\n\n'):cleanText(best.text())).replace(/\n{3,}/g,'\n\n').trim();
  return{title,source};
}
async function fetchText(url,headers={},timeout=30000){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout);
  try{const response=await fetch(url,{headers,signal:controller.signal,redirect:'follow'});const text=await response.text();return{response,text};}
  finally{clearTimeout(timer)}
}
const headers={'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155 Safari/537.36','Accept':'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8','Accept-Language':'en-US,en;q=0.9'};
const jinaHeaders={'User-Agent':'Mozilla/5.0','Accept':'text/plain,text/html;q=0.9,*/*;q=0.8'};
async function fetchPage(url){
  for(let attempt=0;attempt<2;attempt++){
    try{const r=await fetchText(url,headers,15000);if(r.response.ok&&r.text.trim())return r;if([429,500,502,503,504].includes(r.response.status))await sleep(1500*(attempt+1));}catch{if(attempt===0)await sleep(1000)}
  }
  try{const r=await fetchText(`https://r.jina.ai/${url}`,jinaHeaders,20000);if(r.response.ok&&r.text.trim())return r;}catch{}
  return null;
}
async function fetchChapterDirect(url){
  let errors=[];
  for(let attempt=1;attempt<=3;attempt++){
    try{
      const{response,text}=await fetchText(url,headers,30000);
      if(response.ok){
        const p=extractHtml(text);
        if(p.source.length>=200)return{title:p.title,number:chapterNumberFromUrl(url),source:p.source,sourceChars:Array.from(p.source).length};
        errors.push('page reached but chapter text was not found');
      }else errors.push(`HTTP ${response.status}`);
      if(attempt<3)await sleep(2000*attempt);
    }catch(e){errors.push(String(e?.message||e));if(attempt<3)await sleep(2000*attempt)}
  }
  try{
    const{response,text}=await fetchText(`https://r.jina.ai/${url}`,jinaHeaders,30000);
    if(response.ok&&text.trim().length>=200){const p=extractHtml(text),source=p.source.length>=200?p.source:cleanText(text);if(source.length>=200)return{title:p.title||firstLine(text),number:chapterNumberFromUrl(url),source,sourceChars:Array.from(source).length}}
    errors.push(`Jina HTTP ${response.status}`);
  }catch(e){errors.push(`Jina ${String(e?.message||e)}`)}
  throw new Error(`Could not fetch this NovelPing chapter. ${errors.join('; ')}`);
}
function firstLine(text){return String(text||'').split('\n').map(cleanText).find(Boolean)||''}
function addLinksFromHtml(html,page,found){
  const $=cheerio.load(html);
  $('a[href]').each((_,el)=>{const href=$(el).attr('href');if(!href)return;try{const u=new URL(href,page),n=chapterNumberFromUrl(u.toString());if(n!==null&&looksLikeNovelPing(u.toString())){const clean=u.toString().split('#')[0];found.set(clean,{url:clean,number:n,title:cleanText($(el).attr('title')||$(el).text())||`Chapter ${n}`})}}catch{}});
  const raw=String(html);
  for(const m of raw.matchAll(/\/book\/[^"'\s<>?#]+\/chapter-(\d+)(?:[^"'\s<>#]*)?/gi)){
    try{const u=new URL(m[0],page),n=Number(m[1]),clean=u.toString().split('#')[0];found.set(clean,{url:clean,number:n,title:`Chapter ${n}`})}catch{}
  }
}
function novelSlugFromUrl(url){
  const parts=new URL(url).pathname.split('/').filter(Boolean);
  const i=parts.findIndex(x=>x==='book'||x==='novel');
  return i>=0&&parts[i+1]?parts[i+1]:null;
}
function addArchiveLinks(html,page,found){
  const $=cheerio.load(html);
  // NovelPing returns its archive inside a <template data-chapter-item-template>.
  // Cheerio does not reliably expose template.content like a browser DOM, so parse
  // the template HTML explicitly as well as the normal document.
  $('template').each((_,tpl)=>{
    const inner=$(tpl).html()||'';
    const t$=cheerio.load(inner);
    t$('a[href]').each((__,el)=>{
      const href=t$(el).attr('href');if(!href)return;
      try{
        const u=new URL(href,page),n=chapterNumberFromUrl(u.toString());
        if(n===null||!looksLikeNovelPing(u.toString()))return;
        const clean=u.toString().split('#')[0];
        found.set(clean,{url:clean,number:n,title:cleanText(t$(el).attr('title')||t$(el).text())||`Chapter ${n}`});
      }catch{}
    });
  });
  $('li[data-chapter-item] a[href],.list-chapter li a[href],.chapter-list a[href],a[href]').each((_,el)=>{
    const href=$(el).attr('href');if(!href)return;
    try{
      const u=new URL(href,page),n=chapterNumberFromUrl(u.toString());
      if(n===null||!looksLikeNovelPing(u.toString()))return;
      const clean=u.toString().split('#')[0];
      found.set(clean,{url:clean,number:n,title:cleanText($(el).attr('title')||$(el).text())||`Chapter ${n}`});
    }catch{}
  });
}
async function fetchAjaxArchive(seriesUrl,found){
  const page=await fetchPage(seriesUrl);if(!page)return null;
  // IMPORTANT: NovelPing expects the novel SLUG here, not a numeric database ID.
  // Example: /book/shadow-slave -> novelId=shadow-slave
  const slug=novelSlugFromUrl(seriesUrl);if(!slug)return null;
  const base=new URL(seriesUrl).origin;
  const archiveUrl=`${base}/ajax/chapter-archive?novelId=${encodeURIComponent(slug)}`;
  for(let attempt=1;attempt<=3;attempt++){
    try{
      const r=await fetchText(archiveUrl,{...headers,'Referer':seriesUrl,'X-Requested-With':'XMLHttpRequest'},20000);
      if(r.response.ok&&r.text.trim()){
        addArchiveLinks(r.text,seriesUrl,found);
        console.log(`NovelPing archive ${slug}: ${found.size} chapters discovered.`);
        if(found.size)return{slug,count:found.size};
      }
      if(attempt<3)await sleep(1500*attempt);
    }catch{}
  }
  try{
    const r=await fetchText(`https://r.jina.ai/${archiveUrl}`,jinaHeaders,20000);
    if(r.response.ok&&r.text.trim()){addArchiveLinks(r.text,seriesUrl,found);if(found.size)return{slug,count:found.size}}
  }catch{}
  return null;
}
function chapterNavigationLinks(html,page,currentNumber){
  const $=cheerio.load(html),out=new Set();
  const add=(href)=>{if(!href)return;try{const u=new URL(href,page),n=chapterNumberFromUrl(u.toString());if(n!==null&&looksLikeNovelPing(u.toString()))out.add(u.toString().split('#')[0])}catch{}};
  $('[data-chapter-nav]').each((_,el)=>{const nav=String($(el).attr('data-chapter-nav')||'').toLowerCase();const href=$(el).attr('href')||$(el).attr('data-chapter-url')||$(el).attr('data-url');if(/prev|previous|next|older|newer/.test(nav))add(href)});
  $('a[href]').each((_,el)=>{const href=$(el).attr('href');if(!href)return;const text=cleanText($(el).text()).toLowerCase(),rel=String($(el).attr('rel')||'').toLowerCase(),aria=String($(el).attr('aria-label')||'').toLowerCase(),title=String($(el).attr('title')||'').toLowerCase(),cls=String($(el).attr('class')||'').toLowerCase(),nav=String($(el).attr('data-chapter-nav')||'').toLowerCase();if(rel.includes('prev')||rel.includes('next')||/\b(previous|prev|older|newer|next)\b/i.test(`${text} ${aria} ${title} ${cls} ${nav}`)||/\bchapter\b/i.test(text))add(href)});
  if(Number.isFinite(currentNumber))$('a[href]').each((_,el)=>{const href=$(el).attr('href');if(!href)return;try{const u=new URL(href,page),n=chapterNumberFromUrl(u.toString());if(n!==null&&Math.abs(n-currentNumber)<=2)add(href)}catch{}});
  return[...out];
}
function paginationLinks(html,page){
  const $=cheerio.load(html),base=new URL(page),out=new Set();
  $('a[href]').each((_,el)=>{const href=$(el).attr('href');if(!href)return;const text=cleanText($(el).text()).toLowerCase(),rel=String($(el).attr('rel')||'').toLowerCase();try{const u=new URL(href,base);if(u.hostname!==base.hostname)return;const s=u.toString();if(text.includes('next')||rel.includes('next')||/[?&](page|paged)=\d+/i.test(u.search)||/\/page\/\d+\/?$/i.test(u.pathname))out.add(s)}catch{}});
  return[...out];
}
async function discoverSeries(url){
  const found=new Map();
  // Primary source: NovelPing's own chapter archive. This is the authoritative
  // chapter list and avoids relying on the ~30 links rendered in the book page.
  const ajax=await fetchAjaxArchive(url,found);
  if(ajax&&found.size){
    console.log(`NovelPing series discovery complete from archive: ${found.size} chapters.`);
    return[...found.values()].sort((a,b)=>a.number-b.number||a.url.localeCompare(b.url));
  }

  // Fallback only if the archive endpoint is unavailable.
  const seenPages=new Set(),queue=[url];
  while(queue.length&&seenPages.size<100){
    const page=queue.shift();if(seenPages.has(page))continue;seenPages.add(page);
    const r=await fetchPage(page);if(!r)continue;
    addLinksFromHtml(r.text,page,found);
    for(const next of paginationLinks(r.text,page))if(!seenPages.has(next))queue.push(next);
  }
  if(!found.size)throw new Error('NovelPing did not expose chapter pages to the server. Try a direct chapter URL first.');

  const chapterQueue=[...found.values()].map(x=>x.url),chapterSeen=new Set();
  let rounds=0;
  while(chapterQueue.length&&chapterSeen.size<650&&rounds<100){
    const batch=[];
    while(chapterQueue.length&&batch.length<6){const p=chapterQueue.shift();if(!chapterSeen.has(p)){chapterSeen.add(p);batch.push(p)}}
    const pages=await Promise.all(batch.map(async page=>({page,r:await fetchPage(page)})));
    for(const{page,r}of pages){if(!r)continue;const current=chapterNumberFromUrl(page);addLinksFromHtml(r.text,page,found);for(const next of chapterNavigationLinks(r.text,page,current))if(!chapterSeen.has(next)&&!chapterQueue.includes(next))chapterQueue.push(next)}
    rounds++;
  }
  return[...found.values()].sort((a,b)=>a.number-b.number||a.url.localeCompare(b.url));
}
export async function fetchNovelPingChapter(url){
  if(!looksLikeNovelPing(url))throw new Error('For the first version, only NovelPing URLs are supported.');
  const u=new URL(url);
  if(isChapterUrl(url))return fetchChapterDirect(u.toString());
  const chapters=await discoverSeries(u.toString());
  return{series:true,title:cleanText(u.pathname.split('/').filter(Boolean).pop()||'NovelPing Series'),number:null,chapters,chapterCount:chapters.length};
}
