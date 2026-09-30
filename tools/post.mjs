import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {WriterStore, documentParts} from './writer/storage.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const [command,...args]=process.argv.slice(2), argument=args.join(' ');
try {
  const store=await new WriterStore(root).initialize();
  if(command==='new') {
    const draft=await store.createDraft(argument);
    console.log(`草稿已建立：source/_${draft.id}\n執行 npm run write 即可編輯與貼上圖片。`);
  } else if(command==='publish') {
    const name=argument.replace(/^source\/_drafts\//,'').replace(/^drafts\//,'').replace(/\.md$/,'');
    const draft=await store.read(`drafts/${name}.md`);
    if(!draft.content.trim())throw Error('空白草稿不能發佈。');
    const targetParts=documentParts(`posts/${name}.md`);
    // Exclusive creation never overwrites an existing published article.
    await store.exclusiveWrite(targetParts,draft.content);
    const stamp=new Date().toISOString().replace(/[:.]/g,'-');
    const archive=['.history','published-drafts',stamp,...documentParts(draft.id).slice(2)];
    const destination=await store.checked(archive,{createParents:true});
    await fs.rename(await store.checked(documentParts(draft.id)),destination);
    console.log(`文章已放入：source/_posts/${name}.md\n草稿前像保留於 .history/published-drafts/${stamp}/\n執行 npm run build 與 npm run check，再按 README 的部署流程更新線上網站。`);
  } else {
    throw Error('用法：npm run new -- "文章標題"，或 npm run publish -- "草稿檔名（不含 .md）"。');
  }
} catch(error) { console.error(error.code==='EEXIST'?'同名文章已存在，未覆寫；請更換檔名或編輯原文。':error.message);process.exitCode=1; }
