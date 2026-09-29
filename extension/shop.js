(() => {
 let job,running=false,acted=false;
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 const send=async(type,data={})=>{const r=await chrome.runtime.sendMessage({type,id:job?.id,index:job?.index,...data});if(r?.error)throw Error(r.error);return r;};
 const el=(tag,value)=>{const n=document.createElement(tag);if(value)n.textContent=value;return n;};
 const host=el('div');host.id='shidan-cart-assistant';const root=host.attachShadow({mode:'closed'});
 const style=el('style');style.textContent=':host{all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483647;font:14px/1.6 system-ui;color:#182d41}section{width:min(360px,calc(100vw - 32px));max-height:80vh;overflow:auto;box-sizing:border-box;background:white;border:2px solid #176659;border-radius:12px;padding:16px;box-shadow:0 4px 28px #0003}h2{font-size:18px;margin:0 0 8px}p{margin:8px 0;overflow-wrap:anywhere}button,select{font:inherit;border:1px solid #176659;border-radius:6px;padding:8px;margin:4px 4px 0 0;max-width:100%}button{cursor:pointer;background:#176659;color:white}button:disabled{opacity:.5;cursor:default}button:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid #edb953}img{width:140px;height:160px;object-fit:contain;background:#f2f5f8}figure{margin:0}label{display:block;margin:8px 0}';
 root.append(style);const panel=el('section');panel.setAttribute('aria-label','拾单加购助手');root.append(panel);
 function status(message){panel.replaceChildren(el('h2','拾单 · 加购助手'),el('p',message),el('p','只加入购物车，不填写地址、不下单、不付款。'));}
 async function fail(error){const reason=error.message||String(error);const type=error.definitive?'SD_FAIL':'SD_REVIEW';status((error.definitive?'加购失败：':'需人工核对：')+reason);try{await send(type,{reason});}catch(e){status('已停止：'+e.message);}}
 async function run(){
  if(running)return;running=true;
  try{
   job=(await send('SD_STATE')).job;if(!job)return;
   document.documentElement.append(host);const adapter=globalThis.ShidanAdapters[job.merchant?.type];if(!adapter)throw Error('无法识别商家规则');
   status(`第 ${job.index+1} 条：${job.item.sku} · ${job.item.size} · ${job.item.added}/${job.item.quantity} 件`);
   if(job.stage==='queued'){status('商品页已打开；上一批结束后会继续核对本批。可以返回拾单继续选单。');return;}
   if(job.stage==='baseline' && location.pathname!==job.merchant.cartPath){status('已打开订单商品页，正在读取购物车。可以返回拾单继续选单。');return;}
   if(location.pathname===job.merchant.cartPath&&['baseline','verify'].includes(job.stage)){
    await sleep(12000);const first=await adapter.cart();await sleep(1000);const second=await adapter.cart();
    if(JSON.stringify(first)!==JSON.stringify(second))throw Error('购物车正在变化，请人工核对');await send('SD_CART',{cart:second});return;
   }
   // The checkpoint is saved before adding. Reloading never repeats an add.
   if(job.stage==='verify'){await send('SD_GO_CART');return;}
   if(job.stage==='search'){
    const found=await adapter.search(job.item);const target=new URL(found);
    if(job.item.url){const expected=new URL(job.item.url);if(!globalThis.ShidanAdapters.sameOrigin(expected.href,target.href)||expected.pathname!==target.pathname)throw Error('订单链接与货号搜索结果不一致');}
    await send('SD_PRODUCT',{url:found});return;
   }
   const target=new URL(job.product);
   if(job.stage!=='product'||!globalThis.ShidanAdapters.sameOrigin(location.href,target.href)||location.pathname!==target.pathname)throw Error('商家页面已改变，请人工核对');
   const mainImage=await adapter.mainImage();
   if(!mainImage||!mainImage.startsWith('https://'))throw Error('网页主图无法读取');
   await send('SD_IMAGE',{image:mainImage});
   const choices=await adapter.choices(job.item);if(!choices.length)throw Error('没有可确认的商品规格');
   if(choices.length!==1)throw Error('货号与目标尺码对应多个规格，需人工核对');
   const choice=choices[0];
   await choice.activate();await choice.validate();
   if(!choice.photo||!choice.photo.startsWith('https://'))throw Error('网页主图无法读取');
   const quote=await choice.readPrice();quote.url=job.product;
   await send('SD_IMAGE',{image:choice.photo});await send('SD_QUOTE',{quote});
   status('货号唯一匹配，目标尺码有货，正在自动加入 1 件…');
   await choice.validate();const latest=await choice.readPrice();latest.url=job.product;
   if(['price','originalPrice','currency'].some(k=>latest[k]!==quote[k]))throw Error('网页价格已变化，无法确认当前商品');
   if(acted)return;
   const armed=await send('SD_ARM',{sku:job.item.sku,key:choice.key,quote:latest});
   if(!armed.armed)throw Error('批次已停止');
   acted=true;await choice.validate();await choice.add();
   status('正在核验购物车；结果不明不会重复加购…');await sleep(5000);await send('SD_GO_CART');
  }catch(e){if(job)await fail(e);}
  finally{running=false;}
 }
 run();
})();
