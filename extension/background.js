import {getMerchant, searchURL} from './merchants.js';
import {SHOP, WORKBENCH, validateBatch, shopURL, verifyCart, view, sku} from './model.js';
let queue = Promise.resolve();
const read = async () => (await chrome.storage.local.get('job')).job;
const save = job => chrome.storage.local.set({job});
const fromApp = sender => sender.url?.startsWith(WORKBENCH) && sender.tab?.id != null;
const fromShop = (sender, job) => job && sender.tab?.id === job.tabId && shopURL(sender.url, null, job.merchant.origin);
async function publish(job) {
  await save(job);
  if (job.done) {
    const history = (await chrome.storage.local.get('history')).history || {};
    history[job.id] = view(job);
    await chrome.storage.local.set({history});
  }
  try { await chrome.tabs.sendMessage(job.sourceTab, {type:'SD_RESULT', result:view(job)}); } catch {}
}
async function navigate(job, url) { await publish(job); await chrome.tabs.update(job.tabId,{url}); }
async function next(job) {
  const r = job.items[job.index];
  if (['review','failed'].includes(r.status) || r.added >= r.quantity) job.index++;
  if (job.index >= job.items.length) {
    job.done=true; job.stage='done'; await navigate(job, job.merchant.origin+job.merchant.cartPath); return;
  }
  job.stage='baseline'; await navigate(job,job.merchant.origin+job.merchant.cartPath);
}
async function review(job, reason, status='review') {
  const r=job.items[job.index]; r.status=status; r.reason=reason.slice(0,180);
  await next(job);
}
async function handle(m, sender) {
  if (sender.id !== chrome.runtime.id) throw Error('来源无效');
  let job=await read();
  if (m.type==='SD_HELLO' && fromApp(sender)) return {version:'0.3.0'};
  if (m.type==='SD_START' && fromApp(sender)) {
    validateBatch(m.batch);
    if (job?.id === m.batch.id) return {result:view(job)};
    if (job && !job.done) throw Error('已有加购批次正在处理，请先在扩展中停止或完成');
    job={merchant:getMerchant(m.batch.merchant),id:m.batch.id, sourceTab:sender.tab.id, items:m.batch.items.map(r=>({...r,sku:sku(r.sku),added:0,status:'pending'})), index:0,stage:'baseline',done:false};
    const tab=await chrome.tabs.create({url:'about:blank',active:true}); job.tabId=tab.id;
    await navigate(job,job.merchant.origin+job.merchant.cartPath); return {result:view(job)};
  }
  if (m.type==='SD_POLL' && fromApp(sender)) {
    if (!Array.isArray(m.ids)) return {results:[]};
    const history=(await chrome.storage.local.get('history')).history || {};
    const results=m.ids.filter(id=>typeof id==='string').map(id=>history[id]).filter(Boolean);
    if (job && m.ids.includes(job.id)) { job.sourceTab=sender.tab.id; await save(job); results.push(view(job)); }
    return {results};
  }
  if (m.type==='SD_POPUP' && sender.url===chrome.runtime.getURL('popup.html')) return {job:job ? {...view(job),tabId:job.tabId,items:job.items.map(r=>({id:r.id,sku:r.sku,size:r.size,quantity:r.quantity,added:r.added,status:r.status,reason:r.reason}))}:null};
  if ((m.type==='SD_STOP' && sender.url===chrome.runtime.getURL('popup.html')) || (m.type==='SD_CANCEL' && fromApp(sender) && (!job || job.id===m.id))) {
    if (job && !job.done) {
      for(const r of job.items) if(r.status==='pending') {r.status='review';r.reason='批次已停止；请先核对购物车，勿直接重复加购';}
      job.done=true;job.stage='done'; await publish(job);
    } return {ok:true};
  }
  if (!fromShop(sender,job) || job.done) return {job:null};
  if (m.type==='SD_STATE') return {job:{id:job.id,index:job.index,stage:job.stage,merchant:job.merchant,item:job.items[job.index],product:job.product}};
  if(m.id!==job.id || m.index!==job.index) throw Error('批次已变化，请刷新页面');
  const r=job.items[job.index];
  if(['SD_REVIEW','SD_FAIL'].includes(m.type)) {await review(job, typeof m.reason==='string'?m.reason:'无法确认商品',m.type==='SD_FAIL'?'failed':'review');return {ok:true};}
  if(m.type==='SD_CART' && ['baseline','verify'].includes(job.stage) && new URL(sender.url).pathname===job.merchant.cartPath) {
    const map=m.cart;
    if(!map || Array.isArray(map) || Object.entries(map).some(([k,v])=>! /^[A-Za-z0-9:%._-]{1,240}$/.test(k)||!Number.isSafeInteger(v)||v<0)) throw Error('购物车数据无效');
    if(job.stage==='verify') {
      if(!verifyCart(job.before,map,job.expectedKey)) {await review(job,'加购结果无法确认（购物车数量不符），请人工核对，未自动重试');return {ok:true};}
      r.added++;
      if(r.added===r.quantity) r.status='added';
      await next(job);return {ok:true};
    }
    job.before=map;
    if(!r.sku || !r.size || !r.image) {await review(job,'缺少货号、尺码或订单图片，需人工核对');return {ok:true};}
    job.stage='search';job.product=null;
    await navigate(job,searchURL(job.merchant,r.sku)); return {ok:true};
  }
  if(m.type==='SD_PRODUCT' && job.stage==='search' && new URL(sender.url).href.startsWith(job.merchant.origin+job.merchant.searchPath.split('?')[0])) {
    if(!shopURL(m.url,job.merchant.productPrefix,job.merchant.origin)) throw Error('商品地址无效');
    job.product=m.url;job.stage='product';await navigate(job,m.url);return {ok:true};
  }
  if(m.type==='SD_ARM' && job.stage==='product' && new URL(sender.url).origin===job.merchant.origin && new URL(sender.url).pathname===new URL(job.product).pathname && m.sku===r.sku) {
    const key=m.key || r.sku;
    if(!/^[A-Za-z0-9:%._-]{1,240}$/.test(key) || (job.merchant.type==='petit' && key!==r.sku) || (job.merchant.type==='shopify' && !/^V:[0-9]+$/.test(key)) || (job.merchant.type==='montbell' && !key.startsWith('M:'+r.sku+':'))) throw Error('购物车核验标识无效');
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
  queue=queue.then(async()=>{const job=await read();if(job && !job.done && job.tabId===id){for(const r of job.items) if(r.status==='pending'){r.status='review';r.reason='商家标签页已关闭，请核对购物车后再处理';}job.done=true;job.stage='done';await publish(job);}}).catch(()=>{});
});
