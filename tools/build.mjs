import {existsSync, mkdirSync, renameSync, cpSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const batch = path.join('.history', 'build', `${new Date().toISOString().replace(/[:.]/g,'-')}-${process.pid}`);
for (const file of ['public','db.json','themes/owen/source/vendor']) if (existsSync(file)) {
  const archived=path.join(batch,file);mkdirSync(path.dirname(archived), {recursive:true}); renameSync(file,archived);
}
mkdirSync('themes/owen/source/vendor', {recursive:true});
cpSync('node_modules/katex/dist/katex.min.css','themes/owen/source/vendor/katex.min.css');
cpSync('node_modules/katex/dist/fonts','themes/owen/source/vendor/fonts',{recursive:true});
cpSync('node_modules/mermaid/dist/mermaid.min.js','themes/owen/source/vendor/mermaid.min.js');
const result = spawnSync(process.execPath,['node_modules/hexo/bin/hexo','generate'],{stdio:'inherit'});
if(result.status === 0){
  const sync = spawnSync(process.execPath,['services/likes/scripts/sync-posts.mjs'],{stdio:'inherit'});
  process.exitCode = sync.status ?? 1;
}else process.exitCode = result.status ?? 1;
