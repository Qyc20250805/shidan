(() => {
 const sameOrigin=(a,b)=>{try{const x=new URL(a),y=new URL(b);return [x,y].every(u=>u.protocol==='https:'&&!u.port&&!u.username&&!u.password)&&x.hostname.replace(/^www\./,'')===y.hostname.replace(/^www\./,'');}catch{return false;}};
 const text=el=>(el?.textContent||'').trim();
 const normal=v=>String(v||'').normalize('NFKC').trim();
 const size=v=>normal(v).replace(/(?:cm|码|厘米)$/i,'').trim().toUpperCase();
 const visible=el=>el && el.getClientRects().length>0;
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 const wait=async(fn,ms=20000)=>{const end=Date.now()+ms;while(Date.now()<end){const v=await fn();if(v)return v;await sleep(250);}throw Error('网站加载超时或结构变化，无法确认商品');};
 const request=async(path,init={})=>{
  const url=new URL(path,location.origin);if(url.origin!==location.origin)throw Error('跨商家请求已停止');
  let response;try{response=await fetch(url.href,{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(15000),...init});}catch{throw Error(init.method==='POST'?'加购响应不明，请核对购物车，勿重试':'商家数据读取失败');}
  if(!response.ok){const e=Error(`商家返回 HTTP ${response.status}`);e.definitive=init.method==='POST'&&response.status>=400&&response.status<500;e.kind=e.definitive?'failed':'review';throw e;}
  return response.json();
 };
 const productPath=href=>{const u=new URL(href,location.origin);const match=u.pathname.match(/^\/products\/([^/]+)$/);return sameOrigin(u.href,location.origin)&&match?'/products/'+match[1]:null;};
 // Price extraction is scoped to the selected product, never recommendations or a promotion percentage.
 const priceNumber=value=>{const t=normal(value).replace(/,/g,'');if(/[~〜～]/.test(t))throw Error('网页显示价格区间，无法确认当前售价');const values=t.match(/[0-9]+(?:\.[0-9]+)?/g);if(!values||values.length!==1)throw Error('网页售价无法唯一确认');return Number(values[0]);};
 const quote=(price,originalPrice,currency)=>{
  if(!Number.isFinite(price)||price<0||originalPrice!==null&&(!Number.isFinite(originalPrice)||originalPrice<price)||!/^[A-Z]{3}$/.test(currency))throw Error('网页价格或币种无法确认');
  return {price,originalPrice,currency,readAt:new Date().toISOString(),url:location.href.split('#')[0]};
 };
 function pbPrice(){
  const blocks=[...document.querySelectorAll('main [class*="product-heading_PriceContainer__"]')].filter(visible);
  if(blocks.length!==1)throw Error('网页价格区域无法唯一确认');
  const compare=blocks[0].querySelector('[class*="CompareAtPrice__"]');
  const prices=[...blocks[0].querySelectorAll('[class*="product-heading_Price__"]')].filter(n=>n!==compare&&visible(n));
  if(prices.length!==1 || !/[￥¥]/.test(text(prices[0])))throw Error('网页售价或币种无法确认');
  return quote(priceNumber(text(prices[0])),compare?priceNumber(text(compare)):null,'JPY');
 }
 function montPrice(add){
  const block=add.closest('li');const prices=[...block.querySelectorAll('.display-price')].filter(visible);
  if(prices.length!==1)throw Error('所选发货区域价格无法唯一确认');
  const value=text(prices[0]);const currency=/[¥￥]/.test(value)?'JPY':/USD|US\$/.test(value)||/\$/.test(value)&&text(block).includes('USA')?'USD':/€/.test(value)?'EUR':null;
  const compare=prices[0].querySelector('del,s');
  const current=prices[0].cloneNode(true);current.querySelectorAll('del,s').forEach(n=>n.remove());
  return quote(priceNumber(text(current)),compare?priceNumber(text(compare)):null,currency);
 }
 function pbState(){
  const main=document.querySelector('main');if(!main)return null;
  const description=main.querySelector('[id$="-panel-description"]');
  const codes=[...new Set([...text(description).matchAll(/商品番号\s*[：:]\s*([A-Za-z0-9-]+)/g)].map(m=>m[1].toUpperCase()))];
  const selected=[...main.querySelectorAll('input[type=radio]:checked')].find(el=>/cm/.test(el.value));
  const adds=[...main.querySelectorAll('button')].filter(el=>text(el)==='カートに入れる'&&visible(el));
  const color=[...main.querySelectorAll('h3')].find(el=>text(el).startsWith('カラー'));
  const photo=[...main.querySelectorAll('img')].find(el=>el.src.includes('cdn.shopify.com/')&&visible(el));
  return {sku:codes.length===1?codes[0]:null,size:selected?.value,add:adds.length===1?adds[0]:null,color:[...main.querySelectorAll('input[type=radio]:checked')].find(el=>!/cm/.test(el.value))?.value || text(color),photo:photo?.src};
 }
 function pbCheck(row){
  const p=pbState();if(!p||p.sku!==row.sku)throw Error('所选尺码的完整货号与订单不一致');
  if(normal(p.size).match(/(?:^|\s)(\d+(?:\.\d+)?)\s*cm(?:$|\s)/i)?.[1]!==size(row.size))throw Error('尺码不一致');
  if(!p.add||p.add.disabled||p.add.getAttribute('data-disabled')==='true')throw Error('此尺码缺货或不可加购');
  if(document.querySelector('main input[type=number]'))throw Error('出现额外数量控件，请人工核对');return p;
 }
 const petit={
  async mainImage(){await wait(()=>pbState()?.photo);return pbState().photo;},
  async search(){await wait(()=>/全\s*\d+\s*アイテム/.test(text(document.querySelector('main'))));const main=document.querySelector('main');const total=Number(text(main).match(/全\s*(\d+)\s*アイテム/)?.[1]);const links=[...new Set([...main.querySelectorAll('a[href^="/products/"]')].map(el=>el.href))];if(total!==1||links.length!==1)throw Error('货号搜索结果为空或不唯一');return links[0];},
  async cart(){return wait(()=>{const main=document.querySelector('main');if(!main)return null;const entries=[...main.querySelectorAll('[class*="cart-item_ItemDetails__"]')];if(!entries.length&&!text(main).includes('現在、買い物かごには商品が入っておりません'))return null;const map={};for(const entry of entries){const code=text(entry).match(/商品番号\s*[：:]\s*([A-Z0-9-]+)/)?.[1];const plus=entry.querySelector('button[aria-label="Increase quantity"]');const qty=Number(text(plus?.parentElement.querySelector('p')));if(!code||!Number.isSafeInteger(qty)||qty<1)return null;map[code]=(map[code]||0)+qty;}return map;});},
  async choices(row){await wait(()=>document.querySelector('main input[type=radio][value*="cm"]'));const radios=[...document.querySelectorAll('main input[type=radio]')].filter(el=>normal(el.value).match(/(?:^|\s)(\d+(?:\.\d+)?)\s*cm(?:$|\s)/i)?.[1]===size(row.size));if(radios.length!==1||radios[0].disabled)throw Error('找不到唯一且可选的订单尺码');radios[0].click();await sleep(1200);const p=pbCheck(row);return [{label:`${p.sku} · ${p.size} · ${p.color}`,photo:p.photo,key:row.sku,readPrice:async()=>{pbCheck(row);return pbPrice();},activate:async()=>{},validate:async()=>{const now=pbCheck(row);if(now.photo!==p.photo||now.color!==p.color)throw Error('商品图片或颜色已变化，请重新核对');},add:async()=>pbCheck(row).add.click()}];}
 };
 function variants(product,row){
  if(!Array.isArray(product.variants)||product.variants.length>=250)throw Error('规格数据不完整');
  const sizeOption=product.options.filter(o=>/^(サイズ|size|尺码|尺寸)$/i.test(o.name));if(sizeOption.length!==1)throw Error('无法识别唯一尺码字段');
  const pos=sizeOption[0].position;
  const codes=product.variants.filter(v=>String(v.sku).toUpperCase()===row.sku);
  const allowed=String(product.handle).toUpperCase()===row.sku?product.variants:codes;
  let matches=allowed.filter(v=>size(v['option'+pos])===size(row.size));
  const colorOption=product.options.find(o=>/^(カラー|color|colour|颜色)$/i.test(o.name));
  if(row.color&&colorOption)matches=matches.filter(v=>normal(v['option'+colorOption.position])===normal(row.color));
  if(!matches.length)throw Error('货号、颜色或尺码不一致');
  if(matches.length!==1)throw Error('货号与目标尺码对应多个规格，需人工核对');
  matches=matches.filter(v=>v.available&&!v.requires_selling_plan&&(!v.quantity_rule||v.quantity_rule.min===1&&v.quantity_rule.increment===1));
  if(!matches.length)throw Error('目标尺码缺货或需要额外购买条件');return matches;
 }
 const shopify={
  async mainImage(){const path=productPath(location.href);if(!path)throw Error("商品地址无法确认");const p=await request(path+".js");if(!p.featured_image)throw Error("网页主图无法读取");return new URL(p.featured_image,location.origin).href;},
  async search(row){
   const main=await wait(()=>document.querySelector('main,#MainContent'));
   await wait(()=>main.querySelector('a[href*="/products/"]')||/0件|見つかりません|no results/i.test(text(main)));
   const paths=[...new Set([...main.querySelectorAll('a[href*="/products/"]')].map(a=>productPath(a.href)).filter(Boolean))];
   if(!paths.length||paths.length>12)throw Error('搜索结果为空或过多，需人工核对');
   const products=await Promise.all(paths.map(async path=>({path,data:await request(path+'.js')})));
   const found=products.filter(({data})=>String(data.handle).toUpperCase()===row.sku||data.variants?.some(v=>String(v.sku).toUpperCase()===row.sku));
   if(found.length!==1)throw Error('无法通过完整货号唯一确定商品');return location.origin+found[0].path;
  },
  async cart(){const data=await request('/cart.js');if(!Array.isArray(data.items))throw Error('购物车数据无效');const map={};for(const r of data.items){if(!Number.isSafeInteger(r.variant_id)||!Number.isSafeInteger(r.quantity)||r.quantity<1)throw Error('购物车规格或数量无效');const key='V:'+r.variant_id;map[key]=(map[key]||0)+r.quantity;}return map;},
  async choices(row){
   const path=productPath(location.href);if(!path)throw Error('商品地址无法确认');
   const form=document.querySelector('form[action*="/cart/add"]');
   if(form?.querySelector('[required][name^="properties["]'))throw Error('此商品需要定制信息，请人工处理');
   const product=await request(path+'.js');const matches=variants(product,row);
   return matches.map(v=>({label:`${product.handle} · ${v.title} · SKU ${v.sku}`,photo:(v.featured_image?.src||product.featured_image)?new URL(v.featured_image?.src||product.featured_image,location.origin).href:null,key:'V:'+v.id,readPrice:async()=>{const fresh=await request(path+'.js');const current=variants(fresh,row).find(x=>x.id===v.id);if(!current)throw Error('当前规格已变化');const cart=await request('/cart.js');if(typeof current.price!=='number')throw Error('网页售价无法确认');return quote(current.price/100,current.compare_at_price>current.price?current.compare_at_price/100:null,cart.currency);},activate:async()=>{},validate:async()=>{const fresh=await request(path+'.js');const current=variants(fresh,row).find(x=>x.id===v.id);if(!current||current.title!==v.title)throw Error('商品规格或库存已变化');},add:async()=>{const result=await request('/cart/add.js',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({items:[{id:v.id,quantity:1}]})});if(!result.items?.some(item=>item.variant_id===v.id&&item.quantity>=1))throw Error('加购结果无法确认');}}));
  }
 };
 const montKey=(code,color,siz,shipping)=>['M',code,color,siz,shipping].map(x=>encodeURIComponent(x)).join(':');
 function montCheck(row,color){
  if(location.pathname!=='/jp/en/products/detail/'+row.sku||!text(document.querySelector('main')).includes('#'+row.sku))throw Error('Montbell 货号不一致');
  const current=document.querySelector('input[name="detail-size-radio"]:checked');if(size(current?.dataset.sizeName)!==size(row.size))throw Error('Montbell 尺码不一致');
  const radio=document.querySelector('input.colors-radio:checked');const photo=radio?.parentElement.querySelector('img[data-color-label]');if(photo?.dataset.colorLabel!==color)throw Error('Montbell 颜色已变化');
  const adds=[...document.querySelectorAll('main a.add-to-cart[data-shipping_from]')].filter(visible);
  if(adds.length!==1)throw Error('发货区域或加购入口不唯一，请人工核对');const add=adds[0];
  if(size(add.dataset.product_size_name)!==size(row.size)||add.dataset.product_color_name!==color)throw Error('加购规格与订单不符');
  const quantity=document.querySelector('select#quantity');if(!quantity||quantity.disabled||quantity.value!=='1')throw Error('加购数量不是 1，已停止');
  return {add,key:montKey(row.sku,color,add.dataset.product_size_name,add.dataset.shipping_from),shipping:text(add.closest('li')),photo:new URL(photo.dataset.image_url_origin||photo.src,location.origin).href};
 }
 const montbell={
  async mainImage(){const img=await wait(()=>document.querySelector("main input.colors-radio:checked")?.parentElement.querySelector("img[data-color-label]"));return new URL(img.dataset.image_url_origin||img.src,location.origin).href;},
  async search(row){await wait(()=>document.querySelector('main a[href*="/products/detail/"]'));const links=[...document.querySelectorAll('main a[href*="/products/detail/"]')].map(a=>new URL(a.href)).filter(u=>sameOrigin(u.href,location.origin)&&u.pathname==='/jp/en/products/detail/'+row.sku);const paths=[...new Set(links.map(u=>u.origin+u.pathname))];if(paths.length!==1)throw Error('Montbell 货号搜索无法唯一确认');return paths[0];},
  async cart(){return wait(()=>{const main=document.querySelector('main');if(!main||!main.querySelector('#checkout-button'))return null;const entries=[...main.querySelectorAll('.cart-item[data-group-detail-id]')];const map={};for(const entry of entries){const code=text(entry.querySelector('[data-product-code]')).replace(/^#/,'');const url=entry.querySelector('a[href*="/products/detail/"]')?.href;const color=url?new URL(url).searchParams.get('color'):null;const siz=entry.querySelector('[data-size] [data-text]')?.getAttribute('data-text');const select=entry.querySelector('select.select-quantity[data-sfc]');const qty=Number(select?.value);if(!code||!color||!siz||!select||!Number.isSafeInteger(qty)||qty<1)return null;const key=montKey(code,color,siz,select.dataset.sfc);map[key]=(map[key]||0)+qty;}
   if(!entries.length){const count=[...document.querySelectorAll('header a, [role=banner] a, nav a')].find(a=>new URL(a.href,location.origin).pathname==='/jp/en/products/cart'&&text(a)==='0');if(!main.querySelector('#checkout-button').disabled||!count)return null;}return map;});},
  async choices(row){
   await wait(()=>document.querySelector('input[name="detail-size-radio"]'));
   const radios=[...document.querySelectorAll('input[name="detail-size-radio"]')].filter(r=>size(r.dataset.sizeName)===size(row.size));if(radios.length!==1||radios[0].disabled)throw Error('Montbell 尺码不存在或缺货');radios[0].click();await sleep(1500);
   const colors=[...document.querySelectorAll('main input.colors-radio')].map(r=>({radio:r,img:r.parentElement.querySelector('img[data-color-label]')})).filter(c=>c.img);
   const options=row.color?colors.filter(c=>[c.img.dataset.colorLabel,c.img.alt].some(v=>normal(v)===normal(row.color))):colors;
   if(!options.length)throw Error('Montbell 颜色无法确认');
   return options.map(c=>({label:`${row.sku} · ${row.size} · ${c.img.dataset.colorLabel} ${c.img.alt}`,photo:new URL(c.img.dataset.image_url_origin||c.img.src,location.origin).href,key:null,readPrice:async function(){const p=montCheck(row,c.img.dataset.colorLabel);if(p.key!==this.key)throw Error('发货区域已变化');return montPrice(p.add);},activate:async function(){c.radio.click();await sleep(1200);const qty=document.querySelector('select#quantity');if(qty&&[...qty.options].some(o=>o.value==='1')){qty.value='1';qty.dispatchEvent(new Event('change',{bubbles:true}));}await wait(()=>[...document.querySelectorAll('main a.add-to-cart[data-shipping_from]')].some(visible));const current=montCheck(row,c.img.dataset.colorLabel);this.key=current.key;this.shipping=current.shipping;},validate:async function(){const p=montCheck(row,c.img.dataset.colorLabel);if(p.key!==this.key)throw Error('发货区域已变化');},add:async()=>montCheck(row,c.img.dataset.colorLabel).add.click()}));
  }
 };
 globalThis.ShidanAdapters={petit,shopify,montbell,variants,montKey,sameOrigin};
})();
