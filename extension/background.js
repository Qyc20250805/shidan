import {getMerchant, searchURL, directProductURL, itemURL} from './merchants.js';
import {SHOP, WORKBENCH, validateBatch, shopURL, verifyCart, view, sku, safeImage, validQuote} from './model.js';
let queue = Promise.resolve();
const read = async () => (await chrome.storage.local.get('job')).job;
const save = job => chrome.storage.local.set({job});
const fromApp = sender => sender.url?.startsWith(WORKBENCH) && sender.tab?.id != null;
const fromShop = (sender, job) => job && [job.tabId,job.baselineTabId].includes(sender.tab?.id) && shopURL(sender.url, null, job.merchant.origin);
async function announce(job) {
  if (job.done) {
    const history = (await chrome.storage.local.get('history')).history || {};
    history[job.id] = view(job);
    await chrome.storage.local.set({history});
  }
  try { await chrome.tabs.sendMessage(job.sourceTab, {type:'SD_RESULT', result:view(job)}); } catch {}
}
async function publish(job) { job.updatedAt=Date.now(); await save(job); await announce(job); }
const waiting = async () => (await chrome.storage.local.get('waiting')).waiting || [];
async function closeBaseline(job) {
 const id=job.baselineTabId;delete job.baselineTabId;
 if(id!=null)try{await chrome.tabs.remove(id);}catch{}
}
async function beginItem(job) {
 const row=job.items[job.index];
 job.product=directProductURL(row.url,job.merchant);
 job.stage='baseline';
 await closeBaseline(job);
 const baseline=await chrome.tabs.create({url:'about:blank',active:false});job.baselineTabId=baseline.id;
 await publish(job);
 // The visible tab always starts at the saved product, never the merchant home.
 await chrome.tabs.update(job.tabId,{url:itemURL(row,job.merchant)});
 await chrome.tabs.update(job.baselineTabId,{url:job.merchant.origin+job.merchant.cartPath});
}
async function runWaiting() {
 const list=await waiting();if(!list.length)return;
 const nextJob=list.shift();await chrome.storage.local.set({waiting:list});
 await beginItem(nextJob);
}
async function stopJob(job,reason) {
 for(const r of job.items)if(r.status==='pending'){r.status='review';r.reason=reason;}
 job.done=true;job.stage='done';await closeBaseline(job);await publish(job);
}
async function navigate(job, url) { await publish(job); await chrome.tabs.update(job.tabId,{url}); }
async function next(job) {
  const r = job.items[job.index];
  if (['review','failed'].includes(r.status) || r.added >= r.quantity) job.index++;
  if (job.index >= job.items.length) {
    job.done=true; job.stage='done'; await closeBaseline(job); await navigate(job, job.merchant.origin+job.merchant.cartPath); await runWaiting(); return;
  }
  await beginItem(job);
}
async function review(job, reason, status='review') {
  const r=job.items[job.index]; r.status=status; r.reason=reason.slice(0,180);
  await next(job);
}
async function handle(m, sender) {
  if (sender.id !== chrome.runtime.id) throw Error('来源无效');
  let job=await read();
  if (m.type==='SD_HELLO' && fromApp(sender)) return {version:'0.4.0',pricing:'fixed-chain-v1'};
  if (m.type==='SD_START' && fromApp(sender)) {
    validateBatch(m.batch);
    if (job?.id === m.batch.id) return {result:view(job)};
    const completed=(await chrome.storage.local.get('history')).history?.[m.batch.id];if(completed)return {result:completed};
    const list=await waiting();const queued=list.find(j=>j.id===m.batch.id);if(queued)return {result:view(queued)};
    if(JSON.stringify([job,...list,m.batch]).length>8_000_000)throw Error('待处理图片总量过大，请完成当前批次后重试');
    const merchant=getMerchant(m.batch.merchant);
    const nextJob={merchant,id:m.batch.id,sourceTab:sender.tab.id,items:m.batch.items.map(r=>({...r,sku:sku(r.sku),added:0,status:'pending'})),index:0,stage:'queued',done:false,updatedAt:Date.now()};
    const tab=await chrome.tabs.create({url:'about:blank',active:true});nextJob.tabId=tab.id;
    if(job && !job.done){
      list.push(nextJob);await chrome.storage.local.set({waiting:list});
      await chrome.tabs.update(tab.id,{url:itemURL(nextJob.items[0],merchant)});await announce(nextJob);
    }else await beginItem(nextJob);
    return {result:view(nextJob)};
  }
  if (m.type==='SD_POLL' && fromApp(sender)) {
    if (!Array.isArray(m.ids)) return {results:[]};
    if(job && !job.done && Date.now()-(job.updatedAt || 0)>10*60*1000){
      await stopJob(job,'加购会话长时间未响应，请核对购物车后重新发起');await runWaiting();job=await read();
    }
    const history=(await chrome.storage.local.get('history')).history || {};
    const results=m.ids.filter(id=>typeof id==='string').map(id=>history[id]).filter(Boolean);
    if (job && m.ids.includes(job.id)) { job.sourceTab=sender.tab.id; await save(job); results.push(view(job)); }
    const list=await waiting();
    for(const queued of list)if(m.ids.includes(queued.id)){queued.sourceTab=sender.tab.id;results.push(view(queued));}
    await chrome.storage.local.set({waiting:list});
    return {results,missingIds:m.ids.filter(id=>!results.some(r=>r.id===id))};
  }
  if (m.type==='SD_POPUP' && sender.url===chrome.runtime.getURL('popup.html')) return {job:job ? {...view(job),tabId:job.tabId,items:job.items.map(r=>({id:r.id,sku:r.sku,size:r.size,quantity:r.quantity,added:r.added,status:r.status,reason:r.reason}))}:null};
  if(m.type==='SD_CANCEL' && fromApp(sender)){
    const list=await waiting();const queued=list.find(j=>j.id===m.id);
    if(queued){for(const r of queued.items){r.status='review';r.reason='批次已停止，可重新选择';}queued.done=true;queued.stage='done';await chrome.storage.local.set({waiting:list.filter(j=>j.id!==m.id)});await announce(queued);return {ok:true};}
    if(!job || job.id!==m.id || job.done)return {ok:true};
    if(job.stage==='verify')throw Error('正在确认购物车结果，请稍后再停止');
    await stopJob(job,'批次已停止，请核对购物车后重试');await runWaiting();return {ok:true};
  }
  if(m.type==='SD_STOP' && sender.url===chrome.runtime.getURL('popup.html')){
    if(job && !job.done){if(job.stage==='verify')throw Error('正在确认购物车结果，请稍后再停止');await stopJob(job,'批次已停止，请核对购物车后重试');await runWaiting();}return {ok:true};
  }
  if(m.type==='SD_STATE'){
    const queued=(await waiting()).find(j=>j.tabId===sender.tab?.id && shopURL(sender.url,null,j.merchant.origin));
    if(queued)return {job:{id:queued.id,index:0,stage:'queued',merchant:queued.merchant,item:queued.items[0]}};
  }
  if (!fromShop(sender,job) || job.done) return {job:null};
  if (m.type==='SD_STATE') return {job:{id:job.id,index:job.index,stage:job.stage,merchant:job.merchant,item:job.items[job.index],product:job.product}};
  if(m.id!==job.id || m.index!==job.index) throw Error('批次已变化，请刷新页面');
  const r=job.items[job.index];
  if(['SD_REVIEW','SD_FAIL'].includes(m.type)) {await review(job, typeof m.reason==='string'?m.reason:'无法确认商品',m.type==='SD_FAIL'?'failed':'review');return {ok:true};}
  if(m.type==='SD_CART' && (job.stage==='baseline'?sender.tab.id===job.baselineTabId:sender.tab.id===job.tabId) && ['baseline','verify'].includes(job.stage) && new URL(sender.url).pathname===job.merchant.cartPath) {
    const map=m.cart;
    if(!map || Array.isArray(map) || Object.entries(map).some(([k,v])=>! /^[A-Za-z0-9:%._-]{1,240}$/.test(k)||!Number.isSafeInteger(v)||v<0)) throw Error('购物车数据无效');
    if(job.stage==='verify') {
      if(!verifyCart(job.before,map,job.expectedKey)) {await review(job,'加购结果无法确认（购物车数量不符），请人工核对，未自动重试');return {ok:true};}
      r.added++;
      if(r.added===r.quantity) r.status='added';
      await next(job);return {ok:true};
    }
    job.before=map;await closeBaseline(job);
    if(!r.sku || !r.size || !r.url) {await review(job,'缺少货号、尺码或商品链接，需人工核对');return {ok:true};}
    job.product=directProductURL(r.url,job.merchant);job.stage=job.product?'product':'search';
    await navigate(job,job.product || searchURL(job.merchant,r.sku)); return {ok:true};
  }
  if(m.type==='SD_PRODUCT' && job.stage==='search' && new URL(sender.url).href.startsWith(job.merchant.origin+job.merchant.searchPath.split('?')[0])) {
    if(!shopURL(m.url,job.merchant.productPrefix,job.merchant.origin)) throw Error('商品地址无效');
    job.product=m.url;job.stage='product';await navigate(job,m.url);return {ok:true};
  }
  const onProduct=sender.tab.id===job.tabId && job.stage==='product' && new URL(sender.url).origin===job.merchant.origin && new URL(sender.url).pathname===new URL(job.product).pathname;
  if(m.type==='SD_IMAGE' && onProduct){
    if(!safeImage(m.image) || !m.image.startsWith('https://'))throw Error('网页主图无法读取');
    r.webImage=m.image;await publish(job);return {ok:true};
  }
  if(m.type==='SD_QUOTE' && onProduct){
    if(!validQuote(m.quote,job.product) || !r.webImage)throw Error('网页价格或主图无法确认，请人工核对');
    r.quote={price:m.quote.price,originalPrice:m.quote.originalPrice,currency:m.quote.currency,url:m.quote.url,readAt:m.quote.readAt};
    await publish(job);return {ok:true};
  }
  if(m.type==='SD_ARM' && sender.tab.id===job.tabId && job.stage==='product' && new URL(sender.url).origin===job.merchant.origin && new URL(sender.url).pathname===new URL(job.product).pathname && m.sku===r.sku) {
    const key=m.key || r.sku;
    if(!/^[A-Za-z0-9:%._-]{1,240}$/.test(key) || (job.merchant.type==='petit' && key!==r.sku) || (job.merchant.type==='shopify' && !/^V:[0-9]+$/.test(key)) || (job.merchant.type==='montbell' && !key.startsWith('M:'+r.sku+':'))) throw Error('购物车核验标识无效');
    if(!r.quote || !validQuote(m.quote,job.product) || ['price','originalPrice','currency'].some(k=>m.quote[k]!==r.quote[k]))throw Error('网页价格已变化，请重新核对');
    job.expectedKey=key;job.stage='verify'; await publish(job); return {armed:true};
  }
  if(m.type==='SD_GO_CART' && job.stage==='verify') {await chrome.tabs.update(job.tabId,{url:job.merchant.origin+job.merchant.cartPath});return {ok:true};}
  throw Error('当前步骤已变化，已停止操作');
}
chrome.runtime.onMessage.addListener((m,sender,reply)=>{
  const task=queue.then(()=>handle(m,sender));queue=task.catch(()=>{});
  task.then(reply,error=>reply({error:error.message}));return true;
});
chrome.tabs.onRemoved.addListener(id=>{
 queue=queue.then(async()=>{
  const list=await waiting(),queued=list.find(j=>j.tabId===id);
  if(queued){for(const r of queued.items){r.status='review';r.reason='商品标签页已关闭，可重新选择重试';}queued.done=true;queued.stage='done';await chrome.storage.local.set({waiting:list.filter(j=>j!==queued)});await announce(queued);}
  const job=await read();
  if(job&&!job.done&&(job.tabId===id||job.baselineTabId===id)){await stopJob(job,'商品或购物车核验标签页已关闭，请核对购物车后重试');await runWaiting();}
 }).catch(()=>{});
});
