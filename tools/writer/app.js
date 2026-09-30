const $ = (id) => document.getElementById(id);
const token = document.querySelector('meta[name="writer-token"]').content;
const editor = $('editor');
const state = { id: null, version: null, saved: '', documents: [], saving: false, opening: 0 };
let previewTimer;
let previewController;
let previewNumber = 0;
let lastPreviewId = null;

const syncPreference = 'owen.writer.scroll-sync.v1';
let syncEnabled = true;
try { syncEnabled = localStorage.getItem(syncPreference) !== 'off'; } catch { /* Local preferences are optional. */ }
const scrollSync = { points: [], source: '', driver: 'editor', frame: 0, ready: false, expected: {}, observer: null, window: null, width: 0, editorHeight: 0, tops: { editor: 0, preview: 0 } };
const mirror = document.createElement('div');
mirror.className = 'editor-measure'; mirror.setAttribute('aria-hidden', 'true'); document.body.append(mirror);

function updateSyncControl() {
  const button = $('scroll-sync');
  button.setAttribute('aria-pressed', String(syncEnabled));
  button.title = syncEnabled ? '已同步捲動；點擊解除同步' : '兩邊可各自捲動；點擊重新同步';
}

// Keep the renderer unchanged. Match visible Markdown blocks in the parent page;
// unmatched HTML and complex blocks use interpolation between known positions.
function markdownBlocks(source) {
  const lines = source.replace(/^\uFEFF/, '').split('\n');
  let start = 0;
  if (lines[0].trim() === '---') { const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---'); if (end > 0) start = end + 1; }
  else if (/^[\w-]+:/.test(lines[0])) { const end = lines.findIndex((line) => line.trim() === '---'); if (end >= 0 && lines.slice(0, end).every((line) => /^[\w-]+:|^[ \t]+/.test(line))) start = end + 1; }
  const blocks = [];
  let language = 'all';
  const selectedLanguage = $('preview-language').value;
  const marker = (line) => line.match(/^\s*<!--\s*LANG:(ZH|EN) (START|END)\s*-->\s*$/);
  const special = (line) => /^(?: {0,3}#{1,6}\s|\s*(`{3,}|~{3,})|\s*>|\s*(?:[-+*]|\d+[.)])\s|\s*(?:---+|\*\*\*+|___+)\s*$)/.test(line) || Boolean(marker(line));
  for (let index = start; index < lines.length;) {
    const line = lines[index], delimiter = marker(line);
    if (delimiter) { language = delimiter[2] === 'START' ? delimiter[1].toLowerCase() : 'all'; index += 1; continue; }
    if (!line.trim()) { index += 1; continue; }
    const first = index;
    let kind = 'p', content = line;
    const fence = line.match(/^\s*(`{3,}|~{3,})/);
    const heading = line.match(/^ {0,3}(#{1,6})\s+(.+?)(?:\s+#+\s*)?$/);
    if (fence) {
      kind = 'pre'; index += 1;
      while (index < lines.length && !new RegExp(`^\\s*${fence[1][0]}{${fence[1].length},}\\s*$`).test(lines[index])) index += 1;
      content = lines.slice(first + 1, index).join('\n'); index = Math.min(index + 1, lines.length);
    } else if (heading) { kind = `h${heading[1].length}`; content = heading[2]; index += 1; }
    else if (index + 1 < lines.length && /^\s*(?:=+|-+)\s*$/.test(lines[index + 1])) { kind = lines[index + 1].includes('=') ? 'h1' : 'h2'; index += 2; }
    else if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) { kind = 'hr'; content = ''; index += 1; }
    else {
      if (/^\s*>/.test(line)) kind = 'blockquote';
      else if (/^\s*(?:[-+*]|\d+[.)])\s/.test(line)) kind = 'list';
      else if (index + 1 < lines.length && line.includes('|') && /^\s*\|?\s*:?-+:?\s*\|/.test(lines[index + 1])) kind = 'table';
      index += 1;
      while (index < lines.length && lines[index].trim() && !marker(lines[index]) && (kind !== 'p' || !special(lines[index]))) index += 1;
      content = lines.slice(first, index).join('\n');
    }
    if (language === 'all' || language === selectedLanguage) blocks.push({ line: first, kind, content });
  }
  return { lines, blocks };
}

function plainText(value) {
  return value.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, '').replace(/&(?:amp|lt|gt|quot|apos);/g, (entity) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" }[entity]))
    .normalize('NFKC').toLocaleLowerCase().replace(/[\p{P}\p{S}\s]/gu, '');
}

function editorLinePositions(lines) {
  const style = getComputedStyle(editor);
  if (editor.clientWidth > 0) scrollSync.width = editor.clientWidth;
  if (editor.clientHeight > 0) scrollSync.editorHeight = editor.clientHeight;
  if (!scrollSync.width) return [];
  for (const key of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'tabSize', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft']) mirror.style[key] = style[key];
  mirror.style.width = `${scrollSync.width}px`;
  const fragment = document.createDocumentFragment();
  for (const line of lines) { const row = document.createElement('div'); row.textContent = line || '\u200b'; fragment.append(row); }
  mirror.replaceChildren(fragment);
  const top = mirror.getBoundingClientRect().top;
  return [...mirror.children].map((row) => row.getBoundingClientRect().top - top);
}

function paneVisible(side) {
  const element = side === 'editor' ? editor : $('preview');
  return element.clientWidth > 0 && element.clientHeight > 0;
}

function rebuildScrollMap() {
  const iframe = $('preview'), win = iframe.contentWindow, doc = iframe.contentDocument;
  if (!scrollSync.ready || !doc?.querySelector('.writer-preview')) return false;
  const { lines, blocks } = markdownBlocks(scrollSync.source);
  const positions = editorLinePositions(lines);
  if (!positions.length) return false;
  const editorMax = Math.max(0, (editor.clientHeight ? editor.scrollHeight : mirror.scrollHeight) - scrollSync.editorHeight);
  // A hidden iframe reports zero geometry. Retain its last valid coordinates;
  // only update the source side when the textarea becomes visible at a new width.
  if (!paneVisible('preview')) {
    if (paneVisible('editor')) for (const point of scrollSync.points) point.editor = point.end ? editorMax : point.line === undefined ? 0 : Math.min(editorMax, positions[point.line] ?? editorMax);
    return scrollSync.points.length > 1;
  }
  const blockTags = 'h1,h2,h3,h4,h5,h6,p,pre,table,blockquote,ul,ol,hr';
  const nodes = [...doc.querySelector('.writer-preview').querySelectorAll(blockTags)].filter((node) => !node.hasAttribute('data-writer-title') && node.getBoundingClientRect().height > 0 && !node.parentElement.closest(blockTags));
  const candidates = nodes.map((node) => ({ node, kind: /^(ul|ol)$/.test(node.tagName.toLowerCase()) ? 'list' : node.tagName.toLowerCase(), text: plainText(node.textContent || [...node.querySelectorAll('img')].map((image) => image.alt).join(' ')) }));
  const previewMax = Math.max(0, doc.documentElement.scrollHeight - win.innerHeight);
  const points = [{ editor: 0, preview: 0 }];
  let cursor = 0;
  for (const block of blocks) {
    const text = plainText(block.content), prefix = text.slice(0, 24);
    let match = candidates.findIndex((candidate, index) => index >= cursor && candidate.kind === block.kind && (prefix ? candidate.text.startsWith(prefix) || text.startsWith(candidate.text) && candidate.text.length > 6 : !candidate.text));
    if (match < 0 && !/^h\d$/.test(block.kind)) match = candidates.findIndex((candidate, index) => index === cursor && candidate.kind === block.kind);
    if (match < 0) continue;
    cursor = match + 1;
    const point = { editor: Math.min(editorMax, positions[block.line]), preview: Math.min(previewMax, candidates[match].node.getBoundingClientRect().top + win.scrollY), line: block.line };
    const previous = points.at(-1);
    if (point.editor > previous.editor + 1 && point.preview > previous.preview + 1) points.push(point);
  }
  while (points.length > 1 && (points.at(-1).editor >= editorMax || points.at(-1).preview >= previewMax)) points.pop();
  if (editorMax > 0 && previewMax > 0) points.push({ editor: editorMax, preview: previewMax, end: true });
  scrollSync.points = points;
  return points.length > 1;
}

function mappedPosition(value, from, to) {
  const points = scrollSync.points;
  if (value <= 0 || points.length < 2) return 0;
  for (let index = 1; index < points.length; index += 1) {
    const end = points[index], start = points[index - 1];
    if (value <= end[from]) return start[to] + (end[to] - start[to]) * Math.max(0, Math.min(1, (value - start[from]) / (end[from] - start[from])));
  }
  return points.at(-1)[to];
}

function alignScroll(driver) {
  if (!syncEnabled || !scrollSync.ready || !scrollSync.points.length || !paneVisible(driver)) return;
  const win = $('preview').contentWindow;
  scrollSync.tops[driver] = driver === 'editor' ? editor.scrollTop : win.scrollY;
  const target = driver === 'editor' ? 'preview' : 'editor';
  const top = mappedPosition(scrollSync.tops[driver], driver, target);
  scrollSync.tops[target] = top;
  if (!paneVisible(target)) return;
  if (target === 'preview') { win.scrollTo(0, top); scrollSync.expected.preview = scrollSync.tops.preview = win.scrollY; }
  else { editor.scrollTop = top; scrollSync.expected.editor = scrollSync.tops.editor = editor.scrollTop; }
}

function queueScroll(driver, rebuild = false) {
  if (!syncEnabled || !scrollSync.ready || !paneVisible(driver)) return;
  scrollSync.driver = driver;
  cancelAnimationFrame(scrollSync.frame);
  scrollSync.frame = requestAnimationFrame(() => { if (rebuild) rebuildScrollMap(); alignScroll(driver); });
}

function handleScroll(driver, top) {
  if (!paneVisible(driver)) return;
  scrollSync.tops[driver] = top;
  const expected = scrollSync.expected[driver];
  if (expected !== undefined && Math.abs(expected - top) < 2) return;
  delete scrollSync.expected[driver];
  scrollSync.driver = driver;
  queueScroll(driver);
}

function connectPreviewScroll() {
  scrollSync.observer?.disconnect();
  const iframe = $('preview'), win = iframe.contentWindow;
  scrollSync.window = win;
  scrollSync.expected = {};
  win.addEventListener('scroll', () => handleScroll('preview', win.scrollY), { passive: true });
  win.addEventListener('wheel', () => { delete scrollSync.expected.preview; }, { passive: true });
  win.addEventListener('touchstart', () => { delete scrollSync.expected.preview; }, { passive: true });
  scrollSync.observer = new ResizeObserver(() => queueScroll(scrollSync.driver, true));
  scrollSync.observer.observe(iframe.contentDocument.querySelector('.writer-preview'));
  for (const image of iframe.contentDocument.images) image.addEventListener('load', () => queueScroll(scrollSync.driver, true), { once: true });
  rebuildScrollMap();
  // Typing keeps the caret and source viewport stable. Reading or changing the
  // preview language instead preserves the preview's existing reading position.
  if (syncEnabled) {
    const driver = document.activeElement === editor && scrollSync.driver === 'editor' ? 'editor' : 'preview';
    scrollSync.driver = driver; alignScroll(driver);
  }
}

$('scroll-sync').addEventListener('click', () => {
  syncEnabled = !syncEnabled;
  try { localStorage.setItem(syncPreference, syncEnabled ? 'on' : 'off'); } catch { /* Keep this page usable without storage. */ }
  updateSyncControl();
  if (syncEnabled) queueScroll(scrollSync.driver, true);
  else cancelAnimationFrame(scrollSync.frame);
  setStatus(syncEnabled ? '已開啟同步捲動。' : '已解除同步，Markdown 與預覽可各自捲動。');
});
editor.addEventListener('scroll', () => handleScroll('editor', editor.scrollTop), { passive: true });
editor.addEventListener('wheel', () => { delete scrollSync.expected.editor; }, { passive: true });
editor.addEventListener('touchstart', () => { delete scrollSync.expected.editor; }, { passive: true });
new ResizeObserver(() => queueScroll(scrollSync.driver, true)).observe(editor);
updateSyncControl();

const escapeHTML = (text) => String(text).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const dirty = () => Boolean(state.id && editor.value !== state.saved);
function showError(message) { $('error').textContent = message; $('error').hidden = false; }
function clearError() { $('error').hidden = true; }
function setStatus(message) { $('status').textContent = message; }
function updateDirty() {
  $('save').disabled = !state.id || !dirty() || state.saving;
  if (!state.saving) setStatus(dirty() ? '尚有未儲存的修改。' : state.id ? '已儲存在本機。' : '文章與圖片保留在你的本機。');
}
function canLeave() { return !dirty() || window.confirm('目前有尚未儲存的修改。確定離開這篇文章？'); }

async function api(endpoint, { method = 'GET', data, file, signal } = {}) {
  const headers = { 'X-Writer-Token': token };
  let body;
  if (data !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(data); }
  if (file) { headers['Content-Type'] = file.type || ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }[file.name?.split('.').at(-1).toLowerCase()] ?? 'application/octet-stream'); body = file; }
  let response;
  try { response = await fetch(endpoint, { method, headers, body, signal, credentials: 'same-origin' }); }
  catch (error) { if (error.name === 'AbortError') throw error; throw new Error('無法連接寫作工具。請確認 npm run write 仍在執行，再重試；目前文字仍在編輯區。'); }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? '操作未完成，請重試。');
  return result;
}

function drawLibrary() {
  const target = $('library');
  target.replaceChildren();
  const filter = $('filter').value.trim().toLocaleLowerCase();
  for (const [kind, heading] of [['drafts', '草稿'], ['posts', '文章']]) {
    const documents = state.documents.filter((item) => item.kind === kind && item.name.toLocaleLowerCase().includes(filter));
    const section = document.createElement('section');
    const h2 = document.createElement('h2'); h2.textContent = `${heading} · ${documents.length}`; section.append(h2);
    const list = document.createElement('ul');
    for (const item of documents) {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'article-link'; button.textContent = item.name.replace(/\.md$/, '');
      button.setAttribute('aria-current', item.id === state.id ? 'true' : 'false');
      button.addEventListener('click', () => openDocument(item.id));
      li.append(button); list.append(li);
    }
    if (documents.length) section.append(list);
    else { const empty = document.createElement('p'); empty.className = 'quiet'; empty.textContent = filter ? '沒有符合的文章。' : kind === 'drafts' ? '還沒有草稿。' : '還沒有文章。'; section.append(empty); }
    target.append(section);
  }
}

async function loadLibrary() {
  state.documents = (await api('/api/library')).documents;
  drawLibrary();
}

function selectDocument(result) {
  scrollSync.ready = false;
  scrollSync.driver = 'editor';
  scrollSync.points = []; scrollSync.tops = { editor: 0, preview: 0 };
  state.id = result.id; state.version = result.version; state.saved = result.content;
  editor.value = result.content; editor.scrollTop = 0; editor.disabled = false;
  $('attach-image').disabled = false;
  $('kind').textContent = result.id.startsWith('drafts/') ? '草稿' : '文章';
  $('document-name').textContent = result.id.split('/').slice(1).join('/');
  clearError(); updateDirty(); drawLibrary(); schedulePreview();
  editor.focus();
}

async function openDocument(id) {
  if (!canLeave()) return;
  const opening = ++state.opening;
  try {
    const result = await api(`/api/document?id=${encodeURIComponent(id)}`);
    if (opening === state.opening) selectDocument(result);
  } catch (error) { if (opening === state.opening) showError(error.message); }
}

async function save() {
  if (!state.id || !dirty() || state.saving) return;
  state.saving = true; updateDirty(); clearError(); setStatus('正在儲存…');
  const id = state.id; const content = editor.value; const version = state.version;
  try {
    const result = await api('/api/document', { method: 'PUT', data: { id, content, version } });
    if (state.id === id) { state.saved = content; state.version = result.version; }
    setStatus(`已儲存 · ${new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })}`);
  } catch (error) { showError(error.message); setStatus('尚未儲存，編輯內容仍保留在畫面。'); }
  finally { state.saving = false; $('save').disabled = !state.id || !dirty(); if (dirty()) setStatus('尚有未儲存的修改。'); }
}

function previewDocument(title, html) {
  const origin = location.origin;
  const language = $('preview-language').value === 'en' ? 'en' : 'zh';
  return `<!doctype html><html lang="${language === 'en' ? 'en' : 'zh-Hant'}" data-preview-language="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${origin} 'unsafe-inline'; img-src ${origin} https: data:; font-src ${origin} data:; script-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><link rel="stylesheet" href="${origin}/vendor/katex.min.css"><link rel="stylesheet" href="${origin}/preview-style.css"><link rel="stylesheet" href="${origin}/preview.css"><title>${escapeHTML(title || '文章預覽')}</title></head><body><article class="writer-preview article-body prose">${title ? `<h1 data-writer-title>${escapeHTML(title)}</h1>` : ''}${html || '<p class="empty-preview">文章內容會出現在這裡。</p>'}</article></body></html>`;
}

function schedulePreview() {
  scrollSync.ready = false;
  clearTimeout(previewTimer);
  previewController?.abort();
  const number = ++previewNumber;
  previewTimer = setTimeout(async () => {
    previewController = new AbortController();
    try {
      const result = await api('/api/preview', { method: 'POST', data: { content: editor.value }, signal: previewController.signal });
      if (number === previewNumber) {
        const languages = ['zh', 'en'].filter((language) => result.html.includes(`data-language="${language}"`));
        const selector = $('preview-language');
        const previous = selector.value;
        selector.hidden = languages.length < 2;
        if (languages.length) { selector.replaceChildren(...languages.map((language) => new Option(language === 'zh' ? '繁體中文' : 'English', language))); selector.value = languages.includes(previous) ? previous : languages[0]; }
        const iframe = $('preview');
        const scrollY = lastPreviewId === state.id ? paneVisible('preview') ? iframe.contentWindow?.scrollY ?? 0 : scrollSync.tops.preview : 0;
        lastPreviewId = state.id;
        const source = editor.value;
        iframe.onload = () => { if (number === previewNumber) { scrollSync.tops.preview = scrollY; if (paneVisible('preview')) iframe.contentWindow.scrollTo(0, scrollY); scrollSync.source = source; scrollSync.ready = true; connectPreviewScroll(); } };
        iframe.srcdoc = previewDocument(selector.value === 'en' ? result.titleEn || result.title : result.title, result.html);
      }
    } catch (error) { if (error.name !== 'AbortError' && number === previewNumber) showError(`預覽未完成：${error.message}`); }
  }, 300);
}

async function insertImages(files) {
  if (!state.id || !files.length) return;
  const id = state.id;
  clearError();
  for (const file of files) {
    try {
      setStatus('正在加入圖片…');
      if (file.size > 12 * 1024 * 1024) throw new Error('圖片超過 12 MB，請縮小後再加入。');
      const result = await api('/api/images', { method: 'POST', file });
      if (state.id !== id) { showError(`圖片已保存在 ${result.path}，但文章已切換；請自行加入這個圖片路徑。`); return; }
      const alt = (file.name || '圖片').replace(/\.[^.]+$/, '').replace(/[\[\]\\\r\n]/g, ' ').trim() || '圖片';
      const insertion = `![${alt}](${result.path})`;
      const start = editor.selectionStart; const end = editor.selectionEnd;
      const prefix = start > 0 && editor.value[start - 1] !== '\n' ? '\n\n' : '';
      editor.setRangeText(`${prefix}${insertion}\n`, start, end, 'end');
      scrollSync.driver = 'editor';
      updateDirty(); schedulePreview(); editor.focus();
    } catch (error) { showError(error.message); updateDirty(); return; }
  }
  updateDirty();
}

$('save').addEventListener('click', save);
$('filter').addEventListener('input', drawLibrary);
$('reload-library').addEventListener('click', async () => {
  $('reload-library').disabled = true;
  try {
    await loadLibrary();
    if (state.id && !state.documents.some((document) => document.id === state.id)) showError('找不到目前開啟的檔案；編輯區文字仍保留。請從清單重新開啟文章。');
  } catch (error) { showError(error.message); }
  finally { $('reload-library').disabled = false; }
});
$('preview-language').addEventListener('change', schedulePreview);
editor.addEventListener('input', () => { scrollSync.driver = 'editor'; updateDirty(); schedulePreview(); });
editor.addEventListener('paste', (event) => {
  const images = [...(event.clipboardData?.items ?? [])].filter((item) => item.kind === 'file' && item.type.startsWith('image/')).map((item) => item.getAsFile()).filter(Boolean);
  if (images.length) { event.preventDefault(); insertImages(images); }
});
editor.addEventListener('dragover', (event) => { if ([...(event.dataTransfer?.types ?? [])].includes('Files')) { event.preventDefault(); document.body.classList.add('drop-active'); } });
editor.addEventListener('dragleave', () => document.body.classList.remove('drop-active'));
editor.addEventListener('drop', (event) => { event.preventDefault(); document.body.classList.remove('drop-active'); insertImages([...event.dataTransfer.files]); });
$('attach-image').addEventListener('click', () => $('image-input').click());
$('image-input').addEventListener('change', (event) => { insertImages([...event.target.files]); event.target.value = ''; });
window.addEventListener('keydown', (event) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); save(); } });
window.addEventListener('beforeunload', (event) => { if (dirty()) { event.preventDefault(); event.returnValue = ''; } });

