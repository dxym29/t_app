(function(){
 const $=id=>document.getElementById(id);if(!$('fetchChapterBtn'))return;
 const panel=$('fetchSelectionPanel');let discovery=null,existing=new Set(),selected=new Set();
 async function api(url,opts={}){const r=await fetch(url,{headers:{'Content-Type':'application/json',...(opts.headers||{})},...opts}),j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||'Request failed');return j}
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const novelId=()=>window.currentNovel?.id||localStorage.getItem('novelId');
 function newOnes(){return(discovery?.chapters||[]).filter(c=>!existing.has(Number(c.number)))}
 function refresh(){
  if(!discovery)return;
  const n=newOnes(),count=n.filter(c=>selected.has(c.url)).length;
  $('fetchSelectionSummary').textContent=discovery.chapters.length+' discovered • '+n.length+' new • '+count+' selected';
  $('fetchSelectedBtn').disabled=count===0||$('fetchSelectedBtn').dataset.busy==='1';
  $('fetchSelectedBtn').textContent='Fetch Selected ('+count+')';
 }
 function render(){
  $('fetchChapterList').innerHTML=discovery.chapters.map((c,i)=>{const old=existing.has(Number(c.number));return '<label class="ep" style="display:flex;gap:10px;align-items:center;padding:7px"><input type="checkbox" data-ch="'+i+'" '+(selected.has(c.url)?'checked ':'')+(old?'disabled ':'')+'><span><b>#'+esc(c.number)+'</b> '+esc(c.title||'Chapter '+c.number)+'<small style="display:block">'+(old?'Already in database':'Available')+'</small></span></label>'}).join('');
  panel.hidden=false;refresh();
 }
 function selectRange(){
  const a=$('fetchFromChapter').value.trim(),b=$('fetchToChapter').value.trim();
  if(a&&(!/^\d+$/.test(a)||Number(a)<1))return alert('Invalid starting chapter.');
  if(b&&(!/^\d+$/.test(b)||Number(b)<1))return alert('Invalid ending chapter.');
  const from=a?Number(a):-Infinity,to=b?Number(b):Infinity;
  if(from>to)return alert('Starting chapter must not exceed ending chapter.');
  selected=new Set(newOnes().filter(c=>Number(c.number)>=from&&Number(c.number)<=to).map(c=>c.url));render();
 }
 async function fetchOne(c){
  let last;for(let i=1;i<=3;i++){try{const d=await api('/api/fetch-chapter',{method:'POST',body:JSON.stringify({url:c.url})});if(!d.source||d.source.length<50)throw Error('Source is empty or too short');return d}catch(e){last=e;if(i<3)await sleep(2500*i)}}throw last;
 }
 async function importSelected(){
  const chosen=newOnes().filter(c=>selected.has(c.url));if(!chosen.length)return alert('Select chapters first.');
  if(!confirm('Fetch '+chosen.length+' selected chapters? Existing chapters will not be overwritten.'))return;
  const btn=$('fetchSelectedBtn');btn.dataset.busy='1';refresh();let ok=0,failed=0;const errors=[];
  try{
   for(const c of chosen){
    $('fetchStatus').textContent='Fetching Chapter '+c.number+' ('+(ok+failed+1)+'/'+chosen.length+')...';
    try{const d=await fetchOne(c);await api('/api/episodes/'+encodeURIComponent(novelId()),{method:'POST',body:JSON.stringify({number:Number(c.number),title:d.title||c.title||'Chapter '+c.number,source:d.source,translation:''})});existing.add(Number(c.number));selected.delete(c.url);ok++}
    catch(e){failed++;errors.push('#'+c.number+': '+e.message)}
    refresh();await sleep(300);
   }
   if(typeof loadNovel==='function')await loadNovel();render();
   $('fetchStatus').textContent='Selected fetch complete • '+ok+' imported • '+failed+' failed';
   if(typeof setStatus==='function')setStatus(errors.length?errors.slice(0,8).join(' | '):'Selected chapters imported.',failed===0);
  }finally{btn.dataset.busy='0';refresh()}
 }
 async function discover(){
  const url=$('chapterUrl').value.trim();if(!url)return alert('Paste a NovelPing chapter or series URL.');
  const btn=$('fetchChapterBtn');btn.disabled=true;panel.hidden=true;$('fetchStatus').textContent='Discovering...';
  try{
   const d=await api('/api/fetch-chapter',{method:'POST',body:JSON.stringify({url})});
   if(!d.series){$('source').value=d.source||'';if(d.number)$('episodeNumber').value=d.number;if(d.title)$('episodeTitle').value=d.title;if(typeof updateStats==='function')updateStats();$('fetchStatus').textContent='Fetched Chapter '+(d.number||'')+' • '+Number(d.sourceChars||0).toLocaleString()+' characters';if(typeof setStatus==='function')setStatus('Loaded into Original; not saved yet.',true);return}
   if(!novelId())throw Error('Select a novel first.');
   const list=await api('/api/episodes/'+encodeURIComponent(novelId())+'/list');existing=new Set(list.map(e=>Number(e.number)));discovery=d;
   selected=new Set(newOnes().map(c=>c.url));
   const gaps=Number(d.discovery?.gaps||0),count=Number(d.chapterCount||0);
   if((count<100||gaps>0)&&!confirm('Discovery warning: '+count+' chapters found'+(gaps?' with '+gaps+' chapter-number gaps':'')+'. The archive may be incomplete. Continue to selection?'))return;
   render();$('fetchStatus').textContent='Select the exact chapters to fetch below.';
   if(typeof setStatus==='function')setStatus('Chapter selection ready. No database records have been changed yet.',true);
  }catch(e){$('fetchStatus').textContent='Fetch failed';if(typeof setStatus==='function')setStatus(e.message||'Fetch failed')}
  finally{btn.disabled=false}
 }
 panel.addEventListener('change',e=>{const el=e.target.closest('[data-ch]');if(!el)return;const c=discovery?.chapters[Number(el.dataset.ch)];if(!c)return;if(el.checked)selected.add(c.url);else selected.delete(c.url);refresh()});
 $('fetchSelectRangeBtn').onclick=selectRange;
 $('fetchSelectAllBtn').onclick=()=>{selected=new Set(newOnes().map(c=>c.url));render()};
 $('fetchClearSelectionBtn').onclick=()=>{selected.clear();render()};
 $('fetchSelectedBtn').onclick=()=>importSelected().catch(e=>alert(e.message));
 $('fetchChapterBtn').onclick=discover;
})();