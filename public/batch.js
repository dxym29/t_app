(function(){
  const $=id=>document.getElementById(id);
  if(!$('batchBtn'))return;
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const RETRY_DELAY=5000;
  function isQuotaError(error){const text=String(error?.message||error||'').toLowerCase();return /quota|resource exhausted|rate.?limit|too many requests|\b429\b|exceeded.*limit|limit.*exceeded/.test(text)}
  async function requestNotifications(){if(!('Notification' in window))return false;if(Notification.permission==='granted')return true;if(Notification.permission==='denied')return false;try{return (await Notification.requestPermission())==='granted'}catch{return false}}
  function notify(title,body,tag='batch'){if(!('Notification' in window)||Notification.permission!=='granted')return;try{const n=new Notification(title,{body,tag});n.onclick=()=>{window.focus();n.close()}}catch{}}
  function setEpisodeUI(e){currentEpisode=e;$('episodeNumber').value=e.number??'';$('episodeTitle').value=e.title||'';$('source').value=e.source||'';$('translation').value=e.translation||'';$('polishedTranslation').value='';localStorage.setItem('episodeId',e.id);updateStats();if($('episodeSelect'))$('episodeSelect').value=e.id}
  function updateEpisodeMeta(e){const i=episodes.findIndex(x=>x.id===e.id);const meta={id:e.id,novel_id:e.novel_id,number:e.number,title:e.title||'',status:e.status||'translated',model:e.model||'',updated_at:e.updated_at||''};if(i>=0)episodes[i]=meta;else episodes.push(meta);episodes.sort((a,b)=>Number(a.number)-Number(b.number));$('episodeSelect').innerHTML=episodes.map(x=>`<option value="${x.id}">#${x.number} ${esc(x.title||'')}</option>`).join('');$('episodeSelect').value=e.id;renderEpisodes()}
  async function getFullEpisode(id){return await api(`/api/episodes/${currentNovel.id}/${id}`)}
  async function saveBatchEpisode(e,translation){const saved=await api(`/api/episodes/${currentNovel.id}/${e.id}`,{method:'PUT',body:JSON.stringify({number:Number(e.number),title:e.title||'',source:e.source||'',translation,status:'translated'})});updateEpisodeMeta(saved);currentEpisode=saved;return saved}
  async function runUntilSuccess(label,phase,fn){
    let attempt=0;
    while(attempt<3){
      attempt++;
      try{return await fn()}
      catch(error){
        const message=String(error?.message||error);
        if(/PROHIBITED_CONTENT|prompt.?block|safety.?block/i.test(message)){
          const note=`${label} • ${phase} blocked by Gemini PROHIBITED_CONTENT; skipping this chapter without retry.`;
          $('batchStatus').textContent=note;setStatus(note,false);throw error;
        }
        if(attempt>=3)throw error;
        const quota=isQuotaError(error),delay=RETRY_DELAY;
        $('batchStatus').textContent=`${label} • ${phase} error (attempt ${attempt}/3${quota?' • quota/rate limit':''}) • retrying in ${delay/1000}s...`;
        setStatus(`${label} • ${phase} failed${quota?' (quota/rate limit)':''}. Retry ${attempt}/3...`,false);
        await sleep(delay);
      }
    }
    throw new Error(`${label} • ${phase} failed after 3 attempts.`);
  }
  async function translateUntilNonEmpty(label,e){
    const p1=await api('/api/translate',{method:'POST',body:JSON.stringify({novelId:currentNovel.id,episodeId:e.id,source:e.source})});
    if(!String(p1?.translation||'').trim())throw new Error('Phase 1 returned empty output; stopping this chapter rather than repeating the full-chapter request.');
    return p1;
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
    if(!Number.isInteger(count)||count<1||count>500)return alert('Batch size must be between 1 and 500 chapters.');
    const chapters=[];const skippedMissing=[];
    for(let n=start;n<start+count;n++){const e=sorted.find(x=>Number(x.number)===n);if(!e){skippedMissing.push(n);continue}chapters.push(e)}
    if(!chapters.length){setStatus(`Batch has no existing chapters in #${start}–#${start+count-1}.`,false);notify('Batch stopped',`No existing chapters in #${start}–#${start+count-1}.`,'batch-stop');return}
    const missingText=skippedMissing.length?`\n\nMissing chapters will be skipped automatically: ${skippedMissing.join(', ')}.`:'';
    if(!confirm(`Run ${chapters.length} available chapters: #${chapters[0].number}–#${chapters[chapters.length-1].number}?${missingText}\n\n1. Pass 1 Translate\n2. Pass 2 Polish\n3. Save final result\n\nEnglish cleanup uses one Glossary API request per chapter. Translation sends the whole cleaned chapter as one chunk. PROHIBITED_CONTENT skips the chapter without retry. Translation stops after a maximum of two attempts on the same model for other non-quota errors. Phase 2 errors are skipped and Pass 1 is saved. Empty source is skipped automatically.`))return;
    const btn=$('batchBtn');btn.disabled=true;await requestNotifications();$('batchStatus').textContent=`Starting batch • ${chapters.length} chapters${skippedMissing.length?` • ${skippedMissing.length} missing skipped`:''}`;
    let completed=0,skipped=skippedMissing.length,emptySkipped=0,polishSkipped=0;const skippedReasons=skippedMissing.map(n=>`#${n}: chapter not found`);const polishErrors=[];
    try{
      for(let i=0;i<chapters.length;i++){
        const meta=chapters[i];const label=`Chapter ${meta.number} (${i+1}/${chapters.length})`;$('batchStatus').textContent=`${label} • Loading...`;setStatus(`${label} • Loading source...`,true);
        const e=await runUntilSuccess(label,'Loading',()=>getFullEpisode(meta.id));setEpisodeUI(e);
        if(!String(e.source||'').trim()){skipped++;emptySkipped++;skippedReasons.push(`#${e.number}: source is empty`);$('batchStatus').textContent=`${label} • skipped — source data is empty`;setStatus(`${label} skipped — source data is empty. Continuing batch...`,false);continue}
        $('batchStatus').textContent=`${label} • English cleanup / filter (Glossary API)...`;
        try{
          const cleaned=await api('/api/clean-chapter',{method:'POST',body:JSON.stringify({source:e.source})});
          const cleanedSource=String(cleaned?.source||'').trim();
          if(!cleanedSource)throw new Error('Glossary API English cleanup returned empty text.');
          e.source=cleanedSource;
          $('source').value=cleanedSource;
          updateStats();
        }catch(cleanError){
          const cleanMessage=String(cleanError?.message||cleanError);
          if(/PROHIBITED_CONTENT|prompt.?block|safety.?block|CONTENT_BLOCKED/i.test(cleanMessage)){
            skipped++;skippedReasons.push('#'+e.number+': PROHIBITED_CONTENT during English cleanup; no retry.');
            $('batchStatus').textContent=label+' • skipped — English cleanup blocked';
            setStatus(label+' skipped because English cleanup was blocked. Continuing to next chapter...',false);
            continue;
          }
          throw cleanError;
        }
        $('batchStatus').textContent=`${label} • Phase 1 Translate (single full-chapter chunk)...`;
        let p1;
        try{p1=await translateUntilNonEmpty(label,e)}catch(translateError){
          const translateMessage=String(translateError?.message||translateError);
          if(translateMessage.startsWith('SKIP_CHAPTER:')||translateError?.code==='CONTENT_BLOCKED'||translateError?.code==='QUOTA_EXHAUSTED'){
            skipped++;skippedReasons.push('#'+e.number+': '+translateMessage.replace(/^SKIP_CHAPTER:\\s*/,''));
            const reason=translateError?.code==='QUOTA_EXHAUSTED'?'all translation APIs are out of quota':'Gemini content filter or chapter block';
            $('batchStatus').textContent=label+' • skipped — '+reason;
            setStatus(label+' skipped — '+reason+'. Continuing to next chapter...',false);
            continue;
          }
          throw translateError;
        }
        $('translation').value=p1.translation;$('polishedTranslation').value='';currentEpisode.translation=p1.translation;updateStats();
        let finalText=p1.translation;
        try{$('batchStatus').textContent=`${label} • Phase 2 Polish...`;const p2=await api('/api/polish',{method:'POST',body:JSON.stringify({novelId:currentNovel.id,episodeId:e.id,translation:p1.translation})});if(!String(p2.translation||'').trim())throw new Error('Polish returned empty output.');finalText=p2.translation;$('polishedTranslation').value=finalText;updateStats()}catch(polishError){polishSkipped++;polishErrors.push(`#${e.number}: ${polishError.message||'Polish failed'}`);finalText=p1.translation;$('polishedTranslation').value='';updateStats();$('batchStatus').textContent=`${label} • Phase 2 error → skipping Polish, saving Pass 1...`}
        $('batchStatus').textContent=`${label} • Saving...`;const saved=await runUntilSuccess(label,'Save',()=>saveBatchEpisode(e,finalText));setEpisodeUI({...saved,source:e.source||saved.source||'',translation:finalText});completed++;$('batchStatus').textContent=`${label} • Saved • ${completed}/${chapters.length}`;setStatus(`Batch progress: ${completed}/${chapters.length} saved${skipped?` • ${skipped} skipped`:''}`,true);await sleep(500);
      }
      const summary=`Batch complete • ${completed}/${chapters.length} saved${skipped?` • ${skipped} skipped`:''}${polishSkipped?` • ${polishSkipped} Pass 2 skipped`:''}`;$('batchStatus').textContent=summary;const detail=[...skippedReasons.slice(0,10),...polishErrors.slice(0,5)];setStatus(detail.length?`${summary}\n${detail.join(' | ')}`:summary,true);saveNotice(summary);notify('Batch completed ✓',`${summary}.`,'batch-complete');
    }catch(e){$('batchStatus').textContent=`Batch stopped • ${completed}/${chapters.length} saved • ${skipped} skipped`;setStatus(e.message||'Batch stopped.',false)}finally{btn.disabled=false}
  }
  $('batchBtn').onclick=()=>runBatch().catch(e=>{$('batchStatus').textContent='Batch stopped.';setStatus(e.message||'Batch stopped.',false);$('batchBtn').disabled=false});
})();
