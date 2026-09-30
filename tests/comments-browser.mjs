import { homedir } from 'node:os';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {chromium} from 'playwright';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = new URL(process.env.BROWSER_BASE_URL || 'http://127.0.0.1:4000/');
assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname), 'Tests use only a local preview and isolated provider fixtures.');
const output = path.join(project, 'audit/comments', new Date().toISOString().replace(/[:.]/g, '-'));
await fs.mkdir(output, {recursive: true});
const receipt = {base: base.href, providerMode: 'isolated fixture; no authenticated posting or real giscus service validation', externalWrites: 0, cases: []};
const require = createRequire(import.meta.url), cheerio = require('cheerio');
const posts = await (await fetch(new URL('search.json', base))).json();
const article = posts.find(post => post.url.includes('202209')).url;
const original = await (await fetch(new URL(article, base))).text();
const script = await fs.readFile(path.join(project, 'themes/owen/source/js/site.js'), 'utf8');
const css = Object.fromEntries(await Promise.all(['light', 'dark'].map(async mode => [mode, await fs.readFile(path.join(project, `themes/owen/source/css/comments-${mode}.css`), 'utf8')])));
const proposed = process.env.BROWSER_EXECUTABLE || chromium.executablePath();
let executable = proposed;
try {await fs.access(executable);} catch {
  const cache = path.join(homedir(), 'Library', 'Caches', 'ms-playwright');
  const versions = (await fs.readdir(cache)).filter(name => /^chromium_headless_shell-\d+$/.test(name)).sort((a, b) => Number(b.split('-').at(-1)) - Number(a.split('-').at(-1)));
  executable = path.join(cache, versions[0], 'chrome-headless-shell-mac-arm64/chrome-headless-shell');
}
const browser = await chromium.launch({executablePath: executable, headless: true});
const context = await browser.newContext({viewport: {width: 1440, height: 900}, locale: 'zh-TW'});
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
async function check(name, operation) {
  const details = await operation();receipt.cases.push({name, passed: true, details});console.log(`PASS ${name}`);
}

const fixtureScript = `(() => {
  window.__commentFixtureAttributes = {...document.currentScript.dataset};
  window.__commentFixturePathname = location.pathname;
  const frame = document.createElement('iframe');frame.className = 'giscus-frame';
  frame.src = 'https://giscus.app/zh-TW/widget?isolated_fixture=1';
  frame.style.cssText = 'width:100%;height:500px;border:0';document.querySelector('.giscus').append(frame);
})();`;
const frameHTML = `<!doctype html><html lang="zh-TW"><head><meta name="viewport" content="width=device-width"><link id="fixture-theme" rel="stylesheet" href="https://yuchen0515.github.io/css/comments-light.css"><style>*{box-sizing:border-box}body{margin:0}main{padding:12px}.gsc-comment-content{color:var(--color-fg-default);background:var(--color-canvas-default)}.gsc-comment-box-textarea{width:100%;min-height:100px}button{padding:8px}.gsc-comment-header{color:var(--color-fg-muted)}</style></head><body><main><p>隔離測試介面，未連接真留言服務</p><div class="gsc-comment"><div class="gsc-comment-header">測試資料</div><div class="markdown gsc-comment-content">這是一則隔離的留言樣本，用來驗證十八像素字體與閱讀對比。</div></div><form class="gsc-comment-box"><textarea class="gsc-comment-box-textarea" aria-label="測試留言" disabled placeholder="登入後留言"></textarea><button type="button">預覽</button></form></main><script>
window.addEventListener('message',event=>{if(!event.data?.giscus?.setConfig)return;const theme=event.data.giscus.setConfig.theme;document.documentElement.dataset.receivedTheme=theme;document.querySelector('#fixture-theme').href=theme==='light'?'https://yuchen0515.github.io/css/comments-light.css':theme==='dark_dimmed'?'https://yuchen0515.github.io/css/comments-dark.css':theme;});
</script></body></html>`;
let providerLoads = 0, failScript = false;
await context.route('https://giscus.app/**', async route => {
  if (route.request().url().endsWith('/client.js')) {providerLoads++;if(failScript)return route.abort('failed');return route.fulfill({contentType:'application/javascript',body:fixtureScript});}
  if (route.request().url().includes('isolated_fixture=1')) return route.fulfill({contentType:'text/html',body:frameHTML});
  return route.abort('blockedbyclient');
});
await context.route('https://yuchen0515.github.io/css/comments-*.css', route => {
  const mode = route.request().url().includes('comments-dark') ? 'dark' : 'light';
  return route.fulfill({contentType:'text/css',headers:{'Access-Control-Allow-Origin':'*'},body:css[mode]});
});
await context.route('**/js/site.js', route => route.fulfill({contentType:'application/javascript',body:script}));