const dialog = $('draft-dialog');
$('new-draft').addEventListener('click', () => { if (!canLeave()) return; $('draft-error').hidden = true; $('draft-title').value = ''; dialog.showModal(); $('draft-title').focus(); });
$('cancel-draft').addEventListener('click', () => dialog.close());
$('draft-form').addEventListener('submit', async (event) => {
  event.preventDefault(); $('create-draft').disabled = true; $('draft-error').hidden = true;
  try {
    const result = await api('/api/drafts', { method: 'POST', data: { title: $('draft-title').value } });
    ++state.opening; await loadLibrary(); selectDocument(result); dialog.close();
  } catch (error) { $('draft-error').textContent = error.message; $('draft-error').hidden = false; }
  finally { $('create-draft').disabled = false; }
});
function selectTab(preview) {
  for (const side of ['editor', 'preview']) if (paneVisible(side)) scrollSync.tops[side] = side === 'editor' ? editor.scrollTop : $('preview').contentWindow.scrollY;
  document.querySelector('.workspace').classList.toggle('show-preview', preview);
  $('edit-tab').setAttribute('aria-selected', String(!preview)); $('preview-tab').setAttribute('aria-selected', String(preview));
  $('edit-tab').tabIndex = preview ? -1 : 0; $('preview-tab').tabIndex = preview ? 0 : -1;
  requestAnimationFrame(() => {
    rebuildScrollMap();
    const target = preview ? 'preview' : 'editor', driver = scrollSync.driver;
    const top = syncEnabled && scrollSync.points.length > 1 && driver !== target ? mappedPosition(scrollSync.tops[driver], driver, target) : scrollSync.tops[target];
    if (preview) { $('preview').contentWindow.scrollTo(0, top); scrollSync.expected.preview = scrollSync.tops.preview = $('preview').contentWindow.scrollY; }
    else { editor.scrollTop = top; scrollSync.expected.editor = scrollSync.tops.editor = editor.scrollTop; }
  });
}
$('edit-tab').addEventListener('click', () => selectTab(false));
$('preview-tab').addEventListener('click', () => selectTab(true));
for (const tab of [$('edit-tab'), $('preview-tab')]) tab.addEventListener('keydown', (event) => { if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); const preview = tab === $('edit-tab'); selectTab(preview); (preview ? $('preview-tab') : $('edit-tab')).focus(); } });
selectTab(false);
$('preview').srcdoc = previewDocument('', '<p class="empty-preview">開啟文章後，這裡會顯示即時預覽。</p>');
loadLibrary().catch((error) => showError(error.message));
