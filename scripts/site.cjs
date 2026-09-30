const fs = require('node:fs');
const path = require('node:path');
const cheerio = require('cheerio');
const {languageParts} = require('../lib/markdown.cjs');
require('../lib/public-assets.cjs').installPublicAssetFilter(hexo);
const plain = html => cheerio.load(html).text().replace(/\s+/g,' ').trim();
hexo.extend.helper.register('icon', function(name) {
  if (!/^[a-z-]+$/.test(name)) throw new Error('Invalid icon name');
  const svg = fs.readFileSync(path.join(hexo.base_dir,'node_modules/lucide-static/icons',`${name}.svg`),'utf8');
  return svg.replace('<svg','<svg class="icon" aria-hidden="true" focusable="false"');
});
hexo.extend.helper.register('summary', function(post, size = 130) {
  const $ = cheerio.load(post.content || '');
  $('[data-language="en"],script,style,pre,.code-copy').remove();
  const text = $('p').first().text() || $.text();
  return text.trim().slice(0,size) + (text.length > size ? '…' : '');
});
hexo.extend.helper.register('reading_minutes', function(post) {
  const $ = cheerio.load(post.content || ''); $('[data-language="en"],script,style').remove();
  return Math.max(1,Math.ceil($.text().length / 450));
});
hexo.extend.helper.register('content_toc', function(content) {
  const $ = cheerio.load(content || '');
  return $('h2[id],h3[id]').map((i,el)=>({id:$(el).attr('id'),title:$(el).text(),level:el.tagName,language:$(el).closest('[data-language]').attr('data-language') || 'all'})).get();
});
hexo.extend.helper.register('issue_number', function(post) {
  const issue = post.github_issue ?? this.theme.comments?.issues?.[post.slug] ?? (post.path?.startsWith('links/') ? this.theme.comments?.issues?.links : null);
  if (issue !== null && issue !== undefined && (!Number.isInteger(issue) || issue <= 0)) throw new Error(`github_issue 必須是實際的正整數 Issue 編號：${post.slug || post.path}`);
  return issue;
});
hexo.extend.generator.register('site-search', function(locals) {
  return {path:'search.json',data:JSON.stringify(locals.posts.sort('-date').map(post => {
    const $ = cheerio.load(post.content || ''); $('script,style,.code-copy').remove();
    return {title:post.title,title_en:post.title_en || '',url:'/'+post.path,date:post.date.format('YYYY-MM-DD'),categories:post.categories.map(c=>c.name),tags:post.tags.map(t=>t.name),text:$.text().replace(/\s+/g,' ').trim()};
  }))};
});
hexo.extend.generator.register('not-found',()=>({path:'404.html',layout:'not-found',data:{title:'找不到這一頁'}}));
hexo.extend.generator.register('legacy-pages',()=>[
  {path:'about/index_20250423.html',layout:'legacy-redirect',data:{title:'關於我',redirect_to:'/about/'}},
  {path:'README.html',layout:'legacy-redirect',data:{title:'Owen Lin 的文章與筆記',redirect_to:'/'}}
]);
hexo.extend.filter.register('before_generate', function() {
  const settings = hexo.theme.config;
  if (settings.support_url && !/^https:\/\//.test(settings.support_url)) throw new Error('support_url 必須是已設定的 HTTPS 公開贊助頁。');
  if (settings.comments?.enabled !== false) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(settings.comments?.repo || '')) throw new Error('comments.repo 必須是實際 GitHub repo 的 owner/name。');
    if (Object.values(settings.comments?.issues || {}).some(issue => !Number.isInteger(issue) || issue <= 0)) throw new Error('comments.issues 必須使用實際的正整數 Issue 編號。');
    const giscus = settings.giscus || {};
    if (giscus.enabled && Boolean(giscus.category) !== Boolean(giscus.category_id)) throw new Error('giscus.category 與 category_id 必須一起填入 GitHub 的實際分類資料。');
    if (giscus.enabled && giscus.category_id && !giscus.repo_id) throw new Error('giscus.repo_id 必須填入實際 GitHub repo node ID。');
  }
});
