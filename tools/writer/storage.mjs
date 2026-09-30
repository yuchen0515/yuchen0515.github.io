import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export class WriterError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export const versionOf = (text) => createHash('sha256').update(text).digest('hex');
const imageTypes = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };

function segments(relative) {
  if (typeof relative !== 'string' || relative.length > 320 || relative.includes('\\') || relative.includes('\0') || path.isAbsolute(relative)) {
    throw new WriterError(400, '檔案路徑不正確。');
  }
  const parts = relative.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))) throw new WriterError(400, '檔案路徑不正確。');
  return parts;
}

export function documentParts(id) {
  const parts = segments(id);
  if (!['posts', 'drafts'].includes(parts[0]) || parts.length < 2 || !parts.at(-1).endsWith('.md')) throw new WriterError(400, '只能編輯文章與草稿的 Markdown 檔。');
  return ['source', parts[0] === 'posts' ? '_posts' : '_drafts', ...parts.slice(1)];
}

export class WriterStore {
  constructor(projectRoot) { this.projectRoot = path.resolve(projectRoot); }

  async initialize() {
    this.root = await fs.realpath(this.projectRoot);
    return this;
  }

  async checked(parts, { createParents = false } = {}) {
    let current = this.root;
    for (const [index, part] of parts.entries()) {
      if (!part || part === '.' || part === '..' || part.includes('/') || part.includes('\\') || part.includes('\0')) throw new WriterError(400, '檔案路徑不正確。');
      current = path.join(current, part);
      const parent = index < parts.length - 1;
      let stat;
      try { stat = await fs.lstat(current); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (parent && createParents) { await fs.mkdir(current); stat = await fs.lstat(current); }
        else if (parent) throw new WriterError(404, '找不到這個檔案。');
        else return current;
      }
      if (stat.isSymbolicLink()) throw new WriterError(400, '寫作工具不讀寫符號連結。');
      if (parent && !stat.isDirectory()) throw new WriterError(400, '檔案所在位置不是資料夾。');
      if (!parent && !stat.isFile()) throw new WriterError(400, '這個位置不是一般檔案。');
    }
    return current;
  }

  async read(id) {
    const file = await this.checked(documentParts(id));
    let handle;
    try {
      handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (stat.size > 2 * 1024 * 1024) throw new WriterError(413, '文章超過 2 MB，請在文字編輯器中編輯。');
      const content = await handle.readFile('utf8');
      return { id, content, version: versionOf(content) };
    } catch (error) {
      if (error.code === 'ENOENT') throw new WriterError(404, '找不到這篇文章，請重新整理清單。');
      throw error;
    } finally { await handle?.close(); }
  }

