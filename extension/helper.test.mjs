import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const {JSDOM}=createRequire(process.env.SHIDAN_TEST_PACKAGE || new URL('./package.json',import.meta.url))('jsdom');
import {MERCHANTS,getMerchant,searchURL} from './merchants.js';
import {validateBatch,verifyCart,SHOP} from './model.js';
const row={id:'r1',sku:'A0DV401090',size:'95',color:'',image:'data:image/png;base64,YQ==',url:'',quantity:1};
const batch={id:'b1',merchant:SHOP,items:[row]};
test('strict quantity limit, unique IDs, restricted image data and merchant',()=>{
 assert.equal(validateBatch(batch),true);
 assert.throws(()=>validateBatch({...batch,items:[{...row,quantity:21}]}));
 assert.throws(()=>validateBatch({...batch,items:[row,row]}));
 assert.throws(()=>validateBatch({...batch,merchant:'https://evil.test'}));
 assert.throws(()=>validateBatch({...batch,items:[{...row,image:'https://evil.test/x'}]}));
});
test('cart confirmation requires exactly one intended SKU increment and no other changes',()=>{
 assert.ok(verifyCart({OLD:2},{OLD:2,A0DV401090:1},row.sku));
 assert.ok(verifyCart({A0DV401090:2},{A0DV401090:3},row.sku));
 for(const after of [{OLD:2},{OLD:2,A0DV401090:2},{OLD:3,A0DV401090:1}])assert.equal(verifyCart({OLD:2},after,row.sku),false);
});
const adapters=fs.readFileSync(new URL('./adapters.js',import.meta.url),'utf8');
const script=fs.readFileSync(new URL('./shop.js',import.meta.url),'utf8');
async function productFixture(code='A0DV401090'){
 const dom=new JSDOM(`<main><h1>商品</h1><h3>カラー ブルー</h3><img src="https://cdn.shopify.com/x.jpg"><input type="radio" value="36ヶ月 95cm"><div id="x-panel-description">商品番号： ${code}</div><button id="add">カートに入れる</button></main>`,{url:SHOP+'/products/test',runScripts:'outside-only'});
 const w=dom.window;const messages=[];let panel,clicks=0;
 const attach=w.HTMLElement.prototype.attachShadow;w.HTMLElement.prototype.attachShadow=function(o){panel=attach.call(this,o);return panel};
 w.HTMLElement.prototype.getClientRects=()=>[{}];
 Object.defineProperty(w.HTMLImageElement.prototype,'complete',{get:()=>true});Object.defineProperty(w.HTMLImageElement.prototype,'naturalWidth',{get:()=>100});
 w.setTimeout=fn=>setTimeout(fn,0);
 w.chrome={runtime:{sendMessage:async m=>{messages.push(m);if(m.type==='SD_STATE')return{job:{id:'b1',index:0,stage:'product',merchant:MERCHANTS[0],item:{...row,added:0},product:SHOP+'/products/test'}};return m.type==='SD_ARM'?{armed:true}:{ok:true}}}};
 w.document.querySelector('#add').onclick=()=>clicks++;
 w.eval(adapters);w.eval(script);await new Promise(r=>setTimeout(r,120));
 return{w,messages,get panel(){return panel},get clicks(){return clicks}};
}
test('product adapter requires explicit image confirmation before one cart click',async()=>{
 const f=await productFixture();assert.equal(f.clicks,0);const check=f.panel.querySelector('input');assert.ok(check);check.checked=true;check.dispatchEvent(new f.w.Event('change'));
 const confirm=[...f.panel.querySelectorAll('button')].find(b=>b.textContent.includes('确认一致'));
 confirm.click();confirm.click();await new Promise(r=>setTimeout(r,30));assert.equal(f.clicks,1);assert.equal(f.messages.filter(m=>m.type==='SD_ARM').length,1);assert.ok(f.messages.some(m=>m.type==='SD_GO_CART'));
 f.w.close();
});
test('mismatched SKU stops without cart click',async()=>{const f=await productFixture('A0DV401070');assert.equal(f.clicks,0);assert.ok(f.messages.some(m=>m.type==='SD_REVIEW'));f.w.close();});
test('image mismatch stops without cart click',async()=>{const f=await productFixture();[...f.panel.querySelectorAll('button')].find(b=>b.textContent.startsWith('不一致')).click();await new Promise(r=>setTimeout(r,10));assert.equal(f.clicks,0);assert.ok(f.messages.some(m=>m.type==='SD_REVIEW'));f.w.close();});

