(function(){
  const $=id=>document.getElementById(id);
  if(!$('batchBtn'))return;
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  async function requestNotifications(){if(!('Notification' in window))return false;if(Notification.permission==='granted')return true;if(Notification.permission==='denied')return false;try{return (await Notification.requestPermission())==='granted'}catch{return false}}
  function notify(title,body,tag='batch'){if(!('Notification' in window)||Notification.permission!=='granted')return;try{const n=new Notification(title,{body,tag});n.onclick=()=>{window.focus();n.close()}}catch{}}
  function setEpisodeUI(e){currentEpisode=e;$('episodeNumber').value=e.number??'';$('episodeTitle').value=e.title||'';$('source').value=e.source||'';$('translation').value=e.translation||'';$('polishedTranslation').value='';sessionStorage.setItem('episodeId',e.id);updateStats();if($('episodeSelect'))$('episodeSelect').value=e.id}
  function updateEpisodeMeta(e){const i=episodes.findIndex(x=>x.id===e.id);const meta={id:e.id,novel_id:e.novel_id,number:e.number,title:e.title||'',status:e.status||'translated',model:e.model||'',updated_at:e.updated_at||'',hasRaw:!!String(e.source||'').trim(),hasTranslation:!!String(e.translation||'').trim()};if(i>=0)episodes[i]=meta;else episodes.push(meta);episodes.sort((a,b)=>Number(a.number)-Number(b.number));$('episodeSelect').innerHTML=episodes.map(x=>`<option value="${x.id}">#${x.number} ${esc(x.title||'')}</option>`).join('');$('episodeSelect').value=e.id;renderEpisodes()}
  async function getFullEpisode(id){return await api(`/api/episodes/${currentNovel.id}/${id}`)}
  async function saveBatchEpisode(e,translation){const saved=await api(`/api/episodes/${currentNovel.id}/${e.id}`,{method:'PUT',body:JSON.stringify({number:Number(e.number),title:e.title||'',source:e.source||'',translation,status:'translated'})});updateEpisodeMeta(saved);currentEpisode=saved;return saved}
  async function runUntilSuccess(label,phase,fn){
    try{return await fn()}
    catch(error){
      const message=String(error?.message||error);
      const note=label+' • '+phase+' failed; skipping this chapter: '+message;
      $('batchStatus').textContent=note;
      setStatus(note,false);
      throw error;
    }
  }
  async function translateUntilNonEmpty(label,e){
    const p1=await api('/api/translate',{method:'POST',body:JSON.stringify({novelId:currentNovel.id,episodeId:e.id,source:e.source,deferSave:true})});
    if(!String(p1?.translation||'').trim())throw new Error('Phase 1 returned empty output; stopping this chapter rather than repeating the full-chapter request.');
    return p1;
  }
  async function runBatch(allUntranslated=false){
    if(!currentNovel)return alert('Select a novel first.');
    const list=await api(`/api/episodes/${currentNovel.id}/list`);
    const sorted=[...list].sort((a,b)=>Number(a.number)-Number(b.number));
    const onlyUntranslated=allUntranslated||$('batchMode')?.value==='untranslated';
    const chapters=[],skippedMissing=[],skippedTranslated=[],skippedNoRaw=[];
    let start=0,count=0;
    if(allUntranslated){
      for(const e of sorted){
        if(e.hasTranslation)continue;
        if(!e.hasRaw){skippedNoRaw.push(Number(e.number));continue}
        chapters.push(e);
      }
    }else{
      const selectedNumber=Number(currentEpisode?.number);
      const startRaw=$('batchStart').value.trim();
      start=startRaw?Number(startRaw):(Number.isFinite(selectedNumber)&&selectedNumber>0?selectedNumber+1:0);
      count=Number($('batchCount').value);
      if(!Number.isInteger(start)||start<1)return alert('Enter a valid starting chapter number.');
      if(!Number.isInteger(count)||count<1||count>500)return alert('Batch size must be between 1 and 500 chapters.');
      for(let n=start;n<start+count;n++){
        const e=sorted.find(x=>Number(x.number)===n);
        if(!e){skippedMissing.push(n);continue}
        if(onlyUntranslated&&e.hasTranslation){skippedTranslated.push(n);continue}
        if(onlyUntranslated&&!e.hasRaw){skippedNoRaw.push(n);continue}
        chapters.push(e);
      }
    }
    if(!chapters.length){const msg=allUntranslated?'No untranslated chapters with Raw source were found in this novel.':(onlyUntranslated?'No untranslated chapters with Raw source were found in the selected range.':('Batch has no existing chapters in #'+start+'–#'+(start+count-1)+'.'));setStatus(msg,false);notify('Batch stopped',msg,'batch-stop');return}
    const missingText=skippedMissing.length?'\n\nMissing chapter records: '+skippedMissing.join(', ')+'.':'';
    const modeText=allUntranslated?'ALL-UNTRANSLATED mode: every chapter in this novel without a saved translation will be processed.':(onlyUntranslated?'UNTRANSLATED-ONLY mode: chapters already translated will be left untouched.':'Current mode: run every existing chapter in the selected range.');
    const noRawText=skippedNoRaw.length?'\nChapters without Raw source skipped: '+skippedNoRaw.join(', ')+'.':'';
    if(!confirm('Run '+chapters.length+' '+(onlyUntranslated?'untranslated ':'')+'chapters: #'+chapters[0].number+'–#'+chapters[chapters.length-1].number+(allUntranslated?' (entire novel)':'')+'?\n'+modeText+missingText+noRawText+'\n\n1. English-to-English polish / cleanup\n2. Auto Glossary extraction + database add (names/entities only)\n3. English-to-Myanmar translation\n4. Myanmar-to-Myanmar polish / run one strong full-chapter corrective pass if validation finds issues\n\nGlossary limits: max 30 through chapter 100; 25 additional through chapter 200; 70 total per novel. Existing/duplicate terms are skipped. dao → တာအို and cultivation → ကျင့်ကြံခြင်း are fixed global terms. Phase 1 and Phase 2 process the complete chapter in one request (no chunking). Every AI task tries 3.1 Flash Lite → 3.5 Flash Lite → 3.1 Flash Lite → 3.5 Flash Lite. If all four attempts fail, skip that chapter and continue. Phase 2 performs only one corrective pass when validation finds issues. Empty source is skipped automatically.'))return;
    const btn=$('batchBtn');const allBtn=$('batchAllUntranslatedBtn');btn.disabled=true;if(allBtn)allBtn.disabled=true;await requestNotifications();$('batchStatus').textContent=`Starting batch • ${chapters.length} chapters${skippedMissing.length?` • ${skippedMissing.length} missing skipped`:''}`;
    let autoStyleNotice='';
    try{
      $('batchStatus').textContent='Analyzing novel genre and translation style with AI...';
      const styleResult=await api('/api/novels/'+encodeURIComponent(currentNovel.id)+'/auto-style',{method:'POST',body:JSON.stringify({})});
      if(styleResult?.style){currentNovel.style=styleResult.style;autoStyleNotice=styleResult.generated?'AI novel style created and saved.':'Existing novel style retained.';}
    }catch(styleError){
      autoStyleNotice='Automatic style analysis unavailable; continuing with existing translation rules. '+String(styleError?.message||styleError);
      console.warn(autoStyleNotice);
    }
    $('batchStatus').textContent=autoStyleNotice||`Starting batch • ${chapters.length} chapters${skippedMissing.length?` • ${skippedMissing.length} missing skipped`:''}`;

    let completed=0,skipped=skippedMissing.length+skippedNoRaw.length,emptySkipped=0,polishSkipped=0;const skippedReasons=[...skippedMissing.map(n=>`#${n}: chapter not found`),...skippedNoRaw.map(n=>`#${n}: Raw source is empty`)];const polishErrors=[];
    try{
      for(let i=0;i<chapters.length;i++){
        const meta=chapters[i];const label=`Chapter ${meta.number} (${i+1}/${chapters.length})`;
        try{
        $('batchStatus').textContent=`${label} • Loading...`;setStatus(`${label} • Loading source...`,true);
        const e=await runUntilSuccess(label,'Loading',()=>getFullEpisode(meta.id));setEpisodeUI(e);
        if(!String(e.source||'').trim()){skipped++;emptySkipped++;skippedReasons.push(`#${e.number}: source is empty`);$('batchStatus').textContent=`${label} • skipped — source data is empty`;setStatus(`${label} skipped — source data is empty. Continuing batch...`,false);continue}
        $('batchStatus').textContent=`${label} • English cleanup / filter (Glossary API)...`;
        const rawSource=String(e.source||'');
        let cleanedSource='';
        try{
          const cleaned=await api('/api/clean-chapter',{method:'POST',body:JSON.stringify({source:rawSource})});
          cleanedSource=String(cleaned?.source||'').trim();
          if(!cleanedSource)throw new Error('English cleanup returned empty text.');
          $('batchStatus').textContent=label+' • English cleanup completed.';
        }catch(cleanError){
          console.warn(label+' • English cleanup failed after 4 model attempts; skipping chapter:',String(cleanError?.message||cleanError));
          $('batchStatus').textContent=label+' • cleanup failed • skipping chapter...';
          throw cleanError;
        }
        e.source=cleanedSource;
        $('source').value=cleanedSource;
        updateStats();
        $('batchStatus').textContent=label+' • Auto Glossary extraction / database add...';
        const glossaryResult=await runUntilSuccess(label,'Auto Glossary',()=>api('/api/auto-glossary',{method:'POST',body:JSON.stringify({novelId:currentNovel.id,chapterNo:Number(e.number),source:cleanedSource})}));
        $('batchStatus').textContent=label+' • Glossary +'+Number(glossaryResult.added||0)+' ('+Number(glossaryResult.total||0)+'/'+Number(glossaryResult.limit||70)+')';
        $('batchStatus').textContent=`${label} • Phase 1 Translate (complete chapter)...`;
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
        try{
          $('batchStatus').textContent=`${label} • Phase 2 Polish...`;
          const p2=await api('/api/polish',{method:'POST',body:JSON.stringify({novelId:currentNovel.id,episodeId:e.id,translation:p1.translation})});
          if(p2.phase2OutputAccepted===true&&String(p2.translation||'').trim()){
            finalText=p2.translation;
            if(p2.validationWarnings?.length)console.warn(`#${e.number}: Phase 2 output accepted with non-blocking warnings:`,p2.validationWarnings);
            $('polishedTranslation').value=finalText;
            updateStats();
          }else if(p2.polishFallback===true&&p2.phase2Failed===true&&String(p2.translation||'').trim()){
            finalText=p1.translation;
            polishSkipped++;
            polishErrors.push(`#${e.number}: Phase 2 request returned the configured Phase 1 fallback. ${p2.fallbackReason||''}`);
            $('polishedTranslation').value='';
            $('batchStatus').textContent=`${label} • Phase 2 fallback • saving Phase 1...`;
            updateStats();
          }else{
            if(p2.validated===false||p2.polishFallback||!String(p2.translation||'').trim())throw new Error('Phase 2 did not return an accepted final translation. '+(p2.validationWarnings||[]).join('; '));
            finalText=p2.translation;
            $('polishedTranslation').value=finalText;
            updateStats();
          }
        }catch(polishError){
          polishSkipped++;polishErrors.push(`#${e.number}: Phase 2 failed; saved Phase 1 translation instead. ${polishError.message||'Polish failed'}`);
          finalText=p1.translation;
          $('polishedTranslation').value='';$('translation').value=finalText;updateStats();
          $('batchStatus').textContent=`${label} • Phase 2 failed • saving Phase 1 result...`;
        }
        $('batchStatus').textContent=`${label} • Saving...`;const saved=await runUntilSuccess(label,'Save',()=>saveBatchEpisode(e,finalText));setEpisodeUI({...saved,source:e.source||saved.source||'',translation:finalText});completed++;$('batchStatus').textContent=`${label} • Saved • ${completed}/${chapters.length}`;setStatus(`Batch progress: ${completed}/${chapters.length} saved${skipped?` • ${skipped} skipped`:''}`,true);await sleep(500);
        }catch(chapterError){
          const message=String(chapterError?.message||chapterError);
          skipped++;skippedReasons.push('#'+meta.number+': '+message);
          $('batchStatus').textContent=label+' • error/blocked • continuing to next chapter...';
          setStatus(label+' failed: '+message+'; continuing batch...',false);
          continue;
        }
      }
      await loadEpisodeSummary().catch(()=>{});
      const summary=`Batch complete • ${completed}/${chapters.length} saved${skipped?` • ${skipped} skipped`:''}${polishSkipped?` • ${polishSkipped} Pass 2 skipped`:''}`;$('batchStatus').textContent=summary;const detail=[...skippedReasons.slice(0,10),...polishErrors.slice(0,5)];setStatus(detail.length?`${summary}\n${detail.join(' | ')}`:summary,true);saveNotice(summary);notify('Batch completed ✓',`${summary}.`,'batch-complete');
    }catch(e){$('batchStatus').textContent=`Batch stopped • ${completed}/${chapters.length} saved • ${skipped} skipped`;setStatus(e.message||'Batch stopped.',false)}finally{btn.disabled=false;if(allBtn)allBtn.disabled=false}
  }
  $('batchBtn').onclick=()=>runBatch(false).catch(e=>{$('batchStatus').textContent='Batch stopped.';setStatus(e.message||'Batch stopped.',false);$('batchBtn').disabled=false});
  if($('batchAllUntranslatedBtn'))$('batchAllUntranslatedBtn').onclick=()=>runBatch(true).catch(e=>{$('batchStatus').textContent='Batch stopped.';setStatus(e.message||'Batch stopped.',false);$('batchBtn').disabled=false;$('batchAllUntranslatedBtn').disabled=false});
})();
