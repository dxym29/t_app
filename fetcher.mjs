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

function chapterNumberFromUrl(url){
  const m=String(url).match(/\/chapter-(\d+)/i);
  return m?Number(m[1]):null;
}

export async function fetchNovelPingChapter(url){
  if(!looksLikeNovelPing(url)) throw new Error('For the first version, only NovelPing URLs are supported.');
  const u=new URL(url);
  const response=await fetch(u,{headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/155 Safari/537.36','Accept':'text/html,application/xhtml+xml'}});
  if(!response.ok) throw new Error(`NovelPing returned HTTP ${response.status}.`);
  const html=await response.text();
  const $=cheerio.load(html);
  const title=cleanText($('h1').first().text()) || cleanText($('title').text());
  const candidates=[
    '.chapter-content','.chapter-content p','.chapter__content','.chapter-text','.reading-content','.entry-content','article'
  ];
  let root=null;
  for(const selector of candidates){
    const node=$(selector).first();
    if(node.length && cleanText(node.text()).length>200){root=node;break;}
  }
  if(!root){
    const heading=$('h1').first();
    if(heading.length){
      const article=heading.closest('article');
      if(article.length && cleanText(article.text()).length>200) root=article;
    }
  }
  if(!root) throw new Error('Could not find the chapter text on this NovelPing page.');
  root.find('script,style,noscript,nav,header,footer,button,form,aside,.ads,.advertisement').remove();
  const paragraphs=[];
  root.find('p').each((_,el)=>{
    const t=cleanText($(el).text());
    if(t.length>=2) paragraphs.push(t);
  });
  let source=paragraphs.length>=2?paragraphs.join('\n\n'):cleanText(root.text());
  source=source.replace(/\n{3,}/g,'\n\n').trim();
  if(source.length<200) throw new Error('The page was fetched, but the extracted chapter text is too short.');
  return {title,number:chapterNumberFromUrl(url),source,sourceChars:Array.from(source).length};
}
