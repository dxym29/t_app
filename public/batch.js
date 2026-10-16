(function(){
  const $=id=>document.getElementById(id);
  if(!$('batchBtn'))return;

  const sleep=ms=>new Promise(r=>setTimeout(r,ms));

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

  async function getFullEpisode(id){
    return await api(`/api/episodes/${currentNovel.id}/${id}`);
  }

  async function saveBatchEpisode(e,translation){
    const saved=await api(`/api/episodes/${currentNovel.id}/${e.id}`,{
      method:'PUT',
      body:JSON.stringify({
        number:Number(e.number),
        title:e.title||'',
        source:e.source||'',
        translation,
        status:'translated'
      })
    });
    updateEpisodeMeta(saved);
    currentEpisode=saved;
    return saved;
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
        return;
      }
      chapters.push(e);
    }

    if(!confirm(`Run ${count} chapters: #${start}–#${start+count-1}?\n\nEach chapter will run:\n1. Pass 1 Translate\n2. Pass 2 Polish\n3. Save final result\n\nIf Pass 1 fails, the batch stops.\nIf Pass 2 fails, Pass 1 is saved and the batch continues.`))return;

    const btn=$('batchBtn');
    btn.disabled=true;
    $('batchStatus').textContent=`Starting batch • ${count} chapters`;

    let completed=0,polishSkipped=0;
    const polishErrors=[];

    try{
      for(let i=0;i<chapters.length;i++){
        const meta=chapters[i];
        const label=`Chapter ${meta.number} (${i+1}/${count})`;
        $('batchStatus').textContent=`${label} • Loading...`;
        setStatus(`${label} • Loading source...`,true);

        const e=await getFullEpisode(meta.id);
        setEpisodeUI(e);

        if(!String(e.source||'').trim()){
          throw new Error(`${label}: source is empty. Batch stopped.`);
        }

        // Phase 1 — use the existing translation endpoint and logic exactly as normal.
        $('batchStatus').textContent=`${label} • Phase 1 Translate...`;
        const p1=await api('/api/translate',{
          method:'POST',
          body:JSON.stringify({
            novelId:currentNovel.id,
            episodeId:e.id,
            source:e.source
          })
        });
        $('translation').value=p1.translation||'';
        $('polishedTranslation').value='';
        currentEpisode.translation=p1.translation||'';
        updateStats();

        if(!String(p1.translation||'').trim()){
          throw new Error(`${label}: Phase 1 returned empty translation. Batch stopped.`);
        }

        // Phase 2 — use the existing polish endpoint. A failure here is non-fatal.
        let finalText=p1.translation;
        try{
          $('batchStatus').textContent=`${label} • Phase 2 Polish...`;
          const p2=await api('/api/polish',{
            method:'POST',
            body:JSON.stringify({
              novelId:currentNovel.id,
              episodeId:e.id,
              translation:p1.translation
            })
          });
          if(!String(p2.translation||'').trim())throw new Error('Polish returned empty output.');
          finalText=p2.translation;
          $('polishedTranslation').value=finalText;
          updateStats();
        }catch(polishError){
          polishSkipped++;
          polishErrors.push(`#${e.number}: ${polishError.message}`);
          $('polishedTranslation').value='';
          updateStats();
          $('batchStatus').textContent=`${label} • Polish failed → saving Pass 1 and continuing...`;
        }

        // Save exactly one chapter at a time. Pass 2 if available; otherwise Pass 1.
        $('batchStatus').textContent=`${label} • Saving...`;
        const saved=await saveBatchEpisode(e,finalText);
        setEpisodeUI({...saved,source:e.source||saved.source||'',translation:finalText});
        completed++;
        $('batchStatus').textContent=`${label} • Saved • ${completed}/${count}`;
        setStatus(`Batch progress: ${completed}/${count} saved`,true);
        await sleep(500);
      }

      const summary=`Batch complete • ${completed}/${count} saved${polishSkipped?` • ${polishSkipped} Pass 2 skipped`:''}`;
      $('batchStatus').textContent=summary;
      setStatus(polishErrors.length?`${summary}\n${polishErrors.slice(0,5).join(' | ')}`:summary,true);
      saveNotice(summary);
    }catch(e){
      $('batchStatus').textContent=`Batch stopped • ${completed}/${count} saved`;
      setStatus(e.message||'Batch failed. Process stopped.',false);
    }finally{
      btn.disabled=false;
    }
  }

  $('batchBtn').onclick=()=>runBatch().catch(e=>{
    $('batchStatus').textContent='Batch failed.';
    setStatus(e.message||'Batch failed.',false);
    $('batchBtn').disabled=false;
  });
})();
