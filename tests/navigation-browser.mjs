import { homedir } from 'node:os';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const base=new URL(process.env.NAVIGATION_BASE_URL||'http://127.0.0.1:4000/');
const local=['127.0.0.1','localhost','[::1]'].includes(base.hostname)&&base.protocol==='http:';
assert.ok(local||base.origin==='https://yuchen0515.github.io','Navigation acceptance only targets loopback or the official HTTPS website.');
assert.ok(!base.username&&!base.password&&!base.search&&!base.hash&&base.pathname==='/','Use only the site base URL.');
const run=new Date().toISOString().replace(/[:.]/g,'-');
const output=path.join(project,'audit','navigation',run);
await fs.mkdir(output,{recursive:true});
const receipt={startedAt:new Date().toISOString(),base:base.href,cases:[],pageErrors:[],localFailures:[],blockedWrites:[],screenshots:[]};
let browser;

async function executable(){
 const proposed=process.env.BROWSER_EXECUTABLE||chromium.executablePath();
 try{await fs.access(proposed);return proposed}catch{}
 const cache=path.join(homedir(), 'Library', 'Caches', 'ms-playwright');
 const versions=(await fs.readdir(cache)).filter(name=>/^chromium_headless_shell-\d+$/.test(name)).sort((a,b)=>Number(b.split('-').at(-1))-Number(a.split('-').at(-1)));
 for(const version of versions){const candidate=path.join(cache,version,'chrome-headless-shell-mac-arm64','chrome-headless-shell');try{await fs.access(candidate);return candidate}catch{}}
 throw Error('No existing Playwright Chromium executable is available.');
}
async function context(options={}){
 const ctx=await browser.newContext(options);
 await ctx.route('**/*',async route=>{
   const request=route.request();
   if(!['GET','HEAD','OPTIONS'].includes(request.method())){receipt.blockedWrites.push({url:request.url(),method:request.method()});await route.abort();return}
   await route.continue();
 });
 ctx.on('page',page=>{
   page.on('pageerror',error=>receipt.pageErrors.push({page:page.url(),message:error.message}));
   page.on('requestfailed',request=>{if(new URL(request.url()).origin===base.origin&&['image','script','stylesheet','font'].includes(request.resourceType()))receipt.localFailures.push({url:request.url(),error:request.failure()?.errorText})});
   page.on('response',response=>{if(response.status()>=400&&new URL(response.url()).origin===base.origin&&['image','script','stylesheet','font'].includes(response.request().resourceType()))receipt.localFailures.push({url:response.url(),status:response.status()})});
 });
 return ctx;
}
async function check(name,operation){const started=Date.now();try{const details=await operation();receipt.cases.push({name,passed:true,durationMs:Date.now()-started,...(details?{details}:{})});console.log('PASS '+name)}catch(error){receipt.cases.push({name,passed:false,durationMs:Date.now()-started,error:error.stack||String(error)});console.error('FAIL '+name+': '+error.message)}}
async function visit(page,route){const response=await page.goto(new URL(route,base).href,{waitUntil:'domcontentloaded'});assert.equal(response.status(),200,route);await page.locator('main').waitFor();await page.evaluate(()=>document.fonts.ready);}
async function noOverflow(page){const result=await page.evaluate(()=>({viewport:innerWidth,document:document.documentElement.scrollWidth,body:document.body.scrollWidth}));assert.ok(result.document<=result.viewport+1&&result.body<=result.viewport+1,JSON.stringify(result));return result;}
async function picture(page,name){const target=path.join(output,name+'.png');await page.screenshot({path:target});receipt.screenshots.push(path.relative(project,target));}

