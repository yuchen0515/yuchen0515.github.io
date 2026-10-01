const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { create, MAX_BYTES } = require('../tools/writer/recovery.js');

class MemoryStorage {
  constructor() { this.values = new Map(); this.failWrites = false; }
  get length() { return this.values.size; }
  getItem(key) { return this.values.get(String(key)) ?? null; }
  key(index) { return [...this.values.keys()][index] ?? null; }
  setItem(key, value) {
    if (this.failWrites) throw new Error('QuotaExceededError');
    this.values.set(String(key), String(value));
  }
}

const project = 'website-project-hash';
const version = 'a'.repeat(64);
const document = { id: 'drafts/中文筆記.md', content: '未儲存原文', baseVersion: version };
const open = (storage, writerId = 'first-tab') => create({ storage, project, writerId });

test('Recovery retains exact Markdown, cursor and base version across a writer restart', () => {
  const storage = new MemoryStorage();
  const content = '---\r\ntitle: "還原測試"\r\n---\r\n\r\n## 雙語\r\n\r\n$x_i^2$\n![截圖](/images/uploads/原始圖片.png)\n\n作者表情：🌱\n';
  const result = open(storage).save({ ...document, content, selectionStart: 7, selectionEnd: 15, scrollTop: 234.5, updatedAt: 12345 });
  assert.equal(result.ok, true);
  const records = open(storage, 'restarted-tab').list(document.id).records;
  assert.equal(records.length, 1);
  assert.deepEqual(records[0], result.record);
  assert.equal(records[0].content, content);
  assert.equal(records[0].baseVersion, version);
});

test('Separate tabs and projects preserve their own recovery copies and newest-first order', () => {
  const storage = new MemoryStorage();
  open(storage).save({ ...document, content: '第一個頁籤', updatedAt: 10 });
  open(storage, 'second-tab').save({ ...document, content: '第二個頁籤', updatedAt: 20 });
  create({ storage, project: 'other-project', writerId: 'first-tab' }).save({ ...document, content: '另一個網站', updatedAt: 30 });
  open(storage).save({ ...document, content: '第一個頁籤繼續編輯', updatedAt: 40 });
  assert.deepEqual(open(storage, 'restarted-tab').list().records.map(({ content }) => content), ['第一個頁籤繼續編輯', '第二個頁籤']);
  assert.equal(storage.length, 3);
});

test('A completed save acknowledges only its own exact content and retains later edits', () => {
  const storage = new MemoryStorage();
  const first = open(storage);
  const second = open(storage, 'second-tab');
  first.save(document);
  second.save(document);
  first.save({ ...document, content: `${document.content}\n儲存途中繼續輸入` });
  assert.equal(first.acknowledge(document.id, document.content).acknowledged, false);
  assert.equal(first.list(document.id).records.length, 2);
  const acknowledged = first.acknowledge(document.id, `${document.content}\n儲存途中繼續輸入`);
  assert.equal(acknowledged.acknowledged, true);
  assert.equal(first.list(document.id).records.length, 1);
  assert.equal(first.list(document.id).records[0].writerId, 'second-tab');
  const retained = JSON.parse(storage.getItem(acknowledged.record.key));
  assert.equal(retained.status, 'saved');
  assert.equal(retained.content, `${document.content}\n儲存途中繼續輸入`);
});

test('Dismissing a recovery copy hides it while retaining the entire Markdown payload', () => {
  const storage = new MemoryStorage();
  const saved = open(storage).save(document);
  const restarted = open(storage, 'restarted-tab');
  assert.equal(restarted.dismiss(saved.record.key).ok, true);
  assert.deepEqual(restarted.list(document.id).records, []);
  assert.equal(storage.length, 1);
  assert.equal(JSON.parse(storage.getItem(saved.record.key)).content, document.content);
  assert.equal(JSON.parse(storage.getItem(saved.record.key)).status, 'dismissed');
  assert.equal(restarted.dismiss(`owen.writer.recovery.v1:other-project:first-tab:${encodeURIComponent(document.id)}`).ok, false);
});

