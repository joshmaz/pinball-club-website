// Optional real-browser QA. Run with PLAYWRIGHT_MODULE pointing at a Playwright installation.
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const engineName = process.env.PLAYWRIGHT_BROWSER || 'chromium';
const engine = playwright[engineName];
const root = path.resolve(new URL('..', import.meta.url).pathname);
const mime = {'.js':'text/javascript','.html':'text/html','.css':'text/css','.png':'image/png'};
const server = createServer(async(req,res)=>{
 try {
  const relative=decodeURIComponent(new URL(req.url,'http://local').pathname).replace(/^\//,'');
  if(relative.includes('..')) throw new Error('Invalid path');
  const file=path.join(root,relative || 'photos.html');res.setHeader('Content-Type',mime[path.extname(file)] || 'application/octet-stream');res.end(await readFile(file));
 }catch{res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
let browser;
try {
 browser=await engine.launch({headless:true,...(engineName==='chromium'?{executablePath:process.env.PLAYWRIGHT_CHROMIUM || engine.executablePath(),args:['--no-sandbox']}:(process.env.PLAYWRIGHT_WEBKIT?{executablePath:process.env.PLAYWRIGHT_WEBKIT}:{}))});
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const albumId='00000000-0000-0000-0000-000000000200';
 const assetId='00000000-0000-0000-0000-000000000100';
 const albums=[{id:albumId,title:'Club night',eventId:'event-one',eventTitle:'Pinball night',description:'Our community',coverAssetId:assetId,
 assets:[0,1].map(n=>({id:n?assetId+'1':assetId,caption:n?'Second photo':'Cover photo',altText:'Pinball machines',variants:['web','thumb'].map(variant=>({variant,bucket:'photos-public',objectKey:variant+'.webp',width:640,height:427}))}))}];
 albums.push({...albums[0],id:'large-album',slug:'large-album',title:'Tournament weekend',eventId:'event-two',coverAssetId:null,
  assets:Array.from({length:50},(_,i)=>({...albums[0].assets[0],id:'large-'+i,caption:'Photo '+(i+1)}))});
 for(let i=0;i<12;i++)albums.push({...albums[0],id:'extra-'+i,title:'Archive '+i,eventId:null});
 await page.route('https://**/*',route=>route.fulfill({contentType:'text/javascript',body:''}));
 await page.route('**/assets/js/config.js',route=>route.fulfill({contentType:'text/javascript',body:'window.SNH_CONFIG={supabaseUrl:"https://test.supabase.co",supabaseAnonKey:"test"};'}));
 await page.addInitScript(albums=>{
  window.supabase={createClient:()=>({rpc:async()=>({data:albums,error:null}),auth:{getSession:async()=>({data:{session:null}}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})}})};
 },albums);
 await page.route('**/storage/v1/object/public/photos-public/**',route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="640" height="427"><rect width="640" height="427" fill="#153c42"/><rect x="80" y="60" width="170" height="300" fill="#ffa020"/><text x="285" y="220" fill="white" font-size="30">Pinball night</text></svg>'}));
 await page.goto(base+'/photos.html');
 await page.getByRole('heading',{name:'Club night'}).waitFor();
 assert.equal(await page.locator('.photos-album').count(),12,'initial album rendering is bounded');
 assert.equal(await page.locator('.photos-grid button').count(),0,'collapsed albums create no photo grids');
 await page.locator('#album-'+albumId+' > summary').click();
 await page.waitForFunction(()=>document.querySelectorAll('.photos-grid button').length===2);
 assert.equal(await page.locator('.photos-grid button').count(),2);
 assert.equal(await page.locator('[download]').count(),0);
 await page.locator('.photos-grid button').first().click();assert.ok(await page.locator('#photos-lightbox').evaluate(e=>e.open));
 await page.keyboard.press('ArrowRight');assert.match(await page.locator('#photos-caption').textContent(),/Second photo.*2 of 2/);
 await page.keyboard.press('Escape');assert.equal(await page.locator('#photos-lightbox').evaluate(e=>e.open),false);
 assert.equal(await page.locator('.photos-grid button').first().evaluate(e=>e===document.activeElement),true);
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:'/tmp/photo-gallery-mobile.png',fullPage:true});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile gallery does not overflow');
 await page.locator('#album-'+albumId+' > summary').click();
 await page.waitForFunction(()=>document.querySelectorAll('.photos-grid button').length===0);
 await page.getByRole('button',{name:/Show more albums/}).click();
 assert.equal(await page.locator('.photos-album').count(),14);
 assert.equal(await page.locator('.photos-grid button').count(),0);
 await page.goto(base+'/photos.html?album=large-album');
 await page.waitForFunction(()=>document.querySelectorAll('.photos-grid button').length===24);
 assert.equal(await page.locator('.photos-album[open]').count(),1,'direct album links open the album');
 await page.locator('.photos-grid button').nth(23).click();
 await page.keyboard.press('ArrowRight');
 assert.match(await page.locator('#photos-caption').textContent(),/Photo 25.*25 of 50/,'lightbox can reach photos beyond rendered grid');
 await page.keyboard.press('Escape');
 await page.getByRole('button',{name:'Show more photos in Tournament weekend'}).click();
 assert.equal(await page.locator('.photos-grid button').count(),48);
 await page.getByRole('button',{name:'Show more photos in Tournament weekend'}).click();
 assert.equal(await page.locator('.photos-grid button').count(),50);
 await page.locator('#album-large-album > summary').click();
 await page.waitForFunction(()=>document.querySelectorAll('.photos-grid button').length===0);
 await page.locator('#album-large-album > summary').click();
 await page.waitForFunction(()=>document.querySelectorAll('.photos-grid button').length===24);
 await page.goto(base+'/photos.html?event=event-one');
 await page.getByRole('heading',{name:'Club night'}).waitFor();
 assert.equal(await page.locator('.photos-album').count(),1);
 assert.equal(await page.locator('.photos-grid button').count(),0);
 await page.goto(base+'/photos.html?event=missing');await page.getByText('No published photos are available yet.').waitFor();
 await page.goto(base+'/photos.html?album='+albumId);await page.getByRole('link',{name:'All albums',exact:true}).waitFor();
 // Real canvas/WebP encoding, resize limits, no enlargement, and metadata rejection behavior.
 await page.addScriptTag({url:base+'/assets/js/photo-conversion.js'});
 let fallbackRequests=0;
 page.on('request',request=>{if(request.url().includes('/assets/vendor/jsquash-webp/'))fallbackRequests++;});
 const convertSamples=async()=>{
  const c=document.createElement('canvas');c.width=4200;c.height=2800;const ctx=c.getContext('2d');
  ctx.fillStyle='#153c42';ctx.fillRect(0,0,c.width,c.height);ctx.fillStyle='#ffa020';ctx.fillRect(0,0,1200,1800);
  const input=new File([await new Promise(r=>c.toBlob(r,'image/jpeg',0.9))],'large.jpg',{type:'image/jpeg'});
  const output=await SNHPhotoConversion.convert(input);
  window.photoConvertedBytes=await Promise.all(output.map(async v=>Array.from(new Uint8Array(await v.blob.arrayBuffer()))));
  const result=[];
  for(const v of output){const decoded=await createImageBitmap(v.blob);result.push({variant:v.variant,width:decoded.width,height:decoded.height,type:v.blob.type});decoded.close();}
  c.width=200;c.height=100;const small=new File([await new Promise(r=>c.toBlob(r,'image/png'))],'small.png',{type:'image/png'});
  result.push(...(await SNHPhotoConversion.convert(small)).map(v=>({variant:v.variant,width:v.width,height:v.height})));
  const jpg=new Uint8Array(await (await new Promise(r=>c.toBlob(r,'image/jpeg'))).arrayBuffer());
  const exif=new Uint8Array([255,225,0,34,69,120,105,102,0,0,73,73,42,0,8,0,0,0,1,0,18,1,3,0,1,0,0,0,6,0,0,0,0,0,0,0]);
  const rotated=new File([jpg.slice(0,2),exif,jpg.slice(2)],'rotated.jpg',{type:'image/jpeg'});
  result.push(...(await SNHPhotoConversion.convert(rotated)).map(v=>({variant:v.variant,width:v.width,height:v.height})));
  return result;
 };
 const conversion=await page.evaluate(convertSamples);
 assert.deepEqual(conversion.slice(0,2),[{variant:'web',width:1920,height:1280,type:'image/webp'},{variant:'thumb',width:640,height:427,type:'image/webp'}]);
 assert.ok(conversion.slice(2,4).every(v=>v.width===200 && v.height===100));
 assert.ok(conversion.slice(4).every(v=>v.width===100 && v.height===200),'EXIF rotation is applied');
 // Safari/iOS behavior: requesting WebP from canvas yields PNG. Exercise the
 // actual bundled WASM worker, with the same real resize/orientation samples.
 if(engineName==='chromium') assert.equal(fallbackRequests,0,'native browsers do not download the fallback');
 await page.evaluate(()=>{
  const original=HTMLCanvasElement.prototype.toBlob;
  window.restorePhotoToBlob=()=>{HTMLCanvasElement.prototype.toBlob=original;};
  HTMLCanvasElement.prototype.toBlob=function(callback,type,quality){return original.call(this,callback,type==='image/webp'?'image/png':type,quality);};
 });
 await page.addScriptTag({url:base+'/assets/js/photo-conversion.js'});
 const fallbackConversion=await page.evaluate(convertSamples);
 assert.deepEqual(fallbackConversion,conversion,'WASM fallback preserves dimensions, WebP output and EXIF orientation');
 assert.ok(fallbackRequests>=3,'fallback loads local codec JS, defaults and WASM');
 const ts=require('typescript');
 const shared=await readFile(path.join(root,'supabase/functions/_shared/photo-v2.ts'),'utf8');
 const parserSource=ts.transpileModule(shared.replace(/^import .*?;\s*$/gm,'').replace(/^export /gm,''),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
 const parseWebp=new Function(parserSource+';return webpDimensions;')();
 const fallbackBytes=await page.evaluate(()=>photoConvertedBytes);
 assert.deepEqual(fallbackBytes.map(bytes=>parseWebp(new Uint8Array(bytes))),[{width:1920,height:1280},{width:640,height:427}],'fallback bytes pass actual backend WebP validation');
 // A load failure must produce a retryable error; conversion succeeds after retry.
 await page.route('**/assets/vendor/jsquash-webp/webp_enc.wasm',route=>route.abort());
 const failure=await page.evaluate(async()=>{
  const c=document.createElement('canvas');c.width=c.height=10;
  const file=new File([await new Promise(r=>c.toBlob(r,'image/png'))],'test.png',{type:'image/png'});
  try {await SNHPhotoConversion.convert(file);return null;}catch(error){return error.message;}
 });
 assert.ok(failure,'failed WASM download is surfaced');
 await page.unroute('**/assets/vendor/jsquash-webp/webp_enc.wasm');
 assert.deepEqual(await page.evaluate(convertSamples),conversion,'retry after encoder load failure succeeds');
 await page.evaluate(()=>restorePhotoToBlob());
 // Phase 2 volunteer workspace: drag/drop, weighted progress, retry, covers and one-action publication.
 await page.setContent('<main><div id="member-photos-status" role="status"></div><div id="member-photos-app"></div></main>');
 for(const stylesheet of ['styles.css','clubhouse.css','club-account.css']) await page.addStyleTag({url:base+'/assets/css/'+stylesheet});
 await page.evaluate(()=>document.documentElement.classList.add('clubhouse','club-account'));
 await page.addScriptTag({url:base+'/assets/js/photo-conversion.js'});
 await page.evaluate(({albumId,assetId})=>{
  window.testUploads=[]; window.failOnce=true; window.failPublishOnce=true; window.publishCalls=[]; window.albumSaves=[]; window.purgeCalls=[];
  window.editorAlbum={id:albumId,title:'Club night',slug:'club-night',published:false,coverAssetId:null,assetCounts:{total:0}};
  window.editorAssets=[]; window.extraAlbums=[]; window.galleryOrder={mode:'custom',revision:1}; window.orderSaves=[]; window.failOrder=false;
  const copy=value=>JSON.parse(JSON.stringify(value));
  window.SNHMemberPortal={
   photoAlbumsListEditor:async()=>[copy({...editorAlbum,sortPosition:editorAlbum.sortPosition || 0,assetCounts:{total:editorAssets.length,published:editorAssets.filter(a=>a.status==='published').length}}),...copy(extraAlbums)],
   photoAlbumOrderSettings:async()=>copy(galleryOrder),
   photoAlbumOrderSave:async(mode,ids,revision)=>{if(failOrder){failOrder=false;throw new Error('Album order changed. Cancel and reopen the sorter.');}orderSaves.push({mode,ids:ids.slice(),revision});if(mode==='custom')ids.forEach((id,i)=>{const a=id===editorAlbum.id?editorAlbum:extraAlbums.find(a=>a.id===id);a.sortPosition=i+1;});galleryOrder={mode,revision:revision+1};return copy(galleryOrder);},
   photoAssetsListEditor:async()=>copy(editorAssets),photoEventsListForPhotoLink:async()=>[],
   photoUploadAndRegister:async(album,file,job)=>{
    testUploads.push(file.name); job.onProgress('Converting',10);
    await new Promise(resolve=>setTimeout(resolve,250));
    if(file.name==='first.png' && failOnce){failOnce=false;throw new Error('Network interrupted');}
    job.onProgress('Uploading photo',50); await new Promise(resolve=>setTimeout(resolve,100));
    const id=assetId+'-'+file.name;
    editorAssets.push({id,albumId,status:'uploaded',uploadMode:'browser',originalFilename:file.name,
      variants:[{variant:'thumb',bucket:'photos-public',objectKey:'thumb.webp'},{variant:'web',bucket:'photos-public',objectKey:'web.webp'}]});
    job.onProgress('Ready to publish',100);return {assetId:id};
   },
   photoAlbumUpsert:async(id,fields)=>{albumSaves.push(copy(fields));Object.assign(editorAlbum,fields);return id;},
   photoPublishAsset:async(id)=>{
    publishCalls.push(id);await new Promise(resolve=>setTimeout(resolve,100));
    if(id.endsWith('first.png') && failPublishOnce){failPublishOnce=false;throw new Error('Publication interrupted');}
    editorAssets.find(asset=>asset.id===id).status='published';return {ok:true};
   },
   photoPurgeAsset:async(id,action)=>{purgeCalls.push({id,action});},
   buildPublicPhotoUrl:key=>'https://test.supabase.co/storage/v1/object/public/photos-public/'+key,
   photoCleanup:async()=>({cleanup:{removed:0,failed:0,pending:0}})
  };
 },{albumId,assetId});
 await page.addScriptTag({url:base+'/assets/js/member-photos-panel.js'});
 await page.evaluate(()=>window.SNHMemberPhotosPanel.init(['photos_admin']));
 await page.getByRole('button',{name:/Club night/}).click();
 await page.getByText('Edit album details',{exact:true}).click();
 assert.equal(await page.locator('#member-photos-album-sort').count(),0,'album position numbers are not shown');
 await page.locator('#member-photos-album-title').fill('Updated club night');
 const transfer=await page.evaluateHandle(()=>{
  const data=new DataTransfer();
  for(const name of ['first.png','second.png']) data.items.add(new File(['synthetic'],name,{type:'image/png'}));
  return data;
 });
 const zone=page.locator('#member-photos-drop-zone');
 await zone.dispatchEvent('dragenter',{dataTransfer:transfer});
 assert.ok(await zone.evaluate(e=>e.classList.contains('is-dragging')));
 await zone.dispatchEvent('drop',{dataTransfer:transfer});
 await page.waitForFunction(()=>document.querySelector('.photo-upload-job progress')?.value===10);
 assert.equal(await page.locator('#member-photos-publish-album').isDisabled(),true,'publication waits for active upload');
 assert.ok(await page.locator('#member-photos-batch-progress').evaluate(e=>e.value>0));
 await page.waitForFunction(()=>document.querySelector('#member-photos-batch-summary').textContent==='1 of 2 photos ready · 1 need attention');
 assert.deepEqual(await page.evaluate(()=>testUploads),['first.png','second.png']);
 assert.match(await page.locator('#member-photos-batch-summary').textContent(),/1 of 2.*1 need attention/);
 await page.setViewportSize({width:1280,height:1000});
 await page.screenshot({path:'/tmp/photo-editor-phase2-retry-desktop.png',fullPage:true});
 await page.getByRole('button',{name:'Retry failed files',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('#member-photos-batch-summary').textContent==='2 of 2 photos ready');
 assert.deepEqual(await page.evaluate(()=>testUploads),['first.png','second.png','first.png']);
 assert.equal(await page.locator('#member-photos-batch-progress').evaluate(e=>e.value),100);
 assert.equal(await page.locator('#member-photos-album-title').inputValue(),'Updated club night','unsaved details survive batch refresh');
 await page.locator('.member-photos-asset').filter({hasText:'second.png'}).getByRole('button',{name:'Use as cover',exact:true}).click();
 await page.getByRole('button',{name:'Selected cover',exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>editorAlbum.coverAssetId),assetId+'-second.png');
 assert.equal(await page.evaluate(()=>editorAlbum.published),false,'cover selection does not publish');
 assert.equal(await page.locator('.member-photos-asset.is-cover').count(),1);
 await page.evaluate(()=>editorAssets.push({...editorAssets[0],id:'hidden-photo',status:'unpublished',originalFilename:'Intentionally hidden.png'}));
 await page.getByRole('button',{name:'Publish album',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('#member-photos-status').textContent.includes('Album publication did not finish'));
 assert.equal(await page.evaluate(()=>editorAlbum.published),false,'failed photo publication leaves the album draft');
 await page.getByRole('button',{name:'Publish album',exact:true}).click();
 await page.getByRole('button',{name:'Hide from gallery',exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>editorAlbum.published),true);
 assert.equal(await page.evaluate(()=>editorAssets.filter(a=>a.id!=='hidden-photo').every(a=>a.status==='published')),true);
 assert.deepEqual(await page.evaluate(()=>publishCalls),[assetId+'-second.png',assetId+'-first.png',assetId+'-first.png'],'retry publishes only remaining photos');
 assert.equal(await page.evaluate(()=>editorAssets.find(a=>a.id==='hidden-photo').status),'unpublished','album publication preserves intentionally hidden photos');
 assert.equal(await page.evaluate(()=>editorAlbum.title),'Updated club night');
 await page.setViewportSize({width:390,height:844});
 await page.screenshot({path:'/tmp/photo-editor-phase2-mobile.png',fullPage:true});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile editor does not overflow');
 await page.getByRole('button',{name:'Hide from gallery',exact:true}).click();
 await page.getByRole('button',{name:'Publish album',exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>editorAlbum.published),false);
 assert.deepEqual(await page.evaluate(()=>purgeCalls),[],'hiding album retains all photos');
 await page.getByRole('button',{name:'Clear completed files',exact:true}).click();
 assert.equal(await page.locator('#member-photos-batch').isVisible(),false);
 await page.getByRole('button',{name:'New album',exact:true}).click();
 assert.equal(await page.locator('#member-photos-album-sort').count(),0);
 await page.evaluate(()=>extraAlbums=[{id:'album-two',title:'Second album',published:false,sortPosition:1,displayAt:'2025-01-01'}, {id:'album-three',title:'Third album',published:true,sortPosition:2,displayAt:'2026-01-01'}]);
 await page.getByRole('button',{name:'Refresh albums',exact:true}).click();
 await page.getByRole('button',{name:'Arrange albums',exact:true}).click();
 await page.locator('#photo-album-order-mode').waitFor();
 assert.equal(await page.locator('#member-photos-album-sort').count(),0);
 await page.getByRole('button',{name:'Move to top: Third album',exact:true}).click();
 assert.deepEqual(await page.locator('.photo-sort-row').evaluateAll(rows=>rows.map(r=>r.dataset.albumId)),['album-three',albumId,'album-two']);
 assert.ok(await page.locator('#photo-sort-album-three').evaluate(e=>e.contains(document.activeElement)),'move actions retain keyboard focus');
 await page.screenshot({path:'/tmp/photo-album-sorter-mobile.png',fullPage:true});
 await page.getByRole('button',{name:'Cancel',exact:true}).click();
 assert.deepEqual(await page.evaluate(()=>orderSaves),[],'cancel does not persist ordering');
 await page.getByRole('button',{name:'Arrange albums',exact:true}).click();
 await page.locator('#photo-album-order-mode').waitFor();
 const reorderTransfer=await page.evaluateHandle(()=>new DataTransfer());
 await page.locator('#photo-sort-album-three .photo-sort-handle').dispatchEvent('dragstart',{dataTransfer:reorderTransfer});
 await page.locator('#photo-sort-'+albumId).dispatchEvent('drop',{dataTransfer:reorderTransfer});
 assert.equal(await page.locator('.photo-sort-row').first().getAttribute('data-album-id'),'album-three','drag reorders albums');
 await page.getByRole('button',{name:'Save order',exact:true}).click();
 await page.getByRole('button',{name:'Arrange albums',exact:true}).waitFor();
 assert.deepEqual(await page.evaluate(()=>orderSaves[0].ids),['album-three',albumId,'album-two']);
 await page.getByRole('button',{name:'Arrange albums',exact:true}).click();
 await page.locator('#photo-album-order-mode').selectOption('newest');
 assert.equal(await page.locator('.photo-sort-row').first().getAttribute('data-album-id'),'album-three');
 assert.equal(await page.getByRole('button',{name:/Move up:/}).count(),0,'automatic mode has no manual moves');
 await page.evaluate(()=>failOrder=true);
 await page.getByRole('button',{name:'Save order',exact:true}).click();
 await page.getByText('Album order changed. Cancel and reopen the sorter.',{exact:true}).waitFor();
 assert.equal(await page.locator('#photo-album-order-mode').count(),1,'save errors keep the draft available');
 await page.getByRole('button',{name:'Save order',exact:true}).click();
 await page.getByText('Newest albums first',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>orderSaves.at(-1).mode),'newest');
 await page.getByRole('button',{name:'Arrange albums',exact:true}).click();
 await page.locator('#photo-album-order-mode').selectOption('custom');
 assert.deepEqual(await page.locator('.photo-sort-row').evaluateAll(rows=>rows.map(r=>r.dataset.albumId)),['album-three',albumId,'album-two'],'automatic mode preserves saved custom sequence');
 await page.getByRole('button',{name:'Cancel',exact:true}).click();
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile sorter does not overflow');
 await page.evaluate(()=>SNHMemberPortal.photoAlbumOrderSettings=async()=>{throw new Error('missing migration');});
 await page.getByRole('button',{name:'Refresh albums',exact:true}).click();
 assert.equal(await page.getByRole('button',{name:'Arrange albums',exact:true}).isDisabled(),true,'missing migration disables sorter safely');
 await page.getByRole('button',{name:/Updated club night/}).click();
 await page.getByText('Edit album details',{exact:true}).click();
 await page.getByRole('button',{name:'Save details',exact:true}).click();
 await page.getByText('Album details saved.',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>albumSaves.at(-1).sortPosition),2,'old-backend metadata saves preserve album position');
 assert.deepEqual(errors,[]);
 console.log(engineName + ' browser QA passed: native/fallback WebP encoding and encoder download failure/retry, WebP/EXIF conversion, gallery/lightbox, collapsed albums, bounded album/photo rendering, direct links, visual sorter drag/move/save/cancel, automatic order, stale-save recovery, migration compatibility, drag/drop, visible batch progress, retry without duplicate success, draft preservation, cover selection, publication failure/retry, one-action publication and mobile layout.');
} finally {if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
