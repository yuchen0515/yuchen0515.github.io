# 2026-10-02 編修驗收快照

這六份 Markdown 是完成英文校對、原文恢復與本人此次排名更新時的公開頁面原樣快照，檔案 bytes 與當時 source 完全一致。`../chinese-preservation.json` 保留原始來源 `path`、中文區塊 hash、此次 About 共同附錄 hash，並新增 `snapshotPath` 與完整快照 `snapshotSha256`。

英文校對、原文恢復及本次排名數值的歷史驗收讀取快照；原始中文證據仍保留在 `../author-originals/`。截圖原件以帶日期的 source/about/images 檔名保留並核 SHA。這些歷史基準不要求本人未來修改文章、個人介紹、推薦連結或排名時同步編輯測試。

日常 source 由共用 renderer、build、站內資產／網址／錨點檢查與瀏覽器驗收；寫作桌只修改 source 文件與圖片，沒有修改測試基準的權限。`tests/editorial-isolation.test.cjs` 在隔離子程序拒絕讀取六份 live Markdown，確認歷史驗收不會再次綁住本人可編輯的內容。

快照不含草稿、修訂前像、憑證或本機設定。這是測試證據，不是另外一份寫作來源。
