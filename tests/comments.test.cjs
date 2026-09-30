const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const ejs = require('ejs');
const yaml = require('js-yaml');

const project = path.resolve(__dirname, '..');
const settings = yaml.load(fs.readFileSync(path.join(project, 'themes/owen/_config.yml'), 'utf8'));
const helpers = new Map(), filters = new Map();
const scriptPath = path.join(project, 'scripts/site.cjs');
const hexo = {base_dir: project, theme: {config: settings}, extend: {
  helper: {register: (name, fn) => helpers.set(name, fn)},
  filter: {register: (name, fn) => filters.set(name, fn)},
  generator: {register: () => {}}
}};
vm.runInNewContext(fs.readFileSync(scriptPath, 'utf8'), {
  require: createRequire(scriptPath),
  hexo
});
const issueNumber = page => helpers.get('issue_number').call({theme: settings}, page);
const template = fs.readFileSync(path.join(project, 'themes/owen/layout/_partial/engagement.ejs'), 'utf8');

test('existing article discussions keep their exact real issue mappings', () => {
  for (const [slug, number] of Object.entries(settings.comments.issues)) {
    assert.equal(issueNumber(slug === 'links' ? {path: 'links/index.html'} : {slug}), number);
  }
  assert.equal(issueNumber({slug: 'new-article'}), null);
  assert.equal(issueNumber({slug: 'new-article', github_issue: 12}), 12);
  for (const value of [0, -1, '12', 1.5]) assert.throws(() => issueNumber({slug: 'invalid-article', github_issue: value}), /正整數/);
});

test('on-site comments are the primary action, with no exposed authentication configuration', () => {
  const html = ejs.render(template, {
    page: {path: '202209_MIRlab-owen-lin-RD-page/index.html', slug: 'MIRlab-owen-lin-RD-page'},
    theme: settings, issue_number: issueNumber, icon: () => '<svg aria-hidden="true"></svg>'
  });
  assert.match(html, /href="#discussion" data-open-comments/);
  assert.match(html, /data-issue="8"/);
  assert.match(html, /data-comment-widget data-comment-configured="false"/);
  assert.match(html, /留言功能正在設定中/);
  assert.match(html, /data-comment-retry hidden/);
  assert.match(html, /https:\/\/github.com\/yuchen0515\/yuchen0515.github.io\/issues\/8/);
  assert.doesNotMatch(html, /issues\/new|在 GitHub 參與討論|client[_-]?[Ss]ecret|https:\/\/giscus.app\/client.js/);
});

test('new article comments use provider mapping without inventing an issue or outbound posting link', () => {
  const html = ejs.render(template, {
    page: {path: 'new-article/index.html', slug: 'new-article'},
    theme: settings, issue_number: issueNumber, icon: () => '<svg aria-hidden="true"></svg>'
  });
  assert.match(html, /data-issue=""/);
  assert.match(html, /data-comment-widget/);
  assert.doesNotMatch(html, /issues\/new|data-comment-fallback/);
});

test('configured discussions render only the real repo metadata and an on-site container', () => {
  const html = ejs.render(template, {
    page: {path: 'new-article/index.html', slug: 'new-article'},
    theme: {...settings, giscus: {...settings.giscus, category: 'Isolated test fixture', category_id: 'DIC_fixture'}},
    issue_number: issueNumber, icon: () => '<svg aria-hidden="true"></svg>'
  });
  assert.match(html, /data-comment-configured="true"/);
  assert.match(html, /data-comment-repo-id="R_kgDOHSayAQ"/);
  assert.match(html, /data-comment-category-id="DIC_fixture"/);
  assert.doesNotMatch(html, /留言功能正在設定中/);
});

test('build rejects malformed comment repositories and issue configuration', () => {
  const validate = config => {hexo.theme.config = config; return filters.get('before_generate')();};
  assert.doesNotThrow(() => validate(settings));
  assert.throws(() => validate({...settings, comments: {repo: '', issues: {}}}), /comments.repo/);
  assert.throws(() => validate({...settings, comments: {repo: settings.comments.repo, issues: {article: 0}}}), /comments.issues/);
  assert.throws(() => validate({...settings, giscus: {...settings.giscus, category: 'Incomplete'}}), /必須一起填入/);
  assert.doesNotThrow(() => validate({...settings, comments: {enabled: false}}));
});
