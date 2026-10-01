# 資產來源

- Lucide SVG：`lucide-static` 套件，ISC 授權。介面與原文既有空白 icon 對應使用它；作者寫的 emoji 保留。
- KaTeX 字型與 CSS：`katex` 套件，MIT 授權，建置時一起複製；HTML 與樣式使用同一版本。
- Mermaid：`mermaid` 套件，MIT 授權，建置時保存本機 bundle。
- JetBrains Mono：沿用原主題的 `JetBrainsMono-Regular.woff2`，SIL Open Font License；原件保留在 `.history/retired-legacy-20261001/themes/Arknights/`。
- 師大標誌 `source/images/logos/ntnu.png`：取自[國立臺灣師範大學官方網站](https://www.ntnu.edu.tw/cherry_images/logo-mobile.png)。用於作者教育與工作經歷的品牌識別，未改作。舊 Wikimedia 圖片在真瀏覽器遭 ORB 阻擋；renderer 對該失效 URL 使用此本機資產，Markdown 原文保留。
- TOI 標誌 `source/images/logos/toi.png`：取自[TOI 官方網站](https://tpmso.k12ea.gov.tw/toi/)當前 header 的[官方 PNG](https://tpmso.k12ea.gov.tw/toi/wp-content/uploads/2022/02/TOI_logo.png)，保留原始圖片 bytes，供作者命題經歷的品牌識別。官網標示 © 2022 TOI 工作小組，未宣稱開放授權。舊圖網址改為導向 HTML，renderer 僅替換該精確圖片 URL；Markdown 原文不變。透明底黑字加白色底板，以維持深色模式可讀。
- 文章／About／Links 圖片：原網站作者資產，保留原路徑；圖片貼上新增資產存於 `source/images/uploads/`。
- 2026-10-02 CodinGame 排名截圖：本人此次提供的原始 PNG，保存於 `source/about/images/codingame-legends-code-magic-rank-15-20261002.png` 與 `codingame-minishogi-overall-rank-3-of-63-20261002.png`；沒有裁切或重製。供本人競賽成績說明，不宣稱平台圖片為開放授權。
- 留言主題 CSS：以 giscus 官方 [light.css](https://github.com/giscus/giscus/blob/main/styles/themes/light.css) 與 [dark.css](https://github.com/giscus/giscus/blob/main/styles/themes/dark.css) 的 Primer 色彩變數為基礎，調整網站紙色／墨色與閱讀字體。Primer MIT 完整授權在 [docs/licenses/primer-MIT.txt](licenses/primer-MIT.txt)，發布的 CSS 同時保留授權全文。

網站不需外部 icon font、Google Fonts 或外部公式腳本。文章自行引用的其他外部圖片／連結仍依其來源服務提供。
