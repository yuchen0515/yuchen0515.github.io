import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import worker, { canonicalPath } from '../src/worker.mjs';
import { POST_PATHS } from '../src/posts.mjs';

// Execute the real migration and every real SQL statement against SQLite,
// exposing D1's prepared-statement/batch surface without a Cloudflare account.
class SqliteD1 {
  constructor() {
    this.sql = new DatabaseSync(':memory:');
    this.sql.exec(readFileSync(new URL('../migrations/0001_likes.sql', import.meta.url), 'utf8'));
  }
  prepare(query) {
    const db = this;
    return {
      query, values: [],
      bind(...values) { return { ...this, values }; },
      async first() { return db.sql.prepare(this.query).get(...this.values) ?? null; },
      async run() { return db.execute(this); },
    };
  }
  execute(statement) {
    const stmt = this.sql.prepare(statement.query);
    if (stmt.columns().length) return { success: true, results: stmt.all(...statement.values) };
    return { success: true, results: [], meta: stmt.run(...statement.values) };
  }
  async batch(statements) {
    this.sql.exec('BEGIN IMMEDIATE');
    try {
      const result = statements.map(s => this.execute(s));
      this.sql.exec('COMMIT');
      return result;
    } catch (error) {
      this.sql.exec('ROLLBACK');
      throw error;
    }
  }
}

const origin = 'https://yuchen0515.github.io';
const path = POST_PATHS[0];
const fixture = (options = {}) => ({
  DB: new SqliteD1(), VISITOR_HMAC_SECRET: 'unit-test-only-secret-never-used-for-a-deployment', ...options,
});
function request(method = 'GET', { id, liked, article = path, from = origin, body, ip = '192.0.2.1', extraHeaders = {} } = {}) {
  const headers = new Headers(extraHeaders);
  if (from !== null) headers.set('Origin', from);
  if (id) headers.set('X-Visitor-Id', id);
  if (ip) headers.set('CF-Connecting-IP', ip);
  if (method === 'POST') headers.set('Content-Type', 'application/json');
  return new Request(`https://likes.example.test/likes${method === 'GET' ? `?path=${encodeURIComponent(article)}` : ''}`,
    { method, headers, ...(method === 'POST' ? { body: body ?? JSON.stringify({ path: article, liked }) } : {}) });
}
async function call(env, method, options) {
  const response = await worker.fetch(request(method, options), env);
  return { response, body: await response.json() };
}

test('real shared counts, personal state, idempotent like/unlike, and independent browsers', async () => {
  const env = fixture();
  const first = randomUUID();
  const second = randomUUID();
  assert.deepEqual((await call(env, 'GET')).body, { path, count: 0, liked: null });
  assert.deepEqual((await call(env, 'POST', { id: first, liked: true })).body, { path, count: 1, liked: true });
  assert.deepEqual((await call(env, 'POST', { id: first, liked: true })).body, { path, count: 1, liked: true });
  assert.equal((await call(env, 'GET', { id: second })).body.liked, false);
  assert.deepEqual((await call(env, 'POST', { id: second, liked: true })).body, { path, count: 2, liked: true });
  assert.deepEqual((await call(env, 'POST', { id: first, liked: false })).body, { path, count: 1, liked: false });
  assert.deepEqual((await call(env, 'POST', { id: first, liked: false })).body, { path, count: 1, liked: false });
  assert.deepEqual((await call(env, 'GET', { id: second })).body, { path, count: 1, liked: true });
  assert.equal((await call(env, 'GET', { id: second, article: POST_PATHS[1] })).body.count, 0);
});

test('concurrent same-browser retries create one row; independent browsers each count', async () => {
  const env = fixture({ VISITOR_RATE_LIMIT: '100', IP_RATE_LIMIT: '100' });
  const same = randomUUID();
  const repeated = await Promise.all(Array.from({ length: 20 }, () => call(env, 'POST', { id: same, liked: true })));
  assert.ok(repeated.every(v => v.response.status === 200));
  assert.equal((await call(env, 'GET')).body.count, 1);
  const responses = await Promise.all(Array.from({ length: 20 }, () => call(env, 'POST', { id: randomUUID(), liked: true })));
  assert.ok(responses.every(v => v.response.status === 200));
  assert.equal((await call(env, 'GET')).body.count, 21);
});

test('failed transaction rolls back throttle and vote together, without leaking SQL or secret', async () => {
  const env = fixture();
  env.DB.sql.exec(`CREATE TRIGGER fail_like BEFORE INSERT ON likes BEGIN SELECT RAISE(ABORT, 'sensitive SQL detail'); END;`);
  const { response, body } = await call(env, 'POST', { id: randomUUID(), liked: true });
  assert.equal(response.status, 503);
  assert.equal(body.error, 'unavailable');
  assert.equal(JSON.stringify(body).includes('sensitive'), false);
  assert.equal(JSON.stringify(body).includes(env.VISITOR_HMAC_SECRET), false);
  assert.equal(env.DB.sql.prepare('SELECT COUNT(*) AS count FROM rate_limits').get().count, 0);
  assert.equal((await call(env, 'GET')).body.count, 0);
});

test('visitor throttle is atomic and does not block another reader behind the same IP', async () => {
  const env = fixture({ VISITOR_RATE_LIMIT: '2' });
  const id = randomUUID();
  await call(env, 'POST', { id, liked: true });
  await call(env, 'POST', { id, liked: true });
  const denied = await call(env, 'POST', { id, liked: false });
  assert.equal(denied.response.status, 429);
  assert.ok(Number(denied.response.headers.get('Retry-After')) > 0);
  assert.equal(denied.response.headers.get('Access-Control-Expose-Headers'), 'Retry-After');
  assert.equal((await call(env, 'GET', { id })).body.liked, true);
  assert.equal((await call(env, 'POST', { id: randomUUID(), liked: true })).response.status, 200);
  assert.equal((await call(env, 'GET')).body.count, 2);
});