  async list() {
    const documents = [];
    for (const [kind, folder] of [['drafts', '_drafts'], ['posts', '_posts']]) {
      let base;
      try { base = await this.checked(['source', folder, '_listing']); }
      catch (error) { if (error.status === 404) continue; throw error; }
      const walk = async (directory, relative = '') => {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
          if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
          const name = relative ? `${relative}/${entry.name}` : entry.name;
          if (entry.isDirectory()) await walk(path.join(directory, entry.name), name);
          else if (entry.isFile() && entry.name.endsWith('.md')) documents.push({ id: `${kind}/${name}`, name, kind });
        }
      };
      await walk(path.dirname(base));
    }
    return documents.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name, 'zh-Hant'));
  }

  async exclusiveWrite(parts, content) {
    const file = await this.checked(parts, { createParents: true });
    let handle;
    try {
      handle = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(content);
      await handle.sync();
    } finally { await handle?.close(); }
    return file;
  }

  async save(id, content, version) {
    if (typeof content !== 'string' || Buffer.byteLength(content) > 2 * 1024 * 1024) throw new WriterError(413, '文章超過 2 MB，無法儲存。');
    const previous = await this.read(id);
    if (previous.version !== version) throw new WriterError(409, '檔案已被其他編輯器更新。請先複製目前文字，再重新開啟文章比對。');
    if (previous.content === content) return previous;
    const parts = documentParts(id);
    const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
    const revisionDirectory = ['.history', 'writer', id.split('/')[0], versionOf(id).slice(0, 16)];
    await this.exclusiveWrite([...revisionDirectory, `${stamp}.md`], previous.content);
    await this.exclusiveWrite([...revisionDirectory, `${stamp}.json`], JSON.stringify({ id, version: previous.version, savedAt: new Date().toISOString() }, null, 2));
    const target = await this.checked(parts);
    const temporary = [...parts.slice(0, -1), `.writer-${randomUUID()}.tmp`];
    const temporaryPath = await this.exclusiveWrite(temporary, content);
    const latest = await this.read(id);
    if (latest.version !== previous.version) throw new WriterError(409, '儲存期間檔案有新修改；你的文字已保留在暫存檔，請重新比對。');
    await this.checked(parts);
    await fs.rename(temporaryPath, target);
    return { id, content, version: versionOf(content) };
  }

  async createDraft(title) {
    if (typeof title !== 'string' || !title.trim() || title.length > 200) throw new WriterError(400, '請輸入 1 至 200 字的文章標題。');
    title = title.trim();
    const stem = title.normalize('NFKC').replace(/[^\p{L}\p{N} _-]/gu, '').trim().replace(/\s+/g, '-').slice(0, 80) || 'untitled';
    const id = `drafts/${stem}.md`;
    const local = new Date();
    const date = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')} ${String(local.getHours()).padStart(2, '0')}:${String(local.getMinutes()).padStart(2, '0')}:${String(local.getSeconds()).padStart(2, '0')}`;
    const content = `---\ntitle: ${JSON.stringify(title)}\ndate: ${date}\ntags: []\ncategories: []\n---\n\n`;
    try { await this.exclusiveWrite(documentParts(id), content); }
    catch (error) { if (error.code === 'EEXIST') throw new WriterError(409, '同名草稿已存在，請換個標題或開啟原有草稿。'); throw error; }
    return { id, content, version: versionOf(content) };
  }

  async saveImage(bytes, mime) {
    const type = mime?.split(';', 1)[0].toLowerCase();
    const extension = imageTypes[type];
    if (!extension || !Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 12 * 1024 * 1024) throw new WriterError(400, '請選擇 12 MB 以內的 PNG、JPEG、WebP 或 GIF 圖片。');
    const png = bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0;
    const jpeg = bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const webp = bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
    const gif = bytes.length >= 13 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6));
    if (!({ 'image/png': png, 'image/jpeg': jpeg, 'image/webp': webp, 'image/gif': gif }[type])) throw new WriterError(400, '圖片內容與格式不符，請重新匯出圖片後再試。');
    const name = `${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}-${randomUUID().slice(0, 8)}${extension}`;
    await this.exclusiveWrite(['source', 'images', 'uploads', name], bytes);
    return { path: `/images/uploads/${name}`, name };
  }

  async image(relative) {
    const parts = segments(relative);
    const extension = path.extname(parts.at(-1)).toLowerCase();
    const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }[extension];
    if (!mime) throw new WriterError(404, '找不到圖片。');
    const file = await this.checked(['source', 'images', ...parts]);
    let handle;
    try {
      handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (stat.size > 20 * 1024 * 1024) throw new WriterError(413, '圖片太大。');
      return { bytes: await handle.readFile(), mime };
    } catch (error) { if (error.code === 'ENOENT') throw new WriterError(404, '找不到圖片。'); throw error; }
    finally { await handle?.close(); }
  }
}

export function previewParts(source) {
  const normalized = source.replace(/^\uFEFF/, '');
  const standard = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const legacy = !standard && normalized.match(/^((?:[\w-]+:[^\n]*\r?\n|[ \t]+[^\n]*\r?\n)+)---(?:\r?\n|$)/);
  const frontMatter = standard?.[1] ?? legacy?.[1] ?? '';
  const readTitle = (key) => {
    let title = frontMatter.match(new RegExp(`^${key}:[ \\t]*(.+)$`, 'm'))?.[1].trim() || '';
    if (title.startsWith('"')) { try { title = JSON.parse(title); } catch { /* Preserve authored YAML text. */ } }
    else if (title.startsWith("'") && title.endsWith("'")) title = title.slice(1, -1).replace(/''/g, "'");
    return title;
  };
  const title = readTitle('title');
  return { title, titleEn: readTitle('title_en') || title, body: normalized.slice(standard?.[0].length ?? legacy?.[0].length ?? 0) };
}
