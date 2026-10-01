/* Browser-only safety copies. Saving or dismissing retains the copied Markdown. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WriterRecovery = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  const MAX_BYTES = 2 * 1024 * 1024;
  const VALID_STATUSES = new Set(['pending', 'saved', 'dismissed']);
  const identifier = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);

  function validId(id) {
    if (typeof id !== 'string' || id.length > 320 || /[\\\u0000-\u001f]/.test(id)) return false;
    const parts = id.split('/');
    if (parts.some((part) => !part || part.startsWith('.'))) return false;
    if (id === 'pages/about/index.md' || id === 'pages/links/index.md') return true;
    return ['posts', 'drafts'].includes(parts[0]) && parts.length >= 2 && parts.at(-1).endsWith('.md');
  }

  function byteLength(content) {
    let size = 0;
    for (const character of content) {
      const point = character.codePointAt(0);
      size += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
      if (size > MAX_BYTES) break;
    }
    return size;
  }

  function create({ storage, project, writerId } = {}) {
    const configured = identifier(project) && identifier(writerId);
    const prefix = `owen.writer.recovery.v1:${project}:`;
    const keyFor = (owner, id) => `${prefix}${owner}:${encodeURIComponent(id)}`;
    const failure = (error, extra) => ({ ok: false, error, ...extra });
    const available = () => configured && storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function' && typeof storage.key === 'function';

    function validRecord(record, key) {
      return record && typeof record === 'object' && !Array.isArray(record)
        && record.schema === 1 && record.project === project && identifier(record.writerId)
        && validId(record.id) && key === keyFor(record.writerId, record.id)
        && typeof record.content === 'string' && byteLength(record.content) <= MAX_BYTES
        && typeof record.baseVersion === 'string' && record.baseVersion.length > 0 && record.baseVersion.length <= 160
        && !/[\u0000-\u001f]/.test(record.baseVersion)
        && Number.isInteger(record.selectionStart) && Number.isInteger(record.selectionEnd)
        && record.selectionStart >= 0 && record.selectionEnd >= record.selectionStart && record.selectionEnd <= record.content.length
        && Number.isFinite(record.scrollTop) && record.scrollTop >= 0
        && Number.isFinite(record.updatedAt) && record.updatedAt >= 0
        && VALID_STATUSES.has(record.status);
    }

    function read(key) {
      const raw = storage.getItem(key);
      if (raw === null) return null;
      let record;
      try { record = JSON.parse(raw); }
      catch { return null; }
      return validRecord(record, key) ? { ...record, key } : null;
    }

    function write(record) {
      const { key, ...payload } = record;
      storage.setItem(key, JSON.stringify(payload));
      return { ok: true, record: { ...payload, key } };
    }

    function save(input = {}) {
      try {
        if (!available()) return failure('Browser storage is unavailable.');
        const record = {
          schema: 1, project, writerId,
          id: input.id, content: input.content, baseVersion: input.baseVersion,
          selectionStart: input.selectionStart ?? 0,
          selectionEnd: input.selectionEnd ?? input.selectionStart ?? 0,
          scrollTop: input.scrollTop ?? 0,
          updatedAt: input.updatedAt ?? Date.now(), status: 'pending',
          key: keyFor(writerId, input.id),
        };
        if (!validRecord(record, record.key)) return failure('Recovery content or metadata is invalid.');
        return write(record);
      } catch { return failure('Browser storage could not save this recovery copy.'); }
    }

    function list(id) {
      const records = [];
      try {
        if (!available()) return failure('Browser storage is unavailable.', { records });
        if (id !== undefined && !validId(id)) return failure('Recovery document is invalid.', { records });
        const size = storage.length;
        if (!Number.isInteger(size) || size < 0) return failure('Browser storage could not read recovery copies.', { records });
        for (let index = 0; index < size; index += 1) {
          const key = storage.key(index);
          if (typeof key !== 'string' || !key.startsWith(prefix)) continue;
          const record = read(key);
          if (record?.status === 'pending' && (id === undefined || record.id === id)) records.push(record);
        }
        records.sort((a, b) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key));
        return { ok: true, records };
      } catch { return failure('Browser storage could not read recovery copies.', { records }); }
    }

    function acknowledge(id, exactContent) {
      try {
        if (!available()) return failure('Browser storage is unavailable.');
        if (!validId(id) || typeof exactContent !== 'string') return failure('Recovery document is invalid.');
        const record = read(keyFor(writerId, id));
        if (!record || record.content !== exactContent) return { ok: true, acknowledged: false, record };
        const result = write({ ...record, status: 'saved' });
        return { ...result, acknowledged: true };
      } catch { return failure('Browser storage could not update this recovery copy.'); }
    }

    function dismiss(key, exactContent) {
      try {
        if (!available()) return failure('Browser storage is unavailable.');
        if (typeof key !== 'string' || !key.startsWith(prefix)) return failure('Recovery copy is invalid.');
        if (exactContent !== undefined && typeof exactContent !== 'string') return failure('Recovery content is invalid.');
        const record = read(key);
        if (!record) return failure('Recovery copy is invalid.');
        if (exactContent !== undefined && record.content !== exactContent) return { ok: true, dismissed: false, record };
        return { ...write({ ...record, status: 'dismissed' }), dismissed: true };
      } catch { return failure('Browser storage could not update this recovery copy.'); }
    }

    return { save, list, acknowledge, dismiss };
  }

  return { create, MAX_BYTES };
});
