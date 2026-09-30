const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {uploadReference, referencedUploads, publicUploads, installPublicAssetFilter} = require('../lib/public-assets.cjs');

test('published Markdown, HTML, page covers and reference links retain uploads; drafts and code do not', () => {
  const documents = [
    ['source/_posts/public.md', '![image](/images/uploads/public.png?size=2#view)\n![reference][asset]\n\n[asset]: /images/uploads/referenced.png\n\n```html\n<img src="/images/uploads/code-only.png">\n```'],
    ['source/about/index.md', '---\ncover: /images/uploads/cover.png\n---\n<img src="/images/uploads/中文%20圖.png?v=2&amp;size=3">'],
    ['source/links/index.md', '<source srcset="/images/uploads/small.png 1x, /images/uploads/large.png 2x">'],
    ['source/_drafts/private.md', '![private](/images/uploads/private.png)'],
    ['source/_posts/hidden-legacy.md', 'title: Private\npublished: false\n---\n\n![private](/images/uploads/legacy-private.png)'],
    ['source/_posts/hidden-wrapped.md', '---\ntitle: Private\npublished: false\n---\n\n![private](/images/uploads/wrapped-private.png)']
  ];
  const allowed = referencedUploads(documents);
  assert.deepEqual([...allowed].sort(), ['cover.png','large.png','public.png','referenced.png','small.png','中文 圖.png'].map(name=>'source/images/uploads/'+name).sort());
  assert.equal(allowed.has('source/images/uploads/private.png'),false);
  assert.equal(allowed.has('source/images/uploads/code-only.png'),false);
});

test('query strings and encoded names resolve without authorizing traversal or off-site URLs', () => {
  assert.equal(uploadReference('/images/uploads/space%20name.png?v=1#zoom'),'source/images/uploads/space name.png');
  assert.equal(uploadReference('https://yuchen0515.github.io/images/uploads/public.png','https://yuchen0515.github.io/'),'source/images/uploads/public.png');
  for (const value of ['/images/uploads/../uploads/secret.png','/images/uploads/%2e%2e/secret.png','/images/uploads/%252e%252e/secret.png','/images/uploads/%5csecret.png','/images/uploads/%00secret.png','//evil.example/images/uploads/secret.png','https://evil.example/images/uploads/secret.png','images/uploads/secret.png','/images/uploads/%ZZ']) assert.equal(uploadReference(value,'https://yuchen0515.github.io/'),null,value);
});

test('route filtering updates after publication and never alters local assets or legacy images', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'blog-upload-privacy-'));
  const write=(name,content)=>{const target=path.join(root,name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,content);};
  write('source/_posts/public.md','![published](/images/uploads/public.png)');
  write('source/_drafts/private.md','![draft](/images/uploads/private.png)');
  write('source/images/uploads/public.png','public image bytes');
  write('source/images/uploads/private.png','private image bytes');
  write('source/images/legacy.png','legacy author image');
  const routes=[{path:'images/uploads/public.png'},{path:'images/uploads/private.png'},{path:'images/legacy.png'}];
  const hooks=[],generators=new Map([['asset',async()=>routes]]);
  const hexo={base_dir:root,extend:{filter:{register:(_,fn)=>hooks.push(fn)},generator:{get:name=>generators.get(name),register:(name,fn)=>generators.set(name,fn)}}};
  installPublicAssetFilter(hexo);hooks[0]();
  assert.deepEqual((await generators.get('asset')()).map(route=>route.path),['images/uploads/public.png','images/legacy.png']);
  assert.deepEqual([...publicUploads(root)],['source/images/uploads/public.png']);
  write('source/_posts/published-draft.md',fs.readFileSync(path.join(root,'source/_drafts/private.md'),'utf8'));
  hooks[0]();
  assert.deepEqual((await generators.get('asset')()).map(route=>route.path),routes.map(route=>route.path));
  assert.equal(fs.readFileSync(path.join(root,'source/images/uploads/private.png'),'utf8'),'private image bytes');
  assert.equal(fs.readFileSync(path.join(root,'source/_drafts/private.md'),'utf8'),'![draft](/images/uploads/private.png)');
});

test('real Hexo output excludes a draft upload and includes it after publication, preserving its local bytes', async () => {
  const Hexo=require('hexo');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'blog-hexo-upload-privacy-'));
  const write=(name,content)=>{const target=path.join(root,name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,content);};
  write('_config.yml','url: https://yuchen0515.github.io\ntheme: ""\n');
  write('package.json','{"name":"isolated-upload-fixture","version":"1.0.0"}');
  write('source/about/index.md','---\nlayout: false\n---\n<img src="/images/uploads/public.png">');
  write('source/_drafts/private.md','---\ntitle: Private draft\n---\n![private](/images/uploads/private.png)');
  write('source/_posts/hidden-legacy.md','title: Hidden legacy draft\npublished: false\n---\n\n![private](/images/uploads/legacy-private.png)');
  write('source/images/uploads/public.png','public image bytes');
  write('source/images/uploads/private.png','private image bytes');
  write('source/images/uploads/legacy-private.png','legacy private image bytes');
  write('source/images/legacy.png','legacy author image');
  const hexo=new Hexo(root,{silent:true});
  await hexo.init();
  hexo.extend.renderer.register('md','html',data=>new (require('markdown-it'))({html:true}).render(data.text),true);
  installPublicAssetFilter(hexo);
  try {
    await hexo.call('generate');
    assert.equal(fs.existsSync(path.join(root,'public/images/uploads/private.png')),false);
    assert.equal(fs.existsSync(path.join(root,'public/images/uploads/legacy-private.png')),false);
    assert.equal(fs.readFileSync(path.join(root,'public/images/uploads/public.png'),'utf8'),'public image bytes');
    assert.equal(fs.readFileSync(path.join(root,'public/images/legacy.png'),'utf8'),'legacy author image');
    write('source/links/index.md','---\nlayout: false\n---\n![published](/images/uploads/private.png)');
    await hexo.call('generate');
    assert.equal(fs.readFileSync(path.join(root,'public/images/uploads/private.png'),'utf8'),'private image bytes');
    assert.equal(fs.readFileSync(path.join(root,'source/images/uploads/private.png'),'utf8'),'private image bytes');
    assert.equal(fs.existsSync(path.join(root,'source/_drafts/private.md')),true);
    assert.equal(fs.readFileSync(path.join(root,'source/images/uploads/legacy-private.png'),'utf8'),'legacy private image bytes');
  } finally {await hexo.exit();}
});
