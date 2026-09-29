import {getMerchant, directProductURL, sameMerchantOrigin} from './merchants.js';
export const SHOP = 'https://www.petit-bateau.co.jp';
export const WORKBENCH = 'https://qyc20250805.github.io/shidan/';
export const sku = value => String(value || '').trim().toUpperCase();
export const size = value => String(value || '').normalize('NFKC').trim().replace(/(?:cm|码|厘米)$/i, '').trim();
export function shopURL(value, path, origin=SHOP) {
  try { const u = new URL(value); return sameMerchantOrigin(u.href,origin) && !u.username && !u.password && (!path || u.pathname.startsWith(path)) ? u.href : null; } catch { return null; }
}
export function validateBatch(batch) {
  if (!batch || typeof batch.id !== 'string' || batch.id.length > 100 || !getMerchant(batch.merchant)) throw Error('请选择已适配的四家商家网址');
  if (!Array.isArray(batch.items) || !batch.items.length || batch.items.length > 20) throw Error('请选择商品，数量合计最多 20 件');
  const ids = new Set(); let total = 0;
  for (const r of batch.items) {
    if (!r || typeof r.id !== 'string' || ids.has(r.id) || r.id.length > 100) throw Error('明细标识无效');
    ids.add(r.id);
    if (!Number.isSafeInteger(r.quantity) || r.quantity < 1) throw Error('商品数量无效');
    total += r.quantity;
    for (const key of ['sku','size','color','url']) if (typeof r[key] !== 'string' || r[key].length > 2000) throw Error('商品字段无效');
    if(!r.sku.trim() || !r.size.trim() || !directProductURL(r.url,getMerchant(batch.merchant))) throw Error('信息不完整：需要货号、尺码和当前商家的商品链接');
    if(r.image && !safeImage(r.image))throw Error('商品图片格式无效');
  }
  if (total > 20) throw Error('数量合计不能超过 20 件');
  if (JSON.stringify(batch).length > 7_000_000) throw Error('图片总量过大，请缩小图片后再开始');
  return true;
}
export function verifyCart(before, after, expectedSku) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return keys.size > 0 && [...keys].every(k => (after[k] || 0) === (before[k] || 0) + (k === expectedSku ? 1 : 0)) && (after[expectedSku] || 0) === (before[expectedSku] || 0) + 1;
}
export function view(job) {
  if (!job) return null;
  return {id:job.id, done:job.done, phase:job.stage, items:job.items.map(r=>({id:r.id, status:r.status, added:r.added, reason:r.reason || '',quote:r.quote || null,webImage:r.webImage || ''}))};
}

export function safeImage(value) {
 if(typeof value!=='string')return false;
 if(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value))return true;
 try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password;}catch{return false;}
}
export function validQuote(q,product) {
 return Boolean(q && typeof q.price==='number' && Number.isFinite(q.price) && q.price>=0 &&
 (q.originalPrice===null || typeof q.originalPrice==='number' && Number.isFinite(q.originalPrice) && q.originalPrice>=q.price) &&
 /^[A-Z]{3}$/.test(q.currency) && q.url===product && Number.isFinite(Date.parse(q.readAt)) && Math.abs(Date.now()-Date.parse(q.readAt))<120000);
}
