import * as cheerio from 'cheerio';

function cleanText(s=''){
  return String(s).replace(/\u00a0/g,' ').replace(/[ \t]+/g,' ').replace(/\n[ \t]+/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
}
function sleep(ms){return new Promise(r=>setTimeout(r,ms))}
function looksLikeNovelPing(url){try{const u=new URL(url);return u.hostname==='novelping.com'||u.hostname.endsWith('.novelping.com')}catch{return false}}
function isChapterUrl(url){try{return /\/chapter-/i.test(new URL(url).pathname)}catch{return false}}
function chapterNumberFromUrl(url){const m=String(url).match(/\/chapter-(\d+)/i);return m?Number(m[1]):null}
function firstLine(text){return String(text||'').split('\n').map(cleanText).find(Boolean)||''}
function novelSlugFromUrl(url){
  const parts=new URL(url).pathname.split('/').filter(Boolean);
  const i=parts.findIndex(x=>x==='book'||x==='novel');
  return i>=0&&parts[i+1]?parts[i+1]:null;
}

function extractHtml(html){
  const $=cheerio.load(html);
  const title=cleanText($('h2 .chr-text').first().text())||cleanText($('h1').first().text())||cleanText($('title').text());
  const selectors=['#chr-content','#chapter-content','.chapter-content','.chapter__content','.chapter-text','.reading-content','.entry-content','.post-content','.text-content','[class*="chapter-content"]','[id*="chapter-content"]','article'];
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
  try{const response=await fetch(url,{headers,signal:controller.signal,redirect:'follow'});const text=await response.text();return{response,text}}
  finally{clearTimeout(timer)}
}

const headers={
  'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155 Safari/537.36',
  'Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language':'en-US,en;q=0.9',
  'Cache-Control':'no-cache',
};
const jinaHeaders={'User-Agent':'Mozilla/5.0','Accept':'text/plain,text/html;q=0.9,*/*;q=0.8'};

async function fetchPage(url,cookie=''){
  for(let attempt=0;attempt<2;attempt++){
    try{
      const r=await fetchText(url,{...headers,...(cookie?{Cookie:cookie}:{})},15000);
      if(r.response.ok&&r.text.trim()){
        const setCookie=r.response.headers.get('set-cookie')||'';
        return{...r,cookie:setCookie||cookie};
      }
      if([429,500,502,503,504].includes(r.response.status))await sleep(1200*(attempt+1));
    }catch{if(attempt===0)await sleep(1000)}
  }
  try{
    const r=await fetchText(`https://r.jina.ai/${url}`,jinaHeaders,20000);
    if(r.response.ok&&r.text.trim())return{...r,cookie};
  }catch{}
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
    }catch(e){errors.push(String(e?.message||e))}
    if(attempt<3)await sleep(1800*attempt);
  }
  try{
    const{response,text}=await fetchText(`https://r.jina.ai/${url}`,jinaHeaders,30000);
    if(response.ok&&text.trim().length>=200){
      const p=extractHtml(text),source=p.source.length>=200?p.source:cleanText(text);
      if(source.length>=200)return{title:p.title||firstLine(text),number:chapterNumberFromUrl(url),source,sourceChars:Array.from(source).length};
    }
    errors.push(`Jina HTTP ${response.status}`);
  }catch(e){errors.push(`Jina ${String(e?.message||e)}`)}
  throw new Error(`Could not fetch this NovelPing chapter. ${errors.join('; ')}`);
}

function addChapter(found,url,title=''){
  try{
    const u=new URL(url);
    if(!looksLikeNovelPing(u.toString()))return;
    const clean=u.toString().split('#')[0];
    const n=chapterNumberFromUrl(clean);
    if(n===null)return;
    const t=cleanText(title)||`Chapter ${n}`;
    const old=found.get(clean);
    if(!old||t.length>old.title.length)found.set(clean,{url:clean,number:n,title:t});
  }catch{}
}

