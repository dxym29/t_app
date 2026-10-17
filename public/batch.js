(function(){
  const $=id=>document.getElementById(id);
  if(!$('batchBtn'))return;

  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const RETRY_DELAY=10000;

  function isQuotaError(error){
    const text=String(error?.message||error||'').toLowerCase();
    return /quota|resource exhausted|rate.?limit|too many requests|\b429\b|exceeded.*limit|limit.*exceeded/.test(text);
  }

  async function requestNotifications(){
    if(!('Notification' in window))return false;
    if(Notification.permission==='granted')return true;
    if(Notification.permission==='denied')return false;
    try{return (await Notification.requestPermission())==='granted'}catch{return false}
  }

  function notify(title,body,tag='batch'){
    if(!('Notification' in window)||Notification.permission!=='granted')return;
    try{
      const n=new Notification(title,{body,tag});
      n.onclick=()=>{window.focus();n.close()};
    }catch{}
  }

  function setEpisodeUI(e){
    currentEpisode=e;
    $('episodeNumber').value=e.number??'';
    $('episodeTitle').value=e.title||'';
    $('source').value=e.source||'';
    $('translation').value=e.translation||'';
    $('polishedTranslation').value='';
    localStorage.setItem('episodeId',e.id);
    updateStats();
    if($('episodeSelect'))$('episodeSelect').value=e.id;
  }

  function updateEpisodeMeta(e){
    const i=episodes.findIndex(x=>x.id===e.id);
    const meta={id:e.id,novel_id:e.novel_id,number:e.number,title:e.title||'',status:e.status||'translated',model:e.model||'',updated_at:e.updated_at||''};
    if(i>=0)episodes[i]=meta;else episodes.push(meta);
    episodes.sort((a,b)=>Number(a.number)-Number(b.number));
    $('episodeSelect').innerHTML=episodes.map(x=>`<option value="${x.id}">#${x.number} ${esc(x.title||'')}</option>`).join('');
    $('episodeSelect').value=e.id;
    renderEpisodes();
  }

  async function getFullEpisode(id){return await api(`/api/episodes/${currentNovel.id}/${id}`)}

  async function saveBatchEpisode(e,translation){
    const saved=await api(`/api/episodes/${currentNovel.id}/${e.id}`,{
      method:'PUT',
      body:JSON.stringify({number:Number(e.number),title:e.title||'',source:e.source||'',translation,status:'translated'})
    });
    updateEpisodeMeta(saved);
    currentEpisode=saved;
    return saved;
  }

  async function runUntilSuccess(label,phase,fn){
    let attempt=0;
    while(true){
      attempt++;
      try{return await fn()}
      catch(error){
        if(isQuotaError(error)){
          notify('Batch stopped — quota exceeded',`${label} • ${phase} hit a quota/rate limit.`, 'batch-quota');
          throw new Error(`${label}: ${phase} stopped because quota/rate limit was exceeded.`)
        }
        $('batchStatus').textContent=`${label} • ${phase} error (attempt ${attempt}) • retrying in ${RETRY_DELAY/1000}s...`;
        setStatus(`${label} • ${phase} failed. Retrying automatically...`,false);
        await sleep(RETRY_DELAY);
      }
    }
  }

  async function runBatch(){
    if(!currentNovel)return alert('Select a novel first.');

    const list=await api(`/api/episodes/${currentNovel.id}/list`);
    const sorted=[...list].sort((a,b)=>Number(a.number)-Number(b.number));
    const selectedNumber=Number(currentEpisode?.number);
    const startRaw=$('batchStart').value.trim();
    const start=startRaw?Number(startRaw):(Number.isFinite(selectedNumber)&&selectedNumber>0?selectedNumber+1:0);
    const count=Number($('batchCount').value);

    if(!Number.isInteger(start)||start<1)return alert('Enter a valid starting chapter number.');
    if(!Number.isInteger(count)||count<1||count>100)return alert('Batch size must be between 1 and 100 chapters.');

    const chapters=[];
    for(let n=start;n<start+count;n++){
      const e=sorted.find(x=>Number(x.number)===n);
      if(!e){
        setStatus(`Batch stopped: Chapter ${n} was not found. No later chapters were processed.`,false);
        notify('Batch stopped',`Chapter ${n} was not found.`, 'batch-stop');
        return;
      }
      chapters.push(e);
    }

    if(!confirm(`Run ${count} chapters: #${start}–#${start+count-1}?\n\nEach chapter will run:\n1. Pass 1 Translate\n2. Pass 2 Polish\n3. Save final result\n\nQuota/rate-limit errors stop the batch.\nOther errors retry the same phase automatically until it succeeds.`))return;

    const btn=$('batchBtn');
    btn.disabled=true;
    await requestNotifications();
    $('batchStatus').textContent=`Starting batch • ${count} chapters`;

    let completed=0;

    try{
      for(let i=0;i<chapters.length;i++){
        const meta=chapters[i];
        const label=`Chapter ${meta.number} (${i+1}/${count})`;
        $('batchStatus').textContent=`${label} • Loading...`;
        setStatus(`${label} • Loading source...`,true);

        const e=await runUntilSuccess(label,'Loading',()=>getFullEpisode(meta.id));
        setEpisodeUI(e);

        if(!String(e.source||'').trim()){
          throw new Error(`${label}: source is empty. Batch stopped.`);
        }

        // Phase 1 — existing translation endpoint. Non-quota errors retry forever.
        $('batchStatus').textContent=`${label} • Phase 1 Translate...`;
        const p1=await runUntilSuccess(label,'Phase 1 Translate',()=>api('/api/translate',{
          method:'POST',
          body:JSON.stringify({novelId:currentNovel.id,episodeId:e.id,source:e.source})
        }));
        $('translation').value=p1.translation||'';
        $('polishedTranslation').value='';
        currentEpisode.translation=p1.translation||'';
        updateStats();
        if(!String(p1.translation||'').trim())throw new Error(`${label}: Phase 1 returned empty translation.`);

        // Phase 2 — existing polish endpoint. Non-quota errors retry forever.
        $('batchStatus').textContent=`${label} • Phase 2 Polish...`;
        const p2=await runUntilSuccess(label,'Phase 2 Polish',()=>api('/api/polish',{
          method:'POST',
          body:JSON.stringify({novelId:currentNovel.id,episodeId:e.id,translation:p1.translation})
        }));
        if(!String(p2.translation||'').trim())throw new Error(`${label}: Polish returned empty output.`);
        const finalText=p2.translation;
        $('polishedTranslation').value=finalText;
        updateStats();

        // Save exactly one chapter at a time.
        $('batchStatus').textContent=`${label} • Saving...`;
        const saved=await runUntilSuccess(label,'Save',()=>saveBatchEpisode(e,finalText));
        setEpisodeUI({...saved,source:e.source||saved.source||'',translation:finalText});
        completed++;
        $('batchStatus').textContent=`${label} • Saved • ${completed}/${count}`;
        setStatus(`Batch progress: ${completed}/${count} saved`,true);
        await sleep(500);
      }

      const summary=`Batch complete • ${completed}/${count} saved`;
      $('batchStatus').textContent=summary;
      setStatus(summary,true);
      saveNotice(summary);
      notify('Batch completed ✓',`${summary}. All chapters were translated, polished, and saved.`, 'batch-complete');
    }catch(e){
      $('batchStatus').textContent=`Batch stopped • ${completed}/${count} saved`;
      setStatus(e.message||'Batch stopped.',false);
    }finally{
      btn.disabled=false;
    }
  }

  $('batchBtn').onclick=()=>runBatch().catch(e=>{
    $('batchStatus').textContent='Batch stopped.';
    setStatus(e.message||'Batch stopped.',false);
    $('batchBtn').disabled=false;
  });
})();
