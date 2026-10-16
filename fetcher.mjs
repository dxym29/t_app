import * as cheerio from 'cheerio';

function cleanText(s=''){return String(s).replace(/\u00a0/g,' ').replace(/[ \t]+/g,' ').replace(/\n[ \t]+/g,'\n').replace(/\n{3,}/g,'\n\n').trim()}
function looksLikeNovelPing(url){try{const u=new URL(url);return u.hostname==='novelping.com'||u.hostname.endsWith('.novelping.com')}catch{return false}}
function isChapterUrl(url){return /\/chapter-/i.test(new URL(url).pathname)}
function chapterNumberFromUrl(url){const m=String(url).match(/\/chapter-(\d+)/i);return m?Number(m[1]):null}
function chapterUrlFromSeries(seriesUrl,n){const u=new URL(seriesUrl);const parts=u.pathname.split('/').filter(Boolean);const i=parts.indexOf('book');const book=i>=0?parts[i+1]:null;if(!book)throw new Error('Invalid NovelPing book URL.');return `${u.origin}/book/${book}/chapter-${n}`}
function extractHtml(html){const $=cheerio.load(html);const title=cleanText($('h1').first().text())||cleanText($('title').text());const selectors=['.chapter-content','.chapter__content','.chapter-text','.reading-content','.entry-content','.post-content','.text-content','[class*="chapter-content"]','[id*="chapter-content"]','article'];let best=null,bestLen=0;for(const selector of selectors)$(selector).each((_,node)=>{const len=cleanText($(node).text()).length;if(len>bestLen){bestLen=len;best=$(node)}});if(!best)return{title,source:''};best.find('script,style,noscript,nav,header,footer,button,form,aside,iframe,.ads,.advertisement,[class*="ad-"]').remove();const ps=[];best.find('p').each((_,el)=>{const t=cleanText($(el).text());if(t.length>=2)ps.push(t)});const source=(ps.length>=2?ps.join('\n\n'):cleanText(best.text())).replace(/\n{3,}/g,'\n\n').trim();return{title,source}}
async function fetchText(url,headers={}){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);try{const response=await fetch(url,{headers,signal:controller.signal,redirect:'follow'});const text=await response.text();return{response,text}}finally{clearTimeout(timer)}}
async function fetchPage(url){
  try{const r=await fetchText(url,headers);if(r.response.ok&&r.text.trim())return r}catch{}
  try{const r=await fetchText(`https://r.jina.ai/${url}`,{'User-Agent':'Mozilla/5.0','Accept':'text/plain,text/html;q=0.9,*/*;q=0.8'});if(r.response.ok&&r.text.trim())return r}catch{}
  return null;
}
const headers={'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155 Safari/537.36','Accept':'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8','Accept-Language':'en-US,en;q=0.9'};
async function fetchChapterDirect(url){let err='';try{const{response,text}=await fetchText(url,headers);if(response.ok){const p=extractHtml(text);if(p.source.length>=200)return{title:p.title,number:chapterNumberFromUrl(url),source:p.source,sourceChars:Array.from(p.source).length};err='page reached but chapter text was not found.'}else err=`NovelPing returned HTTP ${response.status}.`}catch(e){err=String(e?.message||e)}try{const{response,text}=await fetchText(`https://r.jina.ai/${url}`,{'User-Agent':'Mozilla/5.0','Accept':'text/plain,text/html;q=0.9,*/*;q=0.8'});if(response.ok&&text.trim().length>=200){const p=extractHtml(text),source=p.source.length>=200?p.source:cleanText(text);if(source.length>=200)return{title:p.title||firstLine(text),number:chapterNumberFromUrl(url),source,sourceChars:Array.from(source).length}}}catch(e){err+=` Fallback: ${String(e?.message||e)}`}throw new Error(`Could not fetch this NovelPing chapter. ${err}`)}
function firstLine(text){return String(text||'').split('\n').map(cleanText).find(Boolean)||''}
function addLinksFromHtml(html,page,found){const $=cheerio.load(html);$('a[href]').each((_,el)=>{const href=$(el).attr('href');if(!href)return;try{const u=new URL(href,page),n=chapterNumberFromUrl(u.toString());if(n!==null)found.set(u.toString().split('#')[0],{url:u.toString().split('#')[0],number:n,title:cleanText($(el).text())||`Chapter ${n}`})}catch{}});const raw=String(html);for(const m of raw.matchAll(/\/book\/[^"'\s<>?#]+\/chapter-(\d+)(?:[^"'\s<>#]*)?/gi)){try{const u=new URL(m[0],page),n=Number(m[1]);found.set(u.toString().split('#')[0],{url:u.toString().split('#')[0],number:n,title:`Chapter ${n}`})}catch{}}}
async function discoverSeries(url){
  const found=new Map();
  const first=await fetchPage(url);
  if(first)addLinksFromHtml(first.text,url,found);
  if(found.size)return[...found.values()].sort((a,b)=>a.number-b.number);

  // If the site hides the chapter list behind JavaScript, probe the predictable chapter URLs.
  // We first locate a valid chapter with exponential probing, then binary-search the end.
  async function exists(n){
    const chapterUrl=chapterUrlFromSeries(url,n);
    try{const r=await fetchText(chapterUrl,headers);if(r.response.ok){const p=extractHtml(r.text);if(p.source.length>=200)return{url:chapterUrl,number:n,title:p.title||`Chapter ${n}`};}}catch{}
    try{const r=await fetchText(`https://r.jina.ai/${chapterUrl}`,{'User-Agent':'Mozilla/5.0','Accept':'text/plain,text/html;q=0.9,*/*;q=0.8'});if(r.response.ok&&r.text.trim().length>=200)return{url:chapterUrl,number:n,title:firstLine(r.text)||`Chapter ${n}`}}catch{}
    return null;
  }
  let firstValid=null,low=1,high=1;
  for(let n of [1,2,4,8,16,32,64,128,256,512,1024]){const x=await exists(n);if(x){firstValid=x;low=n;high=n;break}if(n>=1024)break}
  if(!firstValid)throw new Error('NovelPing did not expose chapter pages to the server. Try a direct chapter URL first.');
  // Find the highest existing chapter. A few missing chapters are tolerated after the last hit.
  let probe=high*2;while(probe<=2000){const x=await exists(probe);if(x){high=probe;probe*=2}else break}
  let lo=low,hi=high;
  while(lo<hi){const mid=Math.floor((lo+hi+1)/2);const x=await exists(mid);if(x)lo=mid;else hi=mid-1}
  const max=lo,chapters=[];
  for(let n=1;n<=max;n++)chapters.push({url:chapterUrlFromSeries(url,n),number:n,title:`Chapter ${n}`});
  return chapters;
}
export async function fetchNovelPingChapter(url){if(!looksLikeNovelPing(url))throw new Error('For the first version, only NovelPing URLs are supported.');const u=new URL(url);if(isChapterUrl(url))return fetchChapterDirect(u.toString());const chapters=await discoverSeries(u.toString());return{series:true,title:cleanText(u.pathname.split('/').filter(Boolean).pop()||'NovelPing Series'),number:null,chapters,chapterCount:chapters.length}}
