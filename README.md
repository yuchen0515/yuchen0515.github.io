# Owen Lin 的文章與筆記

網站：<https://yuchen0515.github.io/>。使用 Hexo 與 Markdown，介面採 Lucide SVG。

## 本機寫作

使用 Node.js 22.12 以上，先執行 `npm ci`，再執行 `npm run write`，開啟終端機顯示的本機網址。

寫作桌可編輯文章、草稿、個人介紹與推薦連結。完整 Markdown 與 frontmatter 都保留；網站與預覽使用同一套 renderer。按「儲存」或 `⌘/Ctrl + S` 寫回原檔；外部修改會觸發版本衝突保護。

複製截圖或右鍵「複製圖片」後，在 Markdown 按 `⌘/Ctrl + V`，也可按「貼上圖片」、拖入或選取圖片。圖片存在本機網站資產，加入後可複製 Markdown 語法重用。左右預覽可同步捲動，也可解除同步。

未儲存內容在瀏覽器保留備份，重載後可明確還原或下載；每個頁籤互相獨立。「下載 Markdown」可帶走目前編輯內容。瀏覽器備份不會自動寫回原檔；清除瀏覽器資料會移除這些備份。

新增草稿：`npm run new -- "文章標題"`。準備公開：`npm run publish -- "草稿檔名（不含 .md）"`。這一步尚未更新線上網站。

草稿與標成 `published: false` 的文章不公開。貼上的圖片只有被公開文章或頁面引用時才隨網站發布。

詳細操作見 [寫作桌說明](tools/writer/README.md)。

## 渲染與閱讀

程式碼使用有語言名稱的 fenced code block；表格使用 Markdown 分隔列。公式支援 `$...$` 與 `$$...$$`；Mermaid 使用 `mermaid` code fence。

雙語內容使用配對的 `<!-- LANG:ZH START -->`／`END` 與 `LANG:EN` 標記，區塊外的內容共用；缺漏會直接報錯。作者的 HTML、已公開網址與舊錨點保留。

網站提供搜尋、深色模式、雙語閱讀、可收合手機目錄、圖片放大與程式碼複製。留言使用站內 giscus，匿名愛心使用獨立服務。設定方式見 [留言文件](docs/COMMENTS.md) 與 [愛心服務](services/likes/README.md)。公開贊助頁可填入主題設定的 `support_url`。

## 驗證與發布

```sh
npm test
npm run build
npm run check
npm run preview
```

網站透過 GitHub Actions 從 `source` 分支建置與部署。提交並核對要公開的檔案後，使用 `npm run release:prepare` 準備公開分支；工具會檢查公開檔案政策與歷史，遇到不符合項目就停止。

確認公開候選後才執行 `git push origin source:source`。推送是對外發佈，GitHub 上也可閱讀提交歷史。發布後核對 Actions 結果與正式網站。
