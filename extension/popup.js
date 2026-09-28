const status=document.querySelector('#status'),list=document.querySelector('#list');
let current;
async function refresh(){try{const result=await chrome.runtime.sendMessage({type:'SD_POPUP'});if(result.error)throw Error(result.error);current=result.job;list.replaceChildren();status.textContent=current?(current.done?'本批已结束，请核对购物车与需人工核对条目':'正在处理，请到商家页面核对图片'):'请先在拾单点击“开始加购”';document.querySelector('#stop').disabled=!current||current.done;document.querySelector('#open').disabled=!current;
for(const r of current?.items||[]){const item=document.createElement('article');item.textContent=`${r.sku} · ${r.size}码 · 已加 ${r.added}/${r.quantity} 件 · ${{pending:'处理中',added:'已加购',review:'需人工核对',failed:'加购失败'}[r.status]} ${r.reason||''}`;list.append(item);}}catch(error){status.textContent=error.message;}}
document.querySelector('#refresh').onclick=refresh;
document.querySelector('#open').onclick=async()=>{try{await chrome.tabs.update(current.tabId,{active:true});}catch{status.textContent='商家标签页已关闭，请回到拾单核对结果';}};
document.querySelector('#stop').onclick=async()=>{await chrome.runtime.sendMessage({type:'SD_STOP'});await refresh();};refresh();