try {
  await check('unconfigured real preview never loads a provider or a fake composer', async () => {
    await page.goto(new URL(article, base).href,{waitUntil:'domcontentloaded'});
    await page.locator('[data-open-comments]').click();
    assert.equal(await page.locator('[data-open-comments]').getAttribute('href'),'#discussion');
    assert.equal(await page.locator('[data-comment-widget]').getAttribute('data-comment-configured'),'false');
    assert.equal(await page.locator('[data-comment-widget]').isVisible(),false);
    assert.equal(await page.locator('[data-comment-status]').textContent(),'留言功能正在設定中。');
    assert.equal(providerLoads,0);
    assert.equal(await page.locator('[data-comment-fallback]').getAttribute('href'),'https://github.com/yuchen0515/yuchen0515.github.io/issues/8');
    return {providerLoads, accountSetupPending:true};
  });
  const $ = cheerio.load(original);
  $('[data-comment-widget]').attr('data-comment-configured','true').attr('data-comment-repo-id','R_kgDOHSayAQ').attr('data-comment-category','Isolated fixture').attr('data-comment-category-id','DIC_fixture').removeAttr('hidden');
  $('[data-comment-status]').text('留言將在這裡載入。');
  $('[data-comment-fallback]').attr('hidden','');
  $('main').prepend('<p>隔離測試介面：沒有真留言、登入或投稿。</p>');
  await context.route('https://fixture.owen.invalid/**', async route => {
    const url=new URL(route.request().url());
    if([decodeURI(article),decodeURI(article+'index.html')].includes(decodeURI(url.pathname)))return route.fulfill({contentType:'text/html',body:$.html()});
    if(url.pathname==='/js/site.js')return route.fulfill({contentType:'application/javascript',body:script});
    const local=await fetch(new URL(url.pathname+url.search,base));
    return route.fulfill({status:local.status,contentType:local.headers.get('content-type')||'application/octet-stream',body:Buffer.from(await local.arrayBuffer())});
  });
  await check('configured provider uses zh-TW, stable paths, and no authenticated article reactions', async () => {
    await page.goto('https://fixture.owen.invalid'+article,{waitUntil:'domcontentloaded'});
    await page.locator('[data-open-comments]').click();
    await page.locator('iframe.giscus-frame').waitFor();
    const attributes = await page.evaluate(()=>window.__commentFixtureAttributes);
    assert.equal(attributes.repo,'yuchen0515/yuchen0515.github.io');
    assert.equal(attributes.repoId,'R_kgDOHSayAQ');
    assert.equal(attributes.categoryId,'DIC_fixture');
    assert.equal(attributes.mapping,'pathname');assert.equal(attributes.strict,'1');
    assert.equal(attributes.lang,'zh-TW');assert.equal(attributes.reactionsEnabled,'0');
    assert.equal(attributes.inputPosition,'top');
    assert.equal(attributes.theme,'https://yuchen0515.github.io/css/comments-light.css');
    return {attributes, dataMode:'fixture only'};
  });
  await check('direct index.html aliases share the canonical pathname without losing query or hash', async () => {
    await page.goto('https://fixture.owen.invalid'+article+'index.html?read=1#discussion',{waitUntil:'domcontentloaded'});
    await page.locator('[data-open-comments]').click();await page.locator('iframe.giscus-frame').waitFor();
    const current=new URL(page.url());
    assert.equal(decodeURI(current.pathname),decodeURI(article));
    assert.equal(current.search,'?read=1');assert.equal(current.hash,'#discussion');
    assert.equal(decodeURI(await page.evaluate(()=>window.__commentFixturePathname)),decodeURI(article));
    return {canonicalPath:current.pathname,query:current.search,hash:current.hash};
  });
  await check('loading only settles on a message from the actual provider frame', async () => {
    assert.equal(await page.locator('[data-comment-widget]').getAttribute('aria-busy'),'true');
    await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{origin:'https://giscus.app',source:window,data:{giscus:{resizeHeight:500}}})));
    assert.equal(await page.locator('[data-comment-widget]').getAttribute('aria-busy'),'true');
    const frame = page.frames().find(frame=>frame.url().includes('isolated_fixture=1'));
    assert.ok(frame);
    await frame.evaluate(()=>parent.postMessage({giscus:{resizeHeight:500}},'*'));
    await page.waitForFunction(()=>document.querySelector('[data-comment-widget]').getAttribute('aria-busy')==='false');
    assert.equal(await page.locator('[data-comment-status]').isVisible(),false);
    return {spoofIgnored:true, trustedFrameAccepted:true};
  });
  await check('custom comment font, input size and dark sync work at mobile and desktop widths', async () => {
    const frame = page.frames().find(frame=>frame.url().includes('isolated_fixture=1'));
    const measurements = [];
    for (const width of [320,390,1440]) {
      await page.setViewportSize({width,height:900});
      for (const mode of ['dark','light']) {
        await page.evaluate(mode=>document.documentElement.dataset.theme=mode,mode);
        await frame.waitForFunction(mode=>document.documentElement.dataset.receivedTheme?.endsWith('comments-'+mode+'.css'),mode);
        await frame.waitForFunction(mode=>getComputedStyle(document.querySelector('main')).getPropertyValue('--color-fg-default').trim()===(mode==='dark'?'#e7e9e2':'#242a27'),mode);
        const values=await frame.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,bodySize:getComputedStyle(document.querySelector('.gsc-comment-content')).fontSize,inputSize:getComputedStyle(document.querySelector('textarea')).fontSize,metadataSize:getComputedStyle(document.querySelector('.gsc-comment-header')).fontSize,buttonHeight:document.querySelector('button').getBoundingClientRect().height,foreground:getComputedStyle(document.querySelector('.gsc-comment-content')).color,background:getComputedStyle(document.querySelector('.gsc-comment-content')).backgroundColor}));
        assert.equal(values.bodySize,'18px');assert.equal(values.inputSize,'18px');assert.equal(values.metadataSize,'14px');assert.ok(values.buttonHeight>=44);assert.ok(values.scrollWidth<=values.width+1);
        measurements.push({width,mode,...values});
      }
    }
    await page.screenshot({path:path.join(output,'isolated-comments-fixture.png'),fullPage:true});
    return measurements;
  });
  await check('provider error remains visible until retry, with no outbound posting action', async () => {
    const frame = page.frames().find(frame=>frame.url().includes('isolated_fixture=1'));
    await frame.evaluate(()=>parent.postMessage({giscus:{error:'Isolated fixture connection failure'}},'*'));
    await page.locator('[data-comment-retry]').waitFor({state:'visible'});
    await frame.evaluate(()=>parent.postMessage({giscus:{resizeHeight:500}},'*'));
    assert.equal(await page.locator('[data-comment-retry]').isVisible(),true);
    const before=providerLoads;await page.locator('[data-comment-retry]').click();
    await page.waitForFunction(()=>window.__commentFixtureAttributes?.lang==='zh-TW');
    assert.equal(providerLoads,before+1);
    assert.equal(await page.locator('[data-comment-retry]').isVisible(),false);
    return {providerLoads, retryReloaded:true};
  });
  await check('a failed provider script gives an accessible retry state', async () => {
    failScript=true;
    await page.reload({waitUntil:'domcontentloaded'});await page.locator('[data-open-comments]').click();
    await page.locator('[data-comment-retry]').waitFor({state:'visible'});
    assert.match(await page.locator('[data-comment-status]').textContent(),/暫時無法載入/);
    assert.equal(await page.locator('[data-comment-status]').getAttribute('role'),'status');
    assert.equal(await page.locator('[data-comment-widget]').getAttribute('aria-busy'),'false');
    return {scriptFailureHandled:true};
  });
  await check('OAuth return mounts immediately without waiting for intersection or a click', async () => {
    failScript=false;const before=providerLoads;
    await page.addInitScript(()=>{window.IntersectionObserver=class{observe(){}disconnect(){}}});
    await page.goto('https://fixture.owen.invalid'+article+'?giscus=isolated-test-return',{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>window.__commentFixtureAttributes?.lang==='zh-TW');
    assert.equal(providerLoads,before+1);
    assert.equal(await page.locator('[data-comment-widget]').getAttribute('id'),'discussion-comments');
    return {immediateProviderMount:true, realOAuthNotPerformed:true};
  });
  assert.deepEqual(errors,[]);receipt.pageErrors=errors;
} finally {
  await fs.writeFile(path.join(output,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');
  await browser.close();console.log(output);
}