test('hashed IP throttle limits ID rotation per article, while other IPs/articles keep working', async () => {
  const env = fixture({ IP_RATE_LIMIT: '2' });
  await call(env, 'POST', { id: randomUUID(), liked: true });
  await call(env, 'POST', { id: randomUUID(), liked: true });
  const denied = await call(env, 'POST', { id: randomUUID(), liked: true });
  assert.equal(denied.response.status, 429);
  assert.equal((await call(env, 'GET')).body.count, 2);
  assert.equal((await call(env, 'POST', { id: randomUUID(), liked: true, ip: '192.0.2.2' })).response.status, 200);
  assert.equal((await call(env, 'POST', { id: randomUUID(), liked: true, article: POST_PATHS[1] })).response.status, 200);
});

test('only HMAC digests reach storage; expiry removes rate rows without losing likes', async () => {
  const env = fixture();
  const id = randomUUID();
  await call(env, 'POST', { id, liked: true });
  const vote = env.DB.sql.prepare('SELECT * FROM likes').get();
  assert.match(vote.visitor_hash, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(vote).includes(id));
  const rates = env.DB.sql.prepare('SELECT * FROM rate_limits').all();
  assert.ok(rates.every(row => /^[a-f0-9]{64}$/.test(row.key_hash)));
  assert.ok(!JSON.stringify(rates).includes('192.0.2.1'));
  env.DB.sql.prepare('INSERT INTO rate_limits VALUES (?, 1, 1)').run('a'.repeat(64));
  await worker.scheduled({}, env);
  assert.equal(env.DB.sql.prepare('SELECT COUNT(*) AS count FROM rate_limits').get().count, 2);
  assert.equal((await call(env, 'GET', { id })).body.liked, true);
});

test('CORS allows exact origins and headers, rejects wildcards/lookalikes/missing origin on writes', async () => {
  const env = fixture();
  const id = randomUUID();
  for (const from of ['https://yuchen0515.github.io.evil.test', 'https://evil.test', 'null', null]) {
    const { response } = await call(env, 'POST', { id, liked: true, from });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  }
  for (const from of [origin, 'http://localhost:4000', 'http://127.0.0.1:4000']) {
    const preflight = new Request('https://likes.example.test/likes', { method: 'OPTIONS', headers: {
      Origin: from, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Content-Type, X-Visitor-Id',
    } });
    const response = await worker.fetch(preflight, env);
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), from);
    assert.equal(response.headers.get('Access-Control-Allow-Credentials'), null);
  }
  const invalid = new Request('https://likes.example.test/likes', { method: 'OPTIONS', headers: {
    Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Authorization',
  } });
  assert.equal((await worker.fetch(invalid, env)).status, 403);
  assert.equal((await call(env, 'GET', { from: null })).response.status, 200);
});

test('canonical allowlist preserves Chinese permalinks and rejects arbitrary URLs/path manipulation', async () => {
  assert.equal(canonicalPath(encodeURI(path)), path);
  assert.equal(canonicalPath(path.slice(0, -1)), path);
  const env = fixture();
  for (const article of ['/unknown/', '//evil.test/x/', '/foo/../bar/', '/foo/%2e%2e/bar/', `${path}?x=1`, `${path}#x`, '/%ZZ/', '/%252e%252e/', '/foo\\bar/', path.replace(/\/$/, '%2f'), 'https://yuchen0515.github.io'+path]) {
    const { response } = await call(env, 'GET', { article });
    assert.ok([400, 404].includes(response.status), article);
  }
  assert.equal((await worker.fetch(new Request('https://likes.example.test/likes?path=a&path=b'), env)).status, 400);
  assert.equal((await worker.fetch(new Request('https://likes.example.test/likes'), env)).status, 400);
});

test('validation rejects missing/malformed identity, JSON, nonboolean state and oversized streamed bodies', async () => {
  const env = fixture();
  for (const options of [
    { liked: true }, { id: 'not-a-random-uuid', liked: true },
    { id: randomUUID(), body: '{}' }, { id: randomUUID(), body: '{invalid' },
    { id: randomUUID(), body: JSON.stringify({ path, liked: 'true' }) },
  ]) assert.equal((await call(env, 'POST', options)).response.status, 400);
  const huge = await call(env, 'POST', { id: randomUUID(), body: ' '.repeat(3000) });
  assert.equal(huge.response.status, 413);
  const wrongType = request('POST', { id: randomUUID(), liked: true });
  wrongType.headers.set('Content-Type', 'text/plain');
  assert.equal((await worker.fetch(wrongType, env)).status, 415);
  assert.equal((await call(fixture({ VISITOR_HMAC_SECRET: '' }), 'POST', { id: randomUUID(), liked: true })).response.status, 503);
  assert.equal((await call(env, 'POST', { id: randomUUID(), liked: true, ip: null })).response.status, 503);
});

test('unsupported endpoint/methods are explicit and successful responses cannot be cached', async () => {
  const env = fixture();
  assert.equal((await worker.fetch(new Request('https://likes.example.test/admin'), env)).status, 404);
  assert.equal((await worker.fetch(new Request('https://likes.example.test/likes', { method: 'DELETE' }), env)).status, 405);
  const { response } = await call(env, 'GET');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
});
