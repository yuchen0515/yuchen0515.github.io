# 本機寫作桌

在專案根目錄執行 `npm run write`，開啟終端機顯示的 `http://127.0.0.1:4174/`。
連接埠已使用時，可執行 `WRITER_PORT=4175 npm run write`。工具只聆聽本機。

左側「網站頁面」可開啟「個人介紹」或「推薦連結」，也可開啟文章或草稿，直接編輯完整 Markdown，包含標題、日期、標籤等 frontmatter。
按「儲存」或 `⌘/Ctrl + S` 寫回原檔；沒有自動儲存。預覽與正式網站共用 `lib/markdown.cjs` 的 renderer。
手機可切換 Markdown 與預覽。預覽上方的「同步捲動」預設開啟，捲動 Markdown 或預覽時另一邊會對齊相同段落；點擊即可解除，兩邊各自捲動，並記住偏好。重新開啟同步時以最近閱讀的一邊對齊。編輯中預覽更新會保留原文游標與閱讀位置。
原文裡的 HTML 可預覽，預覽區隔離在禁止執行腳本與送出表單的 iframe。原文編輯區採 16px，預覽內文桌面 19px、手機 18px。
雙語文章可切換預覽語言。數學與程式碼沿用網站樣式；Mermaid 圖表在寫作桌保留原始碼，正式網站才執行圖表渲染。

複製截圖或在圖片上按右鍵「複製圖片」，在 Markdown 編輯區按 `⌘/Ctrl + V` 即可插入並立即預覽，不必先命名或另存檔。也可按「貼上圖片」直接讀取剪貼簿、拖入圖片，或按「加入圖片」選檔。支援 12 MB 以內的 PNG、JPEG、WebP、GIF。
「複製圖片網址」只會取得文字連結；請選「複製圖片」。瀏覽器未提供剪貼簿讀取或拒絕授權時，仍可在編輯區使用系統貼上。Safari 可能顯示原生「貼上」選單，選取後才會讀取圖片。
圖片加入後，下方可「複製圖片語法」，貼進其他文章、個人介紹或推薦連結，重用同一個本機資產。
加入期間保留原插入位置，即使移動游標或繼續輸入，也不會覆蓋新選取的文字；完成前暫停切換文件及儲存。純文字貼上與拖入維持瀏覽器原生操作。
圖片存入 `source/images/uploads/`，並插入 `/images/uploads/...` 的 Markdown 引用；沒有外部圖床。
不接收 SVG。圖片加入後仍需儲存文章。

「新增草稿」只建立 `source/_drafts/*.md`。儲存草稿不會發佈網站。
已在 `source/_posts` 的文章修改後，也要走網站既有 build／deploy 流程才會更新線上內容。

每次覆寫文章前，工具先把原文與來源路徑存到 `.history/writer/`。修訂按 `pages`／`posts`／`drafts` 及來源路徑的 SHA256 前 16 碼分組，每份 `.md` 旁的 `.json` 記錄原檔位置。
工具遇到外部編輯器已改過原檔時會拒絕覆寫；先複製編輯區文字，再重新開啟文章比對。
可再次點選目前文章，重新讀取原檔。用 CLI 新增或發佈文章後，按清單旁的重新整理按鈕更新檔案列表。
不需要還原時也保留修訂檔。圖片與修訂沒有自動清除。

啟動時產生新的 session token；它放在本機頁面的 meta 標籤，由父頁 API 請求帶入。一般介面、網址與終端機 log 都不顯示 token。重新啟動工具後，瀏覽器頁面也要重新整理。
API 限制來源、Host 與 token；頁面編輯僅允許 `source/about/index.md` 與 `source/links/index.md`，其他檔案操作維持文章、草稿、圖片與修訂資料夾限制，拒絕符號連結與穿越路徑。

執行 `node --test tools/writer/test.mjs` 驗證儲存修訂、衝突處理、圖片與本機 API 限制。
測試只在 `tools/writer/.fixtures/` 建立隔離資料，保留收據，不碰既有文章。
剪貼簿相容性以 [WebKit 官方說明](https://webkit.org/blog/10855/async-clipboard-api/) 與 [Clipboard.read 文件](https://developer.mozilla.org/en-US/docs/Web/API/Clipboard/read) 為依據；實際驗收瀏覽器以收據為準。

另可執行 `node tools/writer/browser-check.mjs`，使用已安裝的 Google Chrome 檢查畫面、貼圖、數學排版與安全隔離，並保留桌面與手機截圖。
