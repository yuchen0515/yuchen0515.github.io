const $ = (id) => document.getElementById(id);
const token = document.querySelector('meta[name="writer-token"]').content;
const editor = $('editor');
const state = { id: null, version: null, saved: '', documents: [], saving: false, opening: 0 };
let previewTimer;
let previewController;
let previewNumber = 0;
let lastPreviewId = null;

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
  state.id = result.id; state.version = result.version; state.saved = result.content;
  editor.value = result.content; editor.disabled = false;
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
  return `<!doctype html><html lang="${language === 'en' ? 'en' : 'zh-Hant'}" data-preview-language="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${origin} 'unsafe-inline'; img-src ${origin} https: data:; font-src ${origin} data:; script-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><link rel="stylesheet" href="${origin}/vendor/katex.min.css"><link rel="stylesheet" href="${origin}/preview-style.css"><link rel="stylesheet" href="${origin}/preview.css"><title>${escapeHTML(title || '文章預覽')}</title></head><body><article class="writer-preview article-body prose">${title ? `<h1>${escapeHTML(title)}</h1>` : ''}${html || '<p class="empty-preview">文章內容會出現在這裡。</p>'}</article></body></html>`;
}

function schedulePreview() {
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
        const scrollY = lastPreviewId === state.id ? iframe.contentWindow?.scrollY ?? 0 : 0;
        lastPreviewId = state.id;
        iframe.onload = () => { if (number === previewNumber) iframe.contentWindow.scrollTo(0, scrollY); };
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
editor.addEventListener('input', () => { updateDirty(); schedulePreview(); });
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
  document.querySelector('.workspace').classList.toggle('show-preview', preview);
  $('edit-tab').setAttribute('aria-selected', String(!preview)); $('preview-tab').setAttribute('aria-selected', String(preview));
  $('edit-tab').tabIndex = preview ? -1 : 0; $('preview-tab').tabIndex = preview ? 0 : -1;
}
$('edit-tab').addEventListener('click', () => selectTab(false));
$('preview-tab').addEventListener('click', () => selectTab(true));
for (const tab of [$('edit-tab'), $('preview-tab')]) tab.addEventListener('keydown', (event) => { if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); const preview = tab === $('edit-tab'); selectTab(preview); (preview ? $('preview-tab') : $('edit-tab')).focus(); } });
selectTab(false);
$('preview').srcdoc = previewDocument('', '<p class="empty-preview">開啟文章後，這裡會顯示即時預覽。</p>');
loadLibrary().catch((error) => showError(error.message));
