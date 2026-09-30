import { homedir } from 'node:os';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = new URL(process.env.BROWSER_BASE_URL || 'http://127.0.0.1:4000/');
assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname), 'Browser acceptance only targets a local preview.');
const run = new Date().toISOString().replace(/[:.]/g, '-');
const output = path.join(project, 'audit', 'browser', run);
await fs.mkdir(output, { recursive: true });
const receipt = { startedAt: new Date().toISOString(), base: base.href, cases: [], pageErrors: [], localFailures: [], externalFailures: [], navigationCancellations: [], screenshots: [], fixtures: [] };
const require = createRequire(import.meta.url);
const { renderMarkdown } = require('../lib/markdown.cjs');
const cheerio = require('cheerio');
const searchResponse = await fetch(new URL('search.json', base));
assert.equal(searchResponse.status, 200, 'Start Hexo with _config.yml,_config.preview.yml before running this test.');
const posts = await searchResponse.json();
for (const original of ['/202305_～關於我的文章規劃～/', '/202305_那些路過的-me-因們/', '/202209_MIRlab-owen-lin-RD-page/', '/202207_賽後心得-「看見你的聲音-語音辨識後修正」/']) assert.ok(posts.some(post => post.url === original), `The original article must remain available: ${original}`);
const pages = ['/', '/archives/', ...posts.map(post => post.url), '/about/', '/links/'];
const localBroken = new Set();
const externalBroken = new Set();
const scriptErrors = new Set();
const API = 'http://127.0.0.1:8788/likes';
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYl8AAAAASUVORK5CYII=';

