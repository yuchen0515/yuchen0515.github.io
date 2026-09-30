import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const siteOrigin = 'https://yuchen0515.github.io';
const defaultInput = fileURLToPath(new URL('../../../public/search.json', import.meta.url));
const defaultOutput = fileURLToPath(new URL('../src/posts.mjs', import.meta.url));
const defaultHistory = fileURLToPath(new URL('../.history/', import.meta.url));

export function postPath(url) {
  if (typeof url !== 'string' || !url || url.length > 1024) throw new Error('Published article has an invalid URL.');
  let rawPath = url;
  if (/^https?:\/\//i.test(url)) {
    const parsed = new URL(url);
    if (parsed.origin !== siteOrigin || parsed.username || parsed.password) throw new Error('Published article URL must belong to the blog.');
    rawPath = url.match(/^https?:\/\/[^/?#]+(\/[^?#]*)?$/i)?.[1];
  }
  if (!rawPath || !rawPath.startsWith('/') || rawPath.startsWith('//') || /%2f|%5c/i.test(rawPath)) {
    throw new Error('Published article URL must contain a canonical blog path.');
  }
  let decoded;
  try { decoded = decodeURIComponent(rawPath).normalize('NFC'); }
  catch { throw new Error('Published article URL has invalid percent encoding.'); }
  if (/[\\?#%\u0000-\u001f\u007f]/.test(decoded) || decoded.includes('//') || /(^|\/)\.{1,2}(\/|$)/.test(decoded)) {
    throw new Error('Published article URL contains a noncanonical path.');
  }
  decoded = decoded.replace(/\/index\.html$/, '/');
  const path = decoded.endsWith('/') ? decoded : `${decoded}/`;
  if (path === '/') throw new Error('Home page cannot be used as an article permalink.');
  return path;
}

export function renderPosts(records) {
  if (!Array.isArray(records)) throw new Error('public/search.json must be an array of published articles.');
  const paths = records.map(record => postPath(record?.url));
  if (new Set(paths).size !== paths.length) throw new Error('Published articles contain duplicate canonical permalinks.');
  paths.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  return '// Generated from public/search.json by scripts/sync-posts.mjs.\n' +
    '// Canonical published permalinks; do not edit this derived allowlist by hand.\n' +
    `export const POST_PATHS = Object.freeze(${JSON.stringify(paths, null, 2)});\n`;
}

export async function syncPosts({ input = defaultInput, output = defaultOutput, history = defaultHistory } = {}) {
  const records = JSON.parse(await readFile(input, 'utf8'));
  const next = renderPosts(records);
  let previous = null;
  try { previous = await readFile(output, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous === next) return { changed: false, count: records.length };
  if (previous !== null) {
    await mkdir(history, { recursive: true });
    const digest = createHash('sha256').update(previous).digest('hex');
    const archive = resolve(history, `posts-${digest}.mjs`);
    try { await writeFile(archive, previous, { flag: 'wx' }); }
    catch (error) {
      if (error.code !== 'EEXIST' || await readFile(archive, 'utf8') !== previous) throw error;
    }
  }
  await mkdir(dirname(output), { recursive: true });
  const temporary = resolve(dirname(output), `.posts-${randomUUID()}.mjs.tmp`);
  await writeFile(temporary, next, { flag: 'wx' });
  await rename(temporary, output);
  return { changed: true, count: records.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const outcome = await syncPosts(process.argv[2] ? { input: resolve(process.argv[2]) } : {});
    console.log(`Likes allowlist ${outcome.changed ? 'updated' : 'unchanged'}: ${outcome.count} published articles.`);
  } catch (error) {
    console.error(`Cannot synchronize likes allowlist: ${error.message}`);
    process.exitCode = 1;
  }
}
