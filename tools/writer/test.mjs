import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WriterError, WriterStore, previewParts, versionOf } from './storage.mjs';
import { createWriterServer } from './server.mjs';
import { load } from 'cheerio';
import { renderMarkdown as renderPublishedMarkdown } from '../../lib/markdown.cjs';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), '.fixtures');
const original = '---\ntitle: 測試文章\ndate: 2026-10-01 08:00:00\n---\n\n原始文字\n';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYl8AAAAASUVORK5CYII=', 'base64');

async function fixture() {
  await fs.mkdir(fixtures, { recursive: true });
  const root = await fs.mkdtemp(path.join(fixtures, 'run-'));
  await fs.mkdir(path.join(root, 'source', '_posts'), { recursive: true });
  await fs.mkdir(path.join(root, 'source', '_drafts'), { recursive: true });
  await fs.writeFile(path.join(root, 'source', '_posts', '文章.md'), original);
  const store = await new WriterStore(root).initialize();
  return { root, store };
}

async function pageFixture() {
  const fixtureData = await fixture();
  const pages = [
    { id: 'pages/about/index.md', folder: 'about', name: '個人介紹', content: '---\ntitle: 個人介紹\n---\n\n<!-- LANG:ZH START -->\n原始介紹 <span>完整保留</span>\n<!-- LANG:ZH END -->\n<!-- LANG:EN START -->\nOriginal introduction.\n<!-- LANG:EN END -->\n' },
    { id: 'pages/links/index.md', folder: 'links', name: '推薦連結', content: '---\ntitle: 推薦連結\n---\n\n[原有連結](https://example.com/)\n' },
  ];
  for (const page of pages) {
    await fs.mkdir(path.join(fixtureData.root, 'source', page.folder), { recursive: true });
    await fs.writeFile(path.join(fixtureData.root, 'source', page.folder, 'index.md'), page.content);
  }
  return { ...fixtureData, pages };
}

async function pageImageFixture() {
  const data = await pageFixture();
  for (const page of data.pages) {
    await fs.mkdir(path.join(data.root, 'source', page.folder, 'images'));
    await fs.writeFile(path.join(data.root, 'source', page.folder, 'images', '原圖.png'), png);
  }
  return data;
}

