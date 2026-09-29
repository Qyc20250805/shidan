import {getMerchant} from './merchants.js';
export const SHOP = 'https://www.petit-bateau.co.jp';
export const WORKBENCH = 'https://qyc20250805.github.io/shidan/';
export const sku = value => String(value || '').trim().toUpperCase();
export const size = value => String(value || '').normalize('NFKC').trim().replace(/(?:cm|码|厘米)$/i, '').trim();
export function shopURL(value, path, origin=SHOP) {
  try { const u = new URL(value); return u.origin === origin && !u.username && !u.password && (!path || u.pathname.startsWith(path)) ? u.href : null; } catch { return null; }
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
    if (r.image && (typeof r.image !== 'string' || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(r.image))) throw Error('请使用拾单上传的商品图片');
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
  return {id:job.id, done:job.done, phase:job.stage, items:job.items.map(r=>({id:r.id, status:r.status, added:r.added, reason:r.reason || ''}))};
}
