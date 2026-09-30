import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { POST_PATHS } from '../src/posts.mjs';

const base = new URL(process.argv[2] || 'http://127.0.0.1:8788/likes');
if (!['localhost', '127.0.0.1'].includes(base.hostname)) throw new Error('This smoke test changes temporary local votes; it only runs against loopback.');
const path = POST_PATHS[0];
const first = randomUUID();
const second = randomUUID();
const origin = 'http://localhost:4000';

async function call(method = 'GET', id, liked) {
  const url = new URL(base);
  if (method === 'GET') url.searchParams.set('path', path);
  const headers = { Origin: origin, ...(id ? { 'X-Visitor-Id': id } : {}) };
  if (method === 'POST') headers['Content-Type'] = 'application/json';
  const response = await fetch(url, { method, headers, signal: AbortSignal.timeout(10000),
    ...(method === 'POST' ? { body: JSON.stringify({ path, liked }) } : {}) });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  return body;
}

const initial = await call();
try {
  assert.equal((await call('POST', first, true)).count, initial.count + 1);
  const retries = await Promise.all(Array.from({ length: 5 }, () => call('POST', first, true)));
  assert.ok(retries.every(v => v.count === initial.count + 1 && v.liked));
  assert.equal((await call('POST', second, true)).count, initial.count + 2);
  assert.equal((await call('GET', first)).liked, true);
  assert.equal((await call('GET', randomUUID())).liked, false);
  assert.equal((await call('POST', first, false)).count, initial.count + 1);
  assert.equal((await call('POST', first, false)).count, initial.count + 1);
  console.log('Real local Worker/D1 smoke passed: shared count, CORS, concurrency, personal state, idempotent unlike.');
} finally {
  await call('POST', first, false);
  await call('POST', second, false);
  assert.equal((await call()).count, initial.count);
}
