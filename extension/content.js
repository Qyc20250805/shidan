(() => {
  const emit = data => window.postMessage({source:'shidan-extension-v2',...data},location.origin);
  window.addEventListener('message',async e=>{
    if(e.source!==window || e.origin!==location.origin || e.data?.source!=='shidan-page-v2') return;
    const {type,requestId,batch,ids,id}=e.data;
    if(!['SD_HELLO','SD_START','SD_POLL','SD_CANCEL'].includes(type))return;
    try { emit({requestId,...await chrome.runtime.sendMessage({type,batch,ids,id})}); }
    catch {emit({requestId,error:'扩展连接中断，请刷新拾单页面后重试'});}
  });
  chrome.runtime.onMessage.addListener((m,sender)=>{if(sender.id===chrome.runtime.id && m.type==='SD_RESULT')emit({result:m.result});});
})();
