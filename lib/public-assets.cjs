const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const MarkdownIt = require('markdown-it');
const cheerio = require('cheerio');
const yaml = require('js-yaml');
const frontMatter = require('hexo-front-matter');

const UPLOAD_PREFIX = 'source/images/uploads/';
const markdown = new MarkdownIt({html: true});
const publicMarkdown = name => name.startsWith('source/') && !name.startsWith('source/_drafts/') && !name.split('/').some(part => part.startsWith('.')) && /\.(?:md|markdown)$/i.test(name);

function uploadReference(value, siteUrl = '') {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.startsWith('//')) return null;
  let rawPath = text.split(/[?#]/, 1)[0];
  try {
    if (/^https?:\/\//i.test(text)) {
      if (!siteUrl || new URL(text).origin !== new URL(siteUrl).origin) return null;
      rawPath = text.match(/^https?:\/\/[^/?#]+([^?#]*)/i)[1];
    } else if (!text.startsWith('/')) return null;
    const decoded = decodeURIComponent(rawPath);
    if (/[\\\x00-\x1f\x7f]/.test(decoded) || /%[a-f0-9]{2}/i.test(decoded) || decoded.split('/').some(part => part === '.' || part === '..')) return null;
    if (!decoded.startsWith('/images/uploads/') || decoded.endsWith('/')) return null;
    return 'source' + decoded;
  } catch {return null;}
}

function referencedUploads(documents, siteUrl = '') {
  const allowed = new Set();
  const collect = value => {const name = uploadReference(value, siteUrl);if (name) allowed.add(name);};
  for (const [name, source] of documents) {
    if (!publicMarkdown(name)) continue;
    const metadata = frontMatter.parse(source.replace(/\r\n/g, '\n'));
    if (name.startsWith('source/_posts/') && metadata.published === false) continue;
    const collectMetadata = value => {
      if (Array.isArray(value)) value.forEach(collectMetadata);
      else if (value && typeof value === 'object') Object.values(value).forEach(collectMetadata);
      else collect(value);
    };
    for (const key of ['cover', 'image', 'images', 'thumbnail', 'banner']) collectMetadata(metadata[key]);
    const body = metadata._content;
    const $ = cheerio.load(markdown.render(body));
    $('[src],[href],[poster]').each((_, element) => {
      for (const attr of ['src', 'href', 'poster']) collect($(element).attr(attr));
    });
    $('[srcset]').each((_, element) => {
      for (const candidate of $(element).attr('srcset').split(',')) collect(candidate.trim().split(/\s+/)[0]);
    });
  }
  return allowed;
}

function walk(root, prefix = '') {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, {withFileTypes: true}).flatMap(entry => {
    const name = prefix + entry.name;
    if (entry.isDirectory() && !entry.name.startsWith('.')) return walk(path.join(root, entry.name), name + '/');
    return entry.isFile() ? [name] : [];
  });
}

function publicUploads(root) {
  const names = walk(path.join(root, 'source'), 'source/');
  const documents = names.filter(publicMarkdown).map(name => [name, fs.readFileSync(path.join(root, name), 'utf8')]);
  const configPath = path.join(root, '_config.yml');
  const siteUrl = fs.existsSync(configPath) ? yaml.load(fs.readFileSync(configPath, 'utf8'))?.url || '' : '';
  const references = referencedUploads(documents, siteUrl);
  return new Set(names.filter(name => name.startsWith(UPLOAD_PREFIX) && references.has(name)));
}

function filterUploadRoutes(routes, allowed) {
  return routes.filter(route => !route.path.startsWith('images/uploads/') || allowed.has('source/' + route.path));
}

function installPublicAssetFilter(hexo) {
  let installed = false;
  hexo.extend.filter.register('before_generate', () => {
    if (installed) return;
    const assetGenerator = hexo.extend.generator.get('asset');
    if (!assetGenerator) throw new Error('Hexo asset generator is unavailable; upload privacy cannot be enforced.');
    hexo.extend.generator.register('asset', async function(locals) {
      return filterUploadRoutes(await assetGenerator.call(this, locals), publicUploads(hexo.base_dir));
    });
    installed = true;
  });
}

function gitTreeUploads(root, revision) {
  const git = (...args) => execFileSync('git', ['-C', root, ...args], {maxBuffer: 64 * 1024 * 1024});
  const entries = git('ls-tree', '-rz', '--full-tree', revision).toString().split('\0').filter(Boolean).map(entry => {
    const [info, name] = entry.split('\t');return {name, mode: info.split(' ')[0]};
  });
  const regular = entries.filter(entry => ['100644', '100755'].includes(entry.mode));
  const documents = regular.filter(entry => publicMarkdown(entry.name)).map(entry => [entry.name, git('show', `${revision}:${entry.name}`).toString()]);
  const config = regular.some(entry => entry.name === '_config.yml') ? yaml.load(git('show', `${revision}:_config.yml`).toString()) : {};
  const references = referencedUploads(documents, config?.url || '');
  return regular.filter(entry => entry.name.startsWith(UPLOAD_PREFIX) && references.has(entry.name)).map(entry => entry.name).sort();
}

module.exports = {UPLOAD_PREFIX, uploadReference, referencedUploads, publicUploads, filterUploadRoutes, installPublicAssetFilter, gitTreeUploads};
if (require.main === module) {
  if (process.argv[2] !== '--git-tree' || !process.argv[3]) throw new Error('Usage: node lib/public-assets.cjs --git-tree REVISION');
  process.stdout.write(JSON.stringify(gitTreeUploads(process.cwd(), process.argv[3])) + '\n');
}
