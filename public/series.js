(function(){
  const $=id=>document.getElementById(id);
  if(!$('fetchChapterBtn'))return;

  async function seriesApi(url,opts={}){
    const r=await fetch(url,{headers:{'Content-Type':'application/json',...(opts.headers||{})},...opts});
    const j=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(j.error||'Request failed');
    return j;
  }

  async function importSeries(){
    const url=$('chapterUrl').value.trim();
    if(!url)return alert('Paste a NovelPing chapter or series URL first.');
    if(!window.currentNovel && !localStorage.getItem('novelId'))return alert('Select a novel first.');

    const novelId=localStorage.getItem('novelId');
    const button=$('fetchChapterBtn');
    button.disabled=true;
    $('fetchStatus').textContent='Checking URL...';

    try{
      const first=await seriesApi('/api/fetch-chapter',{method:'POST',body:JSON.stringify({url})});

      if(!first.series){
        $('source').value=first.source||'';
        if(first.number)$('episodeNumber').value=first.number;
        if(first.title)$('episodeTitle').value=first.title;
        if(typeof updateStats==='function')updateStats();
        $('fetchStatus').textContent=`Fetched Chapter ${first.number||''} • ${(first.sourceChars||0).toLocaleString()} characters`;
        if(typeof setStatus==='function')setStatus('Chapter fetched into Original. Nothing was saved to the database yet.',true);
        return;
      }

      const chapters=Array.isArray(first.chapters)?first.chapters:[];
      if(!chapters.length)throw new Error('No chapters found on this series page.');

      const existing=await seriesApi(`/api/episodes/${novelId}/list`);
      const existingNumbers=new Set((existing||[]).map(e=>Number(e.number)));
      const pending=chapters.filter(x=>!existingNumbers.has(Number(x.number)));
      const skipped=chapters.length-pending.length;

      if(!confirm(`Found ${chapters.length} chapters.\n\n${skipped} already exist and will be skipped.\n${pending.length} new chapters will be imported.\n\nContinue?`))return;

      let done=0,failed=0;
      const errors=[];
      for(const ch of pending){
        try{
          $('fetchStatus').textContent=`Importing Chapter ${ch.number} (${done+1}/${pending.length})...`;
          const data=await seriesApi('/api/fetch-chapter',{method:'POST',body:JSON.stringify({url:ch.url})});
          if(!data.source||data.source.length<50)throw new Error('Chapter source was empty or too short.');
          await seriesApi(`/api/episodes/${novelId}`,{method:'POST',body:JSON.stringify({number:Number(ch.number),title:data.title||ch.title||`Chapter ${ch.number}`,source:data.source,translation:''})});
          done++;
          $('fetchStatus').textContent=`Imported ${done}/${pending.length} • Chapter ${ch.number}`;
        }catch(e){
          failed++;
          errors.push(`Chapter ${ch.number}: ${e.message}`);
        }
      }

      if(typeof loadNovel==='function')await loadNovel();
      const summary=`Series import complete • ${done} imported • ${skipped} skipped • ${failed} failed`;
      $('fetchStatus').textContent=summary;
      if(typeof setStatus==='function')setStatus(failed?`${summary}\n${errors.slice(0,5).join(' | ')}`:summary,true);
    }catch(e){
      $('fetchStatus').textContent='Fetch failed.';
      if(typeof setStatus==='function')setStatus(e.message);
    }finally{
      button.disabled=false;
    }
  }

  // Replace the original single-chapter handler with the series-aware handler.
  $('fetchChapterBtn').onclick=importSeries;
  $('chapterUrl').placeholder='Paste NovelPing chapter URL or series URL';
})();
