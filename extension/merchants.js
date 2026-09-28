export const MERCHANTS = [
 {id:'petit',name:'Petit Bateau',origin:'https://www.petit-bateau.co.jp',cartPath:'/cart',searchPath:'/search/',productPrefix:'/products/',type:'petit'},
 {id:'panpan',name:'panpantutu',origin:'https://www.panpantutu.com',cartPath:'/cart',searchPath:'/search?q=',productPrefix:'/products/',type:'shopify'},
 {id:'miki',name:'Miki House',origin:'https://www.mikihouse.co.jp',cartPath:'/cart',searchPath:'/search?q=',productPrefix:'/products/',type:'shopify'},
 {id:'montbell',name:'Montbell Japan',origin:'https://www.montbell.com',cartPath:'/jp/en/products/cart',searchPath:'/jp/en/products/list?q=',productPrefix:'/jp/en/products/detail/',type:'montbell'}
];
export function getMerchant(value) {
 try { const u=new URL(value);if(u.username||u.password)return null;return MERCHANTS.find(m=>u.origin===m.origin&&(m.id!=='montbell'||u.pathname.startsWith('/jp/en/products'))) || null; } catch {return null;}
}
export function searchURL(merchant,code){return merchant.origin+merchant.searchPath+encodeURIComponent(code)+(merchant.type==='shopify'?'&type=product':'');}
