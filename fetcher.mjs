import * as cheerio from 'cheerio';

function cleanText(s=''){return String(s).replace(/\u00a0/g,' ').replace(/[ \t]+/g,' ').replace(/\n[ \t]+/g,'\n').replace(/\n{3,}/g,'\n\n').trim()}
function sleep(ms){return new Promise(r=>setTimeout(r,ms))}
function looksLikeNovelPing(url){try{const u=new URL(url);return u.hostname==='novelping.com'||u.hostname.endsWith('.novelping.com')}catch{return false}}
function isChapterUrl(url){try{return /\/chapter-/i.test(new URL(url).pathname)}catch{return false}}
function chapterNumberFromUrl(url){const m=String(url).match(/\/chapter-(\d+)/i);return m?Number(m[1]):null}
function firstLine(text){return String(text||'').split('\n').map(cleanText).find(Boolean)||''}
function novelSlugFromUrl(url){const p=new URL(url).pathname.split('/').filter(Boolean),i=p.findIndex(x=>x==='book'||x==='novel');return i>=0&&p[i+1]?p[i+1]:null}

function extractHtml(html){
  const $=cheerio.load(html),title=cleanText($('h2 .chr-text').first().text())||cleanText($('h1').first().text())||cleanText($('title').text());
  const selectors=['#chr-content','#chapter-content','.chapter-content','.chapter__content','.chapter-text','.reading-content','.entry-content','.post-content','.text-content','[class*="chapter-content"]','[id*="chapter-content"]','article'];
  let best=null,bestLen=0;for(const s of selectors)$(s).each((_,n)=>{const len=cleanText($(n).text()).length;if(len>bestLen){bestLen=len;best=$(n)}});
  if(!best)return{title,source:''};
  best.find('script,style,noscript,nav,header,footer,button,form,aside,iframe,.js-ad-slot,.ads,.advertisement,[class*="ad-"]').remove();
  const ps=[];best.find('p').each((_,el)=>{const t=cleanText($(el).text());if(t.length>=2)ps.push(t)});
  return{title,source:(ps.length>=2?ps.join('\n\n'):cleanText(best.text())).replace(/\n{3,}/g,'\n\n').trim()};
}

async function fetchText(url,headers={},timeout=30000){const c=new AbortController(),t=setTimeout(()=>c.abort(),timeout);try{const response=await fetch(url,{headers,signal:c.signal,redirect:'follow'});return{response,text:await response.text()}}finally{clearTimeout(t)}}
const headers={'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155 Safari/537.36','Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8','Accept-Language':'en-US,en;q=0.9','Cache-Control':'no-cache','Pragma':'no-cache'};
const jinaHeaders={'User-Agent':'Mozilla/5.0','Accept':'text/plain,text/html;q=0.9,*/*;q=0.8'};

async function fetchPage(url){for(let a=0;a<2;a++){try{const r=await fetchText(url,headers,15000);if(r.response.ok&&r.text.trim())return r;if([429,500,502,503,504].includes(r.response.status))await sleep(1200*(a+1))}catch{if(a===0)await sleep(900)}}try{const r=await fetchText(`https://r.jina.ai/${url}`,jinaHeaders,20000);if(r.response.ok&&r.text.trim())return r}catch{}return null}

async function fetchChapterDirect(url){let errors=[];for(let a=1;a<=3;a++){try{const{response,text}=await fetchText(url,headers,30000);if(response.ok){const p=extractHtml(text);if(p.source.length>=200)return{title:p.title,number:chapterNumberFromUrl(url),source:p.source,sourceChars:Array.from(p.source).length};errors.push('page reached but chapter text was not found')}else errors.push(`HTTP ${response.status}`)}catch(e){errors.push(String(e?.message||e))}if(a<3)await sleep(1800*a)}try{const{response,text}=await fetchText(`https://r.jina.ai/${url}`,jinaHeaders,30000);if(response.ok&&text.trim().length>=200){const p=extractHtml(text),source=p.source.length>=200?p.source:cleanText(text);if(source.length>=200)return{title:p.title||firstLine(text),number:chapterNumberFromUrl(url),source,sourceChars:Array.from(source).length}}errors.push(`Jina HTTP ${response.status}`)}catch(e){errors.push(`Jina ${String(e?.message||e)}`)}throw new Error(`Could not fetch this NovelPing chapter. ${errors.join('; ')}`)}

