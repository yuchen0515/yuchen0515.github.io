import { POST_PATHS } from './posts.mjs';

const MINUTE = 60;
const BODY_LIMIT = 2048;
const VISITOR_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_ORIGINS = ['https://yuchen0515.github.io', 'http://localhost:4000', 'http://127.0.0.1:4000'];

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

function origins(env) {
  return new Set((env.ALLOWED_ORIGINS || DEFAULT_ORIGINS.join(',')).split(',').map(v => v.trim()).filter(Boolean));
}

function headers(origin, extra = {}) {
  const value = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Vary': 'Origin, X-Visitor-Id',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  };
  if (origin) {
    value['Access-Control-Allow-Origin'] = origin;
    value['Access-Control-Expose-Headers'] = 'Retry-After';
  }
  return value;
}

function json(body, status, origin, extra) {
  return new Response(JSON.stringify(body), { status, headers: headers(origin, extra) });
}

export function canonicalPath(value, env = {}) {
  if (typeof value !== 'string' || value.length > 1024 || !value.startsWith('/') || value.startsWith('//') || /%2f|%5c/i.test(value)) {
    throw new HttpError(400, 'invalid_path', '文章網址格式不正確。');
  }
  let decoded;
  try { decoded = decodeURIComponent(value).normalize('NFC'); }
  catch { throw new HttpError(400, 'invalid_path', '文章網址格式不正確。'); }
  // Do not let URL normalization silently accept query strings, encoded slashes,
  // dot segments, double decoding, control characters or noncanonical aliases.
  if (/[\\?#%\u0000-\u001f\u007f]/.test(decoded) || decoded.includes('//') || /(^|\/)\.{1,2}(\/|$)/.test(decoded)) {
    throw new HttpError(400, 'invalid_path', '文章網址格式不正確。');
  }
  const path = decoded.endsWith('/') ? decoded : `${decoded}/`;
  const configured = env.ALLOWED_PATHS ? JSON.parse(env.ALLOWED_PATHS) : POST_PATHS;
  if (!Array.isArray(configured) || !configured.every(v => typeof v === 'string')) throw new Error('Invalid allowlist');
  if (!configured.includes(path)) throw new HttpError(404, 'unknown_article', '找不到這篇文章。');
  return path;
}

function visitorId(request, required) {
  const value = request.headers.get('X-Visitor-Id');
  if (!value && !required) return null;
  if (!value || !VISITOR_PATTERN.test(value)) throw new HttpError(400, 'invalid_visitor', '無法辨識這次瀏覽，請重新整理再試。');
  return value.toLowerCase();
}

async function hasher(env) {
  if (!env.DB || typeof env.VISITOR_HMAC_SECRET !== 'string' || env.VISITOR_HMAC_SECRET.length < 32) {
    throw new Error('Missing server configuration');
  }
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.VISITOR_HMAC_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return async value => {
    const hash = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
    return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
  };
}

async function readBody(request) {
  if ((request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new HttpError(415, 'invalid_content_type', '請以 JSON 傳送按讚狀態。');
  }
  if (Number(request.headers.get('Content-Length')) > BODY_LIMIT) throw new HttpError(413, 'body_too_large', '傳送的內容太長。');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'invalid_body', '缺少按讚狀態。');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > BODY_LIMIT) { await reader.cancel(); throw new HttpError(413, 'body_too_large', '傳送的內容太長。'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try {
    const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!body || Array.isArray(body) || typeof body !== 'object' || typeof body.liked !== 'boolean') throw new Error('Invalid shape');
    return body;
  } catch { throw new HttpError(400, 'invalid_body', '按讚狀態格式不正確。'); }
}

function summary(db, path, visitorHash) {
  return db.prepare(`SELECT COUNT(*) AS count,
    CASE WHEN ? IS NULL THEN NULL ELSE EXISTS(
      SELECT 1 FROM likes WHERE page_path = ? AND visitor_hash = ?
    ) END AS liked FROM likes WHERE page_path = ?`).bind(visitorHash, path, visitorHash, path);
}

function result(path, row) {
  return { path, count: Number(row.count), liked: row.liked === null ? null : Boolean(row.liked) };
}

function positiveLimit(value, fallback) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > 10000) throw new Error('Invalid rate limit');
  return number;
}

