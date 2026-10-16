import * as cheerio from 'cheerio';

function cleanText(s=''){
  return String(s).replace(/\u00a0/g,' ').replace(/[ \t]+/g,' ').replace(/\n[ \t]+/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
}
function looksLikeNovelPing(url){try{const u=new URL(url);return u.hostname==='novelping.com'||u.hostname.endsWith('.novelping.com')}catch{return false}}
function isChapterUrl(url){return /\/chapter-/i.test(new URL(url).pathname)}
function chapterNumberFromUrl(url){const m=String(url).match(/\/chapter-(\d+)/i);return m?Number(m[1]):null}
function extractHtml(html){
  const $=cheerio.load(html);
  const title=cleanText($('h1').first().text())||cleanText($('title').text());
  const selectors=['.chapter-content','.chapter__content','.chapter-text','.reading-content','.entry-content','.post-content','.text-content','[class*="chapter-content"]','[id*="chapter-content"]','article'];
  let best=null,bestLen=0;
  for(const selector of selectors)$(selector).each((_,node)=>{const len=cleanText($(node).text()).length;if(len>bestLen){bestLen=len;best=$(node)}});
  if(!best)return{title,source:''};
  best.find('script,style,noscript,nav,header,footer,button,form,aside,iframe,.ads,.advertisement,[class*="ad-"]').remove();
  const ps=[];
  best.find('p').each((_,el)=>{const t=cleanText($(el).text());if(t.length>=2)ps.push(t)});
  const source=(ps.length>=2?ps.join('\n\n'):cleanText(best.text())).replace(/\n{3,}/g,'\n\n').trim();
  return{title,source};
}
async function fetchText(url,headers={},timeout=20000){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout);
  try{const response=await fetch(url,{headers,signal:controller.signal,redirect:'follow'});const text=await response.text();return{response,text};}
  finally{clearTimeout(timer)}
}
const headers={'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155 Safari/537.36','Accept':'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8','Accept-Language':'en-US,en;q=0.9','X-Requested-With':'XMLHttpRequest'};
const jinaHeaders={'User-Agent':'Mozilla/5.0','Accept':'text/plain,text/html;q=0.9,*/*;q=0.8'};
async function fetchPage(url){
  try{const r=await fetchText(url,headers,12000);if(r.response.ok&&r.text.trim())return r;}catch{}
  try{const r=await fetchText(`https://r.jina.ai/${url}`,jinaHeaders,12000);if(r.response.ok&&r.text.trim())return r;}catch{}
  return null;
}
async function fetchChapterDirect(url){
  let err='';
  try{const{response,text}=await fetchText(url,headers);if(response.ok){const p=extractHtml(text);if(p.source.length>=200)return{title:p.title,number:chapterNumberFromUrl(url),source:p.source,sourceChars:Array.from(p.source).length};err='page reached but chapter text was not found.'}else err=`NovelPing returned HTTP ${response.status}.`;}catch(e){err=String(e?.message||e)}
  try{const{response,text}=await fetchText(`https://r.jina.ai/${url}`,jinaHeaders);if(response.ok&&text.trim().length>=200){const p=extractHtml(text),source=p.source.length>=200?p.source:cleanText(text);if(source.length>=200)return{title:p.title||firstLine(text),number:chapterNumberFromUrl(url),source,sourceChars:Array.from(source).length}}}catch(e){err+=` Fallback: ${String(e?.message||e)}`}
  throw new Error(`Could not fetch this NovelPing chapter. ${err}`);
}
function firstLine(text){return String(text||'').split('\n').map(cleanText).find(Boolean)||''}
function addLinksFromHtml(html,page,found){
  const $=cheerio.load(html);
  $('a[href]').each((_,el)=>{const href=$(el).attr('href');if(!href)return;try{const u=new URL(href,page),n=chapterNumberFromUrl(u.toString());if(n!==null&&looksLikeNovelPing(u.toString())){const clean=u.toString().split('#')[0];found.set(clean,{url:clean,number:n,title:cleanText($(el).text())||`Chapter ${n}`})}}catch{}});
  const raw=String(html);
  for(const m of raw.matchAll(/\/book\/[^"'\s<>?#]+\/chapter-(\d+)(?:[^"'\s<>#]*)?/gi)){
    try{const u=new URL(m[0],page),n=Number(m[1]),clean=u.toString().split('#')[0];found.set(clean,{url:clean,number:n,title:`Chapter ${n}`})}catch{}
  }
}
function extractNovelId(html){
  const $=cheerio.load(html);
  const selectors=['[data-novel-id]','#rating[data-novel-id]','[data-book-id]'];
  for(const selector of selectors){const el=$(selector).first();if(el.length){const id=el.attr('data-novel-id')||el.attr('data-book-id');if(id&&/^\d+$/.test(String(id)))return String(id)}}
  const raw=String(html);
  const patterns=[/data-novel-id=["'](\d+)["']/i,/data-book-id=["'](\d+)["']/i,/novelId["']?\s*[:=]\s*["']?(\d+)/i,/novel_id["']?\s*[:=]\s*["']?(\d+)/i];
  for(const re of patterns){const m=raw.match(re);if(m)return m[1]}
  return null;
}
function addArchiveLinks(html,page,found){
  const $=cheerio.load(html);
  const selectors=['li[data-chapter-item] a[href]','.list-chapter li a[href]','.chapter-list a[href]','a[href]'];
  for(const selector of selectors){
    $(selector).each((_,el)=>{
      const href=$(el).attr('href');if(!href)return;
      try{
        const u=new URL(href,page),n=chapterNumberFromUrl(u.toString());
        if(n===null||!looksLikeNovelPing(u.toString()))return;
        const clean=u.toString().split('#')[0];
        found.set(clean,{url:clean,number:n,title:cleanText($(el).text())||`Chapter ${n}`});
      }catch{}
    });
    if(found.size)break;
  }
  addLinksFromHtml(html,page,found);
}
async function fetchAjaxArchive(seriesUrl,found){
  const page=await fetchPage(seriesUrl);if(!page)return null;
  const novelId=extractNovelId(page.text);if(!novelId)return null;
  const base=new URL(seriesUrl).origin;
  const archiveUrl=`${base}/ajax/chapter-archive?novelId=${encodeURIComponent(novelId)}`;
  try{
    const r=await fetchText(archiveUrl,{...headers,'Referer':seriesUrl,'X-Requested-With':'XMLHttpRequest'},15000);
    if(r.response.ok&&r.text.trim()){
      addArchiveLinks(r.text,seriesUrl,found);
      if(found.size>=100){console.log(`NovelPing AJAX archive found ${found.size} chapters (novelId ${novelId}).`);return{novelId,count:found.size}}
    }
  }catch{}
  try{
    const r=await fetchText(`https://r.jina.ai/${archiveUrl}`,jinaHeaders,15000);
    if(r.response.ok&&r.text.trim()){
      addArchiveLinks(r.text,seriesUrl,found);
      if(found.size>=100)return{novelId,count:found.size}
    }
  }catch{}
  return found.size?{novelId,count:found.size}:null;
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
  // Primary method: NovelPing's chapter archive AJAX endpoint, which contains
  // the complete chapter list instead of only the first ~30 links in page HTML.
  const ajax=await fetchAjaxArchive(url,found);
  if(ajax&&found.size>=100){
    return[...found.values()].sort((a,b)=>a.number-b.number||a.url.localeCompare(b.url));
  }

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
    while(chapterQueue.length&&batch.length<12){const p=chapterQueue.shift();if(!chapterSeen.has(p)){chapterSeen.add(p);batch.push(p)}}
    if(!batch.length)break;
    const pages=await Promise.all(batch.map(async page=>({page,r:await fetchPage(page)})));
    for(const{page,r}of pages){
      if(!r)continue;
      const current=chapterNumberFromUrl(page);addLinksFromHtml(r.text,page,found);
      for(const next of chapterNavigationLinks(r.text,page,current))if(!chapterSeen.has(next)&&!chapterQueue.includes(next))chapterQueue.push(next);
    }
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