test('A stale recovery choice cannot dismiss another tab\'s newer unsaved content', () => {
  const storage = new MemoryStorage();
  const first = open(storage);
  const second = open(storage, 'second-tab');
  second.save({ ...document, updatedAt: 10 });
  const snapshot = first.list(document.id).records[0];
  const newer = `${document.content}\n另一頁籤繼續輸入的新內容`;
  second.save({ ...document, content: newer, updatedAt: 20 });
  first.save({ ...document, content: snapshot.content, updatedAt: 30 });
  const before = storage.getItem(snapshot.key);
  const mismatched = first.dismiss(snapshot.key, snapshot.content);
  assert.equal(mismatched.ok, true);
  assert.equal(mismatched.dismissed, false);
  assert.equal(mismatched.record.content, newer);
  assert.equal(mismatched.record.status, 'pending');
  assert.equal(storage.getItem(snapshot.key), before);
  assert.ok(first.list(document.id).records.some((record) => record.content === newer && record.writerId === 'second-tab'));
  const dismissed = first.dismiss(snapshot.key, newer);
  assert.equal(dismissed.ok, true);
  assert.equal(dismissed.dismissed, true);
  assert.equal(JSON.parse(storage.getItem(snapshot.key)).content, newer);
  assert.equal(JSON.parse(storage.getItem(snapshot.key)).status, 'dismissed');
});

test('Malformed recovery records remain untouched and cannot impersonate another document or tab', () => {
  const storage = new MemoryStorage();
  const recovery = open(storage);
  const saved = recovery.save(document);
  const malformedKey = 'owen.writer.recovery.v1:website-project-hash:broken:not-json';
  storage.setItem(malformedKey, '{broken');
  const foreignKey = saved.record.key.replace('first-tab:', 'impersonated-tab:');
  storage.setItem(foreignKey, storage.getItem(saved.record.key));
  const invalidKey = 'owen.writer.recovery.v1:website-project-hash:invalid-tab:draft';
  storage.setItem(invalidKey, JSON.stringify({ ...saved.record, writerId: 'invalid-tab', selectionEnd: -1 }));
  assert.deepEqual(recovery.list().records, [saved.record]);
  assert.equal(storage.getItem(malformedKey), '{broken');
  assert.equal(storage.length, 4);
});

test('Unavailable storage and full quota preserve the last successful recovery copy without throwing', () => {
  assert.equal(open(null).save(document).ok, false);
  assert.deepEqual(open(null).list().records, []);
  const blocked = { get length() { throw new Error('SecurityError'); }, getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('SecurityError'); }, key() { throw new Error('SecurityError'); } };
  assert.equal(open(blocked).list().ok, false);
  assert.equal(open(blocked).save(document).ok, false);
  assert.equal(open(blocked).acknowledge(document.id, document.content).ok, false);
  const storage = new MemoryStorage();
  const recovery = open(storage);
  const saved = recovery.save(document);
  const original = storage.getItem(saved.record.key);
  storage.failWrites = true;
  assert.equal(recovery.save({ ...document, content: '繼續輸入而配額已滿' }).ok, false);
  assert.equal(recovery.dismiss(saved.record.key).ok, false);
  assert.equal(storage.getItem(saved.record.key), original);
  assert.equal(recovery.list().records[0].content, document.content);
});

test('Recovery limits use UTF-8 bytes and reject traversal, unknown pages and invalid metadata', () => {
  const storage = new MemoryStorage();
  const recovery = open(storage);
  const boundary = '中'.repeat(Math.floor(MAX_BYTES / 3)) + 'a'.repeat(MAX_BYTES % 3);
  assert.equal(Buffer.byteLength(boundary), MAX_BYTES);
  assert.equal(recovery.save({ ...document, content: boundary }).ok, true);
  assert.equal(recovery.save({ ...document, content: `${boundary}a` }).ok, false);
  for (const id of ['drafts/../private.md', '/posts/example.md', 'posts/.hidden.md', 'posts/a\\b.md', 'posts/a\u0000.md', 'pages/other/index.md', 'pages/about', 'posts/example.txt', 'posts//example.md']) {
    assert.equal(recovery.save({ ...document, id }).ok, false, id);
    assert.equal(recovery.list(id).ok, false, id);
  }
  for (const id of ['pages/about/index.md', 'pages/links/index.md', 'posts/nested/文章.md']) assert.equal(recovery.save({ ...document, id }).ok, true, id);
  for (const metadata of [{ updatedAt: Infinity }, { updatedAt: -1 }, { selectionStart: -1 }, { selectionEnd: 999 }, { scrollTop: NaN }, { baseVersion: '' }]) assert.equal(recovery.save({ ...document, ...metadata }).ok, false);
  assert.equal(create({ storage, project: '../other', writerId: 'tab' }).save(document).ok, false);
});

test('The same recovery module runs as a classic browser script without Node globals', () => {
  const sandbox = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../tools/writer/recovery.js'), 'utf8'), sandbox);
  assert.equal(typeof sandbox.WriterRecovery.create, 'function');
  const storage = new MemoryStorage();
  const recovery = sandbox.WriterRecovery.create({ storage, project, writerId: 'browser-tab' });
  assert.equal(recovery.save(document).ok, true);
  assert.equal(recovery.list().records[0].content, document.content);
});
