# 匿名文章按讚服務

這個服務將全站按讚數存入 Cloudflare D1。讀者不需要登入；瀏覽器保存一個隨機 UUID 作為識別碼，資料庫保存它的 HMAC 摘要。文章討論與 GitHub 登入由網站的留言系統分開處理。

2026-10-02 擁有者已授權並完成 Cloudflare 官方登入。正式 Worker 已部署至 `https://owen-blog-likes.goldenaifintech.workers.dev`，使用獨立 D1 與正式 HMAC 密鑰；兩位匿名測試訪客的共享、冪等、保留狀態與取消均通過，測試按讚已取消。本機計數未移入正式資料庫。網站填入此真 endpoint 後仍需成功發布與正式頁面互動驗收，實際收據保存在本機 audit/。

## API

網站設定的 endpoint 是 Worker 的 base URL，例如本機 `http://127.0.0.1:8788`；網站 JS 會加上 `/likes`。直接呼叫 API 時使用完整 `http://127.0.0.1:8788/likes`。正式 base URL 以 Wrangler 實際部署輸出為準。

| 請求 | 內容 | 回應 |
| --- | --- | --- |
| `GET /likes?path=<encodedCanonicalPath>` | 可附 `X-Visitor-Id` UUID v4 header | `{ "path": "/article/", "count": 3, "liked": true }` |
| `POST /likes` | `Content-Type: application/json`、`X-Visitor-Id`；body `{ "path": "/article/", "liked": true }` | 同上 |
| `OPTIONS /likes` | 精確允許的 Origin 與請求 headers | `204` CORS preflight |

GET 不附 visitor header 時 `liked` 是 `null`，count 仍是共享真實數字。POST 是設定狀態：`true` 表示按讚、`false` 表示取消；網路重試不會多加或多扣一次。前端只在伺服器回應成功後更新總數，斷線時保留目前畫面並說明可重試。錯誤回應有 `error` 與繁中 `message`，429 另附 `Retry-After` 秒數。

文章使用既有 permalink，例如 `/202305_～關於我的文章規劃～/`；輸入可以是 UTF-8 percent encoding，回應使用正規化的 Unicode 路徑。未知文章、外部網址、query/fragment、路徑穿越會被拒絕。允許清單在 `src/posts.mjs`，由 `scripts/sync-posts.mjs` 讀取站台建置成功後的 `public/search.json` 自動生成，也可由 `ALLOWED_PATHS` JSON 環境變數覆蓋。新增文章時先完成網站建置，再部署更新過的 Worker；不要改舊文章路徑。

從站台根目錄呼叫 `node services/likes/scripts/sync-posts.mjs` 即可同步，或在服務資料夾執行 `npm run sync-posts`。輸出依 canonical decoded 路徑排序，沒有異動時不重寫；有異動先保存前一版至服務內 `.history/` 再原子替換。來源格式、外部 URL、重複 permalink 或路徑不正確時退出失敗，保留原有清單。這個同步必須放在成功 generate 之後，避免把未完成的建置當成已發布文章。

## 本機開發與驗證

使用 Node.js 24 LTS。以下操作只使用本機模擬資料庫，無需登入 Cloudflare。

```sh
cd services/likes
npm ci
npm test
npm run check
npm run dev:setup
npm run dev:migrate
npm run dev
```

另一個 terminal 執行：

```sh
cd services/likes
node scripts/smoke.mjs
```

`dev:setup` 只在 `.dev.vars` 不存在時產生一個隨機的本機密鑰，不輸出值，也不覆蓋既有密鑰。`.dev.vars`、模擬資料庫和 production config 都被 gitignore。`wrangler.local.jsonc` 故意沒有 production database ID，且沒有任何 remote binding。若工具需要將 log 留在服務資料夾，可在指令前加 `WRANGLER_LOG_PATH=.wrangler/logs WRANGLER_SEND_METRICS=false`。

10 個測試透過真 SQLite 執行 migration 與 SQL，涵蓋多訪客共享計數、併發重試、取消按讚、交易失敗完整 rollback、CORS、路徑與 body 驗證、個別訪客與 IP 限流、摘要隱私與限流資料到期。另有 3 個同步測試核對 canonical permalink、固定排序、拒絕錯誤來源、原子替換與可復原前一版。smoke test 實際呼叫本機 workerd / D1；只允許 loopback，測後取消自己建立的測試按讚。

