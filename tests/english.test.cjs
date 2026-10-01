const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const cheerio = require('cheerio');
const {renderMarkdown} = require('../lib/markdown.cjs');
const baseline = require('./fixtures/chinese-preservation.json');

// Editorial guarantees belong to the reviewed snapshots, so later author edits remain deployable.
test('reviewed English snapshots preserve all six author-owned Chinese blocks byte for byte', () => {
  for (const {path, snapshotPath, snapshotSha256, zhSha256, commonOutsideRankUpdateSha256} of baseline) {
    const bytes = fs.readFileSync(snapshotPath);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), snapshotSha256, snapshotPath);
    const source = bytes.toString('utf8');
    const start = source.indexOf('<!-- LANG:ZH START -->');
    const end = source.indexOf('<!-- LANG:ZH END -->') + '<!-- LANG:ZH END -->'.length;
    assert.ok(start >= 0 && end > start, path);
    assert.equal(crypto.createHash('sha256').update(source.slice(start, end)).digest('hex'), zhSha256, path);
    if (commonOutsideRankUpdateSha256) {
      const appendix = source.slice(source.indexOf('<!-- LANG:EN END -->') + '<!-- LANG:EN END -->'.length);
      const updates = [...appendix.matchAll(/<!-- CODINGAME:RANK UPDATE START -->[\s\S]*?<!-- CODINGAME:RANK UPDATE END -->\n\n/g)];
      assert.equal(updates.length, 1, path + ': missing or duplicate authorized ranking update');
      const unchanged = appendix.replace(updates[0][0], '');
      assert.equal(crypto.createHash('sha256').update(unchanged).digest('hex'), commonOutsideRankUpdateSha256, path + ': unrelated activity content changed');
    }
  }
});

test('reviewed translated snapshots retain source links and images with English hidden until selected', () => {
  for (const {path, snapshotPath} of baseline) {
    const $ = cheerio.load(renderMarkdown(fs.readFileSync(snapshotPath, 'utf8')));
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

test('reviewed About snapshot distinguishes the overall Minishogi rank from its Wood label and old rankings', () => {
  const about = baseline.find((entry) => entry.path === 'source/about/index.md');
  const source = fs.readFileSync(about.snapshotPath, 'utf8');
  const $ = cheerio.load(renderMarkdown(source));
  const latest = $('a[href="https://www.codingame.com/multiplayer/bot-programming/minishogi"]').closest('table');
  assert.equal(latest.length, 1);
  assert.equal(latest.closest('[data-language]').length, 0, 'updated ranks remain visible in either language');
  const shogi = latest.find('a[href$="/minishogi"]').closest('tr');
  assert.match(shogi.find('td').eq(1).text(), /^Wood$/);
  assert.match(shogi.find('td').eq(2).text(), /3 \/ 63（全體 \/ overall）/);
  const locam = latest.find('a[href$="/legends-of-code-magic"]').closest('tr');
  assert.equal(locam.find('td').eq(1).text(), 'Legend');
  assert.equal(locam.find('td').eq(2).text(), '15', 'screenshot provides no denominator or percentile');
  const historical = $('a[href$="/legends-of-code-magic"]').closest('table').not(latest);
  assert.match(historical.text(), /868.*2,600/s, 'retain the historical result');
  assert.match(source, /歷史紀錄（2023-02-12） \/ Historical snapshot \(2023-02-12\)/);
  for (const [file, expected] of [
    ['source/about/images/codingame-legends-code-magic-rank-15-20261002.png', '7c1c852ebf2c0d45dfd147dafb3e563f3f06afed893bcafc533fa45356fd4832'],
    ['source/about/images/codingame-minishogi-overall-rank-3-of-63-20261002.png', '28695610e9e26be82eaf477292e16f9e6e52d9a04b9c9f80ef4c48a7bfcaa182']
  ]) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), expected, 'preserve the supplied screenshot: ' + file);
});
