// Optional browser QA: npm install --no-save --package-lock=false playwright
// npx playwright install chromium && node scripts/pintips-browser-check.mjs
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=path.resolve(import.meta.dirname,'..');
const server=createServer(async(req,res)=>{
 try {
  const pathname=new URL(req.url,'http://localhost').pathname;
  const file=path.resolve(root,'.'+pathname);
  if(!file.startsWith(root+path.sep)) throw Error('outside root');
  const body=await readFile(file);
  const type={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png'}[path.extname(file)] || 'application/octet-stream';
  res.writeHead(200,{'Content-Type':type});res.end(body);
 } catch {res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try {
 browser=await chromium.launch({headless:true});
 const page=await browser.newPage(); const calls=[]; const errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',route=>{
  const url=new URL(route.request().url());
  if(url.pathname.endsWith('/config.js')) return route.fulfill({contentType:'text/javascript',body:'window.SNH_CONFIG={gamesCatalogSource:"json"};'});
  if(url.pathname.endsWith('/supabase-init.js')) return route.fulfill({contentType:'text/javascript',body:''});
  if(url.hostname!=='127.0.0.1') {calls.push(url.href);return route.abort();}
  return route.continue();
 });
 await page.goto(`http://127.0.0.1:${server.address().port}/games.html`);
 await page.locator('.games-list-item').first().waitFor();
 await page.evaluate(()=>{
  window.__tipsMode='populated';
  window.snhSupabase={rpc:async name=>name==='snh_public_game_tips'
   ? window.__tipsMode==='error' ? {error:{message:'offline'}} : {data:window.__tipsMode==='empty' ? [] : [
    {id:1,category:'multiball',text:'Shoot the ramps to light locks.\nThen shoot the center scoop to start multiball.'},
    {id:2,category:'general',text:'<img src=x onerror="window.__xss=true">\n'+ 'LongTip'.repeat(35),contributor:'Example contributor'},
   ]} : {data:{highScores:[{score:123456,playerLabel:"Club player"}]}}};
 });
 // Open the actual card button, exercising the async database-read path.
 await page.locator('.games-list-item').first().getByRole('button',{name:/More|details/i}).first().click();
 await page.getByRole('tab',{name:'Tips',exact:true}).click();
 await page.getByText('Tips from PinTips',{exact:true}).waitFor();
 const panel=page.getByRole('tabpanel',{name:'Tips',exact:true});
 await panel.getByText('By Example contributor',{exact:true}).waitFor();
 assert.equal(await panel.locator('img').count(),0);
 assert.equal(await page.evaluate(()=>Boolean(window.__xss)),false);
 assert.equal(await panel.locator('.games-tip-text').first().evaluate(el=>getComputedStyle(el).whiteSpace),'pre-wrap');
 assert.ok((await panel.getByRole('link',{name:'View on PinTips'}).getAttribute('href')).startsWith('https://app.matchplay.events/opdb/entries/'));
 await page.getByRole('tab',{name:'Tips',exact:true}).press('ArrowLeft');
 assert.equal(await page.getByRole('tab',{name:'Tips',exact:true}).getAttribute('aria-selected'),'false');
 await page.getByRole('tab',{name:'Tips',exact:true}).click();
 await mkdir(path.join(root,'temp/pintips-qa'),{recursive:true});
 for(const [name,width,height] of [['desktop',1280,900],['mobile',375,812],['narrow',320,740]]) {
  await page.setViewportSize({width,height});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${name}: page overflow`);
  assert.equal(await panel.evaluate(el=>el.scrollWidth>el.clientWidth),false,`${name}: tips overflow`);
  await page.screenshot({path:path.join(root,`temp/pintips-qa/${name}.png`)});
 }
 for(const [mode,message] of [['empty','No PinTips are available for this game yet.'],['error','Tips could not be loaded. Please try again.']]) {
  await page.keyboard.press('Escape');
  await page.evaluate(mode=>{window.__tipsMode=mode;},mode);
  await page.locator('.games-list-item').first().getByRole('button',{name:/More|details/i}).first().click();
  await page.getByRole('tab',{name:'Tips',exact:true}).click();
  await page.getByText(message,{exact:true}).waitFor();
 }
 assert.ok(!calls.some(url=>url.includes('latest-pintips')||url.includes('/api/pintips')),'browser never requests PinTips provider');
 assert.deepEqual(errors,[]);
 console.log('Browser QA passed: populated/empty/error, safe text, attribution, keyboard tabs, desktop/375px/320px layouts. Screenshots: temp/pintips-qa.');
} finally {await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