function decodeHtml(s){return String(s||'').replace(/&quot;/gi,'"').replace(/&#34;/g,'"').replace(/&#39;/g,"'").replace(/&amp;/gi,'&').replace(/\\\//g,'/')}
function addChapter(found,url,title=''){try{const u=new URL(url);if(!looksLikeNovelPing(u.toString()))return;const clean=u.toString().split('#')[0],n=chapterNumberFromUrl(clean);if(n===null)return;const t=cleanText(title)||`Chapter ${n}`,old=found.get(clean);if(!old||t.length>old.title.length)found.set(clean,{url:clean,number:n,title:t})}catch{}}
function addLinksFromHtml(html,page,found){const raw=decodeHtml(html),$=cheerio.load(raw);$('a[href]').each((_,el)=>addChapter(found,$(el).attr('href'),$(el).attr('title')||$(el).text()));for(const m of raw.matchAll(/(?:https?:\/\/novelping\.com)?\/book\/[^"'<>\\\s]+\/chapter-\d+[^"'<>\\\s]*/gi))addChapter(found,m[0])}
function addArchiveLinks(html,page,found){const raw=decodeHtml(html),$=cheerio.load(raw),template=$('template[data-chapter-item-template]').first();if(template.length){const inner=template.html()||'',t$=cheerio.load(inner);t$('a[href]').each((_,el)=>addChapter(found,t$(el).attr('href'),t$(el).attr('title')||t$('.nchr-text',el).text()||t$(el).text()))}$('a[href]').each((_,el)=>addChapter(found,$(el).attr('href'),$(el).attr('title')||$('.nchr-text',el).text()||$(el).text()));for(const m of raw.matchAll(/(?:https?:\/\/novelping\.com)?\/book\/[^"'<>\\\s]+\/chapter-\d+[^"'<>\\\s]*/gi))addChapter(found,m[0])}

async function fetchAjaxArchive(seriesUrl,found){
  const slug=novelSlugFromUrl(seriesUrl);if(!slug)return{count:0,method:'no-slug'};
  const base=new URL(seriesUrl).origin,plain=`${base}/ajax/chapter-archive?novelId=${slug}`;
  const urls=[plain,`${plain}&_=${Date.now()}`,`${plain}&page=1&_=${Date.now()+1}`];
  const candidates=[];
  for(let i=0;i<urls.length;i++){
    try{
      const r=await fetchText(urls[i],{...headers,'Referer':seriesUrl,'Origin':base,'X-Requested-With':'XMLHttpRequest','Sec-Fetch-Dest':'empty','Sec-Fetch-Mode':'cors','Sec-Fetch-Site':'same-origin'},25000);
      const map=new Map();if(r.response.ok&&r.text.trim()){addArchiveLinks(r.text,seriesUrl,map);addLinksFromHtml(r.text,seriesUrl,map)}
      candidates.push({label:`ajax-${i+1}`,map,textLength:r.text.length,status:r.response.status,hasTemplate:/data-chapter-item-template/i.test(r.text)});
      if(map.size>=100)break;
    }catch(e){candidates.push({label:`ajax-${i+1}`,map:new Map(),textLength:0,error:String(e?.message||e)})}
    await sleep(500);
  }
  try{const r=await fetchText(`https://r.jina.ai/${plain}`,jinaHeaders,25000),map=new Map();if(r.response.ok&&r.text.trim()){addArchiveLinks(r.text,seriesUrl,map);addLinksFromHtml(r.text,seriesUrl,map);candidates.push({label:'jina-archive',map,textLength:r.text.length,status:r.response.status,hasTemplate:/data-chapter-item-template/i.test(r.text)})}}catch{}
  candidates.sort((a,b)=>b.map.size-a.map.size);const best=candidates[0];if(best)for(const x of best.map.values())found.set(x.url,x);
  return{count:found.size,method:best?.label||'none',slug,archiveUrl:plain,archiveChars:best?.textLength||0,hasTemplate:!!best?.hasTemplate,attempts:candidates.map(x=>({method:x.label,count:x.map.size,chars:x.textLength,status:x.status,template:x.hasTemplate}))};
}

function chapterNavigationLinks(html,page){const raw=decodeHtml(html),$=cheerio.load(raw),out=new Set();$('a[href]').each((_,el)=>{const href=$(el).attr('href'),text=cleanText($(el).text()).toLowerCase(),attrs=`${$(el).attr('rel')||''} ${$(el).attr('aria-label')||''} ${$(el).attr('title')||''} ${$(el).attr('class')||''} ${$(el).attr('data-chapter-nav')||''}`.toLowerCase();if(/\b(prev|previous|next|older|newer)\b/.test(`${text} ${attrs}`))try{const u=new URL(href,page),n=chapterNumberFromUrl(u.toString());if(n!==null&&looksLikeNovelPing(u.toString()))out.add(u.toString().split('#')[0])}catch{}});return[...out]}
function discoveryStats(chapters){const nums=[...new Set(chapters.map(x=>Number(x.number)).filter(Number.isFinite))].sort((a,b)=>a-b);let gaps=0,largestGap=0;for(let i=1;i<nums.length;i++){const g=nums[i]-nums[i-1]-1;if(g>0){gaps+=g;largestGap=Math.max(largestGap,g)}}return{count:chapters.length,min:nums[0]??null,max:nums[nums.length-1]??null,gaps,largestGap}}

async function discoverSeries(url){
  const found=new Map();const archive=await fetchAjaxArchive(url,found);let method=archive.method;
  // If the archive is small, follow chapter navigation from every discovered edge.
  if(found.size<100){const queue=[...found.values()].map(x=>x.url),seen=new Set();let rounds=0;while(queue.length&&seen.size<250&&rounds<80){const batch=[];while(queue.length&&batch.length<6){const p=queue.shift();if(!seen.has(p)){seen.add(p);batch.push(p)}}const pages=await Promise.all(batch.map(async page=>({page,r:await fetchPage(page)})));for(const{page,r}of pages){if(!r)continue;const before=found.size;addLinksFromHtml(r.text,page,found);for(const next of chapterNavigationLinks(r.text,page))if(!seen.has(next)&&!queue.includes(next))queue.push(next);if(found.size>before)method=`${method}+chapter-graph`;}rounds++}}
  if(!found.size)throw new Error('NovelPing did not expose chapter pages to the server. Try a direct chapter URL first.');
  const chapters=[...found.values()].sort((a,b)=>a.number-b.number||a.url.localeCompare(b.url)),stats=discoveryStats(chapters);
  return{chapters,stats,method,archiveChars:archive.archiveChars||0,archiveUrl:archive.archiveUrl||null,archiveAttempts:archive.attempts||[]};
}

export async function fetchNovelPingChapter(url){if(!looksLikeNovelPing(url))throw new Error('For this importer, only NovelPing URLs are supported.');const u=new URL(url);if(isChapterUrl(url))return fetchChapterDirect(u.toString());const r=await discoverSeries(u.toString());return{series:true,title:cleanText(u.pathname.split('/').filter(Boolean).pop()||'NovelPing Series'),number:null,chapters:r.chapters,chapterCount:r.chapters.length,discovery:r.stats,discoveryMethod:r.method,archiveChars:r.archiveChars,archiveAttempts:r.archiveAttempts}}
