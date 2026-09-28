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
   if(location.pathname===job.merchant.cartPath&&['baseline','verify'].includes(job.stage)){
    await sleep(12000);const first=await adapter.cart();await sleep(1000);const second=await adapter.cart();
    if(JSON.stringify(first)!==JSON.stringify(second))throw Error('购物车正在变化，请人工核对');await send('SD_CART',{cart:second});return;
   }
   // The checkpoint is saved before adding. Reloading never repeats an add.
   if(job.stage==='verify'){await send('SD_GO_CART');return;}
   if(job.stage==='search'){
    const found=await adapter.search(job.item);const target=new URL(found);
    if(job.item.url){const expected=new URL(job.item.url);if(expected.origin!==target.origin||expected.pathname!==target.pathname)throw Error('订单链接与货号搜索结果不一致');}
    await send('SD_PRODUCT',{url:found});return;
   }
   const target=new URL(job.product);
   if(job.stage!=='product'||location.origin!==target.origin||location.pathname!==target.pathname)throw Error('商家页面已改变，请人工核对');
   const choices=await adapter.choices(job.item);if(!choices.length)throw Error('没有可确认的商品规格');
   panel.replaceChildren(el('h2','请核对图片、颜色和尺码'));
   panel.append(el('p',`${job.merchant.name} · 订单 ${job.item.sku} · ${job.item.size} · ${job.item.quantity}件（已加 ${job.item.added}）`));
   if(job.item.color)panel.append(el('p','订单颜色：'+job.item.color));
   const select=el('select');select.setAttribute('aria-label','选择与订单图片一致的颜色规格');select.append(el('option','请选择与订单图片一致的颜色规格'));select.options[0].value='';
   choices.forEach((c,i)=>{const o=el('option',c.label);o.value=String(i);select.append(o);});panel.append(select);
   const detail=el('p','请先选择规格');panel.append(detail);
   const photos=el('div');photos.style.display='flex';photos.style.gap='8px';
   const order=el('img'),web=el('img');order.alt='订单图片';web.alt='网站图片';order.src=job.item.image;
   for(const [caption,img] of [['订单图片',order],['网站图片',web]]){const fig=el('figure');fig.append(img,el('figcaption',caption));photos.append(fig);}panel.append(photos);
   const label=el('label'),check=el('input');check.type='checkbox';label.append(check,document.createTextNode(' 我已核对，图片、颜色和尺码完全一致'));panel.append(label);
   const confirm=el('button','确认一致，加入 1 件'),skip=el('button','不一致 / 无法确认，跳过');confirm.disabled=true;panel.append(confirm,skip,el('p','不一致时必须跳过。不会进入结账或付款。'));
   let choice=null,activating=false;
   const ready=()=>{confirm.disabled=acted||activating||!choice||!check.checked||[order,web].some(i=>!i.complete||!i.naturalWidth);};
   check.onchange=ready;order.onload=web.onload=ready;order.onerror=web.onerror=()=>{confirm.disabled=true;detail.textContent='图片加载失败，请跳过并人工核对';};
   select.onchange=async()=>{
    if(acted||activating)return;choice=null;check.checked=false;ready();if(select.value==='')return;
    activating=true;select.disabled=true;const candidate=choices[Number(select.value)];
    try{await candidate.activate();if(acted)return;await candidate.validate();if(acted)return;if(!candidate.photo||!job.item.image)throw Error('缺少图片，无法核对');choice=candidate;web.src=candidate.photo;detail.textContent=candidate.label+(candidate.shipping?' · '+candidate.shipping:'');}
    catch(e){acted=true;skip.disabled=true;await fail(e);}
    finally{activating=false;select.disabled=acted;ready();}
   };
   skip.onclick=async()=>{if(acted)return;acted=true;skip.disabled=select.disabled=check.disabled=true;ready();await fail(Error('用户核对图片、颜色或尺码不一致 / 无法确认'));};
   confirm.onclick=async()=>{
    if(acted||confirm.disabled||!choice)return;acted=true;confirm.disabled=skip.disabled=select.disabled=check.disabled=true;
    try{await choice.validate();const armed=await send('SD_ARM',{sku:job.item.sku,key:choice.key});if(!armed.armed)throw Error('批次已停止');await choice.validate();await choice.add();status('正在核验购物车；结果不明不会重复加购…');await sleep(5000);await send('SD_GO_CART');}catch(e){await fail(e);}
   };
   if(choices.length===1){select.value='0';await select.onchange();}
  }catch(e){if(job)await fail(e);}
  finally{running=false;}
 }
 run();
})();