## 正式啟用

首次啟用須由擁有者完成 Cloudflare 登入並明確授權。本站已完成正式建立與部署；以下保留首次設定程序。例行更新沿用既有資料庫與密鑰，只部署更新後的程式及文章允許清單，不重做建立或產生密鑰。正式 CORS 現僅允許本站 HTTPS origin。

1. 複製 `wrangler.example.jsonc` 為 `wrangler.production.jsonc`。保持 `DB` binding 名稱。
2. 執行 `npx wrangler login`，在開啟的瀏覽器中登入自己的 Cloudflare 帳號。
3. 執行 `npx wrangler d1 create owen-blog-likes --config wrangler.production.jsonc`。把它回傳的真實 `database_id` 填入 production config，並核對 database name。不要把範例佔位符當成 ID。
4. 本機測試與程式檢查通過後，建立 schema：

   ```sh
   npx wrangler d1 migrations apply DB --remote --config wrangler.production.jsonc
   ```

5. 將隨機密鑰直接傳給 Wrangler，不顯示在 terminal、不寫進 Git：

   ```sh
   openssl rand -hex 32 | npx wrangler secret put VISITOR_HMAC_SECRET --config wrangler.production.jsonc
   ```

6. 部署並記下它實際回傳的 Worker URL：

   ```sh
   npx wrangler deploy --config wrangler.production.jsonc
   ```

7. 將網站的 likes endpoint 設成該真實 Worker base URL（不要重複加 `/likes`）。本機與正式網站各驗證一次不同瀏覽器按讚、重新整理、取消與共享計數，再部署網站。正式 CORS 可只保留 `https://yuchen0515.github.io`；需要本機驗證時再保留兩個明確的 4000 port origins。

留言、Buy Me a Coffee/Ko-fi 等服務各自需要真正的帳戶與設定，不會由此匿名按讚服務代辦。網站不需要任何 Cloudflare secret；只有 endpoint 和瀏覽器隨機 UUID。不要將 `.dev.vars` 的密鑰作為正式密鑰。

## 資料與防濫用

- 每個「文章＋visitor HMAC」最多一筆 like，D1 transaction 同時處理限流、狀態變更與回傳 count。沒有獨立累加 counter，避免併發造成總數漂移。
- 預設每訪客每篇每分鐘 12 次寫入；另有每 IP 每篇每分鐘 120 次，降低同一人換 UUID 洗票的能力。兩個門檻可用 `VISITOR_RATE_LIMIT`／`IP_RATE_LIMIT` 調整，不把所有網站讀者鎖在同一個全域配額。GET 不扣寫入配額。
- 只使用 Cloudflare 注入的 `CF-Connecting-IP`，不信任 `X-Forwarded-For`。IP 摘要加入日期與文章做 domain separation，資料庫不保存原始 IP。只有 loopback 的 local config 允許開發 fallback。
- Cron 每天移除超過 24 小時的限流紀錄，保留所有文章 like。此處是應用執行期資料到期，不刪 repository 檔案。取消按讚只移除這個 visitor 的該篇 like。
- 自動 request logging 在 config 關閉；程式不記錄 IP、visitor header、密鑰或 SQL 錯誤。Cloudflare 本身的網路與帳戶資料處理依它的政策。
- 匿名 UUID 不是人類驗證：清掉瀏覽器儲存、更換 IP 或自動化仍可產生新識別碼。這是輕量部落格互動，不能作投票、排行獎勵或一人一票的依據。若實際遇到攻擊，才評估 Turnstile 或 Cloudflare WAF。
- 正式 HMAC 密鑰需要長期保存。更換密鑰不會刪掉既有數量，但既有 UUID 會失去對舊 like 的對應；不能取消舊 like，也可能重新投一次。不要把一般 redeploy 當成重新產生密鑰。

官方資料：[D1 transactions / batch](https://developers.cloudflare.com/d1/worker-api/d1-database/)、[D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)、[Wrangler 設定與本機資料庫](https://developers.cloudflare.com/workers/wrangler/configuration/)、[Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)、[Web Crypto HMAC](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)。
