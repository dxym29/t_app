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
  }catch{return false}
}

function isChapterUrl(url){
  return /\/chapter-/i.test(new URL(url).pathname);
}

function chapterNumberFromUrl(url){
  const m=String(url).match(/\/chapter-(\d+)/i);
  return m?Number(m[1]):null;
}

function chapterUrlFromSeries(seriesUrl,n){
  const u=new URL(seriesUrl);
  const parts=u.pathname.split('/').filter(Boolean);
  const i=parts.indexOf('book');
  const book=i>=0?parts[i+1]:null;
  if(!book)throw new Error('Invalid NovelPing book URL.');
  return `${u.origin}/book/${book}/chapter-${n}`;
}

function extractHtml(html){
  const $=cheerio.load(html);
  const title=cleanText($('h1').first().text())||cleanText($('title').text());
  const selectors=[
    '.chapter-content','.chapter__content','.chapter-text','.reading-content',
    '.entry-content','.post-content','.text-content','[class*="chapter-content"]',
    '[id*="chapter-content"]','article'
  ];
  let best=null,bestLen=0;
  for(const selector of selectors){
    $(selector).each((_,node)=>{
      const len=cleanText($(node).text()).length;
      if(len>bestLen){bestLen=len;best=$(node)}
    });
  }
  if(!best)return{title,source:''};
  best.find('script,style,noscript,nav,header,footer,button,form,aside,iframe,.ads,.advertisement,[class*="ad-"]').remove();
  const ps=[];
  best.find('p').each((_,el)=>{
    const t=cleanText($(el).text());
    if(t.length>=2)ps.push(t);
  });
  const source=(ps.length>=2?ps.join('\n\n'):cleanText(best.text()))
    .replace(/\n{3,}/g,'\n\n')
    .trim();
  return{title,source};
}

async function fetchText(url,headers={}){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),20000);
  try{
    const response=await fetch(url,{headers,signal:controller.signal,redirect:'follow'});
    const text=await response.text();
    return{response,text};
  }finally{clearTimeout(timer)}
}

const headers={
  'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155 Safari/537.36',
  'Accept':'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
  'Accept-Language':'en-US,en;q=0.9'
};

async function fetchPage(url){
  try{
    const r=await fetchText(url,headers);
    if(r.response.ok&&r.text.trim())return r;
  }catch{}
  try{
    const r=await fetchText(`https://r.jina.ai/${url}`,{
      'User-Agent':'Mozilla/5.0',
      'Accept':'text/plain,text/html;q=0.9,*/*;q=0.8'
    });
    if(r.response.ok&&r.text.trim())return r;
  }catch{}
  return null;
}

async function fetchChapterDirect(url){
  let err='';
  try{
    const{response,text}=await fetchText(url,headers);
    if(response.ok){
      const p=extractHtml(text);
      if(p.source.length>=200){
        return{
          title:p.title,
          number:chapterNumberFromUrl(url),
          source:p.source,
          sourceChars:Array.from(p.source).length
        };
      }
      err='page reached but chapter text was not found.';
    }else{
      err=`NovelPing returned HTTP ${response.status}.`;
    }
  }catch(e){err=String(e?.message||e)}

  try{
    const{response,text}=await fetchText(`https://r.jina.ai/${url}`,{
      'User-Agent':'Mozilla/5.0',
      'Accept':'text/plain,text/html;q=0.9,*/*;q=0.8'
    });
    if(response.ok&&text.trim().length>=200){
      const p=extractHtml(text);
      const source=p.source.length>=200?p.source:cleanText(text);
      if(source.length>=200){
        return{
          title:p.title||firstLine(text),
          number:chapterNumberFromUrl(url),
          source,
          sourceChars:Array.from(source).length
        };
      }
    }
  }catch(e){err+=` Fallback: ${String(e?.message||e)}`}

  throw new Error(`Could not fetch this NovelPing chapter. ${err}`);
}

function firstLine(text){
  return String(text||'').split('\n').map(cleanText).find(Boolean)||'';
}

