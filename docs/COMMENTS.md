# 站內留言啟用

訪客會在文章下方閱讀、撰寫與回覆；登入使用 giscus 的 GitHub OAuth 流程。網站不保存 OAuth client secret。匿名文章愛心不受留言登入影響。

目前 repo 的 Discussions 尚未啟用，沒有真 category ID；網站呈現設定中，不會載入其他人的 repo 當示範留言。以下操作需使用網站擁有者的 GitHub 帳戶。

1. 開啟 [網站 repo 設定](https://github.com/yuchen0515/yuchen0515.github.io/settings)，在 General → Features 啟用 Discussions。
2. 安裝 [giscus App](https://github.com/apps/giscus)，選 Only select repositories，只選 `yuchen0515.github.io`。
3. 選擇或建立公告（Announcements）類型的分類，例如「文章留言」。由維護者及 giscus 建立文章討論，訪客仍可留言與回覆。
4. 在 [giscus 繁體中文設定頁](https://giscus.app/zh-TW) 填 `yuchen0515/yuchen0515.github.io`，選剛建立的分類。把產生的 `data-category` 與 `data-category-id` 填入 `themes/owen/_config.yml` 的 `giscus.category`／`category_id`。
5. 執行 build／check／preview，核對登入回到文章後能直接繼續留言；正式發布後再驗證真送出、回覆、手機及深色樣式。正式驗收必須另記錄，不能拿 provider fixture 收據當成已啟用。

已核對真 repo ID `R_kgDOHSayAQ`，設定已填入。文章依固定網址對應討論，語言切換不影響歸屬；第一則留言才會建立討論。匿名愛心保留獨立計數，giscus 的文章 reactions 關閉。

既有 Issues 8／9／10／11 及 Links 6 保留，不轉換或刪除。目前唯讀核對皆無留言。舊 Gitalk 的公開 secret 仍需在原 OAuth App 撤銷，安裝 giscus 不代表已撤銷舊憑證。

留言主題使用本站 HTTPS CSS，內文與輸入框 18px、按鈕至少 44px。localhost 預覽採官方淺色／深色主題，避免外部 HTTPS iframe 讀取本機 CSS 的限制；正式 CSS 字級以隔離 fixture 驗證，真 giscus 仍需上線後核對。

設定條件與分類類型依 [giscus 官方文件](https://giscus.app/zh-TW)；自訂 CSS 與動態主題依 [進階用法](https://github.com/giscus/giscus/blob/main/ADVANCED-USAGE.md)。