async function withServer(context, fixtureFactory = fixture, renderMarkdown = (body) => `<p>${body}</p>`) {
  const fixtureData = await fixtureFactory();
  const service = await createWriterServer({ projectRoot: fixtureData.root, renderMarkdown });
  await new Promise((resolve, reject) => {
    service.server.once('error', reject);
    service.server.listen(0, '127.0.0.1', () => { service.server.off('error', reject); resolve(); });
  });
  context.after(() => new Promise((resolve) => { service.server.close(resolve); service.server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${service.server.address().port}`;
  const request = (route, options = {}) => fetch(origin + route, { ...options, headers: { 'X-Writer-Token': service.token, ...options.headers } });
  const json = (route, method, data, headers = {}) => request(route, { method, body: JSON.stringify(data), headers: { 'Content-Type': 'application/json', Origin: origin, ...headers } });
  return { ...fixtureData, ...service, origin, request, json };
}

test('saving preserves exact Markdown and archives the preimage before replacing it', async () => {
  const { root, store } = await fixture();
  const before = await store.read('posts/文章.md');
  const next = `${original}\n新段落 <span>原樣 HTML</span>\n`;
  const result = await store.save(before.id, next, before.version);
  assert.equal(result.content, next);
  assert.equal(await fs.readFile(path.join(root, 'source', '_posts', '文章.md'), 'utf8'), next);
  const revisions = path.join(root, '.history', 'writer', 'posts', versionOf(before.id).slice(0, 16));
  const names = await fs.readdir(revisions);
  assert.equal(names.filter((name) => name.endsWith('.md')).length, 1);
  assert.equal(await fs.readFile(path.join(revisions, names.find((name) => name.endsWith('.md'))), 'utf8'), original);
  const receipt = JSON.parse(await fs.readFile(path.join(revisions, names.find((name) => name.endsWith('.json'))), 'utf8'));
  assert.equal(receipt.id, before.id);
  assert.equal(receipt.version, before.version);
  assert.equal((await fs.readdir(path.join(root, 'source', '_posts'))).some((name) => name.startsWith('.writer-')), false);
  await assert.rejects(store.save(before.id, '失去更新的文字', before.version), { status: 409 });
  assert.equal((await store.read(before.id)).content, next);
});

test('draft creation stays in drafts and duplicate titles preserve the first draft', async () => {
  const { root, store } = await fixture();
  const draft = await store.createDraft('寫作實驗');
  assert.equal(draft.id, 'drafts/寫作實驗.md');
  assert.match(draft.content, /^---\ntitle: "寫作實驗"/);
  await assert.rejects(store.createDraft('寫作實驗'), { status: 409 });
  assert.deepEqual(await fs.readdir(path.join(root, 'source', '_posts')), ['文章.md']);
  assert.equal((await store.list()).length, 2);
});

test('path traversal, absolute paths, hidden paths and symlinks cannot expose files', async () => {
  const { root, store } = await fixture();
  for (const id of ['/etc/passwd', 'posts/../../private.md', 'drafts/../文章.md', 'posts/.hidden.md', 'posts/evil\\file.md', 'posts/image.svg']) {
    await assert.rejects(store.read(id), WriterError);
  }
  const outside = path.join(root, 'outside.md');
  await fs.writeFile(outside, '不可讀取');
  await fs.symlink(outside, path.join(root, 'source', '_posts', 'linked.md'));
  await assert.rejects(store.read('posts/linked.md'), { status: 400 });
  await assert.rejects(store.save('posts/linked.md', '不可寫入', versionOf('不可讀取')), { status: 400 });
  assert.equal((await store.list()).some((item) => item.name === 'linked.md'), false);
  assert.equal(await fs.readFile(outside, 'utf8'), '不可讀取');
  const another = await fixture();
  await fs.symlink(path.join(root, 'source'), path.join(another.root, 'linked-source'));
  await assert.rejects(another.store.checked(['linked-source', '_posts', '文章.md']), { status: 400 });
});

test('image uploads validate MIME and signatures and remain in the image subtree', async () => {
  const { root, store } = await fixture();
  const uploaded = await store.saveImage(png, 'image/png');
  assert.match(uploaded.path, /^\/images\/uploads\/[a-f0-9-]+\.png$/);
  assert.deepEqual(await fs.readFile(path.join(root, 'source', uploaded.path.slice(1))), png);
  assert.deepEqual((await store.image(uploaded.path.slice('/images/'.length))).bytes, png);
  await assert.rejects(store.saveImage(Buffer.from('<svg><script>bad()</script></svg>'), 'image/svg+xml'), { status: 400 });
  await assert.rejects(store.saveImage(Buffer.from('<svg></svg>'), 'image/png'), { status: 400 });
  await assert.rejects(store.saveImage(png, 'image/jpeg'), { status: 400 });
  await assert.rejects(store.saveImage(Buffer.alloc(12 * 1024 * 1024 + 1), 'image/png'), { status: 400 });
  await assert.rejects(store.image('../_posts/文章.md'), { status: 400 });
  await fs.symlink(path.join(root, 'source', '_posts', '文章.md'), path.join(root, 'source', 'images', 'linked.png'));
  await assert.rejects(store.image('linked.png'), { status: 400 });
});

test('preview removes both standard and legacy Hexo frontmatter without changing the saved input', () => {
  assert.deepEqual(previewParts(original), { title: '測試文章', titleEn: '測試文章', body: '\n原始文字\n' });
  assert.deepEqual(previewParts('title: 雜記\ntags:\n  - Vim\ndate: 2023-01-29 08:00:00\n---\n\n## 原文'), { title: '雜記', titleEn: '雜記', body: '\n## 原文' });
  assert.deepEqual(previewParts('## 普通 Markdown\n\n---\n正文'), { title: '', titleEn: '', body: '## 普通 Markdown\n\n---\n正文' });
  assert.deepEqual(previewParts('---\r\ntitle: "A & B"\r\ntitle_en: "Notes in English"\r\n---\r\nText'), { title: 'A & B', titleEn: 'Notes in English', body: 'Text' });
});

test('HTTP API requires the current token and rejects foreign origins and rebinding hosts', async (context) => {
  const { origin, request, json, token } = await withServer(context);
  const page = await fetch(origin);
  assert.equal(page.status, 200);
  const markup = await page.text();
  assert.match(markup, new RegExp(`content="${token}"`));
  assert.match(markup, /id="preview"[^>]*sandbox="allow-same-origin"/);
  assert.equal(markup.includes('allow-scripts'), false);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await fetch(origin + '/api/library')).status, 403);
  assert.equal((await request('/api/library', { headers: { 'X-Writer-Token': 'old-token' } })).status, 403);
  assert.equal((await request('/api/library', { headers: { Origin: 'https://foreign.example' } })).status, 403);
  const rebindingStatus = await new Promise((resolve, reject) => {
    http.get(origin + '/api/library', { headers: { Host: 'foreign.example', 'X-Writer-Token': token } }, (response) => { response.resume(); resolve(response.statusCode); }).on('error', reject);
  });
  assert.equal(rebindingStatus, 403);
  assert.equal((await request('/api/library', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await json('/api/drafts', 'POST', { title: '安全草稿' })).status, 201);
  assert.equal((await request('/api/document?id=' + encodeURIComponent('posts/../../outside.md'))).status, 400);
});

test('concurrent HTTP saves detect stale versions and never silently overwrite', async (context) => {
  const { request, json, store } = await withServer(context);
  const before = await (await request('/api/document?id=' + encodeURIComponent('posts/文章.md'))).json();
  const responses = await Promise.all([
    json('/api/document', 'PUT', { id: before.id, content: '版本 A', version: before.version }),
    json('/api/document', 'PUT', { id: before.id, content: '版本 B', version: before.version }),
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  const after = await store.read(before.id);
  assert.ok(['版本 A', '版本 B'].includes(after.content));
});

test('preview uses the production renderer contract and images load in a script-disabled sandbox', async (context) => {
  const { request, json, origin } = await withServer(context);
  const preview = await (await json('/api/preview', 'POST', { content: original })).json();
  assert.equal(preview.title, '測試文章');
  assert.equal(preview.html, '<p>\n原始文字\n</p>');
  const upload = await request('/api/images', { method: 'POST', body: png, headers: { 'Content-Type': 'image/png', Origin: origin } });
  assert.equal(upload.status, 201);
  const imagePath = (await upload.json()).path;
  const image = await request(imagePath, { headers: { Origin: 'null', 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.equal(image.headers.get('cross-origin-resource-policy'), 'cross-origin');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
  assert.equal((await json('/api/preview', 'POST', { content: 'a'.repeat(2 * 1024 * 1024 + 1) })).status, 413);
  assert.equal((await request('/preview-style.css')).status, 200);
});


test('About and Links are listed as pages and preserve exact preimages and stale-version protection', async () => {
  const { root, store, pages } = await pageFixture();
  const library = await store.list();
  assert.deepEqual(library.filter((item) => item.kind === 'pages'), pages.map(({ id, name }) => ({ id, name, kind: 'pages' })));
  assert.ok(library.some((item) => item.id === 'posts/文章.md'));
  for (const page of pages) {
    const before = await store.read(page.id);
    assert.equal(before.content, page.content);
    const next = `${before.content}\n![貼上的圖片](/images/uploads/example.png)\n`;
    const saved = await store.save(page.id, next, before.version);
    assert.equal(saved.content, next);
    assert.equal(await fs.readFile(path.join(root, 'source', page.folder, 'index.md'), 'utf8'), next);
    const directory = path.join(root, '.history', 'writer', 'pages', versionOf(page.id).slice(0, 16));
    const names = await fs.readdir(directory);
    assert.equal(names.filter((name) => name.endsWith('.md')).length, 1);
    assert.equal(await fs.readFile(path.join(directory, names.find((name) => name.endsWith('.md'))), 'utf8'), page.content);
    const receipt = JSON.parse(await fs.readFile(path.join(directory, names.find((name) => name.endsWith('.json'))), 'utf8'));
    assert.equal(receipt.id, page.id);
    assert.equal(receipt.version, before.version);
    await assert.rejects(store.save(page.id, '舊版本不應覆寫', before.version), { status: 409 });
    assert.equal((await store.read(page.id)).content, next);
    await store.save(page.id, next, saved.version);
    assert.equal((await fs.readdir(directory)).length, names.length);
    assert.equal((await fs.readdir(path.join(root, 'source', page.folder))).some((name) => name.startsWith('.writer-')), false);
  }
  assert.equal((await store.read('posts/文章.md')).content, original);
});

test('pages use a fixed allowlist and cannot expose configuration, other pages or symbolic links', async () => {
  const { root, store } = await pageFixture();
  await fs.mkdir(path.join(root, 'source', 'private'), { recursive: true });
  await fs.writeFile(path.join(root, 'source', 'private', 'index.md'), '其他頁面不開放');
  await fs.writeFile(path.join(root, 'source', 'about', 'old.md'), '舊版介紹不開放');
  for (const id of ['pages/private/index.md', 'pages/about.md', 'pages/links.md', 'pages/about/old.md', 'pages/about/index.md/extra.md', 'pages/about/../links/index.md', 'pages/about/%2e%2e/links/index.md', 'pages/_config.yml', 'pages/../_config.yml', 'source/about/index.md']) {
    await assert.rejects(store.read(id), { status: 400 });
    await assert.rejects(store.save(id, '不能寫入', versionOf('')), { status: 400 });
  }
  assert.equal((await store.list()).filter((item) => item.kind === 'pages').length, 2);
  const outsideFile = path.join(root, 'outside.md');
  await fs.writeFile(outsideFile, '不可讀寫的外部原文');
  await fs.rename(path.join(root, 'source', 'about', 'index.md'), path.join(root, 'source', 'about', 'preserved-original.md'));
  await fs.symlink(outsideFile, path.join(root, 'source', 'about', 'index.md'));
  await assert.rejects(store.read('pages/about/index.md'), { status: 400 });
  await assert.rejects(store.save('pages/about/index.md', '不能寫入', versionOf('不可讀寫的外部原文')), { status: 400 });
  const outsideDirectory = path.join(root, 'outside-directory');
  await fs.mkdir(outsideDirectory);
  await fs.writeFile(path.join(outsideDirectory, 'index.md'), '不可讀寫的外部頁面');
  await fs.rename(path.join(root, 'source', 'links'), path.join(root, 'source', 'preserved-links'));
  await fs.symlink(outsideDirectory, path.join(root, 'source', 'links'));
  await assert.rejects(store.read('pages/links/index.md'), { status: 400 });
  await assert.rejects(store.save('pages/links/index.md', '不能寫入', versionOf('不可讀寫的外部頁面')), { status: 400 });
  assert.equal((await store.list()).some((item) => item.kind === 'pages'), false);
  assert.equal((await store.read('posts/文章.md')).content, original);
  assert.equal(await fs.readFile(outsideFile, 'utf8'), '不可讀寫的外部原文');
  assert.equal(await fs.readFile(path.join(outsideDirectory, 'index.md'), 'utf8'), '不可讀寫的外部頁面');
  const missing = await fixture();
  assert.equal((await missing.store.list()).some((item) => item.kind === 'pages'), false);
  await assert.rejects(missing.store.read('pages/about/index.md'), { status: 404 });
  assert.equal((await fs.readdir(path.join(missing.root, 'source'))).includes('about'), false);
});

test('the existing HTTP document API edits both allowed pages and rejects concurrent stale saves', async (context) => {
  const { root, pages, request, json, store } = await withServer(context, pageFixture);
  const library = await (await request('/api/library')).json();
  assert.deepEqual(library.documents.filter((item) => item.kind === 'pages'), pages.map(({ id, name }) => ({ id, name, kind: 'pages' })));
  for (const page of pages) {
    const response = await request('/api/document?id=' + encodeURIComponent(page.id));
    assert.equal(response.status, 200);
    const before = await response.json();
    const candidates = [`${page.content}\n修訂 A\n`, `${page.content}\n修訂 B\n`];
    const saves = await Promise.all(candidates.map((content) => json('/api/document', 'PUT', { id: page.id, content, version: before.version })));
    assert.deepEqual(saves.map((save) => save.status).sort(), [200, 409]);
    assert.ok(candidates.includes((await store.read(page.id)).content));
  }
  for (const id of ['pages/private/index.md', 'pages/about/other.md', 'pages/_config.yml']) {
    assert.equal((await request('/api/document?id=' + encodeURIComponent(id))).status, 400);
    assert.equal((await json('/api/document', 'PUT', { id, content: '拒絕', version: versionOf('') })).status, 400);
  }
  const post = await (await request('/api/document?id=' + encodeURIComponent('posts/文章.md'))).json();
  assert.equal((await json('/api/document', 'PUT', { id: post.id, content: original + '\n文章仍可儲存\n', version: post.version })).status, 200);
  const draft = await json('/api/drafts', 'POST', { title: '頁面之外的草稿' });
  assert.equal(draft.status, 201);
  assert.equal((await draft.json()).id, 'drafts/頁面之外的草稿.md');
  assert.deepEqual((await fs.readdir(path.join(root, 'source'))).sort(), ['_drafts', '_posts', 'about', 'links']);
});


test('page previews resolve their real relative image files and retain absolute uploads and external images', async (context) => {
  const { pages, store, json, origin } = await withServer(context, pageImageFixture, renderPublishedMarkdown);
  const uploaded = await store.saveImage(png, 'image/png');
  const dataImage = 'data:image/png;base64,' + png.toString('base64');
  const content = `---\ntitle: 圖片預覽\n---\n\n![相對圖片](images/原圖.png?width=24#detail)\n\n![編碼圖片](./images/%E5%8E%9F%E5%9C%96.png)\n\n[圖片連結](images/原圖.png?download=1#picture)\n\n[文件連結](images/guide.html)\n\n![貼上圖片](${uploaded.path})\n\n![外部圖片](https://example.com/photo.png)\n\n<img src="${dataImage}" alt="內嵌圖片">\n`;
  for (const page of pages) {
    const response = await json('/api/preview', 'POST', {id: page.id, content});
    assert.equal(response.status, 200);
    const preview = await response.json();
    const $ = load(preview.html);
    assert.equal($('img[alt="相對圖片"]').attr('src'), `/${page.folder}/images/%E5%8E%9F%E5%9C%96.png?width=24#detail`);
    assert.equal($('img[alt="編碼圖片"]').attr('src'), `/${page.folder}/images/%E5%8E%9F%E5%9C%96.png`);
    assert.equal($('a').filter((_, el) => $(el).text() === '圖片連結').attr('href'), `/${page.folder}/images/%E5%8E%9F%E5%9C%96.png?download=1#picture`);
    assert.equal($('a').filter((_, el) => $(el).text() === '文件連結').attr('href'), 'images/guide.html');
    assert.equal($('img[alt="貼上圖片"]').attr('src'), uploaded.path);
    assert.equal($('img[alt="外部圖片"]').attr('src'), 'https://example.com/photo.png');
    assert.equal($('img[alt="內嵌圖片"]').attr('src'), dataImage);
    for (const relative of [`/${page.folder}/images/${encodeURIComponent('原圖.png')}?width=24`, `/${page.folder}/images/%E5%8E%9F%E5%9C%96.png`, uploaded.path]) {
      const image = await fetch(origin + relative, {headers: {Origin: 'null', 'Sec-Fetch-Site': 'cross-site'}});
      assert.equal(image.status, 200);
      assert.equal(image.headers.get('content-type'), 'image/png');
      assert.equal(image.headers.get('cross-origin-resource-policy'), 'cross-origin');
      assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
      assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
    }
    assert.equal((await store.read(page.id)).content, page.content, 'preview never rewrites the authored Markdown');
  }
  const draft = await store.createDraft('圖片草稿');
  for (const id of [undefined, 'posts/文章.md', draft.id]) {
    const preview = await (await json('/api/preview', 'POST', {id, content})).json();
    assert.equal(load(preview.html)('img[alt="相對圖片"]').attr('src'), 'images/%E5%8E%9F%E5%9C%96.png?width=24#detail');
    assert.equal(load(preview.html)('img[alt="貼上圖片"]').attr('src'), uploaded.path);
  }
});

test('preview document context rejects malformed or unapproved page IDs before rendering', async (context) => {
  let renders = 0;
  const {json} = await withServer(context, pageFixture, (body) => { renders++; return body; });
  for (const id of ['pages/private/index.md', 'pages/about/other.md', 'pages/about/../links/index.md', 'source/about/index.md', '../source/_drafts/private.md', null, {}, 'pages/about/index.md\0']) {
    assert.equal((await json('/api/preview', 'POST', {id, content: '不可解析其他路徑'})).status, 400);
  }
  assert.equal(renders, 0);
  assert.equal((await json('/api/preview', 'POST', {id: 'pages/about/index.md', content: '可以預覽'})).status, 200);
  assert.equal(renders, 1);
});

test('page image routes reject traversal, non-image files, symlinks and oversized files', async (context) => {
  const {root, request, store} = await withServer(context, pageImageFixture);
  for (const route of ['/about/images/%2e%2e%2findex.md', '/about/images/%2e%2e%5cindex.md', '/links/images/%00.png', '/about/images/%2foutside.png', '/links/images/%ZZ.png']) {
    assert.equal((await request(route)).status, 400, route);
  }
  assert.equal((await request('/private/images/原圖.png')).status, 404);
  assert.equal((await request('/about/images/missing.png')).status, 404);
  for (const name of ['private.md', 'unsafe.svg', 'document.html']) {
    await fs.writeFile(path.join(root, 'source', 'about', 'images', name), '<script>private()</script>');
    assert.equal((await request('/about/images/' + name)).status, 404);
  }
  const outside = path.join(root, 'outside.png');
  await fs.writeFile(outside, png);
  await fs.symlink(outside, path.join(root, 'source', 'about', 'images', 'linked.png'));
  assert.equal((await request('/about/images/linked.png')).status, 400);
  await fs.rename(path.join(root, 'source', 'links', 'images'), path.join(root, 'source', 'links', 'preserved-images'));
  await fs.symlink(path.join(root, 'source', 'about', 'images'), path.join(root, 'source', 'links', 'images'));
  assert.equal((await request('/links/images/原圖.png')).status, 400);
  await fs.writeFile(path.join(root, 'source', 'about', 'images', 'large.png'), Buffer.alloc(20 * 1024 * 1024 + 1));
  assert.equal((await request('/about/images/large.png')).status, 413);
  await assert.rejects(store.image('原圖.png', {page: 'private'}), {status: 400});
  assert.deepEqual(await fs.readFile(outside), png);
});