function decodeHtml(s){
  return String(s||'').replace(/&quot;/gi,'"').replace(/&#34;/g,'"').replace(/&#39;/g,"'").replace(/&amp;/gi,'&').replace(/\\\//g,'/');
}

function addLinksFromHtml(html,page,found){
  const raw=decodeHtml(html);
  const $=cheerio.load(raw);
  $('a[href]').each((_,el)=>addChapter(found,$(el).attr('href'),$(el).attr('title')||$(el).text()));
  // Also inspect raw HTML/JSON because chapter links may be inside scripts or templates.
  for(const m of raw.matchAll(/(?:https?:\/\/novelping\.com)?\/book\/[^"'<>\\\s]+\/chapter-\d+[^"'<>\\\s]*/gi))addChapter(found,m[0],`Chapter ${chapterNumberFromUrl(m[0])}`);
}

function addArchiveLinks(html,page,found){
  const raw=decodeHtml(html);
  const $=cheerio.load(raw);
  const template=$('template[data-chapter-item-template]').first();
  if(template.length){
    const inner=template.html()||'';
    const t$=cheerio.load(inner);
    t$('a[href]').each((_,el)=>addChapter(found,t$(el).attr('href'),t$(el).attr('title')||t$('.nchr-text',el).text()||t$(el).text()));
  }
  // Fallback/extra pass: parse every chapter href in the whole archive response.
  $('a[href]').each((_,el)=>addChapter(found,$(el).attr('href'),$(el).attr('title')||$('.nchr-text',el).text()||$(el).text()));
  for(const m of raw.matchAll(/(?:https?:\/\/novelping\.com)?\/book\/[^"'<>\\\s]+\/chapter-\d+[^"'<>\\\s]*/gi))addChapter(found,m[0]);
}

async function fetchAjaxArchive(seriesUrl,found){
  const page=await fetchPage(seriesUrl);
  const slug=novelSlugFromUrl(seriesUrl);
  if(!slug)return{count:0,method:'no-slug',page};
  const base=new URL(seriesUrl).origin;
  const archiveUrl=`${base}/ajax/chapter-archive?novelId=${encodeURIComponent(slug)}`;
  const candidates=[];
  const pageFound=new Map();
  if(page){addArchiveLinks(page.text,seriesUrl,pageFound);addLinksFromHtml(page.text,seriesUrl,pageFound)}
  candidates.push({label:'book-page',map:pageFound,textLength:page?.text?.length||0});

  for(let attempt=1;attempt<=3;attempt++){
    try{
      const cookie=page?.cookie||'';
      const r=await fetchText(archiveUrl,{...headers,'Referer':seriesUrl,'X-Requested-With':'XMLHttpRequest','Sec-Fetch-Dest':'empty','Sec-Fetch-Mode':'cors','Sec-Fetch-Site':'same-origin',...(cookie?{Cookie:cookie}:{})},25000);
      const map=new Map();
      if(r.response.ok&&r.text.trim()){
        addArchiveLinks(r.text,seriesUrl,map);
        addLinksFromHtml(r.text,seriesUrl,map);
        candidates.push({label:`ajax-${attempt}`,map,textLength:r.text.length,status:r.response.status});
      }
      if(r.response.ok&&map.size)break;
    }catch{}
    if(attempt<3)await sleep(1200*attempt);
  }

  try{
    const r=await fetchText(`https://r.jina.ai/${archiveUrl}`,jinaHeaders,25000);
    const map=new Map();
    if(r.response.ok&&r.text.trim()){
      addArchiveLinks(r.text,seriesUrl,map);addLinksFromHtml(r.text,seriesUrl,map);
      candidates.push({label:'jina-archive',map,textLength:r.text.length,status:r.response.status});
    }
  }catch{}

  candidates.sort((a,b)=>b.map.size-a.map.size);
  const best=candidates[0];
  if(best)for(const x of best.map.values())found.set(x.url,x);
  return{count:found.size,method:best?.label||'none',slug,archiveUrl,archiveChars:best?.textLength||0};
}

function chapterNavigationLinks(html,page,currentNumber){
  const raw=decodeHtml(html),$=cheerio.load(raw),out=new Set();
  const add=href=>{if(!href)return;try{const u=new URL(href,page),n=chapterNumberFromUrl(u.toString());if(n!==null&&looksLikeNovelPing(u.toString()))out.add(u.toString().split('#')[0])}catch{}};
  $('a[href]').each((_,el)=>{
    const href=$(el).attr('href');
    const text=cleanText($(el).text()).toLowerCase();
    const attrs=`${$(el).attr('rel')||''} ${$(el).attr('aria-label')||''} ${$(el).attr('title')||''} ${$(el).attr('class')||''} ${$(el).attr('data-chapter-nav')||''}`.toLowerCase();
    if(/\b(prev|previous|next|older|newer)\b/.test(`${text} ${attrs}`)||/chapter-\d+/i.test(href||''))add(href);
  });
  // JS/HTML attributes sometimes contain the navigation URLs without <a> tags.
  for(const m of raw.matchAll(/(?:https?:\/\/novelping\.com)?\/book\/[^"'<>\\\s]+\/chapter-\d+[^"'<>\\\s]*/gi))add(m[0]);
  return[...out];
}

function discoveryStats(chapters){
  const nums=[...new Set(chapters.map(x=>Number(x.number)).filter(Number.isFinite))].sort((a,b)=>a-b);
  let gaps=0,largestGap=0;
  for(let i=1;i<nums.length;i++){const gap=nums[i]-nums[i-1]-1;if(gap>0){gaps+=gap;largestGap=Math.max(largestGap,gap)}}
  return{count:chapters.length,min:nums[0]??null,max:nums[nums.length-1]??null,gaps,largestGap};
}

async function discoverSeries(url){
  const found=new Map();
  const archive=await fetchAjaxArchive(url,found);
  let method=archive.method;

  // If the archive is unexpectedly small, crawl the discovered chapter graph.
  // This is intentionally a fallback, not a DB operation and not an import.
  if(found.size<100){
    const queue=[...found.values()].map(x=>x.url),seen=new Set();
    let rounds=0;
    while(queue.length&&seen.size<250&&rounds<80){
      const batch=[];
      while(queue.length&&batch.length<6){const p=queue.shift();if(!seen.has(p)){seen.add(p);batch.push(p)}}
      const pages=await Promise.all(batch.map(async page=>({page,r:await fetchPage(page)})));
      for(const{page,r}of pages){
        if(!r)continue;
        const before=found.size;
        addLinksFromHtml(r.text,page,found);
        const current=chapterNumberFromUrl(page);
        for(const next of chapterNavigationLinks(r.text,page,current))if(!seen.has(next)&&!queue.includes(next))queue.push(next);
        if(found.size>before)method=`${method}+chapter-graph`;
      }
      rounds++;
    }
  }

  if(!found.size)throw new Error('NovelPing did not expose chapter pages to the server. Try a direct chapter URL first.');
  const chapters=[...found.values()].sort((a,b)=>a.number-b.number||a.url.localeCompare(b.url));
  const stats=discoveryStats(chapters);
  return{chapters,stats,method,archiveChars:archive.archiveChars||0,archiveUrl:archive.archiveUrl||null};
}

export async function fetchNovelPingChapter(url){
  if(!looksLikeNovelPing(url))throw new Error('For this importer, only NovelPing URLs are supported.');
  const u=new URL(url);
  if(isChapterUrl(url))return fetchChapterDirect(u.toString());
  const result=await discoverSeries(u.toString());
  return{
    series:true,
    title:cleanText(u.pathname.split('/').filter(Boolean).pop()||'NovelPing Series'),
    number:null,
    chapters:result.chapters,
    chapterCount:result.chapters.length,
    discovery:result.stats,
    discoveryMethod:result.method,
    archiveChars:result.archiveChars
  };
}