async function executable() {
  const proposed = process.env.BROWSER_EXECUTABLE || chromium.executablePath();
  try { await fs.access(proposed); return proposed; } catch {}
  const cache = path.join(homedir(), 'Library', 'Caches', 'ms-playwright');
  const versions = (await fs.readdir(cache)).filter(name => /^chromium_headless_shell-\d+$/.test(name)).sort((a, b) => Number(b.split('-').at(-1)) - Number(a.split('-').at(-1)));
  for (const version of versions) {
    const candidate = path.join(cache, version, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell');
    try { await fs.access(candidate); return candidate; } catch {}
  }
  throw new Error('No existing Playwright Chromium executable is available.');
}
function observe(page) {
  page.on('pageerror', error => scriptErrors.add(JSON.stringify({ page: page.url(), message: error.message })));
  page.on('requestfailed', request => {
    const url = new URL(request.url());
    if (!['http:', 'https:'].includes(url.protocol)) return;
    const error = request.failure()?.errorText || 'request failed';
    if (url.origin === 'https://giscus.app' && request.resourceType() === 'document' && error === 'net::ERR_ABORTED') {
      receipt.navigationCancellations.push({ url: url.href, error });
      return;
    }
    const failure = JSON.stringify({ url: url.href, error });
    if (url.origin === base.origin && ['image', 'script', 'stylesheet', 'font'].includes(request.resourceType())) localBroken.add(failure);
    else if (url.origin !== base.origin && url.origin !== new URL(API).origin) externalBroken.add(failure);
  });
  page.on('response', response => {
    if (response.status() < 400) return;
    const url = new URL(response.url());
    const failure = JSON.stringify({ url: url.href, status: response.status() });
    if (url.origin === base.origin && ['image', 'script', 'stylesheet', 'font'].includes(response.request().resourceType())) localBroken.add(failure);
    else if (url.origin !== base.origin && url.origin !== new URL(API).origin) externalBroken.add(failure);
  });
}
async function check(name, operation) {
  const started = Date.now();
  try {
    const details = await operation();
    receipt.cases.push({ name, passed: true, durationMs: Date.now() - started, ...(details ? { details } : {}) });
    console.log(`PASS ${name}`);
  } catch (error) {
    receipt.cases.push({ name, passed: false, durationMs: Date.now() - started, error: error.stack || String(error) });
    console.error(`FAIL ${name}: ${error.message}`);
  }
}
async function visit(page, url) {
  const response = await page.goto(new URL(url, base).href, { waitUntil: 'domcontentloaded' });
  assert.equal(response.status(), 200, url);
  await page.locator('main').waitFor();
  await page.evaluate(() => document.fonts.ready);
}
async function geometry(page) {
  return page.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth, protrusions: [...document.querySelectorAll('body *')].filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.right > innerWidth + 1 || r.left < -1) && !el.closest('dialog:not([open]),[hidden]'); }).slice(0, 10).map(el => ({ tag: el.tagName, class: el.className?.baseVal ?? el.className, text: el.textContent.slice(0, 65), rect: { left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right } })) }));
}
async function noOverflow(page) {
  const value = await geometry(page);
  assert.ok(value.document <= value.width + 1 && value.body <= value.width + 1, `Page overflows: ${JSON.stringify(value)}`);
  return value;
}
async function localImages(page) {
  const missing = await page.evaluate(async () => {
    const images = [...document.images].filter(image => image.getAttribute('src'));
    images.forEach(image => { image.loading = 'eager'; });
    await Promise.all(images.filter(image => new URL(image.currentSrc || image.src, location.href).origin === location.origin).map(image => image.complete ? Promise.resolve() : new Promise(resolve => { image.addEventListener('load', resolve, { once: true }); image.addEventListener('error', resolve, { once: true }); setTimeout(resolve, 7000); })));
    return images.filter(image => new URL(image.currentSrc || image.src, location.href).origin === location.origin && (!image.complete || !image.naturalWidth)).map(image => ({ src: image.currentSrc || image.src, alt: image.alt }));
  });
  assert.deepEqual(missing, [], 'All local content images must decode successfully.');
}
async function shot(page, name, fullPage = false) {
  const target = path.join(output, name + '.png');
  await page.screenshot({ path: target, fullPage });
  receipt.screenshots.push(path.relative(project, target));
}
async function settledVote(page) {
  const button = page.locator('[data-like]');
  await button.waitFor();
  await page.waitForFunction(() => !document.querySelector('[data-like]').disabled);
  assert.equal(await page.locator('[data-like-status]').textContent(), '', 'The real shared backend must respond.');
  return { liked: await button.getAttribute('aria-pressed') === 'true', count: Number(await page.locator('[data-like-count]').textContent()) };
}
async function clickVote(page, desired) {
  const before = await settledVote(page);
  if (before.liked !== desired) { await page.locator('[data-like]').click(); await page.waitForFunction(() => !document.querySelector('[data-like]').disabled); }
  const after = await settledVote(page);
  assert.equal(after.liked, desired);
  return after;
}
async function clearVote(context, postPath) {
  const reader = await context.pages()[0]?.evaluate(() => localStorage.getItem('owen-reader-id')).catch(() => null);
  if (!reader) return;
  const response = await fetch(API, { method: 'POST', headers: { Origin: base.origin, 'Content-Type': 'application/json', 'X-Visitor-Id': reader }, body: JSON.stringify({ path: postPath, liked: false }) });
  assert.equal(response.status, 200, 'Remove only the browser test visitor vote.');
}

