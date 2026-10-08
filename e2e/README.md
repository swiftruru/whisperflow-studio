# WhisperFlow Studio — 全自動 UI 測試

本資料夾包含 WhisperFlow Studio 的端對端（E2E）UI 自動化測試，使用 [Playwright](https://playwright.dev) 的 `_electron` API 啟動真實的 Electron app，模擬使用者點擊、鍵盤操作，並斷言畫面結果。

## 這是什麼？跟 unit test 有什麼不同？

| 層級 | 測試對象 | 例子 | 本專案 |
|------|---------|------|--------|
| **Unit test** | 單一函式（純邏輯） | `parseSrt('00:01:23,456 --> ...')` 是否回傳正確物件 | Python 端 pytest |
| **E2E / UI test**（本資料夾） | 整個 app 的使用者體驗 | 「點 `中/EN` 按鈕後，畫面上的『主要』有沒有變成『Main』？」 | Playwright |

E2E 測試**啟動完整的 app**，不是檢查 function 回傳值，而是從**使用者畫面的角度**驗證整個流程。

---

## 怎麼跑？

### 一次性安裝（第一次 clone 完專案）

```bash
npm install
```

> Playwright 走 Electron 的 `_electron` API，**不需要** `npx playwright install` 下載 Chromium — 我們驅動的是專案自己的 Electron。

### 執行所有測試（CLI 模式）

```bash
npm run test:e2e
```

預期輸出：

```
Running 5 tests using 1 worker
  ✓  e2e/specs/i18n.spec.js …
  ✓  e2e/specs/navigation.spec.js …
  ✓  e2e/specs/shortcuts-modal.spec.js …
  ✓  e2e/specs/smoke.spec.js …
  ✓  e2e/specs/theme.spec.js …
  5 passed (~10s)
```

### 互動式 UI 模式（demo 用 ⭐）

```bash
npm run test:e2e:ui
```

開啟 Playwright 的互動視窗，可以：

- 看到所有測試案例樹狀列表
- 一鍵跑單一案例
- **時光倒流**檢視每一步當下的畫面（Trace Viewer）
- 即時看 console.log、network、DOM snapshot

→ **這是給老師看 demo 最適合的模式**。

### 開啟最後一次的 HTML 報告

```bash
npm run test:e2e:report
```

報告會自動開啟瀏覽器，包含：

- 每個案例的 pass/fail
- 失敗時的螢幕截圖
- 失敗時的完整 trace（每一步的 DOM、screenshot、console）

---

## 5 個測試案例做什麼？

| 檔案 | 測什麼 | 為什麼重要 |
|------|--------|-----------|
| [smoke.spec.js](specs/smoke.spec.js) | App 啟動、視窗開出、`Main` tab 是 active、狀態徽章顯示 `Idle` | 最基本的煙霧測試 — 啟動失敗會立刻被抓到 |
| [navigation.spec.js](specs/navigation.spec.js) | 依序點四個 tab（主要/模型/設定/關於），驗證 `.active` class 與對應 pane 顯示 | 保證導覽不被未來 refactor 弄壞 |
| [i18n.spec.js](specs/i18n.spec.js) | 點 `中/EN` 按鈕，驗證 tab 文字從 `Main` ⇄ `主要` 翻轉 | 雙語切換是這個 app 的核心，最容易出 i18next bug |
| [theme.spec.js](specs/theme.spec.js) | 點月亮/太陽按鈕，驗證 `<html data-theme>` 在 `light` 與 移除狀態之間切換 | CSS 變數主題系統的回歸測試 |
| [shortcuts-modal.spec.js](specs/shortcuts-modal.spec.js) | 按 `?` 鍵開啟快捷鍵 modal，按 `Esc` 關閉 | 鍵盤可用性 + modal lifecycle 的代表 |

5 個案例**都不需要 mock IPC** — 涵蓋的全是純前端互動。Python venv、模型下載、實際轉錄這些重後端流程**故意不納入 E2E**，因為會跑 5–10 分鐘且需要外部資源（網路、真實音訊）。

---

## 架構說明

### 目錄結構

```
e2e/
├── playwright.config.js           # Playwright 設定（serial、trace on failure）
├── fixtures/
│   ├── electron-app.js            # 共用 fixture：啟動 app、回傳 page、收尾清理
│   └── test-settings.json         # 預先寫好的 settings.json（鎖 en、關 tray）
├── specs/
│   ├── smoke.spec.js              # 案例 1
│   ├── navigation.spec.js         # 案例 2
│   ├── i18n.spec.js               # 案例 3
│   ├── theme.spec.js              # 案例 4
│   └── shortcuts-modal.spec.js    # 案例 5
└── README.md                      # 本檔
```

### 隔離原則

每個測試案例都在**全新的環境**裡跑：

1. fixture 在 `os.tmpdir()` 建立一個臨時 userData 資料夾
2. 把 `fixtures/test-settings.json` 複製進去當作 `settings.json`
3. 用 `WHISPERFLOW_E2E=1` + `WHISPERFLOW_E2E_USERDATA=<tmp>` 啟動 Electron
4. 測試結束後關閉 app、刪除臨時資料夾

→ **不會污染你日常開發用的 `settings.json`、`history.json`、`localStorage`**。

### `WHISPERFLOW_E2E` 環境變數做什麼？

[`src/main/main.js`](../src/main/main.js) 在偵測到這個 flag 時會：

- 跳過 auto-updater 初始化（避免測試時跳更新對話框）
- 跳過 tray icon 建立（避免污染 macOS menubar）
- 把 `settings.json` 路徑強制指向 `WHISPERFLOW_E2E_USERDATA` 指定的臨時資料夾

**對非測試的正常啟動完全沒有影響** — 沒有設這個 env 就走原本邏輯。

---

## 失敗排查

| 症狀 | 可能原因 | 解法 |
|------|---------|------|
| `Could not find Electron app` | 沒有先 `npm install` | `npm install` 後重試 |
| 卡在 `firstWindow()` 30 秒 timeout | 主程序當掉、看 stderr | 加 `DEBUG=pw:browser*` 跑：`DEBUG=pw:browser* npm run test:e2e` |
| 斷言文字對不上（`Main` 變成 `主要`） | settings.json 的 `uiLanguage` 沒被讀到 | 確認 [src/main/main.js](../src/main/main.js) 的 `LOCAL_SETTINGS_PATH` 在 E2E 模式下用 userData |
| `Locator resolved to <... hidden="">` | UI 元素還沒 init 完就被斷言 | 在 fixture 加 `waitForSelector(...)`，或在 spec 用 `await expect().toBeVisible()` 自帶等待 |

---

## 還能擴充什麼？（未來練習方向）

- **mock IPC**：用 `electronApp.evaluate(...)` 在主程序裡 stub `queue:get-state`，就能測 queue 渲染
- **錄製模式**：`npx playwright codegen` 直接點 app、自動產生測試碼
- **CI 整合**：GitHub Actions 跑 macOS runner（成本較高）或 Linux + xvfb
- **視覺回歸**：`expect(window).toHaveScreenshot()` 比對截圖差異
- **無障礙檢查**：用 `@axe-core/playwright` 檢測 ARIA / 對比度
