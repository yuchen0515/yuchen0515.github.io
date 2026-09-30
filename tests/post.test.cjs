const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const {spawnSync}=require('node:child_process');
test('post CLI keeps draft preimages and refuses replacement or path traversal',()=>{
  const parent=path.resolve('.history/tests');fs.mkdirSync(parent,{recursive:true});const root=fs.mkdtempSync(path.join(parent,'post-cli-'));
  fs.mkdirSync(path.join(root,'tools/writer'),{recursive:true});fs.mkdirSync(path.join(root,'source/_drafts'),{recursive:true});fs.mkdirSync(path.join(root,'source/_posts'),{recursive:true});
  for(const file of ['tools/post.mjs','tools/writer/storage.mjs'])fs.copyFileSync(file,path.join(root,file));
  const run=(...args)=>spawnSync(process.execPath,[path.join(root,'tools/post.mjs'),...args],{encoding:'utf8'});
  assert.equal(run('new','測試文章').status,0);const draft=path.join(root,'source/_drafts/測試文章.md');const original=fs.readFileSync(draft,'utf8');
  assert.equal(run('publish','測試文章').status,0);assert.equal(fs.readFileSync(path.join(root,'source/_posts/測試文章.md'),'utf8'),original);assert.equal(fs.existsSync(draft),false);
  const batches=fs.readdirSync(path.join(root,'.history/published-drafts'));assert.equal(batches.length,1);assert.equal(fs.readFileSync(path.join(root,'.history/published-drafts',batches[0],'測試文章.md'),'utf8'),original);
  assert.equal(run('new','測試文章').status,0);assert.notEqual(run('publish','測試文章').status,0);assert.equal(fs.readFileSync(draft,'utf8'),original);assert.equal(fs.readFileSync(path.join(root,'source/_posts/測試文章.md'),'utf8'),original);
  assert.notEqual(run('publish','../../README').status,0);assert.equal(fs.existsSync(draft),true);
});
