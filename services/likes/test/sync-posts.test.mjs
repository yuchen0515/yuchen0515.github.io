import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { postPath, renderPosts, syncPosts } from '../scripts/sync-posts.mjs';

test('generated allowlist decodes paths, sorts deterministically and preserves canonical old permalinks', () => {
  const records = [{ url: '/202305_%EF%BD%9E%E6%96%87%E7%AB%A0%EF%BD%9E' }, { url: 'https://yuchen0515.github.io/202207_article/index.html' }];
  const output = renderPosts(records);
  assert.equal(output, renderPosts(records.slice().reverse()));
  assert.ok(output.indexOf('/202207_article/') < output.indexOf('/202305_～文章～/'));
  assert.equal(postPath('/cafe\u0301/'), '/café/');
  assert.throws(() => renderPosts([{ url: '/same' }, { url: '/same/' }]), /duplicate/);
  assert.throws(() => renderPosts({ posts: [] }), /array/);
});

test('untrusted or ambiguous generated URLs fail before replacing the allowlist', () => {
  for (const value of [undefined, '/', '//evil.test/article/', 'https://evil.test/article/', '/a/../b/', '/a/%2e%2e/b/', '/x%2f', '/x%5c', '/x/%252e/', '/x/?query=1', '/x/#section', '/bad%ZZ/', 'https://yuchen0515.github.io/a/../b/']) {
    assert.throws(() => postPath(value), undefined, String(value));
  }
});

test('a changed allowlist is atomically replaced with a recoverable snapshot; unchanged builds write nothing', async () => {
  const stateRoot = fileURLToPath(new URL('../.wrangler/', import.meta.url));
  await mkdir(stateRoot, { recursive: true });
  const root = await mkdtemp(join(stateRoot, 'sync-test-'));
  const input = join(root, 'search.json');
  const output = join(root, 'posts.mjs');
  const history = join(root, '.history');
  const old = '// previous generated allowlist\n';
  await writeFile(output, old);
  await writeFile(input, JSON.stringify([{ url: '/202610_new-post/' }]));
  assert.deepEqual(await syncPosts({ input, output, history }), { changed: true, count: 1 });
  const archives = await readdir(history);
  assert.equal(archives.length, 1);
  assert.equal(await readFile(join(history, archives[0]), 'utf8'), old);
  assert.deepEqual(await syncPosts({ input, output, history }), { changed: false, count: 1 });
  assert.deepEqual(await readdir(history), archives);
  const current = await readFile(output, 'utf8');
  await writeFile(input, JSON.stringify([{ url: '/invalid/%2e%2e/' }]));
  await assert.rejects(syncPosts({ input, output, history }));
  assert.equal(await readFile(output, 'utf8'), current);
});