test('four merchant detection, canonical search and total pieces',()=>{
 for(const m of MERCHANTS){assert.equal(getMerchant(m.origin+(m.id==='montbell'?'/jp/en/products':''))?.id,m.id);assert.ok(searchURL(m,'A B').includes('A%20B'));assert.ok(validateBatch({...batch,merchant:m.origin+(m.id==='montbell'?'/jp/en/products':'')}));}
 assert.equal(getMerchant('https://www.panpantutu.com.evil.test'),null);
 assert.equal(getMerchant('https://user:pass@www.panpantutu.com'),null);
 assert.equal(getMerchant('https://www.montbell.com/us/en/products'),null);
 assert.throws(()=>validateBatch({...batch,items:[{...row,quantity:11},{...row,id:'r2',quantity:10}]}));
});
function fixture(merchant,html,pathname,fetch){
 const dom=new JSDOM(html,{url:merchant.origin+pathname,runScripts:'outside-only'}),w=dom.window;
 w.setTimeout=fn=>setTimeout(fn,0);w.HTMLElement.prototype.getClientRects=()=>[{}];w.fetch=fetch;w.AbortSignal.timeout=()=>undefined;
 w.eval(adapters);return w;
}
const panProduct={handle:'171777',featured_image:'/image.jpg',options:[{name:'サイズ',position:1}],variants:[{id:43678571200688,sku:'1717778',option1:'80',title:'80',available:true,quantity_rule:{min:1,increment:1}}]};
const mikiProduct={handle:'13-5619-799',featured_image:'/image.jpg',options:[{name:'カラー',position:1},{name:'サイズ',position:2}],variants:[{id:47763823886514,sku:'13-5619-79900060900',option1:'グレー',option2:'90cm',title:'グレー / 90cm',available:true},{id:47763823886513,sku:'13-5619-79900060800',option1:'グレー',option2:'80cm',title:'グレー / 80cm',available:false}]};
for(const [name,merchant,product,siz] of [['panpantutu',MERCHANTS[1],panProduct,'80'],['Miki House',MERCHANTS[2],mikiProduct,'90']]){
 test(name+' exact search, variant selection and one-unit API add',async()=>{
  const calls=[];const fetch=async(url,init)=>{calls.push({url,init});const body=url.endsWith('/cart/add.js')?{items:[{variant_id:product.variants[0].id,quantity:1}]}:url.endsWith('/cart.js')?{items:[{variant_id:product.variants[0].id,quantity:1}]}:product;return{ok:true,json:async()=>body};};
  const w=fixture(merchant,`<main><a href="/products/${product.handle}">product</a></main>`,'/products/'+product.handle,fetch),a=w.ShidanAdapters.shopify;
  const r={...row,sku:product.handle,size:siz};assert.equal(await a.search(r),merchant.origin+'/products/'+product.handle);
  const choices=await a.choices(r);assert.equal(choices.length,1);assert.equal(choices[0].key,'V:'+product.variants[0].id);await choices[0].validate();await choices[0].add();
  const posts=calls.filter(c=>c.init.method==='POST');assert.equal(posts.length,1);assert.equal(JSON.parse(posts[0].init.body).items[0].quantity,1);assert.ok(posts[0].url.endsWith('/cart/add.js'));
  const map=await a.cart();assert.equal(map[choices[0].key],1);
  await assert.rejects(a.choices({...r,size:'999'}),/不一致/);await assert.rejects(a.choices({...r,sku:'MISSING'}),/不一致/);
  w.close();
 });
}
test('Shopify sold-out and HTTP 422 fail safely; network uncertainty is review',async()=>{
 const w=fixture(MERCHANTS[2],'<main></main>','/products/13-5619-799',async()=>({ok:true,json:async()=>mikiProduct}));
 await assert.rejects(w.ShidanAdapters.shopify.choices({...row,sku:mikiProduct.handle,size:'80'}),/缺货/);
 const [c]=await w.ShidanAdapters.shopify.choices({...row,sku:mikiProduct.handle,size:'90'});
 w.fetch=async()=>({ok:false,status:422});await assert.rejects(c.add(),e=>e.definitive===true&&e.kind==='failed');
 w.fetch=async()=>{throw Error('network')};await assert.rejects(c.add(),e=>!e.definitive&&/响应不明/.test(e.message));w.close();
});
const montHTML=`<main><h1>#2301351</h1><input type="radio" name="detail-size-radio" data-size-name="M"><label><input type="radio" name="color" class="colors-radio"><img data-color-label="LGY" alt="LIGHT GRAY" data-image_url_origin="/x.webp"></label><select id="quantity"><option value="1">1</option></select><li>From USA<a class="add-to-cart" data-shipping_from="2" data-product_color_name="LGY" data-product_size_name="M">Add to Cart</a></li></main>`;
test('Montbell exact size/color/shipping and one-unit click',async()=>{
 const w=fixture(MERCHANTS[3],montHTML,'/jp/en/products/detail/2301351'),r={...row,sku:'2301351',size:'M',color:'LGY'};
 let clicks=0;w.document.querySelector('.add-to-cart').onclick=()=>clicks++;
 const [c]=await w.ShidanAdapters.montbell.choices(r);await c.activate();await c.validate();assert.equal(c.key,'M:2301351:LGY:M:2');await c.add();assert.equal(clicks,1);
 w.document.querySelector('.add-to-cart').dataset.shipping_from='1';await assert.rejects(c.validate(),/发货区域/);w.close();
});
test('Montbell ambiguous shipping and missing size never add',async()=>{
 const w=fixture(MERCHANTS[3],montHTML,'/jp/en/products/detail/2301351'),r={...row,sku:'2301351',size:'M',color:'LGY'};
 await assert.rejects(w.ShidanAdapters.montbell.choices({...r,size:'XL'}),/尺码/);
 const add=w.document.querySelector('.add-to-cart');add.parentElement.append(add.cloneNode(true));
 const [c]=await w.ShidanAdapters.montbell.choices(r);await assert.rejects(c.activate(),/不唯一/);w.close();
});
test('Montbell cart quantity keyed by product, size, color and shipping',async()=>{
 const w=fixture(MERCHANTS[3],`<main><button id="checkout-button">Checkout</button><div class="cart-item" data-group-detail-id="1"><span data-product-code>#2301351</span><a href="/jp/en/products/detail/2301351?color=LGY">product</a><div data-size><span data-text="M">M</span></div><select class="select-quantity" data-sfc="2"><option value="1">1</option></select></div></main>`,'/jp/en/products/cart');
 assert.equal((await w.ShidanAdapters.montbell.cart())['M:2301351:LGY:M:2'],1);w.close();
});
test('direct real product URL, queued next batch, retry and session recovery',async()=>{
 const store={};let listener,removed;let id=10;const tabs=new Map(),navigation=[];
 globalThis.chrome={runtime:{id:'test',getURL:p=>'chrome-extension://test/'+p,onMessage:{addListener:fn=>listener=fn}},storage:{local:{get:async key=>({[key]:structuredClone(store[key])}),set:async values=>Object.assign(store,structuredClone(values))}},tabs:{create:async options=>{const tab={id:++id,...options};tabs.set(id,tab);return tab;},update:async(id,v)=>{Object.assign(tabs.get(id),v);navigation.push({id,...v});},remove:async id=>tabs.delete(id),sendMessage:async()=>{},onRemoved:{addListener:fn=>removed=fn}}};
 await import('./background.js?direct');
 const app={id:'test',url:'https://qyc20250805.github.io/shidan/',tab:{id:1}};
 const send=(m,s=app)=>new Promise(resolve=>listener(m,s,resolve));
 const product=SHOP+'/products/a0dv4-bebe-25h81-cardigans';
 const first={...batch,id:'direct',items:[{...row,url:product}]};
 assert.equal((await send({type:'SD_START',batch:first})).result.id,'direct');
 const job=()=>store.job;
 assert.equal(navigation[0].url,product);assert.equal(tabs.get(job().tabId).active,true);
 assert.equal(tabs.get(job().baselineTabId).active,false);
 const sender=(tabId,path)=>({id:'test',url:SHOP+path,tab:{id:tabId}});
 const msg=(type,data={})=>({type,id:job().id,index:job().index,...data});
 const before=tabs.size;await send({type:'SD_START',batch:first});assert.equal(tabs.size,before);
 await send(msg('SD_CART',{cart:{}}),sender(job().baselineTabId,'/cart'));assert.equal(job().stage,'product');assert.equal(job().product,product);
 const current=job().tabId;
 await send({type:'SD_START',batch:{...first,id:'next'}});assert.equal(store.waiting.length,1);const queued=store.waiting[0];assert.equal(tabs.get(queued.tabId).url,product);
 const state=await send({type:'SD_STATE'},sender(queued.tabId,'/products/a0dv4-bebe-25h81-cardigans'));assert.equal(state.job.stage,'queued');
 await send(msg('SD_ARM',{sku:row.sku}),sender(current,'/products/a0dv4-bebe-25h81-cardigans'));assert.equal(job().stage,'verify');
 assert.ok((await send(msg('SD_ARM',{sku:row.sku}),sender(current,'/products/a0dv4-bebe-25h81-cardigans'))).error);
 await send(msg('SD_CART',{cart:{[row.sku]:1}}),sender(current,'/cart'));
 assert.equal(store.history.direct.items[0].status,'added');assert.equal(job().id,'next');assert.equal(job().stage,'baseline');
 await send(msg('SD_FAIL',{reason:'HTTP 422'}),sender(job().tabId,'/products/a0dv4-bebe-25h81-cardigans'));assert.equal(job().done,true);
 assert.equal(store.history.next.items[0].reason,'HTTP 422');
 await send({type:'SD_START',batch:{...first,id:'retry'}});assert.equal(job().id,'retry');assert.equal(tabs.get(job().tabId).url,product);
 store.job.updatedAt=Date.now()-11*60*1000;
 const poll=await send({type:'SD_POLL',ids:['direct','next','retry','missing']});assert.equal(store.job.done,true);assert.ok(poll.results.some(r=>r.id==='retry'&&r.items[0].status==='review'));assert.deepEqual(poll.missingIds,['missing']);
 const count=tabs.size;await send({type:'SD_START',batch:first});assert.equal(tabs.size,count);
});
