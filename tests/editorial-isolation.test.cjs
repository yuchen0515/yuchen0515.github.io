const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const baseline = require('./fixtures/chinese-preservation.json');

test('historical editorial checks remain independent of later author edits to live Markdown', () => {
  const root = path.resolve(__dirname, '..');
  const liveFiles = baseline.map((entry) => path.resolve(root, entry.path));
  // The child keeps real fixtures and renderer code, but makes every original live document unreadable.
  // A historical check accidentally reading an editable page must fail instead of freezing its content.
  const probe = `
    const fs = require('node:fs');
    const path = require('node:path');
    const live = new Set(${JSON.stringify(liveFiles)});
    const read = fs.readFileSync;
    fs.readFileSync = function (file, ...options) {
      if (typeof file === 'string' && live.has(path.resolve(file))) {
        throw new Error('Historical editorial checks must not freeze an editable author document.');
      }
      return read.call(this, file, ...options);
    };
    require(${JSON.stringify(path.join(__dirname, 'english.test.cjs'))});
    require(${JSON.stringify(path.join(__dirname, 'markdown.test.cjs'))});
  `;
  const result = spawnSync(process.execPath, ['-e', probe], {cwd: root, encoding: 'utf8', timeout: 20_000});
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /reviewed English snapshots preserve/);
  assert.match(result.stdout, /reviewed About snapshot distinguishes/);
  assert.match(result.stdout, /reviewed Chinese article snapshots match/);
});
