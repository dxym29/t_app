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
  let root=null;
  let best=null;
  let bestLen=0;
  for(const selector of candidates){
    $(selector).each((_,node)=>{
      const len=cleanText($(node).text()).length;
      if(len>bestLen){bestLen=len;best=$(node);}
    });
  }
  root=best;
  if(!root){
    const heading=$('h1').first();
    if(heading.length){
      const article=heading.closest('article');
      if(article.length&&cleanText(article.text()).length>200)root=article;
    }
  }
  if(!root)return {title,source:''};
  root.find('script,style,noscript,nav,header,footer,button,form,aside,iframe,.ads,.advertisement,[class*="ad-"]').remove();
  const paragraphs=[];
  root.find('p').each((_,el)=>{
    const t=cleanText($(el).text());
    if(t.length>=2)paragraphs.push(t);
  });
  let source=paragraphs.length>=2?paragraphs.join('\n\n'):cleanText(root.text());
  source=source.replace(/\n{3,}/g,'\n\n').trim();
  return {title,source};
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

export async function fetchNovelPingChapter(url){
  if(!looksLikeNovelPing(url)) throw new Error('For the first version, only NovelPing URLs are supported.');
  const u=new URL(url);
  const headers={
    'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155 Safari/537.36',
    'Accept':'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
    'Accept-Language':'en-US,en;q=0.9'
  };

  let directError='';
  try{
    const {response,text}=await fetchText(u.toString(),headers);
    if(response.ok){
      const parsed=extractHtml(text);
      if(parsed.source.length>=200){
        return {title:parsed.title,number:chapterNumberFromUrl(url),source:parsed.source,sourceChars:Array.from(parsed.source).length};
      }
      directError='NovelPing page was reached, but no chapter text was found.';
    }else{
      directError=`NovelPing returned HTTP ${response.status}.`;
    }
  }catch(e){
    directError=String(e?.message||e);
  }

  // NovelPing may block server-side requests or render the chapter dynamically.
  // Jina Reader is used only as a fallback to retrieve the public page text.
  try{
    const jinaUrl=`https://r.jina.ai/${u.toString()}`;
    const {response,text}=await fetchText(jinaUrl,{
      'User-Agent':'Mozilla/5.0',
      'Accept':'text/plain,text/html;q=0.9,*/*;q=0.8'
    });
    if(response.ok&&text.trim().length>=200){
      const parsed=extractHtml(text);
      const source=parsed.source.length>=200?parsed.source:cleanText(text);
      if(source.length>=200){
        return {title:parsed.title||cleanText($titleFromText(text)),number:chapterNumberFromUrl(url),source,sourceChars:Array.from(source).length};
      }
    }
  }catch(e){
    directError += ` Fallback: ${String(e?.message||e)}`;
  }

  throw new Error(`Could not fetch this NovelPing chapter. ${directError}`);
}

function $titleFromText(text){
  const first=String(text||'').split('\n').map(x=>cleanText(x)).find(x=>x.length>0);
  return first||'';
}
