// Optional local QA: npm install --no-save --package-lock=false playwright
// Uses isolated fixtures and never sends reports to Supabase.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=path.resolve(import.meta.dirname,'..');
const catalog=JSON.parse(await readFile(path.join(root,'data/games.json'),'utf8'));
const game=catalog.games.find(g=>g.title==='Future Spa');
const output=process.env.GAME_CARD_QA_DIR || '/tmp/game-card-qa';
await mkdir(output,{recursive:true});
const server=createServer(async(req,res)=>{
 try {
  const file=path.resolve(root,'.'+new URL(req.url,'http://localhost').pathname);
  if(!file.startsWith(root+path.sep)) throw Error('outside root');
  const data=await readFile(file);
  res.writeHead(200,{'Content-Type':({'.html':'text/html','.js':'text/javascript','.json':'application/json','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'})[path.extname(file)] || 'application/octet-stream'});res.end(data);
 } catch {res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try {
 browser=await chromium.launch({headless:true, ...(process.env.CHROMIUM_EXECUTABLE ? {executablePath:process.env.CHROMIUM_EXECUTABLE}: {})});
 const page=await browser.newPage({viewport:{width:1280,height:900}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.pathname.endsWith('/config.js'))return route.fulfill({contentType:'text/javascript',body:'window.SNH_CONFIG={gamesCatalogSource:"json"};'});
  if(url.pathname.endsWith('/supabase-init.js'))return route.fulfill({contentType:'text/javascript',body:''});
  if(url.pathname.endsWith('/site-auth.js'))return route.fulfill({contentType:'text/javascript',body:`window.SNHSiteAuth={getSession:async()=>window.__member?{user:{id:'member'}}:null,fetchMemberRoles:async()=>[],can:()=>false,onAuthStateChange:callback=>{window.__authListeners=window.__authListeners||new Set();if(callback)window.__authListeners.add(callback);return {data:{subscription:{unsubscribe(){window.__authListeners.delete(callback);}}}}}};`});
  if(url.hostname!=='127.0.0.1') {
   if(route.request().resourceType()==='image' && process.env.GAME_CARD_QA_PHOTO)
    return route.fulfill({contentType:'image/webp',body:await readFile(process.env.GAME_CARD_QA_PHOTO)});
   return route.abort();
  }
  return route.continue();
 });
 await page.goto(`http://127.0.0.1:${server.address().port}/games.html`);
 await page.locator('.games-list-item').first().waitFor();
 await page.evaluate(game=>{
  window.__game=game;window.__calls=[];window.__member=false;window.__failPhotos=false;window.__failSummary=false;
  window.__resolveInfo=null;window.__failNotes=false;window.__deferNotes=false;window.__resolveNotes=null;
  window.__notes=[
   {id:'active',gameId:game.id,title:'Member-only machine note',body:'Member-only detail <img src=x onerror=alert(1)>',status:'open'},
   {id:'resolved',gameId:game.id,title:'Resolved machine note',body:'Older detail',status:'resolved'},
   {id:'other',gameId:'different-game',title:'Other machine secret',body:'Not this machine',status:'open'}
  ];
  window.snhSupabase={rpc:async(name,args)=>{
   window.__calls.push({name,args});
   if(name==='snh_public_game_more_info')return new Promise(resolve=>{window.__resolveInfo=resolve;});
   if(name==='snh_public_game_tips')return {data:[{category:'general',text:'Preserved PinTips text'}]};
   if(name==='snh_public_game_images')return window.__failPhotos?{error:{message:'offline'}}:{data:window.__emptyPhotos?[]:[
    game.primaryImage,{...game.primaryImage,id:'second',altText:'Second approved photo',sourceType:'external',attributionText:'Club fixture credit',attributionUrl:'https://example.com/source'}]};
   if(name==='snh_public_game_issues')return window.__failSummary?{error:{message:'offline'}}:{data:window.__emptyIssues?[]:[{summary:'Left flipper is weak.',status:'in_progress'}]};
   if(name==='snh_club_issues_list')return window.__deferNotes?new Promise(resolve=>{window.__resolveNotes=resolve;}):window.__failNotes?{error:{message:'offline'}}:{data:window.__notes};
   if(name==='snh_club_issues_upsert') {
    if(window.__failSubmit)return {error:{message:'offline'}};
    window.__notes.unshift({...args.p_fields,id:'new-note'});return {data:null};
   }
   throw Error('Unexpected RPC '+name);
  }};
 },game);
 const open=async()=>{await page.evaluate(()=>{void openGameMoreInfoModal(window.__game);});await page.getByRole('tab',{name:'Overview',exact:true}).waitFor();};
 await open();
 const dialog=page.locator('.games-more-info-dialog');
 assert.equal(await dialog.evaluate(n=>n.scrollTop),0);
 const titleBox=await page.locator('.games-more-info-title').boundingBox();
 const closeBox=await page.getByRole('button',{name:'Close',exact:true}).boundingBox();
 assert.ok(Math.abs(titleBox.y-closeBox.y)<4,'title and Close share a row without a blank floated row');
 for(const href of await page.locator('.games-pintips-link').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('href')))) {
  assert.ok(href.includes('/opdb/entries/') && !href.endsWith('/pintips'));
 }

 assert.equal(await page.locator('main').evaluate(n=>n.inert),true);
 await page.getByRole('button',{name:'Close',exact:true}).press('Shift+Tab');
 assert.equal(await page.evaluate(()=>document.activeElement.closest('.games-more-info-dialog')!==null),true,'focus stays inside modal');
 assert.ok((await page.getByRole('tabpanel',{name:'Overview',exact:true}).innerText()).includes('Bridge St · Apr 2026 – Present'));
 assert.equal(await page.evaluate(()=>window.__calls.some(c=>c.name==='snh_public_game_images')),false,'gallery loads on demand');
 await page.getByRole('tab',{name:'Photos',exact:true}).click();
 await page.getByText('Photo 1 of 2',{exact:true}).waitFor();
 await page.getByRole('button',{name:/Show photo 2/}).click();
 await page.getByText('Photo 2 of 2',{exact:true}).waitFor();
 // Late information must not replace selected gallery DOM or keyboard focus.
 await page.evaluate(()=>window.__resolveInfo({data:{highScores:[{score:123456,playerLabel:'Club player'}]}}));
 assert.equal(await page.getByRole('tab',{name:'Photos',exact:true}).getAttribute('aria-selected'),'true');
 assert.match(await page.evaluate(()=>document.activeElement.getAttribute('aria-label')),/Show photo 2/);
 await page.getByText('Club fixture credit',{exact:true}).waitFor();
 const scrolledTitle=await page.locator('.games-more-info-title').boundingBox();
 const scrolledDialog=await dialog.boundingBox();
 const stickyClose=await page.getByRole('button',{name:'Close',exact:true}).boundingBox();
 assert.ok(scrolledTitle.y+scrolledTitle.height<scrolledDialog.y,'title scrolls out rather than obscuring the photo');
 assert.ok(stickyClose.y>=scrolledDialog.y && stickyClose.y<scrolledDialog.y+80,'only Close stays available');
 await page.screenshot({path:path.join(output,'gallery-desktop.png')});
 await page.getByRole('button',{name:'Enlarge photo',exact:true}).click();
 await page.locator('.games-photo-lightbox').waitFor({state:'visible'});
 await page.keyboard.press('Escape');
 assert.equal(await page.locator('#games-more-info-root').isVisible(),true,'Escape closes photo viewer only');
 await page.getByRole('tab',{name:'Tips',exact:true}).click();
 await page.getByText('Preserved PinTips text',{exact:true}).waitFor();
 assert.equal(await page.getByRole('link',{name:'Game info on OPDB',exact:true}).getAttribute('href'),`https://app.matchplay.events/opdb/entries/${game.opdbId}`);
 await page.getByRole('tab',{name:'Notes',exact:true}).click();
 await page.getByText('Left flipper is weak. · In progress',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.__calls.some(c=>c.name==='snh_club_issues_list')),false,'visitors never request member notes');
 const signin=page.getByRole('link',{name:'Sign in or sign up',exact:true});
 const target=new URL(await signin.getAttribute('href'),'http://local').searchParams.get('next');
 assert.equal(target,`members.html?panel=club-issues&issueGame=${game.id}`);
 assert.equal(await page.getByRole('button',{name:'Add a note',exact:true}).count(),0);
 await page.setViewportSize({width:390,height:844});
 await page.screenshot({path:path.join(output,'issues-phone.png')});
 assert.equal(await dialog.evaluate(n=>n.scrollWidth<=n.clientWidth),true,'no modal horizontal overflow');
 await page.getByRole('button',{name:'Close',exact:true}).click();
 assert.equal(await page.locator('main').evaluate(n=>n.inert),false);
 await page.evaluate(()=>{window.__member=true;});await open();
 await page.getByRole('tab',{name:'Notes',exact:true}).click();
 await page.getByText('Member-only machine note',{exact:true}).waitFor();
 assert.equal(await page.getByText('Other machine secret',{exact:true}).count(),0);
 assert.equal(await page.getByText('Resolved machine note',{exact:true}).isVisible(),false);
 await page.getByText('Resolved notes (1)',{exact:true}).click();
 assert.equal(await page.getByText('Resolved machine note',{exact:true}).isVisible(),true);
 assert.equal(await page.locator('.games-note-body img').count(),0,'notes render as plain text');
 assert.equal(await page.getByText('Left flipper is weak. · In progress',{exact:true}).count(),0,'members see original notes instead of duplicate public summaries');
 await page.getByLabel('Title',{exact:true}).fill('Weak flipper');
 await page.getByLabel('Details (optional)',{exact:true}).fill('Left flipper loses power after a few shots.');
 await page.evaluate(()=>window.__resolveInfo({data:{}}));
 assert.equal(await page.getByLabel('Title',{exact:true}).inputValue(),'Weak flipper','draft survives slow info response');
 await page.getByRole('button',{name:'Add a note',exact:true}).click();
 await page.getByText('Note added. Thank you for helping care for this machine.',{exact:true}).waitFor();
 const call=await page.evaluate(()=>window.__calls.find(c=>c.name==='snh_club_issues_upsert'));
 assert.deepEqual(call.args,{p_id:null,p_fields:{gameId:game.id,title:'Weak flipper',body:'Left flipper loses power after a few shots.',status:'open'}});
 // Submission error retains the draft and never claims success.
 await page.evaluate(()=>{window.__failSubmit=true;});
 await page.getByLabel('Title',{exact:true}).fill('Retained draft');
 await page.getByRole('button',{name:'Add a note',exact:true}).click();
 await page.getByText(/The note could not be confirmed/).waitFor();
 assert.equal(await page.getByLabel('Title',{exact:true}).inputValue(),'Retained draft');
 await page.screenshot({path:path.join(output,'member-report-phone.png')});
 await page.getByRole('button',{name:'Close',exact:true}).click();
 await page.evaluate(()=>{window.__failNotes=true;});await open();
 await page.getByRole('tab',{name:'Notes',exact:true}).click();
 await page.getByRole('button',{name:'Retry machine notes',exact:true}).waitFor();
 await page.getByLabel('Title',{exact:true}).fill('Draft while retrying notes');
 await page.evaluate(()=>{window.__failNotes=false;});
 await page.getByRole('button',{name:'Retry machine notes',exact:true}).click();
 await page.getByText('Member-only machine note',{exact:true}).waitFor();
 assert.equal(await page.getByLabel('Title',{exact:true}).inputValue(),'Draft while retrying notes');
 await page.getByRole('button',{name:'Close',exact:true}).click();
 await page.evaluate(()=>{window.__deferNotes=true;});await open();
 await page.getByRole('tab',{name:'Notes',exact:true}).click();
 await page.getByText('Loading machine notes…',{exact:true}).waitFor();
 await page.evaluate(()=>{window.__member=false;for(const callback of window.__authListeners)callback('SIGNED_OUT',null);});
 await page.getByRole('link',{name:'Sign in or sign up',exact:true}).waitFor();
 await page.evaluate(()=>window.__resolveNotes({data:window.__notes}));
 assert.equal(await page.getByText('Member-only machine note',{exact:true}).count(),0,'sign-out removes private notes');
 assert.equal(await page.getByRole('button',{name:'Add a note',exact:true}).count(),0);
 await page.getByRole('button',{name:'Close',exact:true}).click();
 await page.evaluate(()=>{window.__failPhotos=true;window.__failSummary=true;window.__member=false;});await open();
 await page.getByRole('tab',{name:'Photos',exact:true}).click();
 await page.getByRole('button',{name:'Retry photos',exact:true}).waitFor({state:'visible'});
 await page.evaluate(()=>{window.__failPhotos=false;window.__emptyPhotos=true;});
 await page.getByRole('button',{name:'Retry photos',exact:true}).click();
 await page.getByText('No approved photos are available for this machine yet.',{exact:true}).waitFor();
 await page.getByRole('tab',{name:'Notes',exact:true}).click();
 await page.getByRole('button',{name:'Retry public notes',exact:true}).waitFor();
 await page.evaluate(()=>{window.__failSummary=false;window.__emptyIssues=true;});
 await page.getByRole('button',{name:'Retry public notes',exact:true}).click();
 await page.getByText('No public notes have been posted for this machine.',{exact:true}).waitFor();
 // Home/End navigate the tab strip, keeping the selected panel in sync.
 await page.getByRole('tab',{name:'Notes',exact:true}).focus();await page.keyboard.press('Home');
 assert.equal(await page.getByRole('tab',{name:'Overview',exact:true}).getAttribute('aria-selected'),'true');
 // Exercise the existing Issues editor in isolation with its real panel script.
 const editor=await browser.newPage({viewport:{width:390,height:844}});
 editor.on('pageerror',e=>errors.push(e.message));
 await editor.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.pathname==='/editor-fixture.html')return route.fulfill({contentType:'text/html',body:`<!doctype html><html class="clubhouse club-account"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="assets/css/styles.css"><link rel="stylesheet" href="assets/css/clubhouse.css"><link rel="stylesheet" href="assets/css/club-account.css"></head><body><div id="member-club-issues-app"></div><script>
   window.__saved=[];
   window.SNHMemberPortal={
    memberHasAnyRole:()=>false,
    clubIssuesGameOptions:async()=>[{id:'${game.id}',title:'Future Spa'}],
    clubIssuesList:async()=>[{id:'report',gameId:'${game.id}',gameTitle:'Future Spa',title:'Private title',body:'Private details',status:'in_progress',publicSummary:'Weak flipper'}],
    clubIssuesUpsert:async(id,fields)=>{window.__saved.push({id,fields});},
    getFriendlyAuthErrorMessage:e=>e.message
   };
   </script><script src="assets/js/member-club-issues-panel.js"></script></body></html>`});
  return url.hostname==='127.0.0.1'?route.continue():route.abort();
 });
 await editor.goto(`http://127.0.0.1:${server.address().port}/editor-fixture.html?panel=club-issues&issueGame=${game.id}`);
 await editor.evaluate(()=>window.SNHMemberClubIssuesPanel.onPanelShown(['events_editor']));
 await editor.getByRole('button',{name:'Edit',exact:true}).waitFor();
 const filters=editor.getByRole('group',{name:'Filter notes by status',exact:true});
 assert.equal(await filters.getByRole('button').count(),4);
 const filterHeight=await filters.getByRole('button',{name:'In progress',exact:true}).evaluate(n=>n.getBoundingClientRect().height);
 assert.ok(filterHeight>=48,'header filters have prominent touch targets');
 assert.equal(await filters.getByRole('button',{name:'In progress',exact:true}).getAttribute('aria-pressed'),'true');
 await filters.getByRole('button',{name:'All',exact:true}).click();
 assert.equal(await filters.getByRole('button',{name:'All',exact:true}).getAttribute('aria-pressed'),'true');
 await filters.getByRole('button',{name:'In progress',exact:true}).click();
 await editor.screenshot({path:path.join(output,'notes-header-phone.png')});
 await editor.setViewportSize({width:1280,height:900});
 await editor.screenshot({path:path.join(output,'notes-header-desktop.png')});
 assert.equal(await editor.locator('#ci-game-select').inputValue(),game.id);
 assert.equal(await editor.getByRole('button',{name:'In progress',exact:true}).getAttribute('aria-current'),'true','default filter uses selected machine');
 await editor.getByRole('button',{name:'Edit',exact:true}).click();
 await editor.getByLabel('Public machine summary (optional)',{exact:true}).fill('New public symptom');
 await editor.getByRole('button',{name:'Save changes',exact:true}).click();
 await editor.getByText('Saved.',{exact:true}).waitFor();
 assert.equal(await editor.evaluate(()=>window.__saved[0].fields.publicSummary),'New public symptom');
 await editor.evaluate(()=>window.SNHMemberClubIssuesPanel.onPanelShown([]));
 assert.equal(await editor.getByLabel('Public machine summary (optional)',{exact:true}).isVisible(),false);
 await editor.getByLabel('Title',{exact:true}).fill('Member report');
 await editor.getByRole('button',{name:'Add note',exact:true}).click();
 await editor.getByText('Saved.',{exact:true}).waitFor();
 assert.equal(await editor.evaluate(()=>Object.hasOwn(window.__saved.at(-1).fields,'publicSummary')),false,'member never submits helper-only fields');
 await editor.close();
 assert.deepEqual(errors,[]);
 console.log('Passed original linked Notes, resolved history, sign-out/stale-read privacy, prominent header filters, helper publication and desktop/phone gallery, credits, lightbox, focus, PinTips, visitor/member reporting, drafts, retries and empty states.');
 console.log('Screenshots: '+output);
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
