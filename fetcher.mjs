import * as cheerio from 'cheerio';

function cleanText(s=''){
  return String(s)
    .replace(/\u00a0/g,' ')
    .replace(/[ \t]+/g,' ')
    .replace(/\n[ \t]+/g,'\n')
    .replace(/\n{3,}/g,'\n\n')
    .trim();
}

function looksLikeNovelPing(url){
  try{
    const u=new URL(url);
    return u.hostname==='novelping.com'||u.hostname.endsWith('.novelping.com');
  }catch{return false;}
}

function isChapterUrl(url){
  return /\/chapter-/i.test(new URL(url).pathname);
}

function chapterNumberFromUrl(url){
  const m=String(url).match(/\/chapter-(\d+)/i);
  return m?Number(m[1]):null;
}

function extractHtml(html){
  const $=cheerio.load(html);
  const title=cleanText($('h1').first().text()) || cleanText($('title').text());
  const candidates=[
    '.chapter-content','.chapter-content p','.chapter__content','.chapter-text',
    '.reading-content','.entry-content','.post-content','.text-content',
    '[class*="chapter-content"]','[id*="chapter-content"]','article'
  ];
  let best=null,bestLen=0;
  for(const selector of candidates){
    $(selector).each((_,node)=>{
      const len=cleanText($(node).text()).length;
      if(len>bestLen){bestLen=len;best=$(node);}
    });
  }
  if(!best){
    const heading=$('h1').first();
    if(heading.length){
      const article=heading.closest('article');
      if(article.length&&cleanText(article.text()).length>200)best=article;
    }
  }
  if(!best)return {title,source:''};
  best.find('script,style,noscript,nav,header,footer,button,form,aside,iframe,.ads,.advertisement,[class*="ad-"]').remove();
  const paragraphs=[];
  best.find('p').each((_,el)=>{
    const t=cleanText($(el).text());
    if(t.length>=2)paragraphs.push(t);
  });
  let source=paragraphs.length>=2?paragraphs.join('\n\n'):cleanText(best.text());
  source=source.replace(/\n{3,}/g,'\n\n').trim();
  return {title,source};
}

function extractSeriesLinks(html,baseUrl){
  const $=cheerio.load(html);
  const base=new URL(baseUrl);
  const found=new Map();
  $('a[href]').each((_,el)=>{
    const href=$(el).attr('href');
    if(!href)return;
    try{
      const u=new URL(href,base);
      if(u.hostname!==base.hostname) return;
      if(!/\/book\//i.test(u.pathname)||!/\/chapter-/i.test(u.pathname))return;
      const n=chapterNumberFromUrl(u.toString());
      if(n===null)return;
      const title=cleanText($(el).text())||`Chapter ${n}`;
      found.set(u.toString().split('#')[0],{url:u.toString().split('#')[0],number:n,title});
    }catch{}
  });
  return [...found.values()];
}

function paginationLinks(html,baseUrl){
  const $=cheerio.load(html),base=new URL(baseUrl),out=[];
  $('a[href]').each((_,el)=>{
    const href=$(el).attr('href');
    if(!href)return;
    const text=cleanText($(el).text()).toLowerCase();
    const rel=String($(el).attr('rel')||'').toLowerCase();
    if(!(text==='next'||text.includes('next')||rel.includes('next')))return;
    try{
      const u=new URL(href,base);
      if(u.hostname===base.hostname)out.push(u.toString());
    }catch{}
  });
  return [...new Set(out)];
}

async function fetchText(url,headers={}){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),20000);
  try{
    const response=await fetch(url,{headers,signal:controller.signal,redirect:'follow'});
    const text=await response.text();
    return {response,text};
  }finally{clearTimeout(timer);}
}

const headers={
  'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155 Safari/537.36',
  'Accept':'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
  'Accept-Language':'en-US,en;q=0.9'
};

async function fetchChapterDirect(url){
  let directError='';
  try{
    const {response,text}=await fetchText(url,headers);
    if(response.ok){
      const parsed=extractHtml(text);
      if(parsed.source.length>=200)return {title:parsed.title,number:chapterNumberFromUrl(url),source:parsed.source,sourceChars:Array.from(parsed.source).length};
      directError='NovelPing page was reached, but no chapter text was found.';
    }else directError=`NovelPing returned HTTP ${response.status}.`;
  }catch(e){directError=String(e?.message||e)}
  try{
    const jinaUrl=`https://r.jina.ai/${url}`;
    const {response,text}=await fetchText(jinaUrl,{'User-Agent':'Mozilla/5.0','Accept':'text/plain,text/html;q=0.9,*/*;q=0.8'});
    if(response.ok&&text.trim().length>=200){
      const parsed=extractHtml(text);
      const source=parsed.source.length>=200?parsed.source:cleanText(text);
      if(source.length>=200)return {title:parsed.title||$titleFromText(text),number:chapterNumberFromUrl(url),source,sourceChars:Array.from(source).length};
    }
  }catch(e){directError+=` Fallback: ${String(e?.message||e)}`}
  throw new Error(`Could not fetch this NovelPing chapter. ${directError}`);
}

async function discoverSeries(url){
  const seenPages=new Set(),all=new Map(),queue=[url];
  while(queue.length&&seenPages.size<100){
    const page=queue.shift();
    if(seenPages.has(page))continue;
    seenPages.add(page);
    const {response,text}=await fetchText(page,headers);
    if(!response.ok)continue;
    for(const x of extractSeriesLinks(text,page))all.set(x.url,x);
    for(const next of paginationLinks(text,page))if(!seenPages.has(next))queue.push(next);
  }
  const chapters=[...all.values()].sort((a,b)=>a.number-b.number||a.url.localeCompare(b.url));
  if(!chapters.length)throw new Error('No chapter links were found on this NovelPing series page.');
  return chapters;
}

function $titleFromText(text){
  return String(text||'').split('\n').map(x=>cleanText(x)).find(Boolean)||'';
}

export async function fetchNovelPingChapter(url){
  if(!looksLikeNovelPing(url))throw new Error('For the first version, only NovelPing URLs are supported.');
  const u=new URL(url);
  if(isChapterUrl(url))return fetchChapterDirect(u.toString());
  const chapters=await discoverSeries(u.toString());
  return {series:true,title:cleanText(u.pathname.split('/').filter(Boolean).pop()||'NovelPing Series'),number:null,chapters,chapterCount:chapters.length};
}
