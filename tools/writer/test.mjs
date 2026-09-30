import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WriterError, WriterStore, previewParts, versionOf } from './storage.mjs';
import { createWriterServer } from './server.mjs';

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

async function withServer(context) {
  const fixtureData = await fixture();
  const service = await createWriterServer({ projectRoot: fixtureData.root, renderMarkdown: (body) => `<p>${body}</p>` });
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
