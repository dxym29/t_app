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

const headers={'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155 Safari/537.36','Accept':'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8','Accept-Language':'en-US,en;q=0.9'};
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
  $('a[href]').each((_,el)=>{
    const href=$(el).attr('href');if(!href)return;
    try{const u=new URL(href,page),n=chapterNumberFromUrl(u.toString());if(n!==null){const clean=u.toString().split('#')[0];found.set(clean,{url:clean,number:n,title:cleanText($(el).text())||`Chapter ${n}`})}}catch{}
  });
  const raw=String(html);
  for(const m of raw.matchAll(/\/book\/[^"'\s<>?#]+\/chapter-(\d+)(?:[^"'\s<>#]*)?/gi)){
    try{const u=new URL(m[0],page),n=Number(m[1]),clean=u.toString().split('#')[0];found.set(clean,{url:clean,number:n,title:`Chapter ${n}`})}catch{}
  }
}

function chapterNavigationLinks(html,page,currentNumber){
  const $=cheerio.load(html),out=new Set();
  $('a[href]').each((_,el)=>{
    const href=$(el).attr('href');if(!href)return;
    const text=cleanText($(el).text()).toLowerCase();
    const rel=String($(el).attr('rel')||'').toLowerCase();
    try{
      const u=new URL(href,page);if(u.hostname!=='novelping.com'&&!u.hostname.endsWith('.novelping.com'))return;
      const n=chapterNumberFromUrl(u.toString());if(n===null)return;
      if(
        rel.includes('prev')||rel.includes('next')||
        /\b(previous|prev|older|newer|next|chapter)\b/i.test(text)
      )out.add(u.toString().split('#')[0]);
    }catch{}
  });
  // Some NovelPing pages use icon-only previous/next links, so also keep
  // chapter links whose number is close to the current chapter.
  if(Number.isFinite(currentNumber)){
    $('a[href]').each((_,el)=>{
      const href=$(el).attr('href');if(!href)return;
      try{
        const u=new URL(href,page),n=chapterNumberFromUrl(u.toString());
        if(n!==null&&Math.abs(n-currentNumber)<=2)out.add(u.toString().split('#')[0]);
      }catch{}
    });
  }
  return[...out];
}

function paginationLinks(html,page){
  const $=cheerio.load(html),base=new URL(page),out=new Set();
  $('a[href]').each((_,el)=>{const href=$(el).attr('href');if(!href)return;const text=cleanText($(el).text()).toLowerCase(),rel=String($(el).attr('rel')||'').toLowerCase();try{const u=new URL(href,base);if(u.hostname!==base.hostname)return;const s=u.toString();if(text.includes('next')||rel.includes('next')||/[?&](page|paged)=\d+/i.test(u.search)||/\/page\/\d+\/?$/i.test(u.pathname))out.add(s)}catch{}});
  return[...out];
}

async function discoverSeries(url){
  const found=new Map();
  const seenPages=new Set();
  const queue=[url];

  // First collect the chapter links shown by the series page and any normal pagination.
  while(queue.length&&seenPages.size<100){
    const page=queue.shift();if(seenPages.has(page))continue;seenPages.add(page);
    const r=await fetchPage(page);if(!r)continue;
    addLinksFromHtml(r.text,page,found);
    for(const next of paginationLinks(r.text,page))if(!seenPages.has(next))queue.push(next);
  }

  if(!found.size)throw new Error('NovelPing did not expose chapter pages to the server. Try a direct chapter URL first.');

  // IMPORTANT: NovelPing chapter URLs contain a title slug after the number,
  // e.g. /chapter-509-side-story-1-... . Therefore /chapter-477 is NOT a safe
  // URL to guess. We follow the real Previous/Next chapter links instead.
  const chapterQueue=[...found.values()].map(x=>x.url);
  const chapterSeen=new Set();
  let rounds=0;
  while(chapterQueue.length&&chapterSeen.size<650&&rounds<80){
    const batch=[];
    while(chapterQueue.length&&batch.length<12){
      const p=chapterQueue.shift();
      if(!chapterSeen.has(p)){chapterSeen.add(p);batch.push(p)}
    }
    if(!batch.length)break;
    const pages=await Promise.all(batch.map(async page=>({page,r:await fetchPage(page)})));
    for(const{page,r}of pages){
      if(!r)continue;
      const current=chapterNumberFromUrl(page);
      addLinksFromHtml(r.text,page,found);
      for(const next of chapterNavigationLinks(r.text,page,current)){
        if(!chapterSeen.has(next)&&!chapterQueue.includes(next))chapterQueue.push(next);
      }
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
