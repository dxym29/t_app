(function(){
  const $=id=>document.getElementById(id);
  if(!$('batchBtn'))return;
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const RETRY_DELAY=5000;
  function isQuotaError(error){const text=String(error?.message||error||'').toLowerCase();return /quota