function addLinksFromHtml(html,page,found){
  const $=cheerio.load(html);
  $('a[href]').each((_,el)=>{
    const href=$(el).attr('href');
    if(!href)return;
    try{
      const u=new URL(href,page);
      const n=chapterNumberFromUrl(u.toString());
      if(n!==null){
        const clean=u.toString().split('#')[0];
        found.set(clean,{
          url:clean,
          number:n,
          title:cleanText($(el).text())||`Chapter ${n}`
        });
      }
    }catch{}
  });

  const raw=String(html);
  for(const m of raw.matchAll(/\/book\/[^"'\s<>?#]+\/chapter-(\d+)(?:[^"'\s<>#]*)?/gi)){
    try{
      const u=new URL(m[0],page),n=Number(m[1]);
      const clean=u.toString().split('#')[0];
      found.set(clean,{url:clean,number:n,title:`Chapter ${n}`});
    }catch{}
  }
}

function paginationLinks(html,page){
  const $=cheerio.load(html),base=new URL(page),out=new Set();
  $('a[href]').each((_,el)=>{
    const href=$(el).attr('href');
    if(!href)return;
    const text=cleanText($(el).text()).toLowerCase();
    const rel=String($(el).attr('rel')||'').toLowerCase();
    try{
      const u=new URL(href,base);
      if(u.hostname!==base.hostname)return;
      const s=u.toString();
      if(
        text.includes('next')||
        rel.includes('next')||
        /[?&](page|paged)=\d+/i.test(u.search)||
        /\/page\/\d+\/?$/i.test(u.pathname)
      )out.add(s);
    }catch{}
  });
  return[...out];
}

async function probeChapterNumbers(seriesUrl,numbers,found){
  const results=await Promise.all(numbers.map(async n=>{
    const chapterUrl=chapterUrlFromSeries(seriesUrl,n);
    try{
      const r=await fetchText(chapterUrl,headers);
      if(r.response.ok){
        const p=extractHtml(r.text);
        if(p.source.length>=200){
          return{
            url:chapterUrl,
            number:n,
            title:p.title||`Chapter ${n}`
          };
        }
      }
    }catch{}
    return null;
  }));

  for(const x of results.filter(Boolean))found.set(x.url,x);
  return results.filter(Boolean);
}

async function discoverSeries(url){
  const found=new Map();
  const seenPages=new Set();
  const queue=[url];

  // First collect every chapter link exposed by the series/pagination pages.
  while(queue.length&&seenPages.size<100){
    const page=queue.shift();
    if(seenPages.has(page))continue;
    seenPages.add(page);
    const r=await fetchPage(page);
    if(!r)continue;
    addLinksFromHtml(r.text,page,found);
    for(const next of paginationLinks(r.text,page)){
      if(!seenPages.has(next))queue.push(next);
    }
  }

  // NovelPing can expose only the newest ~30 chapters on the series page.
  // Therefore we probe BOTH directions instead of only chapters after maxFound.
  if(found.size){
    const numbers=[...found.values()].map(x=>x.number).filter(Number.isFinite);
    const minFound=Math.min(...numbers);
    const maxFound=Math.max(...numbers);

    // Probe older chapters: e.g. if the first page contains 478-509,
    // continue with 477,476,... until chapter 1 or a long missing run.
    let misses=0;
    for(let end=minFound-1;end>=1&&misses<16;end-=8){
      const start=Math.max(1,end-7);
      const nums=[];
      for(let n=end;n>=start;n--)nums.push(n);
      const hits=await probeChapterNumbers(url,nums,found);
      if(hits.length)misses=0;
      else misses+=nums.length;
    }

    // Also probe newer chapters in case the series page is not up to date.
    misses=0;
    for(let start=maxFound+1;start<=600&&misses<16;start+=8){
      const nums=Array.from({length:8},(_,i)=>start+i).filter(n=>n<=600);
      const hits=await probeChapterNumbers(url,nums,found);
      if(hits.length)misses=0;
      else misses+=nums.length;
    }

    return[...found.values()].sort((a,b)=>a.number-b.number||a.url.localeCompare(b.url));
  }

  // No links at all: fall back to probing the predictable chapter URL pattern.
  const chapters=[];
  let misses=0;
  for(let start=1;start<=600&&misses<16;start+=8){
    const nums=Array.from({length:8},(_,i)=>start+i).filter(n=>n<=600);
    const temp=new Map();
    const hits=await probeChapterNumbers(url,nums,temp);
    if(hits.length){chapters.push(...hits);misses=0;}
    else misses+=nums.length;
  }

  if(!chapters.length){
    throw new Error('NovelPing did not expose chapter pages to the server. Try a direct chapter URL first.');
  }
  return chapters.sort((a,b)=>a.number-b.number);
}

export async function fetchNovelPingChapter(url){
  if(!looksLikeNovelPing(url)){
    throw new Error('For the first version, only NovelPing URLs are supported.');
  }
  const u=new URL(url);
  if(isChapterUrl(url))return fetchChapterDirect(u.toString());
  const chapters=await discoverSeries(u.toString());
  return{
    series:true,
    title:cleanText(u.pathname.split('/').filter(Boolean).pop()||'NovelPing Series'),
    number:null,
    chapters,
    chapterCount:chapters.length
  };
}
