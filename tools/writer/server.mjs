import http from 'node:http';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { WriterError, WriterStore, previewParts } from './storage.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const staticFiles = new Map([
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/writer.css', ['writer.css', 'text/css; charset=utf-8']],
  ['/preview.css', ['preview.css', 'text/css; charset=utf-8']],
]);

const escapeHTML = (text) => String(text).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

async function body(request, limit) {
  if (Number(request.headers['content-length']) > limit) throw new WriterError(413, '內容太大，請縮小檔案後再試。');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new WriterError(413, '內容太大，請縮小檔案後再試。');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function jsonBody(request) {
  if (request.headers['content-type']?.split(';', 1)[0] !== 'application/json') throw new WriterError(415, '請使用 JSON 格式。');
  try {
    const input = JSON.parse((await body(request, 2 * 1024 * 1024 + 64 * 1024)).toString('utf8'));
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new WriterError(400, '內容格式不正確。');
    return input;
  }
  catch (error) { if (error instanceof WriterError) throw error; throw new WriterError(400, '內容格式不正確。'); }
}

export async function createWriterServer({ projectRoot = path.resolve(here, '../..'), renderMarkdown, token = randomBytes(32).toString('hex') } = {}) {
  const store = await new WriterStore(projectRoot).initialize();
  if (!renderMarkdown) {
    const renderer = await import(pathToFileURL(path.join(store.root, 'lib', 'markdown.cjs')));
    renderMarkdown = renderer.renderMarkdown ?? renderer.default?.renderMarkdown;
  }
  if (typeof renderMarkdown !== 'function') throw new Error('lib/markdown.cjs must export renderMarkdown.');
  let writes = Promise.resolve();
  const mutate = (action) => {
    const result = writes.then(action);
    writes = result.catch(() => {});
    return result;
  };
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    const send = (status, value, type = 'application/json; charset=utf-8') => {
      response.writeHead(status, { 'Content-Type': type });
      response.end(type.startsWith('application/json') ? JSON.stringify(value) : value);
    };
    try {
      const port = server.address()?.port;
      const origins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
      if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(request.headers.host)) throw new WriterError(403, '請從本機寫作工具網址開啟。');
      const url = new URL(request.url, origins[0]);
      const fontMatch = url.pathname.match(/^\/vendor\/fonts\/(KaTeX_[A-Za-z0-9_-]+\.woff2)$/);
      const publicAsset = staticFiles.has(url.pathname) || url.pathname === '/preview-style.css' || url.pathname === '/vendor/katex.min.css' || Boolean(fontMatch) || url.pathname === '/font/JetBrainsMono-Regular.woff2' || url.pathname.startsWith('/images/');
      if (!publicAsset && request.headers.origin && !origins.includes(request.headers.origin)) throw new WriterError(403, '這個請求不是來自寫作工具。');
      if (!publicAsset && request.headers['sec-fetch-site'] === 'cross-site') throw new WriterError(403, '這個請求不是來自寫作工具。');
      if (publicAsset) response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      if (url.pathname.startsWith('/api/')) {
        const supplied = Buffer.from(String(request.headers['x-writer-token'] ?? ''));
        const expected = Buffer.from(token);
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new WriterError(403, '寫作工具已重新啟動，請重新整理頁面。');
        if (url.pathname === '/api/library' && request.method === 'GET') return send(200, { documents: await store.list() });
        if (url.pathname === '/api/document' && request.method === 'GET') return send(200, await store.read(url.searchParams.get('id')));
        if (url.pathname === '/api/document' && request.method === 'PUT') {
          const input = await jsonBody(request);
          return send(200, await mutate(() => store.save(input.id, input.content, input.version)));
        }
        if (url.pathname === '/api/drafts' && request.method === 'POST') {
          const input = await jsonBody(request);
          return send(201, await mutate(() => store.createDraft(input.title)));
        }
        if (url.pathname === '/api/images' && request.method === 'POST') {
          const bytes = await body(request, 12 * 1024 * 1024);
          return send(201, await mutate(() => store.saveImage(bytes, request.headers['content-type'])));
        }
        if (url.pathname === '/api/preview' && request.method === 'POST') {
          const input = await jsonBody(request);
          if (typeof input.content !== 'string' || Buffer.byteLength(input.content) > 2 * 1024 * 1024) throw new WriterError(413, '文章太大，無法預覽。');
          const { title, titleEn, body: markdown } = previewParts(input.content);
          try { return send(200, { title, titleEn, html: await renderMarkdown(markdown) }); }
          catch (error) {
            if (/雙語標記|雙語區塊/.test(error.message)) throw new WriterError(422, error.message);
            throw error;
          }
        }
        throw new WriterError(404, '找不到這個操作。');
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') throw new WriterError(405, '這個操作不支援。');
      if (url.pathname === '/' || url.pathname === '/index.html') {
        const template = await fs.readFile(path.join(here, 'index.html'), 'utf8');
        return send(200, template.replace('__WRITER_TOKEN__', escapeHTML(token)), 'text/html; charset=utf-8');
      }
      if (staticFiles.has(url.pathname)) {
        const [file, mime] = staticFiles.get(url.pathname);
        return send(200, await fs.readFile(path.join(here, file)), mime);
      }
      if (url.pathname === '/preview-style.css') {
        let css;
        try { const file = await store.checked(['themes', 'owen', 'source', 'css', 'site.css']); css = await fs.readFile(file, 'utf8'); }
        catch (error) { if (!['ENOENT'].includes(error.code) && error.status !== 404) throw error; css = ''; }
        return send(200, css, 'text/css; charset=utf-8');
      }
      if (url.pathname === '/vendor/katex.min.css' || fontMatch || url.pathname === '/font/JetBrainsMono-Regular.woff2') {
        const parts = url.pathname === '/vendor/katex.min.css' ? ['themes', 'owen', 'source', 'vendor', 'katex.min.css']
          : fontMatch ? ['themes', 'owen', 'source', 'vendor', 'fonts', fontMatch[1]]
            : ['themes', 'owen', 'source', 'font', 'JetBrainsMono-Regular.woff2'];
        const file = await store.checked(parts);
        response.setHeader('Access-Control-Allow-Origin', '*');
        return send(200, await fs.readFile(file), url.pathname.endsWith('.css') ? 'text/css; charset=utf-8' : 'font/woff2');
      }
      if (url.pathname.startsWith('/images/')) {
        let relative;
        try { relative = decodeURIComponent(url.pathname.slice('/images/'.length)); }
        catch { throw new WriterError(400, '圖片路徑不正確。'); }
        const image = await store.image(relative);
        return send(200, image.bytes, image.mime);
      }
      throw new WriterError(404, '找不到這個頁面。');
    } catch (error) {
      if (!(error instanceof WriterError)) console.error('[writer]', error);
      if (!response.headersSent) send(error.status ?? 500, { error: error instanceof WriterError ? error.message : '操作未完成，請重試；原有文章仍保留在本機。' });
      else response.end();
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  return { server, store, token };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const port = Number(process.env.WRITER_PORT ?? 4174);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('WRITER_PORT must be a number between 1 and 65535.');
    const { server } = await createWriterServer();
    server.on('error', (error) => { console.error(error.code === 'EADDRINUSE' ? `連接埠 ${port} 已使用。請改用 WRITER_PORT=4175 npm run write。` : error.message); process.exitCode = 1; });
    server.listen(port, '127.0.0.1', () => console.log(`寫作工具：http://127.0.0.1:${port}/\n只儲存本機 Markdown 與圖片；儲存草稿不會發佈網站。按 Ctrl+C 結束。`));
  } catch (error) { console.error(`無法啟動寫作工具：${error.message}`); process.exitCode = 1; }
}