try{
 browser=await chromium.launch({headless:true,executablePath:await executable()});
 for(const route of ['/about/','/links/'])for(const width of [320,390,768,1440])for(const language of ['zh','en']){
   await check(`${route} ${width}px ${language}: visible headings, keyboard navigation and collapse`,async()=>{
     const ctx=await context({viewport:{width,height:900},reducedMotion:'reduce'});
     try{
       const page=await ctx.newPage();await visit(page,route);
       if(language==='en')await page.locator('[data-language-button=en]').click();
       const mobile=width<=1000,details=page.locator('[data-mobile-toc]'),aside=page.locator('.article-aside');
       assert.equal(await details.isVisible(),mobile);assert.equal(await aside.isVisible(),!mobile);
       const nav=page.locator(mobile?'[data-mobile-toc] nav':'.toc-inner nav');
       if(mobile){assert.equal(await details.evaluate(el=>el.open),false);await details.locator('summary').focus();await page.keyboard.press('Space');await page.waitForFunction(()=>document.querySelector('[data-mobile-toc]').open);assert.notEqual(await details.locator('summary').evaluate(el=>getComputedStyle(el).outlineStyle),'none');await page.keyboard.press('Tab');assert.ok(await nav.locator('a:visible').first().evaluate(el=>el===document.activeElement),'Tab must enter the first visible item.');}
       const headings=await page.locator('.prose h2[id],.prose h3[id]').evaluateAll(els=>els.filter(el=>el.getClientRects().length).map(el=>({id:el.id,text:el.textContent.trim()})));
       const links=await nav.locator('a').evaluateAll(els=>els.filter(el=>el.getClientRects().length).map(el=>({id:decodeURIComponent(el.hash.slice(1)),text:el.textContent.trim()})));
       assert.deepEqual(links,headings,'The visible contents must match the real rendered headings in order.');assert.ok(links.length>8,'Exercise a real long page.');
       assert.equal(await page.locator('.article-header h1').getAttribute('lang'),language==='en'?'en':'zh-Hant');
       if(width===320)await picture(page,route.replaceAll('/','')+'-'+language+'-320-open');
       const target=links[Math.floor(links.length/2)];const link=nav.locator('a:visible').nth(Math.floor(links.length/2));
       await link.focus();await page.keyboard.press('Enter');
       await page.waitForFunction(id=>{const el=document.getElementById(id),rect=el?.getBoundingClientRect();return el===document.activeElement&&rect.top>=-2&&rect.top<innerHeight/2},target.id);
       assert.equal(decodeURIComponent(new URL(page.url()).hash.slice(1)),target.id);
       if(mobile)assert.equal(await details.evaluate(el=>el.open),false,'Choosing a section must collapse the menu.');
       await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>!!document.activeElement.closest('[data-mobile-toc]')),false,'The next Tab continues in the article.');
       return {headings:headings.length,target:target.id,...await noOverflow(page)};
     }finally{await ctx.close()}
   });
 }
 await check('mobile contents update while open and remain usable after viewport changes',async()=>{
   const ctx=await context({viewport:{width:390,height:900},reducedMotion:'reduce'});try{const page=await ctx.newPage();await visit(page,'/about/');await page.locator('[data-mobile-toc] summary').click();await page.locator('[data-language-button=en]').click();assert.equal(await page.locator('[data-mobile-toc]').evaluate(el=>el.open),true);assert.equal(await page.locator('[data-mobile-toc] [data-toc-language=zh]:visible').count(),0);assert.ok(await page.locator('[data-mobile-toc] [data-toc-language=en]:visible').count()>8);await page.setViewportSize({width:1440,height:900});assert.ok(await page.locator('.article-aside').isVisible());assert.equal(await page.locator('[data-mobile-toc]').isVisible(),false);await page.setViewportSize({width:320,height:900});assert.ok(await page.locator('[data-mobile-toc]').isVisible());assert.ok(await page.locator('[data-mobile-toc] [data-toc-language=en]:visible').count()>8);return await noOverflow(page)}finally{await ctx.close()}
 });
 for(const width of [320,390])await check(`normal motion ${width}px dark: repeated same-heading jump preserves focus`,async()=>{
   const ctx=await context({viewport:{width,height:900},colorScheme:'dark',reducedMotion:'no-preference'});try{
     const page=await ctx.newPage();await visit(page,'/about/');const details=page.locator('[data-mobile-toc]');
     assert.equal(await page.locator('[data-toggle-theme]').getAttribute('aria-label'),'切換淺色模式');
     let target;
     for(let attempt=0;attempt<2;attempt++){
       await details.locator('summary').click();const links=details.locator('nav a:visible'),count=await links.count();const link=links.nth(Math.floor(count/2));target=decodeURIComponent(new URL(await link.evaluate(el=>el.href)).hash.slice(1));
       await link.focus();await page.keyboard.press('Enter');
       await page.waitForFunction(id=>{const heading=document.getElementById(id),r=heading?.getBoundingClientRect();return heading===document.activeElement&&r.top>=-2&&r.top<innerHeight/2},target);
       assert.equal(await details.evaluate(el=>el.open),false);assert.equal(decodeURIComponent(new URL(page.url()).hash.slice(1)),target);await noOverflow(page);
     }
     await details.locator('summary').click();if(width===320)await picture(page,'about-dark-320-open');return {width,target,repeated:2};
   }finally{await ctx.close()}
 });
 for(const route of ['/about/','/links/'])await check(`${route} mobile English deep link and legacy Chinese hash`,async()=>{
   const ctx=await context({viewport:{width:320,height:900},reducedMotion:'reduce'});try{const page=await ctx.newPage();await visit(page,route);const en=await page.locator('[data-language=en] h3[id]').first().getAttribute('id'),zh=await page.locator('[data-language=zh] h3[id]').first().getAttribute('id');await page.goto('about:blank');await visit(page,route+'#'+encodeURIComponent(en));await page.waitForFunction(()=>!document.querySelector('[data-language=en]').hidden);assert.equal(await page.locator('[data-mobile-toc]').evaluate(el=>el.open),false);assert.equal(await page.locator('[data-language-button=en]').getAttribute('aria-pressed'),'true');await page.locator('[data-mobile-toc] summary').click();assert.equal(await page.locator('[data-mobile-toc] [data-toc-language=zh]:visible').count(),0);await page.goto('about:blank');await visit(page,route+'#'+encodeURIComponent(zh));assert.equal(await page.locator('[data-language-button=zh]').getAttribute('aria-pressed'),'true');return {en,zh}}finally{await ctx.close()}
 });
 for(const colorScheme of ['dark','light'])await check(`initial ${colorScheme} theme announces the actual next action and persists`,async()=>{
   const ctx=await context({viewport:{width:390,height:900},colorScheme});try{const page=await ctx.newPage();await visit(page,'/about/');const state=()=>page.evaluate(()=>({theme:document.documentElement.dataset.theme||'light',label:document.querySelector('[data-toggle-theme]').getAttribute('aria-label')}));const before=await state();assert.deepEqual(before,{theme:colorScheme,label:colorScheme==='dark'?'切換淺色模式':'切換深色模式'});await page.locator('[data-toggle-theme]').click();const selected=await state();assert.notEqual(selected.theme,colorScheme);assert.equal(selected.label,selected.theme==='dark'?'切換淺色模式':'切換深色模式');await page.reload({waitUntil:'domcontentloaded'});assert.deepEqual(await state(),selected);return {before,selected}}finally{await ctx.close()}
 });
 await check('header navigation marks the current About, Links and archive page',async()=>{
   const ctx=await context({viewport:{width:1440,height:900}});try{const page=await ctx.newPage();for(const route of ['/about/','/links/','/archives/']){await visit(page,route);const current=page.locator('.site-nav [aria-current=page]');assert.equal(await current.count(),1);assert.equal(await current.getAttribute('href'),route)}await visit(page,'/');assert.equal(await page.locator('.site-nav [aria-current=page]').count(),0);return {routes:['/about/','/links/','/archives/']}}finally{await ctx.close()}
 });
}finally{
 await browser?.close();receipt.finishedAt=new Date().toISOString();await fs.writeFile(path.join(output,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');
}
assert.deepEqual(receipt.pageErrors,[],'No browser script errors.');assert.deepEqual(receipt.localFailures,[],'All local assets remain available.');assert.deepEqual(receipt.blockedWrites,[],'The navigation tests must never attempt a write.');
const failed=receipt.cases.filter(item=>!item.passed);console.log(JSON.stringify({cases:receipt.cases.length,failed:failed.length,receipt:path.relative(project,path.join(output,'receipt.json'))}));if(failed.length)process.exitCode=1;