let browser;
try {
  browser = await chromium.launch({ executablePath: await executable(), headless: true });
  receipt.browser = await browser.version();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'], locale: 'zh-TW', colorScheme: 'light' });
  const page = await context.newPage(); observe(page);
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: width < 500 ? 844 : 900 });
    for (const route of pages) await check(`${width}px ${route} layout and local images`, async () => { await visit(page, route); await localImages(page); return noOverflow(page); });
  }
  await check('Long-form text, code, navigation, and school logos stay comfortably readable', async () => {
    const readings=[];
    for (const width of [320,390,1440]) {
      await page.setViewportSize({width,height:900});
      await visit(page,'/about/');
      await localImages(page);
      const sizes=await page.evaluate(()=>{
        const prose=document.querySelector('.prose');
        const style=getComputedStyle(prose);
        const logo=[...prose.querySelectorAll('.school-logo')].find(el=>!el.closest('[hidden]'));
        return {prose:parseFloat(style.fontSize),lineHeight:parseFloat(style.lineHeight),navigation:parseFloat(getComputedStyle(document.querySelector('.site-nav')).fontSize),schoolLogo:logo?.getBoundingClientRect().height,schoolLogoCount:prose.querySelectorAll('.school-logo').length};
      });
      assert.ok(sizes.prose>=(width<641?18:19),JSON.stringify(sizes));
      assert.ok(sizes.lineHeight>=34,JSON.stringify(sizes));
      assert.ok(sizes.navigation>=15,JSON.stringify(sizes));
      assert.ok(sizes.schoolLogo>=38&&sizes.schoolLogoCount>=6,JSON.stringify(sizes));
      await noOverflow(page);
      readings.push({width,...sizes});
    }
    return {readings};
  });
  await check('Ctrl+K searches real article index and returns navigable results', async () => {
    await visit(page, '/'); await page.keyboard.press('Control+k');
    await page.locator('[data-search-dialog][open]').waitFor();
    assert.equal(await page.locator('#site-search').evaluate(el => el === document.activeElement), true);
    await page.locator('#site-search').fill('語音');
    await page.locator('.search-result').first().waitFor();
    const links = await page.locator('.search-result').evaluateAll(elements => elements.map(el => el.getAttribute('href')));
    assert.ok(links.length > 0); assert.ok(links.every(link => posts.some(post => post.url === link)));
    await page.locator('.search-result').first().click(); await page.waitForURL(url => posts.some(post => decodeURI(url.pathname) === decodeURI(post.url)));
    await page.keyboard.press('Escape');
    return { results: links };
  });
  await check('Theme choice persists across reload and navigation', async () => {
    await visit(page, '/'); const initial = (await page.locator('html').getAttribute('data-theme')) || 'light';
    await page.locator('[data-toggle-theme]').click(); const selected = await page.locator('html').getAttribute('data-theme');
    assert.notEqual(selected, initial); await page.reload({ waitUntil: 'domcontentloaded' });
    assert.equal(await page.locator('html').getAttribute('data-theme'), selected);
    await visit(page, '/archives/'); assert.equal(await page.locator('html').getAttribute('data-theme'), selected);
    await page.locator('[data-toggle-theme]').click(); assert.equal(await page.locator('html').getAttribute('data-theme'), initial);
    return { initial, selected };
  });
  await check('About preserves both full languages and the common appendix', async () => {
    await visit(page, '/about/');
    const original = await page.locator('[data-language]').evaluateAll(elements => elements.map(el => ({ language: el.dataset.language, text: el.textContent, headings: el.querySelectorAll('h2,h3').length })));
    assert.deepEqual(original.map(item => item.language), ['zh', 'en']);
    assert.ok(original.every(item => item.text.length > 2500 && item.headings >= 10), 'Both authored language sections must be complete.');
    const common = await page.locator('.prose h2,.prose h3').evaluateAll(elements => elements.filter(el => !el.closest('[data-language]')).map(el => ({ id: el.id, text: el.textContent })));
    assert.ok(common.some(item => item.text.includes('程式相關活動')));
    assert.ok(common.some(item => item.text.includes('CodinGame'))); assert.ok(common.some(item => item.text.includes('LeetCode')));
    for (const language of ['en', 'zh']) {
      await page.locator(`[data-language-button="${language}"]`).click();
      const state = await page.locator('[data-language]').evaluateAll(elements => elements.map(el => ({ language: el.dataset.language, hidden: el.hidden, text: el.textContent })));
      assert.deepEqual(state.map(item => [item.language, item.hidden]), [['zh', language !== 'zh'], ['en', language !== 'en']]);
      assert.deepEqual(state.map(item => item.text), original.map(item => item.text));
      const toc = await page.locator('[data-toc-language]').evaluateAll(elements => elements.map(el => ({ language: el.dataset.tocLanguage, hidden: el.hidden })));
      assert.ok(toc.length > 20); assert.ok(toc.every(item => item.hidden === (item.language !== 'all' && item.language !== language)));
      assert.ok(await page.locator('.prose h2,.prose h3').evaluateAll((elements, ids) => elements.filter(el => ids.includes(el.id)).every(el => !el.closest('[hidden]')), common.map(item => item.id)));
      for (const width of [320, 390, 1440]) { await page.setViewportSize({ width, height: width < 500 ? 844 : 900 }); await noOverflow(page); }
    }
    const englishId = await page.locator('[data-language="en"] h3').first().getAttribute('id');
    await page.evaluate(id => { location.hash = id; }, englishId);
    await page.waitForFunction(() => !document.querySelector('[data-language="en"]').hidden);
    return { sections: original.map(({ language, text, headings }) => ({ language, characters: text.length, headings })), common };
  });
  await check('All six English versions switch fully and English heading links reopen the right language', async () => {
    const details=[];
    for (const route of [...posts.map(post=>post.url), '/about/', '/links/']) {
      await visit(page,route);
      const originalTitle=await page.locator('[data-title-zh]').textContent();
      await page.locator('[data-language-button="en"]').click();
      assert.equal(await page.locator('[data-language="zh"]').isVisible(),false,route);
      assert.equal(await page.locator('[data-language="en"]').isVisible(),true,route);
      assert.equal(await page.locator('[data-title-zh]').textContent(),await page.locator('[data-title-en]').getAttribute('data-title-en'));
      const heading=await page.locator('[data-language="en"] h2[id],[data-language="en"] h3[id]').first().getAttribute('id');
      await page.goto('about:blank');
      await visit(page,route+'#'+encodeURIComponent(heading));
      assert.equal(await page.locator('[data-language="en"]').isVisible(),true,route);
      await noOverflow(page);await localImages(page);
      await page.locator('[data-language-button="zh"]').click();
      assert.equal(await page.locator('[data-title-zh]').textContent(),originalTitle);
      assert.equal(await page.locator('[data-language="en"]').isVisible(),false,route);
      details.push({route,englishHeading:heading});
    }
    return details;
  });
  await check('Article image opens and closes the real zoom dialog', async () => {
    const withImage = posts.find(post => post.url.includes('202207'));
    await visit(page, withImage.url); await localImages(page);
    const image = page.locator('.prose img[role="button"]').first(); assert.ok(await image.count());
    const src = await image.getAttribute('src'); await image.click();
    await page.locator('[data-image-dialog][open]').waitFor();
    assert.equal(await page.locator('[data-image-dialog] img').getAttribute('src'), new URL(src, base).href);
    await page.locator('[data-close-image]').click(); assert.equal(await page.locator('[data-image-dialog]').evaluate(el => el.open), false);
  });
  await check('Real Markdown fixture renders code copying, math, diagram, and a wide table', async () => {
    const source = ['## Renderer browser fixture', '', 'Math: $x^2 + y^2 = z^2$.', '', '```python', 'print("browser acceptance")', '```', '', '```mermaid', 'graph LR', '  Markdown --> HTML', '```', '', '| Key | Long value |', '| --- | --- |', `| Width | ${'long_cell_'.repeat(28)} |`, '', `<img src="${png}" alt="Fixture pixel">`].join('\n');
    const original = await fs.readFile(path.join(project, 'public', 'about', 'index.html'), 'utf8');
    const $ = cheerio.load(original); $('.prose').html(renderMarkdown(source)); $('.article-aside').remove();
    const fixture = $.html(); const fixturePath = path.join(output, 'renderer-fixture.html'); await fs.writeFile(fixturePath, fixture);
    receipt.fixtures.push(path.relative(project, fixturePath));
    await page.route('**/__browser_fixture__/', route => route.fulfill({ status: 200, contentType: 'text/html', body: fixture }));
    await visit(page, '/__browser_fixture__/');
    await page.locator('.mermaid svg').waitFor({ timeout: 20000 }); assert.ok(await page.locator('.katex').count());
    const geometry = await page.locator('.katex-html').first().evaluate(el => { const leaves = [...el.querySelectorAll('span')].filter(span => !span.childElementCount); const x = leaves.find(span => span.textContent.trim() === 'x').getBoundingClientRect(); const two = leaves.find(span => span.textContent.trim() === '2').getBoundingClientRect(); return { x: x.top + x.height / 2, exponent: two.top + two.height / 2 }; });
    assert.ok(geometry.exponent < geometry.x - 2, `The mathematical exponent must render above its base: ${JSON.stringify(geometry)}`);
    const codeFont=await page.locator('.code-block pre code').first().evaluate(el=>parseFloat(getComputedStyle(el).fontSize));
    assert.ok(codeFont>=15,`Code is too small to read: ${codeFont}px`);
    await page.locator('.code-copy').click(); assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'print("browser acceptance")\n');
    assert.equal(await page.locator('[data-toast]').textContent(), '程式碼已複製');
    for (const width of [320, 390, 1440]) { await page.setViewportSize({ width, height: 844 }); await noOverflow(page); }
    await shot(page, 'renderer-fixture'); await page.unroute('**/__browser_fixture__/');
    return { math: geometry, diagram: true, clipboard: true };
  });
  const postPath = posts.find(post => post.url.includes('202209')).url;
  await check('Anonymous hearts are shared, persist on reload, and toggle independently', async () => {
    const second = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const secondPage = await second.newPage(); observe(secondPage);
    try {
      await visit(page, postPath); await visit(secondPage, postPath);
      const a = await settledVote(page); const b = await settledVote(secondPage);
      assert.equal(a.liked, false); assert.equal(b.liked, false); assert.equal(a.count, b.count);
      const reader = await page.evaluate(() => localStorage.getItem('owen-reader-id'));
      assert.notEqual(reader, await secondPage.evaluate(() => localStorage.getItem('owen-reader-id')));
      assert.equal((await clickVote(page, true)).count, a.count + 1);
      await page.reload({ waitUntil: 'domcontentloaded' }); assert.deepEqual(await settledVote(page), { liked: true, count: a.count + 1 });
      assert.equal(await page.evaluate(() => localStorage.getItem('owen-reader-id')), reader);
      await secondPage.reload({ waitUntil: 'domcontentloaded' }); assert.deepEqual(await settledVote(secondPage), { liked: false, count: a.count + 1 });
      assert.equal((await clickVote(secondPage, true)).count, a.count + 2);
      await page.reload({ waitUntil: 'domcontentloaded' }); assert.deepEqual(await settledVote(page), { liked: true, count: a.count + 2 });
      assert.equal((await clickVote(secondPage, false)).count, a.count + 1);
      assert.equal((await clickVote(page, false)).count, a.count);
      assert.equal((await clickVote(page, true)).count, a.count + 1);
      assert.equal((await clickVote(page, false)).count, a.count);
      return { initialCount: a.count, sharedPeak: a.count + 2, finalCount: a.count, persistedReader: true };
    } finally { await clearVote(context, postPath); await clearVote(second, postPath); await second.close(); }
  });
  await check('Failed initial heart read retries before any mutation', async () => {
    let postsSent = 0; const fail = async route => { if (route.request().method() === 'POST') postsSent++; await route.abort('failed'); };
    await page.route('http://127.0.0.1:8788/likes**', fail);
    await visit(page, postPath); await page.waitForFunction(() => !document.querySelector('[data-like]').disabled);
    await page.locator('[data-like]').click(); await page.waitForFunction(() => !document.querySelector('[data-like]').disabled);
    assert.equal(postsSent, 0, 'An unknown previous vote must never be blindly toggled.');
    assert.ok(await page.locator('[data-like-status]').textContent());
    await page.unroute('http://127.0.0.1:8788/likes**', fail);
    try { await page.locator('[data-like]').click(); await page.waitForFunction(() => !document.querySelector('[data-like]').disabled); assert.equal((await settledVote(page)).liked, true); assert.equal((await clickVote(page, false)).liked, false); } finally { await clearVote(context, postPath); }
  });
  await check('Lost write response rechecks the committed vote before a retry', async () => {
    const own = await browser.newContext(); const ownPage = await own.newPage(); observe(ownPage);
    let dropped = false; const methods = [];
    const intercept = async route => { const method = route.request().method(); methods.push(method); if (method === 'POST' && !dropped) { dropped = true; await route.fetch(); await route.abort('failed'); } else await route.continue(); };
    try {
      await visit(ownPage, postPath); await settledVote(ownPage);
      await ownPage.route('http://127.0.0.1:8788/likes**', intercept);
      await ownPage.locator('[data-like]').click(); await ownPage.waitForFunction(() => !document.querySelector('[data-like]').disabled);
      assert.ok(await ownPage.locator('[data-like-status]').textContent());
      await ownPage.locator('[data-like]').click(); await ownPage.waitForFunction(() => !document.querySelector('[data-like]').disabled);
      assert.deepEqual(methods, ['POST', 'GET', 'POST']); assert.equal((await settledVote(ownPage)).liked, false);
    } finally { await ownPage.unroute('http://127.0.0.1:8788/likes**', intercept); await clearVote(own, postPath); await own.close(); }
  });
  await check('Review screenshots', async () => {
    await page.setViewportSize({ width: 1440, height: 900 }); await visit(page, '/'); await shot(page, 'home-desktop', true);
    await page.setViewportSize({ width: 390, height: 844 }); await shot(page, 'home-mobile-390', true);
    await page.setViewportSize({ width: 320, height: 844 }); await shot(page, 'home-mobile-320', true);
    await page.setViewportSize({ width: 1440, height: 900 }); await visit(page, posts.find(post => post.url.includes('202207')).url); await localImages(page); await shot(page, 'article-desktop');
    await visit(page, '/about/'); await shot(page, 'about-chinese-desktop');
    await page.locator('.prose h2,.prose h3').filter({hasText:'教育背景'}).first().scrollIntoViewIfNeeded(); await shot(page, 'about-education-desktop');
    await page.setViewportSize({width:390,height:844}); await shot(page, 'about-education-mobile');
    await page.setViewportSize({ width: 390, height: 844 }); await page.locator('[data-language-button="en"]').click(); await shot(page, 'about-english-mobile');
    await page.locator('.prose h2').filter({ hasText: '程式相關活動' }).scrollIntoViewIfNeeded(); await shot(page, 'about-common-appendix-mobile');
  });
  await context.close();
} catch (error) {
  receipt.cases.push({ name: 'Browser setup', passed: false, error: error.stack || String(error) });
  console.error(error.stack);
} finally {
  await browser?.close();
  receipt.pageErrors = [...scriptErrors].map(value => JSON.parse(value));
  receipt.localFailures = [...localBroken].map(value => JSON.parse(value));
  receipt.externalFailures = [...externalBroken].map(value => JSON.parse(value));
  receipt.finishedAt = new Date().toISOString();
  receipt.passed = receipt.cases.length > 0 && receipt.cases.every(item => item.passed) && !receipt.pageErrors.length && !receipt.localFailures.length;
  await fs.writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify({ passed: receipt.passed, cases: receipt.cases.length, failed: receipt.cases.filter(item => !item.passed).map(item => item.name), pageErrors: receipt.pageErrors, localFailures: receipt.localFailures, externalFailures: receipt.externalFailures.length, receipt: path.relative(project, path.join(output, 'receipt.json')) }, null, 2));
  if (!receipt.passed) process.exitCode = 1;
}
