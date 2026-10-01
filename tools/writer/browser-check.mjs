import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { createWriterServer } from './server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(here, '../..');
const require = createRequire(import.meta.url);
const { renderMarkdown } = require('../../lib/markdown.cjs');
const fixtures = path.join(here, '.fixtures');
await fs.mkdir(fixtures, { recursive: true });
const root = await fs.mkdtemp(path.join(fixtures, 'browser-'));
await fs.mkdir(path.join(root, 'source', '_posts'), { recursive: true });
await fs.mkdir(path.join(root, 'source', '_drafts'), { recursive: true });
await fs.mkdir(path.join(root, 'themes', 'owen', 'source', 'css'), { recursive: true });
await fs.cp(path.join(project, 'themes', 'owen', 'source', 'vendor'), path.join(root, 'themes', 'owen', 'source', 'vendor'), { recursive: true });
await fs.copyFile(path.join(project, 'themes', 'owen', 'source', 'css', 'site.css'), path.join(root, 'themes', 'owen', 'source', 'css', 'site.css'));
const source = '---\ntitle: 寫作桌驗證\ntitle_en: "Writer check"\ndate: 2026-10-01 08:00:00\n---\n\n<!-- LANG:ZH START -->\n## 一篇新文章\n\n在 Markdown 中寫下思考，圖片留在自己的網站。\n\n| 項目 | 結果 |\n| --- | --- |\n| 草稿 | 保留在本機 |\n\n數學：$x^2 + y^2 = z^2$。\n\n```python\nprint("hello")\n```\n<!-- LANG:ZH END -->\n<!-- LANG:EN START -->\n## An English article\n\nMarkdown, with images kept on your own website.\n<!-- LANG:EN END -->\n<script>parent.document.body.dataset.compromised="yes"</script>\n';
await fs.writeFile(path.join(root, 'source', '_posts', '測試文章.md'), source);
const pageFixtures = [
  { id: 'pages/about/index.md', directory: 'about', name: '個人介紹', heading: '自己的介紹', imageAlt: '既有介紹圖片', width: 1, image: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMwjw/6DwADoQHoRkGVTQAAAABJRU5ErkJggg==', original: '---\ntitle: 個人介紹\n---\n\n## 自己的介紹\n\n保留原有介紹。\n\n![既有介紹圖片](images/頁面圖.png)\n' },
  { id: 'pages/links/index.md', directory: 'links', name: '推薦連結', heading: '推薦閱讀', imageAlt: '既有連結圖片', width: 2, image: 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8AAQv8BD/kD/YURmXYAAAAASUVORK5CYII=', original: '---\ntitle: 推薦連結\n---\n\n## 推薦閱讀\n\n[原有推薦](https://example.org/)\n\n![既有連結圖片](images/頁面圖.png)\n' },
];
for (const fixture of pageFixtures) {
  await fs.mkdir(path.join(root, 'source', fixture.directory, 'images'), { recursive: true });
  await fs.writeFile(path.join(root, 'source', fixture.directory, 'index.md'), fixture.original);
  await fs.writeFile(path.join(root, 'source', fixture.directory, 'images', '頁面圖.png'), Buffer.from(fixture.image, 'base64'));
}
const { server, store } = await createWriterServer({ projectRoot: root, renderMarkdown });
let appRequests = 0;
server.on('request', (request) => { if (request.url === '/app.js') appRequests += 1; });
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
let browser;
const errors = [];
const localRequestFailures = [];
const intentionalRequestFailures = [];
let intentionalApiProbe = false;
let intentionalBilingualProbe = false;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const origin = `http://127.0.0.1:${server.address().port}`;
  context.on('page', (child) => child.on('pageerror', (error) => errors.push(error.message)));
  context.on('response', (response) => {
    const url = new URL(response.url());
    if (url.origin !== origin || response.status() < 400) return;
    const failure = { path: url.pathname, method: response.request().method(), status: response.status() };
    const intentional = url.pathname === '/images/absent.png' && response.status() === 404 || intentionalApiProbe && url.pathname === '/api/library' && response.status() === 403 || intentionalBilingualProbe && url.pathname === '/api/preview' && response.status() === 422;
    (intentional ? intentionalRequestFailures : localRequestFailures).push(failure);
  });
  context.on('requestfailed', (request) => {
    const url = new URL(request.url());
    if (url.origin !== origin) return;
    const failure = { path: url.pathname, method: request.method(), error: request.failure()?.errorText ?? 'Request failed' };
    const intentional = failure.error.includes('CSP') && ['/app.js', '/', '/api/drafts'].includes(url.pathname);
    (intentional ? intentionalRequestFailures : localRequestFailures).push(failure);
  });
  const page = await context.newPage();
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  await page.goto(origin);
  await page.getByRole('button', { name: '測試文章', exact: true }).click();
  const frame = page.frameLocator('#preview');
  await frame.getByRole('heading', { name: '一篇新文章' }).waitFor();
  assert.equal(await page.evaluate(() => document.body.dataset.compromised), undefined);
  assert.equal(await frame.locator('body').evaluate((element) => getComputedStyle(element).paddingTop), '28px');
  assert.equal(await frame.locator('body').evaluate((element) => getComputedStyle(element).fontSize), '19px');
  assert.equal(await page.locator('#editor').evaluate((element) => getComputedStyle(element).fontSize), '16px');
  assert.equal(await page.getByRole('button', { name: '同步捲動', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.ok(await frame.locator('.katex').count());
  assert.equal(await frame.locator('.katex').evaluate((element) => getComputedStyle(element).fontFamily.includes('KaTeX')), true);
  const mathGeometry = await frame.locator('.katex-html').first().evaluate((element) => {
    const leaves = [...element.querySelectorAll('span')].filter((span) => !span.childElementCount);
    const base = leaves.find((span) => span.textContent.trim() === 'x').getBoundingClientRect();
    const exponent = leaves.find((span) => span.textContent.trim() === '2').getBoundingClientRect();
    return { baseCenter: base.top + base.height / 2, exponentCenter: exponent.top + exponent.height / 2 };
  });
  assert.ok(mathGeometry.exponentCenter < mathGeometry.baseCenter - 2, `Exponent must appear above the base: ${JSON.stringify(mathGeometry)}`);
  await page.locator('#preview-language').selectOption('en');
  await frame.getByRole('heading', { name: 'An English article' }).waitFor();
  await frame.getByRole('heading', { name: 'Writer check', exact: true }).waitFor();
  assert.equal(await frame.getByRole('heading', { name: '一篇新文章' }).isVisible(), false);
  await page.locator('#preview-language').selectOption('zh');
  await frame.getByRole('heading', { name: '一篇新文章' }).waitFor();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMwjw/6DwADoQHoRkGVTQAAAABJRU5ErkJggg==', 'base64');
  await page.locator('#image-input').setInputFiles({ name: '範例.png', mimeType: 'image/png', buffer: png });
  await page.waitForFunction(() => document.getElementById('editor').value.includes('/images/uploads/'));
  await frame.getByRole('img', { name: '範例' }).waitFor();
  assert.equal(await frame.getByRole('img', { name: '範例' }).evaluate((element) => element.complete && element.naturalWidth), 1);
  await page.locator('#editor').evaluate((element, bytes) => {
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(bytes)], '剪貼簿.png', { type: 'image/png' }));
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
  }, [...png]);
  await page.waitForFunction(() => document.getElementById('editor').value.includes('![剪貼簿]'));
  await page.locator('#editor').evaluate((element, bytes) => {
    element.setSelectionRange(element.value.length, element.value.length);
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(bytes)], '拖入.png', { type: 'image/png' }));
    element.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
  }, [...png]);
  await page.waitForFunction(() => document.getElementById('editor').value.includes('![拖入]'));
  await page.getByRole('button', { name: '儲存', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('已儲存'));
  const saved = await store.read('posts/測試文章.md');
  assert.ok(saved.content.includes('![範例](/images/uploads/'));
  assert.ok(saved.content.includes('![剪貼簿](/images/uploads/'));
  assert.ok(saved.content.includes('![拖入](/images/uploads/'));
  assert.ok(saved.content.includes('<script>parent.document.body.dataset.compromised="yes"</script>'));
  const additionalChecks = [];
  const pageImages = [];
  const clipboardResult = { secureContext: await page.evaluate(() => isSecureContext), nativeImagePaste: false, nativeTextPaste: false, buttonPaste: false, markdownCopied: false, fallback: [] };
  assert.equal(clipboardResult.secureContext, true);
  const saveEdited = async () => {
    await page.getByRole('button', { name: '儲存', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('已儲存'));
  };
  for (const fixture of pageFixtures) {
    await page.getByRole('button', { name: fixture.name, exact: true }).click();
    await frame.getByRole('heading', { name: fixture.heading, exact: true }).waitFor();
    await page.waitForFunction(({ alt, width }) => {
      const image = [...document.getElementById('preview').contentDocument.images].find((element) => element.alt === alt);
      return image?.complete && image.naturalWidth === width && image.naturalHeight === 1;
    }, { alt: fixture.imageAlt, width: fixture.width });
    const image = frame.getByRole('img', { name: fixture.imageAlt, exact: true });
    const imageSource = await image.getAttribute('src');
    assert.equal(decodeURIComponent(new URL(imageSource, origin).pathname), `/${fixture.directory}/images/頁面圖.png`);
    const returned = await context.request.get(new URL(imageSource, origin).href);
    assert.equal(returned.status(), 200);
    assert.deepEqual(await returned.body(), Buffer.from(fixture.image, 'base64'));
    pageImages.push({ page: fixture.directory, src: imageSource, width: fixture.width, height: 1, originalBytesMatched: true });
    additionalChecks.push(`${fixture.directory} existing relative image resolves to its own page and decodes correct dimensions`);
    assert.equal(await page.locator('#editor').inputValue(), fixture.original);
    const content = fixture.original + `\n${fixture.name}在寫作桌的新增內容。\n`;
    await page.locator('#editor').fill(content);
    await frame.getByText(`${fixture.name}在寫作桌的新增內容。`, { exact: true }).waitFor();
    await saveEdited();
    assert.equal((await store.read(fixture.id)).content, content);
    const revisionRoot = path.join(root, '.history', 'writer', 'pages');
    const revisions = await fs.readdir(revisionRoot, { recursive: true });
    let preimage;
    for (const name of revisions.filter((name) => name.endsWith('.json'))) {
      const metadata = JSON.parse(await fs.readFile(path.join(revisionRoot, name), 'utf8'));
      if (metadata.id === fixture.id) preimage = await fs.readFile(path.join(revisionRoot, name.replace(/\.json$/, '.md')), 'utf8');
    }
    assert.equal(preimage, fixture.original, `${fixture.name} must keep the exact preimage`);
    additionalChecks.push(`${fixture.directory} page editing, shared preview and exact saved preimage`);
  }
  await page.getByRole('button', { name: '個人介紹', exact: true }).click();
  await frame.getByRole('heading', { name: '自己的介紹', exact: true }).waitFor();
  await page.locator('#editor').evaluate((element) => { element.focus(); element.setSelectionRange(element.value.length, element.value.length); });
  await page.evaluate(async (bytes) => navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(bytes)], { type: 'image/png' }) })]), [...png]);
  await page.getByRole('button', { name: '貼上圖片', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('editor').value.includes('/images/uploads/') && !document.getElementById('paste-image').disabled);
  await frame.locator('img[src^="/images/uploads/"]').first().waitFor();
  assert.ok(await frame.locator('img[src^="/images/uploads/"]').first().evaluate((image) => image.complete && image.naturalWidth > 0));
  clipboardResult.buttonPaste = true;
  const clipboardMarkdown = await page.locator('#image-markdown').inputValue();
  await page.getByRole('button', { name: '複製圖片語法', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('已複製圖片語法'));
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), clipboardMarkdown);
  clipboardResult.markdownCopied = true;
  additionalChecks.push('real ClipboardItem PNG toolbar paste and decoded page preview', 'real clipboard image Markdown copy');

  const pasteShortcut = process.platform === 'darwin' ? 'Meta+V' : 'Control+V';
  await page.evaluate(async (bytes) => navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(bytes)], { type: 'image/png' }) })]), [...png]);
  const imagesBeforeNativePaste = (await page.locator('#editor').inputValue()).match(/!\[[^\]]*\]\(\/images\/uploads\/[^)]+\)/g).length;
  await page.locator('#editor').evaluate((element) => { element.focus(); element.setSelectionRange(element.value.length, element.value.length); });
  await page.keyboard.press(pasteShortcut);
  await page.waitForFunction((count) => (document.getElementById('editor').value.match(/!\[[^\]]*\]\(\/images\/uploads\/[^)]+\)/g) ?? []).length === count + 1 && !document.getElementById('paste-image').disabled, imagesBeforeNativePaste);
  clipboardResult.nativeImagePaste = true;
  additionalChecks.push('real keyboard image paste from system Clipboard API');

  await page.evaluate(() => { window.__writerClipboardRead = navigator.clipboard.read; });
  const bodyBeforeFallback = await page.locator('#editor').inputValue();
  try {
    for (const mode of ['unavailable', 'denied']) {
      await page.evaluate((value) => Object.defineProperty(navigator.clipboard, 'read', { configurable: true, value: value === 'unavailable' ? undefined : () => Promise.reject(new DOMException('Denied for this fixture', 'NotAllowedError')) }), mode);
      await page.getByRole('button', { name: '貼上圖片', exact: true }).click();
      await page.waitForFunction(() => document.getElementById('status').textContent.includes('⌘/Ctrl + V'));
      assert.equal(await page.locator('#editor').inputValue(), bodyBeforeFallback);
      assert.equal(await page.locator('#editor').evaluate((element) => document.activeElement === element), true);
      assert.equal(await page.getByRole('button', { name: '貼上圖片', exact: true }).isEnabled(), true);
      clipboardResult.fallback.push(mode);
    }
  } finally {
    await page.evaluate(() => Object.defineProperty(navigator.clipboard, 'read', { configurable: true, value: window.__writerClipboardRead }));
  }
  additionalChecks.push('unsupported and refused clipboard reads retain source and native paste fallback');
  const plainSource = '一般文字仍可貼上：';
  await page.locator('#editor').fill(plainSource);
  await page.evaluate(() => navigator.clipboard.writeText('原生文字貼上成功'));
  await page.keyboard.press(pasteShortcut);
  assert.equal(await page.locator('#editor').inputValue(), plainSource + '原生文字貼上成功');
  clipboardResult.nativeTextPaste = true;
  const plainEvents = await page.locator('#editor').evaluate((element) => {
    const transfer = new DataTransfer(); transfer.setData('text/plain', '不應攔截的普通文字');
    const paste = new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true });
    const drop = new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true });
    element.dispatchEvent(paste); element.dispatchEvent(drop);
    return { pastePrevented: paste.defaultPrevented, dropPrevented: drop.defaultPrevented };
  });
  assert.deepEqual(plainEvents, { pastePrevented: false, dropPrevented: false });
  additionalChecks.push('native plain text paste and unblocked text paste/drop events');

  const pasteImage = async (name, caret) => page.locator('#editor').evaluate((element, data) => {
    element.focus();
    if (data.caret !== undefined) element.setSelectionRange(data.caret, data.caret);
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(data.bytes)], data.name, { type: 'image/png' }));
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
  }, { name, caret, bytes: [...png] });
  const delayedImage = async (start, pending, complete) => {
    let announce;
    const requested = new Promise((resolve) => { announce = resolve; });
    let release;
    const released = new Promise((resolve) => { release = resolve; });
    const handler = async (route) => { announce(); await released; await route.continue(); };
    await page.route('**/api/images', handler);
    try {
      await start();
      await requested;
      await pending();
      release();
      await page.waitForFunction(() => !document.getElementById('paste-image').disabled);
      await complete();
    } finally { release(); await page.unroute('**/api/images', handler); }
  };
  const persistedBeforeDelay = (await store.read('pages/about/index.md')).content;
  const delaySource = '## 插入位置驗證\n\n插入位置\n\n尾端文字必須保留\n';
  const delayCaret = delaySource.indexOf('插入位置\n');
  await page.locator('#editor').fill(delaySource);
  await delayedImage(
    () => pasteImage('延遲.png', delayCaret),
    async () => {
      assert.equal(await page.getByRole('button', { name: '儲存', exact: true }).isDisabled(), true);
      await page.getByRole('button', { name: '推薦連結', exact: true }).click();
      assert.equal(await page.locator('#document-name').textContent(), '個人介紹');
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+S' : 'Control+S');
      assert.equal((await store.read('pages/about/index.md')).content, persistedBeforeDelay);
      await page.locator('#editor').evaluate((element) => { element.focus(); element.setSelectionRange(0, 0); });
      await page.keyboard.type('新前綴\n');
      await page.locator('#editor').evaluate((element) => { const start = element.value.indexOf('尾端文字必須保留'); element.setSelectionRange(start, start + '尾端文字必須保留'.length); });
    },
    async () => {
      const body = await page.locator('#editor').inputValue();
      const markdown = await page.locator('#image-markdown').inputValue();
      assert.equal(body, '新前綴\n' + delaySource.slice(0, delayCaret) + markdown + '\n' + delaySource.slice(delayCaret));
      assert.equal(await page.locator('#editor').evaluate((element) => element.value.slice(element.selectionStart, element.selectionEnd)), '尾端文字必須保留');
    },
  );
  additionalChecks.push('pending image blocks switch/save and retains insertion through prefix typing and new selection');
  await page.locator('#editor').fill('aaaa');
  await delayedImage(
    () => pasteImage('重複字.png', 2),
    async () => { await page.locator('#editor').evaluate((element) => element.setSelectionRange(0, 0)); await page.keyboard.type('a'); },
    async () => { const body = await page.locator('#editor').inputValue(); assert.ok(body.startsWith('aaa\n\n![重複字]'), body); assert.ok(body.endsWith('\naa'), body); },
  );
  additionalChecks.push('real repeated-character typing adjusts original image anchor');
  const selectedSource = '開始 原有選取 結束';
  await page.locator('#editor').fill(selectedSource);
  await page.locator('#editor').evaluate((element) => { element.focus(); element.setSelectionRange(3, 7); });
  await delayedImage(
    () => pasteImage('選區.png'),
    () => page.keyboard.type('新輸入正文'),
    async () => { const body = await page.locator('#editor').inputValue(); assert.ok(body.includes('新輸入正文'), body); assert.ok(body.includes('![選區]'), body); assert.ok(body.includes('開始 ') && body.includes(' 結束'), body); },
  );
  additionalChecks.push('typing over the original selection preserves newly authored text');
  await page.locator('#editor').fill('兩張圖片依序插入。');
  await delayedImage(
    async () => { await pasteImage('第一張.png', 0); await pasteImage('第二張.png', 0); },
    async () => { assert.equal(await page.getByRole('button', { name: '儲存', exact: true }).isDisabled(), true); },
    async () => { const body = await page.locator('#editor').inputValue(); assert.ok(body.indexOf('![第一張]') >= 0 && body.indexOf('![第二張]') > body.indexOf('![第一張]'), body); assert.ok(body.endsWith('兩張圖片依序插入。'), body); },
  );
  additionalChecks.push('queued same-caret image batches retain paste order');
  await page.locator('#editor').fill('加入圖片時可以繼續尋找文件。');
  await delayedImage(
    () => pasteImage('焦點.png', 0),
    () => page.locator('#filter').fill('介紹'),
    async () => { assert.equal(await page.locator('#filter').evaluate((element) => document.activeElement === element), true); assert.equal(await page.locator('#filter').inputValue(), '介紹'); },
  );
  await page.locator('#filter').fill('');
  additionalChecks.push('completed image upload keeps focus in document search');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await page.locator('#editor').fill('## 預覽保持開啟\n\n圖片加入不切回編輯。');
  await delayedImage(
    () => pasteImage('手機.png', 0),
    () => page.getByRole('tab', { name: '預覽', exact: true }).click(),
    async () => { assert.equal(await page.getByRole('tab', { name: '預覽', exact: true }).getAttribute('aria-selected'), 'true'); assert.equal(await page.getByRole('tab', { name: '預覽', exact: true }).evaluate((element) => document.activeElement === element), true); },
  );
  additionalChecks.push('completed image upload keeps the mobile preview tab and focus');
  await saveEdited();
  await page.getByRole('button', { name: '測試文章', exact: true }).click();
  await frame.getByRole('heading', { name: '一篇新文章', exact: true }).waitFor();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: path.join(root, 'desktop.png'), fullPage: true });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.getByRole('tab', { name: '預覽', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '加入圖片', exact: true }).isVisible(), true);
    assert.equal(await page.getByRole('button', { name: '貼上圖片', exact: true }).isVisible(), true);
    assert.equal(await page.locator('.sync-indicator').isVisible(), true, 'Mobile sync control must show its on/off state');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}px viewport must not overflow`);
    await page.screenshot({ path: path.join(root, `mobile-${width}.png`), fullPage: true });
  }
  await page.getByRole('button', { name: '新增草稿', exact: true }).click();
  await page.getByRole('textbox', { name: '文章標題', exact: true }).fill('瀏覽器草稿驗證');
  await page.getByRole('button', { name: '建立草稿', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('document-name').textContent === '瀏覽器草稿驗證.md');
  assert.equal((await store.list()).filter((item) => item.kind === 'posts').length, 1);
  assert.equal((await store.list()).filter((item) => item.kind === 'drafts').length, 1);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: '同步捲動', exact: true }).click();
  const longSource = '---\ntitle: 長文捲動驗證\n---\n\n## 長文內容\n\n' + Array.from({ length: 80 }, (_, index) => `第 ${index + 1} 段，保留文章預覽的閱讀位置。`).join('\n\n') + '\n\n<script>parent.document.body.dataset.inlineProbe="yes"</script>\n<script src="/app.js"></script>\n<img alt="事件處理測試" src="/images/absent.png" onerror="parent.document.body.dataset.eventProbe=\'yes\'">\n<iframe src="/"></iframe>\n<form action="/api/drafts" method="post"><input name="title" value="不應建立"><button type="submit">表單測試</button></form>\n';
  await page.locator('#editor').fill(longSource);
  await frame.getByRole('heading', { name: '長文內容', exact: true }).waitFor();
  await page.locator('#preview').evaluate((element) => element.contentWindow.scrollTo(0, 700));
  const scrollBefore = await page.locator('#preview').evaluate((element) => element.contentWindow.scrollY);
  await page.locator('#editor').fill(longSource + '\n\n編輯後新增的段落。\n');
  await frame.getByText('編輯後新增的段落。', { exact: true }).waitFor();
  await page.waitForFunction((expected) => Math.abs(document.getElementById('preview').contentWindow.scrollY - expected) < 4, scrollBefore);
  const scrollAfter = await page.locator('#preview').evaluate((element) => element.contentWindow.scrollY);
  assert.ok(Math.abs(scrollAfter - scrollBefore) < 4, `Preview scroll must survive edits: ${scrollBefore} → ${scrollAfter}`);
  await page.waitForFunction(() => document.getElementById('preview').contentDocument.querySelector('img')?.complete);
  assert.deepEqual(await page.evaluate(() => ({ inline: document.body.dataset.inlineProbe ?? null, event: document.body.dataset.eventProbe ?? null })), { inline: null, event: null });
  assert.equal(appRequests, 1, 'Preview must not fetch or execute the authored external script');
  await frame.getByRole('button', { name: '表單測試', exact: true }).click();
  assert.equal((await store.list()).filter((item) => item.kind === 'drafts').length, 1, 'Preview forms must not create files');
  intentionalApiProbe = true;
  try { assert.equal(await page.evaluate(async () => (await fetch('/api/library')).status), 403, 'Even same-origin requests still require the startup token'); }
  finally { intentionalApiProbe = false; }
  await fs.writeFile(path.join(root, 'source', 'images', 'sync.png'), png);
  const syncSource = '---\ntitle: 同步捲動驗證\n---\n\n' + Array.from({ length: 14 }, (_, index) => `## 對照小節 ${index + 1}\n\n小節 ${index + 1} 的第一段文字。\n\n小節 ${index + 1} 的第二段文字。\n\n${index === 2 ? '<img src="/images/sync.png" class="sync-image">\n\n' : ''}${index === 10 ? '這是會在較窄編輯區自動換行的長段落。'.repeat(20) + '\n\n' : ''}`).join('') + '<style>.writer-preview .sync-image{display:block;height:480px;width:300px;object-fit:contain}</style>\n';
  await page.locator('#editor').fill(syncSource);
  await frame.getByRole('heading', { name: '對照小節 14', exact: true }).waitFor();
  await page.getByRole('button', { name: '同步捲動', exact: true }).click();
  const sourcePosition = async (heading) => page.locator('#editor').evaluate((element, title) => {
    const line = element.value.split('\n').findIndex((text) => text === `## ${title}`);
    const css = getComputedStyle(element);
    return parseFloat(css.paddingTop) + line * parseFloat(css.lineHeight);
  }, heading);
  const sixthSourceTop = await sourcePosition('對照小節 6');
  await page.locator('#editor').evaluate((element, top) => { element.scrollTop = top; }, sixthSourceTop);
  await page.waitForFunction(() => Math.abs([...document.getElementById('preview').contentDocument.querySelectorAll('h2')].find((heading) => heading.textContent === '對照小節 6').getBoundingClientRect().top) < 4);
  const forwardSync = await frame.getByRole('heading', { name: '對照小節 6', exact: true }).evaluate((element) => element.getBoundingClientRect().top);
  const eighthSourceTop = await sourcePosition('對照小節 8');
  await frame.getByRole('heading', { name: '對照小節 8', exact: true }).evaluate((element) => window.scrollTo(0, window.scrollY + element.getBoundingClientRect().top));
  await page.waitForFunction((top) => Math.abs(document.getElementById('editor').scrollTop - top) < 4, eighthSourceTop);
  const reverseSync = await page.locator('#editor').evaluate((element) => element.scrollTop);
  const stableBefore = await page.locator('#preview').evaluate((element) => ({ editor: document.getElementById('editor').scrollTop, preview: element.contentWindow.scrollY }));
  await page.waitForTimeout(300);
  assert.deepEqual(await page.locator('#preview').evaluate((element) => ({ editor: document.getElementById('editor').scrollTop, preview: element.contentWindow.scrollY })), stableBefore, 'Bidirectional scroll must settle without feedback loops');
  await page.getByRole('button', { name: '同步捲動', exact: true }).click();
  await page.locator('#preview').evaluate((element) => element.contentWindow.scrollTo(0, 200));
  await page.waitForTimeout(100);
  assert.equal(await page.locator('#editor').evaluate((element) => element.scrollTop), reverseSync, 'Disconnected preview scrolling must leave the source unchanged');
  await page.locator('#editor').evaluate((element) => { element.scrollTop = 800; });
  await page.waitForTimeout(100);
  assert.equal(await page.locator('#preview').evaluate((element) => element.contentWindow.scrollY), 200, 'Disconnected source scrolling must leave the preview unchanged');
  const preferencePage = await page.context().newPage();
  await preferencePage.goto(`http://127.0.0.1:${server.address().port}/`);
  assert.equal(await preferencePage.getByRole('button', { name: '同步捲動', exact: true }).getAttribute('aria-pressed'), 'false', 'Scroll preference must survive another page load');
  await preferencePage.close();
  await page.getByRole('button', { name: '同步捲動', exact: true }).click();
  await page.locator('#editor').evaluate((element, top) => { element.scrollTop = top; }, sixthSourceTop);
  await page.waitForFunction(() => Math.abs([...document.getElementById('preview').contentDocument.querySelectorAll('h2')].find((heading) => heading.textContent === '對照小節 6').getBoundingClientRect().top) < 4);
  await frame.locator('.sync-image').evaluate((image) => { image.style.height = '840px'; });
  await page.waitForFunction(() => Math.abs([...document.getElementById('preview').contentDocument.querySelectorAll('h2')].find((heading) => heading.textContent === '對照小節 6').getBoundingClientRect().top) < 4);
  assert.ok(Math.abs(await page.locator('#editor').evaluate((element) => element.scrollTop) - sixthSourceTop) < 4, 'Resizing an image must preserve the source reading position');
  const imageResizeSourceOffset = await page.locator('#editor').evaluate((element) => element.scrollTop) - sixthSourceTop;
  await page.locator('#editor').evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await page.waitForFunction(() => { const win = document.getElementById('preview').contentWindow; return Math.abs(win.scrollY - (win.document.documentElement.scrollHeight - win.innerHeight)) < 4; });
  const syncResult = { sourceToPreviewHeadingOffset: forwardSync, previewToSourceOffset: reverseSync - eighthSourceTop, imageResizeSourceOffset, preferenceRetained: true, independentScroll: true, stable: true };
  const typingResults = [];
  for (const position of ['middle', 'end']) {
    await page.locator('#editor').evaluate((element, where) => {
      const caret = where === 'middle' ? element.value.indexOf('小節 8 的第二段文字。') + '小節 8 的第二段文字。'.length : element.value.length;
      element.focus(); element.setSelectionRange(caret, caret);
    }, position);
    const finalParagraph = position === 'middle' ? '中段實際輸入的最後一段。' : '末尾實際輸入的最後一段。';
    await page.keyboard.type(`\n\n實際鍵盤連續輸入，多個段落保持游標的位置。\n\n第二個新段落，預覽更新後仍留在原來的編輯位置。\n\n${finalParagraph}`);
    const before = await page.locator('#editor').evaluate((element) => ({ scrollTop: element.scrollTop, caret: element.selectionStart }));
    await frame.getByText(finalParagraph, { exact: true }).waitFor();
    const after = await page.locator('#editor').evaluate((element) => ({ scrollTop: element.scrollTop, caret: element.selectionStart, focused: document.activeElement === element }));
    assert.ok(Math.abs(after.scrollTop - before.scrollTop) < 4, `Typing at ${position} must keep the source viewport: ${JSON.stringify({ before, after })}`);
    assert.equal(after.caret, before.caret, `Typing at ${position} must keep the caret`);
    assert.equal(after.focused, true);
    typingResults.push({ position, scrollBefore: before.scrollTop, scrollAfter: after.scrollTop, caretRetained: true });
  }
  syncResult.actualTyping = typingResults;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('tab', { name: '預覽', exact: true }).click();
  await page.locator('#preview').evaluate((element) => element.contentWindow.scrollTo(0, 2400));
  await page.waitForTimeout(150);
  const mobilePreviewBefore = await page.locator('#preview').evaluate((element) => element.contentWindow.scrollY);
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await page.waitForTimeout(150);
  const mobileSourceFirst = await page.locator('#editor').evaluate((element) => element.scrollTop);
  assert.ok(mobileSourceFirst > 400, `Switching from a scrolled preview must not reset the source: ${mobileSourceFirst}`);
  await page.getByRole('tab', { name: '預覽', exact: true }).click();
  await page.waitForTimeout(150);
  const mobilePreviewAfter = await page.locator('#preview').evaluate((element) => element.contentWindow.scrollY);
  assert.ok(Math.abs(mobilePreviewAfter - mobilePreviewBefore) < 4, `Mobile tab round-trip must retain preview position: ${mobilePreviewBefore} → ${mobilePreviewAfter}`);
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await page.waitForTimeout(150);
  const mobileSourceAfter = await page.locator('#editor').evaluate((element) => element.scrollTop);
  assert.ok(Math.abs(mobileSourceAfter - mobileSourceFirst) < 4, `Mobile tab round-trip must retain source position: ${mobileSourceFirst} → ${mobileSourceAfter}`);
  syncResult.mobileTabs = { previewBefore: mobilePreviewBefore, previewAfter: mobilePreviewAfter, sourceBefore: mobileSourceFirst, sourceAfter: mobileSourceAfter };
  await page.screenshot({ path: path.join(root, 'scroll-sync.png'), fullPage: true });
  intentionalBilingualProbe = true;
  await page.locator('#editor').fill('---\ntitle: 標記錯誤驗證\n---\n\n<!-- LANG:ZH START -->\n正文');
  await page.getByRole('alert').filter({ hasText: '雙語標記缺少配對' }).waitFor();
  intentionalBilingualProbe = false;
  assert.deepEqual(errors, []);
  assert.deepEqual(localRequestFailures, [], 'Writer and preview local assets must load; deliberate sandbox/API probes are recorded separately');
  additionalChecks.push('no unexpected local asset or API failures');
  const receipt = { passed: true, root, katexVersion: require('katex/package.json').version, mathGeometry, previewScroll: { before: scrollBefore, after: scrollAfter }, scrollSync: syncResult, clipboard: clipboardResult, pageImages, localRequestFailures, intentionalRequestFailures, checks: ['production renderer', 'sandbox inline/event/external scripts blocked', 'preview forms blocked', 'same-origin API still requires token', 'iframe CSS and KaTeX font', 'superscript above base', 'bilingual body and title preview', 'image attachment', 'clipboard paste handler', 'image drop handler', 'explicit save and revisions', '390/320px no overflow', 'draft does not publish', 'preview scroll retained', 'bilingual syntax error explains correction', 'readable writer and preview typography', 'source-to-preview block alignment', 'preview-to-source block alignment', 'scroll sync settles without loops', 'disconnected independent scrolling', 'scroll preference retained', 'image resize realigns current block', 'long wrapped source reaches preview bottom', 'real middle typing retains source viewport and caret', 'real end typing retains source viewport and caret', 'mobile preview tab round-trip retains reading position', 'mobile source tab round-trip retains reading position', ...additionalChecks], pageErrors: errors };
  await fs.writeFile(path.join(root, 'receipt.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt, null, 2));
} catch (error) {
  const receipt = { passed: false, root, error: { name: error.name, message: error.message, stack: error.stack }, pageErrors: errors, localRequestFailures, intentionalRequestFailures };
  await fs.writeFile(path.join(root, 'failure.json'), JSON.stringify(receipt, null, 2));
  console.error(JSON.stringify({ failed: true, root, message: error.message }));
  throw error;
} finally {
  await browser?.close();
  await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
}
