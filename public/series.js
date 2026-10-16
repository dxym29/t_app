(function(){
  const $=id=>document.getElementById(id);
  if(!$('fetchChapterBtn'))return;
  async function seriesApi(url,opts={}){const r=await fetch(url,{headers:{'Content-Type':'application/json',...(opts.headers||{})},...opts});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||'Request failed');return j}
  function sleep(ms){return new Promise(r=>setTimeout(r,ms))}
  async function fetchChapterWithRetry(ch){let last;for(let attempt=1;attempt<=3;attempt++){try{const data=await seriesApi('/api/fetch-chapter',{method:'POST',body:JSON.stringify({url:ch.url})});if(!data.source||data.source.length<50)throw new Error('Chapter source was empty or too short.');return data}catch(e){last=e;if(attempt<3)await sleep(2500*attempt)}}throw last||new Error('Chapter fetch failed.')}

  function discoveryWarning(first){
    const d=first.discovery||{};
    const count=Number(first.chapterCount||d.count||0),max=Number(d.max||0),gaps=Number(d.gaps||0);
    // A result this small is very likely incomplete for a real web-novel series.
    // Do not silently treat it as a complete archive. The user may still explicitly
    // choose to import it, which keeps existing DB rows untouched.
    if(count<100)return `WARNING: Only ${count} chapters were discovered (highest: ${max||'unknown'}). This may be an incomplete NovelPing archive.\n\nDiscovery method: ${first.discoveryMethod||'unknown'}\nArchive response: ${(first.archiveChars||0).toLocaleString()} chars\n${gaps?`Missing chapter-number gaps detected: ${gaps}.\n`:''}\nDo NOT import yet unless you intentionally want a partial import. Continue anyway?`;
    if(gaps>0)return `WARNING: ${count} chapters were discovered, but ${gaps} chapter-number gaps exist (largest gap: ${first.discovery?.largestGap||0}).\n\nDo NOT import yet unless you intentionally want a partial import. Continue anyway?`;
    return '';
  }

  async function importSeries(){
    const url=$('chapterUrl').value.trim();
    if(!url)return alert('Paste a NovelPing chapter or series URL first.');
    if(!window.currentNovel&&!localStorage.getItem('novelId'))return alert('Select a novel first.');
    const novelId=localStorage.getItem('novelId'),button=$('fetchChapterBtn');button.disabled=true;$('fetchStatus').textContent='Checking URL...';
    try{
      const first=await seriesApi('/api/fetch-chapter',{method:'POST',body:JSON.stringify({url})});
      if(!first.series){
        $('source').value=first.source||'';if(first.number)$('episodeNumber').value=first.number;if(first.title)$('episodeTitle').value=first.title;if(typeof updateStats==='function')updateStats();$('fetchStatus').textContent=`Fetched Chapter ${first.number||''} • ${(first.sourceChars||0).toLocaleString()} characters`;if(typeof setStatus==='function')setStatus('Chapter fetched into Original. Nothing was saved to the database yet.',true);return;
      }
      const chapters=Array.isArray(first.chapters)?first.chapters:[];if(!chapters.length)throw new Error('No chapters found on this series page.');
      const existing=await seriesApi(`/api/episodes/${novelId}/list`),existingNumbers=new Set((existing||[]).map(e=>Number(e.number))),pending=chapters.filter(x=>!existingNumbers.has(Number(x.number))),skipped=chapters.length-pending.length;
      const warning=discoveryWarning(first);
      if(warning){
        if(!confirm(warning))return;
      }
      if(!confirm(`Found ${chapters.length} chapters.\n\n${skipped} already exist and will be skipped.\n${pending.length} new chapters will be imported.\n\nContinue?`))return;
      let done=0,failed=0;const errors=[];
      for(const ch of pending){
        try{$('fetchStatus').textContent=`Importing Chapter ${ch.number} (${done+1}/${pending.length})...`;const data=await fetchChapterWithRetry(ch);await seriesApi(`/api/episodes/${novelId}`,{method:'POST',body:JSON.stringify({number:Number(ch.number),title:data.title||ch.title||`Chapter ${ch.number}`,source:data.source,translation:''})});done++;$('fetchStatus').textContent=`Imported ${done}/${pending.length} • Chapter ${ch.number}`;await sleep(350)}catch(e){failed++;errors.push(`Chapter ${ch.number}: ${e.message}`)}}
      if(typeof loadNovel==='function')await loadNovel();
      const summary=`Series import complete • ${done} imported • ${skipped} skipped • ${failed} failed`;$('fetchStatus').textContent=summary;if(typeof setStatus==='function')setStatus(failed?`${summary}\n${errors.slice(0,8).join(' | ')}`:summary,true);
    }catch(e){$('fetchStatus').textContent='Fetch failed.';if(typeof setStatus==='function')setStatus(e.message)}finally{button.disabled=false}
  }
  $('fetchChapterBtn').onclick=importSeries;$('chapterUrl').placeholder='Paste NovelPing chapter URL or series URL';
})();
