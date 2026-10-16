import * as cheerio from 'cheerio';

function cleanText(s=''){return String(s).replace(/\u00a0/g,' ').replace(/[ \t]+/g,' ').replace(/\n[ \t]+/g,'\n').replace(/\n{3,}/g,'\n\n').trim()}
function looksLikeNovelPing(url){try{const u=new URL(url);return u.hostname==='novelping.com'||u.hostname.endsWith('.novelping.com')}catch{return false}}
function isChapterUrl(url){return /\/chapter-/i.test(new URL(url).pathname)}
function chapterNumberFromUrl(url){const m=String(url).match(/\/chapter-(\d+)/i);return m?Number(m[1]):null}
function chapterUrlFromSeries(seriesUrl,n){const u=new URL(seriesUrl);const parts=u.pathname.split('/').filter(Boolean);const book=parts[parts.indexOf('book')+1];if(!book)throw new Error('Invalid NovelPing book URL.');return `${u.origin}/book/${book}/chapter-${n}`}
function extractHtml(html){const $=cheerio.load(html);const title=cleanText($('h1').first().text())||cleanText($('title').text());const selectors=['.chapter-content','.chapter__content','.chapter-text','.reading-content','.entry-content','.post-content','.text-content','[class*="chapter-content"]','[id*="chapter-content"]','article'];let best=null,bestLen=0;for(const selector of selectors)$(selector).each((_,node)=>{const len=cleanText($(node).text()).length;if(len>bestLen){bestLen=len;best=$(node)}});if(!best)return{title,source:''};best.find('script,style,noscript,nav,header,footer,button,form,aside,iframe,.ads,.advertisement,[class*="ad-"]').remove();const ps=[];best.find('p').each((_,el)=>{const t=cleanText($(el).text());if(t.length>=2)ps.push(t)});const source=(ps.length>=2?ps.join('\n\n'):cleanText(best.text())).replace(/\n{3,}/g,'\n\n').trim();return{title,source}}
async function fetchText(url,headers={}){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);try{const response=await fetch(url,{headers,signal:controller.signal,redirect:'follow'});const text=await response.text();return{response,text}}finally{clearTimeout(timer)}}
const headers={'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155 Safari/537.36','Accept':'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8','Accept-Language':'en-US,en;q=0.9'};
async function fetchChapterDirect(url){let err='';try{const{response,text}=await fetchText(url,headers);if(response.ok){const p=extractHtml(text);if(p.source.length>=200)return{title:p.title,number:chapterNumberFromUrl(url),source:p.source,sourceChars:Array.from(p.source).length};err='page reached but chapter text was not found.'}else err=`NovelPing returned HTTP ${response.status}.`}catch(e){err=String(e?.message||e)}try{const{response,text}=await fetchText(`https://r.jina.ai/${url}`,{'User-Agent':'Mozilla/5.0','Accept':'text/plain,text/html;q=0.9,*/*;q=0.8'});if(response.ok&&text.trim().length>=200){const p=extractHtml(text),source=p.source.length>=200?p.source:cleanText(text);if(source.length>=200)return{title:p.title||firstLine(text),number:chapterNumberFromUrl(url),source,sourceChars:Array.from(source).length}}}catch(e){err+=` Fallback: ${String(e?.message||e)}`}throw new Error(`Could not fetch this NovelPing chapter. ${err}`)}
function firstLine(text){return String(text||'').split('\n').map(cleanText).find(Boolean)||''}
async function discoverSeries(url){
  // NovelPing's current series page may render the chapter list client-side, so plain HTML
  // can contain zero <a> chapter links. First try normal links/embedded URLs.
  const seen=new Set(),found=new Map(),queue=[url];
  while(queue.length&&seen.size<100){const page=queue.shift();if(seen.has(page))continue;seen.add(page);const{response,text}=await fetchText(page,headers);if(!response.ok)continue;const $=cheerio.load(text);$('a[href]').each((_,el)=>{const href=$(el).attr('href');if(!href)return;try{const u=new URL(href,page),n=chapterNumberFromUrl(u.toString());if(n!==null)found.set(u.toString().split('#')[0],{url:u.toString().split('#')[0],number:n,title:cleanText($(el).text())||`Chapter ${n}`})}catch{}});const raw=String(text);for(const m of raw.matchAll(/\/book\/[^"'\s<>?#]+\/chapter-(\d+)(?:[^"'\s<>#]*)?/gi)){try{const u=new URL(m[0],page),n=Number(m[1]);found.set(u.toString().split('#')[0],{url:u.toString().split('#')[0],number:n,title:`Chapter ${n}`})}catch{}}}
  if(found.size)return[...found.values()].sort((a,b)=>a.number-b.number);
  // Fallback: NovelPing uses predictable /chapter-N URLs. Probe a bounded range so we can
  // recover even when the chapter list is rendered by JavaScript and invisible to fetch().
  const chapters=[];let consecutiveMisses=0;const MAX_PROBE=600;
  for(let n=1;n<=MAX_PROBE;n++){
    const chapterUrl=chapterUrlFromSeries(url,n);try{const{response}=await fetchText(chapterUrl,headers);if(response.ok){chapters.push({url:chapterUrl,number:n,title:`Chapter ${n}`});consecutiveMisses=0}else consecutiveMisses++}catch{consecutiveMisses++}
    if(n>20&&consecutiveMisses>=8)break;
    if(n%20===0)await new Promise(r=>setTimeout(r,1000));
  }
  if(!chapters.length)throw new Error('No chapter URLs were found on this NovelPing series page.');
  return chapters;
}
export async function fetchNovelPingChapter(url){if(!looksLikeNovelPing(url))throw new Error('For the first version, only NovelPing URLs are supported.');const u=new URL(url);if(isChapterUrl(url))return fetchChapterDirect(u.toString());const chapters=await discoverSeries(u.toString());return{series:true,title:cleanText(u.pathname.split('/').filter(Boolean).pop()||'NovelPing Series'),number:null,chapters,chapterCount:chapters.length}}
