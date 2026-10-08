const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs=require('fs');
(async()=>{
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH || undefined,headless:true,args:['--no-sandbox']});
const reports=[];
for(const [width,dpr] of [[1440,1],[1440,2],[390,1],[390,2],[768,2]]){
 for(const file of ['merch.html','about.html','index.html']){
 const context=await browser.newContext({viewport:{width,height:900},deviceScaleFactor:dpr});
 const page=await context.newPage();
 await page.route('https://**/*',r=>r.abort());
 await page.addInitScript(() => { Math.random = () => 0.5; });
 await page.goto('http://127.0.0.1:8765/'+file);
 if(file==='index.html') await page.waitForSelector('.home-highlight-trigger');
 const selector=file==='merch.html'?'.merch-item-image':file==='about.html'?'.home-highlight-card img':'.home-highlight-trigger img';
 const images=page.locator(selector);
 for(let i=0;i<await images.count();i++) {await images.nth(i).scrollIntoViewIfNeeded();await images.nth(i).evaluate(im=>im.decode());}
 const rows=await images.evaluateAll(ims=>ims.map(im=>({src:im.currentSrc.split('/8765/').pop().replace('http://127.0.0.1:8765/',''),slot:Math.round(im.getBoundingClientRect().width),height:Math.round(im.getBoundingClientRect().height),natural:im.naturalWidth,srcset:im.srcset,complete:im.complete})));
 for(const row of rows){if(Math.abs(row.slot / row.height - 4/3)>0.03)throw Error('card aspect ratio changed');const path=new URL(row.src,'http://127.0.0.1:8765/').pathname.slice(1);row.bytes=fs.statSync(process.cwd()+'/'+path).size;if(!path.includes('/responsive/'))throw Error('original delivered: '+path);}
 let lightbox;
 if(file==='index.html'){
 const before=await page.evaluate(()=>performance.getEntriesByType('resource').filter(e=>/\.w1600/.test(e.name)).length);
 if(before)throw Error('lightbox loaded before click');
 await images.first().click();await page.locator('.home-lightbox-image').evaluate(im=>im.decode());
 lightbox=await page.locator('.home-lightbox-image').evaluate(im=>({src:im.currentSrc,natural:im.naturalWidth}));
 await page.keyboard.press('Escape');if(!await page.locator('.home-lightbox').evaluate(e=>e.hidden))throw Error('escape failed');
 }
 reports.push({file,width,dpr,total:rows.reduce((a,r)=>a+r.bytes,0),images:rows,lightbox});
 if(width===1440&&dpr===1){await page.screenshot({path:'/tmp/'+file+'.png',fullPage:true});}
 await context.close();
 }
}
fs.writeFileSync('docs/static-image-browser-checks.json',JSON.stringify(reports,null,2)+'\n');
console.log(reports.map(r=>({file:r.file,width:r.width,dpr:r.dpr,total:r.total})));
// Exercise the untouched live Photos contract independently from static fallback.
const page=await browser.newPage();
await page.setContent('<div id="home-highlights-grid"></div>');
await page.evaluate(()=>{
 window.SNH_CONFIG={supabaseUrl:'https://photos.example'};
 window.snhSupabase={rpc:async()=>({data:[{title:'Live album',assets:[
  {caption:'Live photo',variants:[{variant:'thumb',objectKey:'thumb.jpg'},{variant:'web',objectKey:'web.jpg'}]},
  {caption:'Missing thumb',variants:[{variant:'web',objectKey:'web-only.jpg'}]},
  {caption:'Excluded',excludeFromSlideshow:true,variants:[{variant:'web',objectKey:'excluded.jpg'}]}
 ]}]})};
});
await page.addScriptTag({path:'assets/js/home-highlights.js'});
await page.waitForSelector('.home-highlight-trigger');
const live=await page.locator('.home-highlight-trigger').evaluateAll(ts=>ts.map(t=>({thumb:t.querySelector('img').getAttribute('src'),full:t.dataset.imageSrc,srcset:t.querySelector('img').srcset})));
if(live.length!==2 || live.some(i=>i.srcset) || !live.some(i=>i.thumb.endsWith('/thumb.jpg')&&i.full.endsWith('/web.jpg')) || !live.some(i=>i.thumb.endsWith('/web-only.jpg')))throw Error('live Photos behavior changed');
console.log('Live Photos thumb/web, missing-thumb fallback and exclusions passed');
await page.setContent('<div id="home-highlights-grid"></div>');
await page.evaluate(()=>{window.snhSupabase=null;window.fetch=async()=>({ok:true,json:async()=>({highlights:[{filename:'legacy.jpg',alt:'Legacy',caption:'Legacy'}]})});});
await page.addScriptTag({path:'assets/js/home-highlights.js'});
await page.waitForSelector('.home-highlight-trigger');
const legacy=await page.locator('.home-highlight-trigger').evaluate(t=>({src:t.querySelector('img').getAttribute('src'),full:t.dataset.imageSrc,srcset:t.querySelector('img').srcset}));
if(legacy.src!=='assets/images/highlights/processed/legacy.jpg'||legacy.full!==legacy.src||legacy.srcset)throw Error('legacy manifest fallback changed');
console.log('Legacy static manifest compatibility passed');
await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
