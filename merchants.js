export const MERCHANTS = [
 {id:'petit',name:'Petit Bateau',origin:'https://www.petit-bateau.co.jp',cartPath:'/cart',searchPath:'/search/',productPrefix:'/products/',type:'petit'},
 {id:'panpan',name:'panpantutu',origin:'https://www.panpantutu.com',cartPath:'/cart',searchPath:'/search?q=',productPrefix:'/products/',type:'shopify'},
 {id:'miki',name:'Miki House',origin:'https://www.mikihouse.co.jp',cartPath:'/cart',searchPath:'/search?q=',productPrefix:'/products/',type:'shopify'},
 {id:'montbell',name:'Montbell Japan',origin:'https://www.montbell.com',cartPath:'/jp/en/products/cart',searchPath:'/jp/en/products/list?q=',productPrefix:'/jp/en/products/detail/',type:'montbell'}
];
export function sameMerchantOrigin(a,b) {
 try {const x=new URL(a),y=new URL(b);return [x,y].every(u=>u.protocol==='https:'&&!u.port&&!u.username&&!u.password)&&x.hostname.replace(/^www\./,'')===y.hostname.replace(/^www\./,'');}catch{return false;}
}
export function getMerchant(value) {
 try { const u=new URL(value);if(u.username||u.password)return null;return MERCHANTS.find(m=>sameMerchantOrigin(u.href,m.origin)&&(m.id!=='montbell'||u.pathname.startsWith('/jp/en/products'))) || null; } catch {return null;}
}
export function searchURL(merchant,code){return merchant.origin+merchant.searchPath+encodeURIComponent(code)+(merchant.type==='shopify'?'&type=product':'');}

// Only an actual product URL on the selected merchant is a direct cart target.
// Image files and home pages cannot identify a purchasable variant.
export function directProductURL(value, merchant) {
 try {
  const u = new URL(value);
  if (!merchant || !sameMerchantOrigin(u.href,merchant.origin) || u.username || u.password) return null;
  if (!u.pathname.startsWith(merchant.productPrefix) || !u.pathname.slice(merchant.productPrefix.length).replace(/\/$/, '') || /\.(?:jpe?g|png|gif|webp|svg)$/i.test(u.pathname)) return null;
  u.hash = ''; return u.href;
 } catch { return null; }
}
export function itemURL(row, merchant) {
 return directProductURL(row.url || row.productUrl || row.imageUrl, merchant) || searchURL(merchant, row.sku);
}