async function setVote(request, env, origin) {
  const id = visitorId(request, true);
  const body = await readBody(request);
  const path = canonicalPath(body.path, env);
  const hash = await hasher(env);
  const visitorHash = await hash(`visitor:v1:${id}`);
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - now % MINUTE;
  // CF-Connecting-IP is supplied by Cloudflare, never X-Forwarded-For.
  // Local IP fallback is explicit and is disallowed on non-local worker hosts.
  let ip = request.headers.get('CF-Connecting-IP');
  if (!ip && env.ALLOW_LOCAL_IP_FALLBACK === 'true' && ['localhost', '127.0.0.1'].includes(new URL(request.url).hostname)) ip = 'local-development';
  if (!ip) throw new HttpError(503, 'unavailable', '按讚服務暫時無法使用，請稍後再試。');
  const [visitorRateKey, ipRateKey] = await Promise.all([
    hash(`rate:visitor:${path}:${visitorHash}`),
    hash(`rate:ip:${Math.floor(now / 86400)}:${path}:${ip}`),
  ]);
  const visitorLimit = positiveLimit(env.VISITOR_RATE_LIMIT, 12);
  const ipLimit = positiveLimit(env.IP_RATE_LIMIT, 120);
  const throttle = key => env.DB.prepare(`INSERT INTO rate_limits(key_hash, window_start, hits) VALUES (?, ?, 1)
    ON CONFLICT(key_hash, window_start) DO UPDATE SET hits = MIN(hits + 1, 10001) RETURNING hits`).bind(key, windowStart);
  const allowed = `(SELECT hits FROM rate_limits WHERE key_hash = ? AND window_start = ?) <= ?
    AND (SELECT hits FROM rate_limits WHERE key_hash = ? AND window_start = ?) <= ?`;
  const guard = [visitorRateKey, windowStart, visitorLimit, ipRateKey, windowStart, ipLimit];
  const change = body.liked
    ? env.DB.prepare(`INSERT OR IGNORE INTO likes(page_path, visitor_hash, created_at) SELECT ?, ?, ? WHERE ${allowed}`).bind(path, visitorHash, now, ...guard)
    : env.DB.prepare(`DELETE FROM likes WHERE page_path = ? AND visitor_hash = ? AND ${allowed}`).bind(path, visitorHash, ...guard);
  // D1 batch is a transaction: both throttles, the idempotent vote and the
  // returned count/state run together. Any failed statement rolls back all.
  const rows = await env.DB.batch([throttle(visitorRateKey), throttle(ipRateKey), change, summary(env.DB, path, visitorHash)]);
  if (rows[0].results[0].hits > visitorLimit || rows[1].results[0].hits > ipLimit) {
    return json({ error: 'rate_limited', message: '操作有點頻繁，請稍等一下再試。' }, 429, origin,
      { 'Retry-After': String(MINUTE - now % MINUTE) });
  }
  return json(result(path, rows[3].results[0]), 200, origin);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const allowed = origins(env);
    const corsOrigin = origin && allowed.has(origin) ? origin : null;
    try {
      const url = new URL(request.url);
      if (url.pathname !== '/likes') return json({ error: 'not_found', message: '找不到這個服務。' }, 404, corsOrigin);
      if (origin && !corsOrigin) throw new HttpError(403, 'forbidden_origin', '這個網站無法使用按讚服務。');
      if (request.method === 'OPTIONS') {
        if (!corsOrigin) throw new HttpError(403, 'forbidden_origin', '缺少網站來源。');
        const method = request.headers.get('Access-Control-Request-Method');
        const requested = (request.headers.get('Access-Control-Request-Headers') || '').split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
        if (!['GET', 'POST'].includes(method) || requested.some(v => !['content-type', 'x-visitor-id'].includes(v))) {
          throw new HttpError(403, 'invalid_preflight', '不支援這個請求。');
        }
        return new Response(null, { status: 204, headers: headers(corsOrigin, {
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-Visitor-Id',
          'Access-Control-Max-Age': '600',
        }) });
      }
      if (request.method === 'GET') {
        if (url.searchParams.getAll('path').length !== 1) throw new HttpError(400, 'invalid_path', '缺少文章網址。');
        const path = canonicalPath(url.searchParams.get('path'), env);
        const id = visitorId(request, false);
        let visitorHash = null;
        if (id) visitorHash = await (await hasher(env))(`visitor:v1:${id}`);
        if (!env.DB) throw new Error('Missing database');
        const row = await summary(env.DB, path, visitorHash).first();
        return json(result(path, row), 200, corsOrigin);
      }
      if (request.method === 'POST') {
        if (!corsOrigin) throw new HttpError(403, 'forbidden_origin', '缺少網站來源。');
        return await setVote(request, env, corsOrigin);
      }
      return json({ error: 'method_not_allowed', message: '不支援這個請求。' }, 405, corsOrigin,
        { 'Allow': 'GET, POST, OPTIONS' });
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.code, message: error.message }, error.status, corsOrigin);
      // Do not return database errors, SQL, headers, IPs, IDs or secret values.
      return json({ error: 'unavailable', message: '按讚服務暫時無法使用，請稍後再試。' }, 503, corsOrigin);
    }
  },
  async scheduled(_event, env) {
    // Task-specific runtime retention: expiring throttle rows carries no votes.
    await env.DB.prepare('DELETE FROM rate_limits WHERE window_start < ?')
      .bind(Math.floor(Date.now() / 1000) - 86400).run();
  },
};
