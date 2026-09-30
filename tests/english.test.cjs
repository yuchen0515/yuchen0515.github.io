const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const cheerio = require('cheerio');
const {renderMarkdown} = require('../lib/markdown.cjs');
const baseline = require('./fixtures/chinese-preservation.json');

test('English revisions preserve all six author-owned Chinese blocks byte for byte', () => {
  for (const {path, zhSha256} of baseline) {
    const source = fs.readFileSync(path, 'utf8');
    const start = source.indexOf('<!-- LANG:ZH START -->');
    const end = source.indexOf('<!-- LANG:ZH END -->') + '<!-- LANG:ZH END -->'.length;
    assert.ok(start >= 0 && end > start, path);
    assert.equal(crypto.createHash('sha256').update(source.slice(start, end)).digest('hex'), zhSha256, path);
  }
});

test('all translated pages retain source links and images with English hidden until selected', () => {
  for (const {path} of baseline) {
    const $ = cheerio.load(renderMarkdown(fs.readFileSync(path, 'utf8')));
    const zh = $('[data-language="zh"]'), en = $('[data-language="en"]');
    assert.equal(zh.length, 1, path); assert.equal(en.length, 1, path);
    assert.equal(zh.is('[hidden]'), false, path); assert.equal(en.is('[hidden]'), true, path);
    const references = section => new Set(section.find('a[href],img[src]').map((_, el) => $(el).attr('href') || $(el).attr('src')).get());
    const translated = references(en);
    for (const reference of references(zh)) assert.ok(translated.has(reference), path + ': missing translated reference ' + reference);
    assert.equal(en.find('img').length, zh.find('img').length, path);
    const ids = $('[id]').map((_, el) => $(el).attr('id')).get();
    assert.equal(new Set(ids).size, ids.length, path + ': duplicate bilingual anchors');
  }
});

test('known malformed QR resource links render correctly without altering Markdown input', () => {
  const source = '[QRCode Generator](https://www.the-qrcode-generator.com://www.the-qrcode-generator.com/)';
  const $ = cheerio.load(renderMarkdown(source));
  assert.equal($('a').attr('href'), 'https://www.the-qrcode-generator.com/');
  assert.equal(source, '[QRCode Generator](https://www.the-qrcode-generator.com://www.the-qrcode-generator.com/)');
});
