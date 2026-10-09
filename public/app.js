const $=id=>document.getElementById(id);
let novels=[], episodes=[], glossary=null, currentNovel=null, currentEpisode=null;

async function api(url, opts={}){const r=await fetch(url,{headers:{'Content-Type':'application/json',...(opts.headers||{})},...opts}); const j=await r.json().catch(()=>({})); if(!r.ok) throw new Error(j.error||'Request failed'); return j}
function esc(s=''){return s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function setStatus(t,ok=false){$('status').textContent=t;$('status').className=ok?'ok':'err'}
async function loadNovels(){
  novels=await api('/api/novels'); $('novelSelect').innerHTML=novels.map(n=>`<option value="${n.id}">${esc(n.name)}</option>`).join('');
  if(!novels.length){currentNovel=null; clearNovel(); return}
  const saved=localStorage.getItem('novelId'); currentNovel=novels.find(n=>n.id===saved)||novels[0]; $('novelSelect').value=currentNovel.id; await loadNovel()
}
function clearNovel(){$('novelName').value='';$('novelStyle').value='';$('episodeSelect').innerHTML='';$('episodes').innerHTML='';$('glossary').innerHTML=''}
async function loadNovel(){
  currentNovel=novels.find(n=>n.id===$('novelSelect').value)||currentNovel; if(!currentNovel)return;
  localStorage.setItem('novelId',currentNovel.id); $('novelName').value=currentNovel.name; $('novelStyle').value=currentNovel.style||'';
  glossary=await api(`/api/glossary/${currentNovel.id}`); renderGlossary();
  episodes=await api(`/api/episodes/${currentNovel.id}`); renderEpisodes();
  $('episodeSelect').innerHTML=episodes.map(e=>`<option value="${e.id}">#${e.number} ${esc(e.title||'')}</option>`).join('');
  const saved=localStorage.getItem('episodeId'); currentEpisode=episodes.find(e=>e.id===saved)||episodes[0]; if(currentEpisode){$('episodeSelect').value=currentEpisode.id; loadEpisode(currentEpisode)}
  else clearEpisode()
}
function clearEpisode(){$('episodeNumber').value='';$('episodeTitle').value='';$('source').value='';$('translation').value='';currentEpisode=null}
function loadEpisode(e){currentEpisode=e;$('episodeNumber').value=e.number;$('episodeTitle').value=e.title||'';$('source').value=e.source||'';$('translation').value=e.translation||'';localStorage.setItem('episodeId',e.id)}
function renderEpisodes(){$('episodes').innerHTML=episodes.map(e=>`<div class="ep"><b>#${e.number} ${esc(e.title||'')}</b><br><small>${esc(e.status||'')}</small></div>`).join('')}
function renderGlossary(){
  const all=[]; for(const type of Object.keys(glossary||{})) for(const x of (glossary[type]||[])) all.push({type,...x});
  $('glossary').innerHTML=all.map(x=>`<div class="term"><button onclick="delTerm('${x.type}','${x.id}')">Delete</button><b>${esc(x.original)} → ${esc(x.translation)}</b><small>${esc(x.type)} ${x.voice?`• ${esc(x.voice)}`:''}<br>${esc(x.note||'')}</small></div>`).join('')
}
async function createNovel(){const name=prompt('Novel name?');if(!name)return;const n=await api('/api/novels',{method:'POST',body:JSON.stringify({name,style:''})});await loadNovels();$('novelSelect').value=n.id;await loadNovel()}
async function createEpisode(){if(!currentNovel)return alert('Create/select a novel first.');const num=Number(prompt('Episode number?'));if(!num)return;const e=await api(`/api/episodes/${currentNovel.id}`,{method:'POST',body:JSON.stringify({number:num,title:'',source:'',translation:''})});await loadNovel();$('episodeSelect').value=e.id;loadEpisode(e)}
async function translate(){
  if(!currentNovel)return alert('Select a novel first.');
  if(!$('source').value.trim())return alert('Paste source text first.');
  setStatus('Translating...',true); $('translateBtn').disabled=true;
  try{const j=await api('/api/translate',{method:'POST',body:JSON.stringify({novelId:currentNovel.id,episodeId:currentEpisode?.id||null,source:$('source').value})});$('translation').value=j.translation;setStatus(`Done • ${j.model}`,true)}
  catch(e){setStatus(e.message)} finally{$('translateBtn').disabled=false}
}
async function saveNovel(){if(!currentNovel)return;const n=await api(`/api/novels/${currentNovel.id}`,{method:'PUT',body:JSON.stringify({name:$('novelName').value,style:$('novelStyle').value})});currentNovel=n;await loadNovels()}
async function saveEpisode(){if(!currentEpisode)return alert('Create/select an episode first.');const e=await api(`/api/episodes/${currentNovel.id}/${currentEpisode.id}`,{method:'PUT',body:JSON.stringify({number:Number($('episodeNumber').value),title:$('episodeTitle').value,source:$('source').value,translation:$('translation').value,status:'translated'})});await loadNovel();currentEpisode=episodes.find(x=>x.id===e.id);loadEpisode(currentEpisode)}
async function addTerm(){if(!currentNovel)return;await api(`/api/glossary/${currentNovel.id}`,{method:'POST',body:JSON.stringify({type:$('termType').value,original:$('termOriginal').value,translation:$('termTranslation').value,note:$('termNote').value,voice:$('termVoice').value})});glossary=await api(`/api/glossary/${currentNovel.id}`);renderGlossary();['termOriginal','termTranslation','termNote','termVoice'].forEach(id=>$(id).value='')}
async function delTerm(type,id){await api(`/api/glossary/${currentNovel.id}/${type}/${id}`,{method:'DELETE'});glossary=await api(`/api/glossary/${currentNovel.id}`);renderGlossary()}
async function exportData(novelOnly=false){const url=novelOnly?`/api/export/novel/${currentNovel.id}`:'/api/export/all';const r=await fetch(url);const blob=await r.blob();const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=novelOnly?`novel-${currentNovel.id}.json`:'webnovel-backup.json';a.click();URL.revokeObjectURL(a.href)}
async function importBackup(file){const text=await file.text();const data=JSON.parse(text);const r=await api('/api/import',{method:'POST',body:JSON.stringify(data)});alert(`Imported ${r.novels} novel(s), ${r.episodes} episode(s).`);await loadNovels()}
$('novelSelect').onchange=loadNovel;$('newNovelBtn').onclick=createNovel;$('saveNovelBtn').onclick=saveNovel;$('newEpisodeBtn').onclick=createEpisode;$('episodeSelect').onchange=()=>loadEpisode(episodes.find(e=>e.id===$('episodeSelect').value));$('translateBtn').onclick=translate;$('copyBtn').onclick=()=>navigator.clipboard.writeText($('translation').value);$('saveEpisodeBtn').onclick=saveEpisode;$('addTermBtn').onclick=addTerm;$('exportNovelBtn').onclick=()=>exportData(true);$('exportAllBtn').onclick=()=>exportData(false);$('importFile').onchange=e=>e.target.files[0]&&importBackup(e.target.files[0]);$('deleteNovelBtn').onclick=async()=>{if(currentNovel&&confirm('Delete this novel?')){await api(`/api/novels/${currentNovel.id}`,{method:'DELETE'});localStorage.removeItem('novelId');await loadNovels()}};$('deleteEpisodeBtn').onclick=async()=>{if(currentEpisode&&confirm('Delete this episode?')){await api(`/api/episodes/${currentNovel.id}/${currentEpisode.id}`,{method:'DELETE'});await loadNovel()}};loadNovels().catch(e=>setStatus(e.message));