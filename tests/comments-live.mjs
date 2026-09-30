import { homedir } from 'node:os';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

const project = path.resolve(process.env.COMMENTS_PROJECT_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const require = createRequire(path.join(project, 'package.json'));
const {chromium} = require('playwright');
const base = new URL(process.env.BROWSER_BASE_URL || 'http://127.0.0.1:4000/');
const canonical = 'https://yuchen0515.github.io/';
const production = base.href === canonical;
const local = ['127.0.0.1', 'localhost'].includes(base.hostname) && ['http:', 'https:'].includes(base.protocol);
assert.ok((local || production) && !base.username && !base.password && base.pathname === '/' && !base.search && !base.hash,
  'Live verification allows only a loopback preview or https://yuchen0515.github.io/.');
const themeURL = mode => production ? new URL(`css/comments-${mode}.css`, canonical).href : `https://giscus.app/themes/${mode === 'dark' ? 'dark_dimmed' : 'light'}.css`;
const output = process.env.COMMENTS_AUDIT_DIR || path.join(project, 'audit/comments-live', new Date().toISOString().replace(/[:.]/g, '-'));
await fs.mkdir(output, {recursive: true});
const receipt = {base:base.href, deploymentMode:production?'production':'local preview', providerMode:'real giscus service; anonymous read-only browser', authenticated:false, commentSubmission:false, externalWrites:0, cases:[], blockedRequests:[], pageErrors:[], consoleWarnings:[]};
const posts = await (await fetch(new URL('search.json', base))).json();
const article = posts.find(post=>post.url.includes('202209')).url;
assert.equal(new URL(article,base).origin,base.origin,'The article belongs to the approved site.');
let executable = process.env.BROWSER_EXECUTABLE || chromium.executablePath();
try {await fs.access(executable);} catch {
  const cache = path.join(homedir(), 'Library', 'Caches', 'ms-playwright');
  const versions = (await fs.readdir(cache)).filter(name=>/^chromium_headless_shell-\d+$/.test(name)).sort((a,b)=>Number(b.split('-').at(-1))-Number(a.split('-').at(-1)));
  executable = path.join(cache, versions[0], 'chrome-headless-shell-mac-arm64/chrome-headless-shell');
}
const browser = await chromium.launch({executablePath:executable, headless:true});
const context = await browser.newContext({viewport:{width:1440,height:1000}, locale:'zh-TW', colorScheme:'light'});
// Leave every provider response untouched. Disallow browser writes during this audit.
await context.route('**/*', async route=>{
  const request = route.request();
  if (!['GET','HEAD','OPTIONS'].includes(request.method())) {
    const url = new URL(request.url());
    receipt.blockedRequests.push({method:request.method(),origin:url.origin,path:url.pathname});
    return route.abort('blockedbyclient');
  }
  return route.continue();
});
await context.addInitScript(()=>{
  window.__giscusLiveAudit=[];
  window.__giscusLiveScript=null;
  // The official client removes its script after mounting; capture its real attributes before then.
  new MutationObserver(records=>{
    for(const record of records)for(const node of record.addedNodes){
      if(node.nodeType===1&&node.matches?.('script[src="https://giscus.app/client.js"]'))window.__giscusLiveScript={...node.dataset};
    }
  }).observe(document,{childList:true,subtree:true});
  window.addEventListener('message',event=>{
    const frame=document.querySelector('iframe.giscus-frame');
    if(event.origin!=='https://giscus.app'||event.source!==frame?.contentWindow||!event.data?.giscus)return;
    const {resizeHeight,error}=event.data.giscus;
    if(Number.isFinite(resizeHeight))window.__giscusLiveAudit.push({resizeHeight});
    if(typeof error==='string')window.__giscusLiveAudit.push({error:error.slice(0,250)});
  });
});
const page = await context.newPage();
page.on('pageerror',error=>receipt.pageErrors.push(error.message));
page.on('console',message=>{if(['warning','error'].includes(message.type()))receipt.consoleWarnings.push(message.text().slice(0,400));});
async function check(name,operation) {
  const details=await operation();receipt.cases.push({name,passed:true,details});console.log(`PASS ${name}`);
}

try {
  await page.goto(new URL(article,base).href,{waitUntil:'domcontentloaded'});
  assert.equal(new URL(page.url()).origin,base.origin,'The top-level page stays on the approved site.');
  await check('site uses the actual repository and Announcements category',async()=>{
    const data=await page.locator('[data-comment-widget]').evaluate(node=>({...node.dataset}));
    assert.equal(data.commentConfigured,'true');
    assert.equal(data.commentRepoId,'R_kgDOHSayAQ');
    assert.equal(data.commentCategory,'Announcements');
    assert.equal(data.commentCategoryId,'DIC_kwDOHSayAc4DGxYs');
    assert.equal(await page.locator('[data-engagement]').getAttribute('data-repo'),'yuchen0515/yuchen0515.github.io');
    return data;
  });
  await page.locator('[data-open-comments]').click();
  const iframe=page.locator('iframe.giscus-frame');
  await iframe.waitFor({timeout:30000});
  const frame=await iframe.elementHandle().then(handle=>handle.contentFrame());
  assert.ok(frame);
  await frame.waitForLoadState('domcontentloaded',{timeout:30000});
  await check('official provider iframe maps the unchanged pathname and uses Traditional Chinese',async()=>{
    const attributes=await page.evaluate(()=>window.__giscusLiveScript);
    assert.ok(attributes,'Real client script attributes were observed before mounting.');
    assert.equal(attributes.repo,'yuchen0515/yuchen0515.github.io');
    assert.equal(attributes.repoId,'R_kgDOHSayAQ');
    assert.equal(attributes.categoryId,'DIC_kwDOHSayAc4DGxYs');
    assert.equal(attributes.mapping,'pathname');assert.equal(attributes.strict,'1');
    assert.equal(attributes.lang,'zh-TW');assert.equal(attributes.reactionsEnabled,'0');
    assert.equal(attributes.inputPosition,'top');assert.equal(attributes.theme,production?themeURL('light'):'light');
    const url=new URL(frame.url());assert.equal(url.origin,'https://giscus.app');assert.equal(url.pathname,'/zh-TW/widget');
    assert.equal(url.searchParams.get('repo'),attributes.repo);assert.equal(url.searchParams.get('repoId'),attributes.repoId);
    assert.equal(url.searchParams.get('categoryId'),attributes.categoryId);
    assert.equal(url.searchParams.get('term'),decodeURI(new URL(article,base).pathname).replace(/^\//,''));
    return {attributes,providerOrigin:url.origin,providerPath:url.pathname,term:url.searchParams.get('term'),iframeTitle:await iframe.getAttribute('title')};
  });
  await check('anonymous visitor sees the real login composer and empty discussion state',async()=>{
    await frame.waitForFunction(()=>document.body.innerText.includes('登入'),null,{timeout:30000});
    await frame.waitForFunction(({expected,production})=>{
      const main=document.querySelector('main'),textarea=document.querySelector('textarea');
      const style=main&&getComputedStyle(main);
      return [...document.querySelectorAll('link[rel="stylesheet"]')].some(node=>node.href===expected)
        &&style?.getPropertyValue('--color-fg-default').trim()
        &&(!production||(style.fontSize==='18px'&&textarea&&getComputedStyle(textarea).fontSize==='18px'));
    },{expected:themeURL('light'),production},{timeout:15000});
    const details=await frame.evaluate(()=>({language:document.documentElement.lang,text:document.body.innerText,buttons:[...document.querySelectorAll('button')].map(node=>({text:node.innerText,disabled:node.disabled})),textareas:[...document.querySelectorAll('textarea')].map(node=>({placeholder:node.placeholder,disabled:node.disabled})),authLinks:[...document.querySelectorAll('a[href]')].filter(node=>/登入|GitHub/.test(node.innerText)).map(node=>({text:node.innerText,origin:new URL(node.href).origin,path:new URL(node.href).pathname}))}));
    assert.match(details.text,/登入/);assert.match(details.text,/GitHub/);
    assert.match(details.text,/0\s*(則)?\s*留言|沒有留言|還沒有|尚無/);
    assert.ok(details.textareas.length>0||details.buttons.some(button=>/登入|撰寫/.test(button.text)));
    return details;
  });
  await check('real resize clears loading and mobile composer stays horizontally contained',async()=>{
    await page.waitForFunction(()=>document.querySelector('[data-comment-widget]').getAttribute('aria-busy')==='false'&&window.__giscusLiveAudit.some(message=>message.resizeHeight>0),null,{timeout:30000});
    assert.equal(await page.locator('[data-comment-status]').isVisible(),false);
    assert.equal(await page.locator('[data-comment-retry]').isVisible(),false);
    const measurements=[];
    for(const width of [1440,390,320]) {
      await page.setViewportSize({width,height:1000});
      await iframe.scrollIntoViewIfNeeded();
      await frame.waitForFunction(()=>document.documentElement.scrollWidth<=innerWidth+1,null,{timeout:10000});
      const layout=await frame.evaluate(()=>{
        const textarea=document.querySelector('textarea');
        const buttons=[...document.querySelectorAll('.gsc-comment-box button, .gsc-comment-box .btn, a[href*="/api/oauth/authorize"]')]
          .filter(node=>node.getBoundingClientRect().height>0).map(node=>({text:node.innerText,height:node.getBoundingClientRect().height,fontSize:getComputedStyle(node).fontSize}));
        const box=textarea?.getBoundingClientRect();
        return {viewport:innerWidth,scrollWidth:document.documentElement.scrollWidth,contentHeight:document.documentElement.scrollHeight,
          bodySize:getComputedStyle(document.body).fontSize,mainSize:getComputedStyle(document.querySelector('main')).fontSize,
          composerSize:textarea?getComputedStyle(textarea).fontSize:null,composer:box?{left:box.left,right:box.right}:null,buttons};
      });
      const box=await iframe.boundingBox();assert.ok(box&&box.height>100);
      assert.ok(layout.scrollWidth<=layout.viewport+1);
      assert.ok(layout.composer&&layout.composer.left>=-1&&layout.composer.right<=layout.viewport+1);
      assert.ok(box.x>=-1&&box.x+box.width<=width+1);
      if(production){
        assert.equal(layout.mainSize,'18px');assert.equal(layout.composerSize,'18px');
        assert.ok(layout.buttons.length>=2,'Real composer controls were measured.');
        for(const button of layout.buttons)assert.ok(button.height>=44,`${button.text||'Composer control'} height ${button.height}px is below 44px.`);
      }
      measurements.push({width,iframe:box,provider:layout});
    }
    await page.locator('#discussion').screenshot({path:path.join(output,'real-provider-mobile.png')});
    return {trustedMessages:await page.evaluate(()=>window.__giscusLiveAudit),measurements};
  });
  await check('real provider applies light and dark themes for the selected deployment',async()=>{
    const themes=[];
    for(const mode of ['dark','light']) {
      const previousColor=await frame.evaluate(()=>getComputedStyle(document.querySelector('main')).getPropertyValue('--color-fg-default').trim());
      await page.evaluate(mode=>document.documentElement.dataset.theme=mode,mode);
      const expected=themeURL(mode);
      await frame.waitForFunction(({expected,previousColor})=>{
        const main=document.querySelector('main');
        return [...document.querySelectorAll('link[rel="stylesheet"]')].some(node=>node.href===expected)
          &&getComputedStyle(main).getPropertyValue('--color-fg-default').trim()!==previousColor;
      },{expected,previousColor},{timeout:15000});
      const measured=await frame.evaluate(expected=>({themeCSS:[...document.querySelectorAll('link[rel="stylesheet"]')].map(node=>node.href).filter(href=>href===expected),
        foreground:getComputedStyle(document.querySelector('main')).getPropertyValue('--color-fg-default').trim(),
        background:getComputedStyle(document.querySelector('main')).getPropertyValue('--color-canvas-default').trim(),
        mainSize:getComputedStyle(document.querySelector('main')).fontSize,composerSize:getComputedStyle(document.querySelector('textarea')).fontSize}),expected);
      if(production){assert.equal(measured.mainSize,'18px');assert.equal(measured.composerSize,'18px');assert.equal(measured.foreground,mode==='dark'?'#e7e9e2':'#242a27');}
      themes.push({mode,...measured});
    }
    await page.setViewportSize({width:1440,height:1000});
    await page.locator('#discussion').screenshot({path:path.join(output,'real-provider-desktop.png')});
    return {themes,productionCustomCSSTested:production,reason:production?'Real provider loaded the production HTTPS CSS.':'Localhost uses official themes; production custom CSS requires a publicly reachable HTTPS deployment.'};
  });
  assert.deepEqual(receipt.pageErrors,[]);
  assert.deepEqual(receipt.blockedRequests,[]);
  assert.ok(!receipt.consoleWarnings.some(message=>message.includes("Failed to execute 'postMessage'")),'Provider theme sync must wait for its own origin to load.');
} catch(error) {
  receipt.failure={message:error.message};
  try {await page.screenshot({path:path.join(output,'real-provider-failure.png'),fullPage:true});} catch {}
  throw error;
} finally {
  await fs.writeFile(path.join(output,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');
  await browser.close();console.log(output);
}
