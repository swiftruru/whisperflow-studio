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
Running 8 tests using 1 worker
  ✓  e2e/specs/i18n.spec.js …
  ✓  e2e/specs/isolation.spec.js …（3 項）
  ✓  e2e/specs/navigation.spec.js …
  ✓  e2e/specs/shortcuts-modal.spec.js …
  ✓  e2e/specs/smoke.spec.js …
  ✓  e2e/specs/theme.spec.js …
  8 passed (~17s)
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

## 8 個測試案例做什麼？

| 檔案 | 測什麼 | 為什麼重要 |
|------|--------|-----------|
| [smoke.spec.js](specs/smoke.spec.js) | App 啟動、視窗開出、`Main` tab 是 active、狀態徽章顯示 `Idle` | 最基本的煙霧測試 — 啟動失敗會立刻被抓到 |
| [navigation.spec.js](specs/navigation.spec.js) | 依序點四個 tab（主要/模型/設定/關於），驗證 `.active` class 與對應 pane 顯示 | 保證導覽不被未來 refactor 弄壞 |
| [i18n.spec.js](specs/i18n.spec.js) | 點 `中/EN` 按鈕，驗證 tab 文字從 `Main` ⇄ `主要` 翻轉 | 雙語切換是這個 app 的核心，最容易出 i18next bug |
| [theme.spec.js](specs/theme.spec.js) | 點月亮/太陽按鈕，驗證 `<html data-theme>` 在 `light` 與 移除狀態之間切換 | CSS 變數主題系統的回歸測試 |
| [shortcuts-modal.spec.js](specs/shortcuts-modal.spec.js) | 按 `?` 鍵開啟快捷鍵 modal，按 `Esc` 關閉 | 鍵盤可用性 + modal lifecycle 的代表 |
| [isolation.spec.js](specs/isolation.spec.js) | App 讀到的是 fixture 的 config、`models_dir` 的寫入落在隔離目錄、專案樹的 `config.json` 不含暫存路徑 | 這套測試曾經會讀寫開發者本機的 `config.json`，這三項把修好的隔離釘住 |

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
3. 在同一個臨時目錄下建 `python-config/`，從 `config.example.json` seed 一份
   `config.json`，並把 `media_root_path` 指向一個同樣在臨時目錄裡、確實存在的資料夾
4. 用 `WHISPERFLOW_E2E=1` + `WHISPERFLOW_E2E_USERDATA=<tmp>` +
   `WHISPERFLOW_E2E_CONFIG_DIR=<tmp>/python-config` 啟動 Electron
5. 測試結束後關閉 app、刪除臨時資料夾

→ **不會污染你日常開發用的 `settings.json`、`history.json`、`localStorage`，
也不會動到 `python/config/config.json`**。

第 3 步不是可有可無的。在它存在之前，這套測試會讀、而且會**建立**開發者本機的
`python/config/config.json`：`readConfig` 在檔案不存在時會建立它，接著
`ensureModelsDirInConfig` 會把 fixture 的臨時 userData 路徑寫進 `models_dir`
——而那個目錄在測試結束時就被刪掉。全新 clone 如果在第一次啟動 App 之前先跑
e2e，`config.json` 的 `models_dir` 就會指向一個已不存在的目錄。同時 `smoke` 的
狀態徽章斷言也因此取決於本機的 `media_root_path` 設成什麼，在多數機器上是紅的。

`config.metadata.json` **刻意不隨之搬移**：那是追蹤中的唯讀檔，永遠從 App 自己的
樹讀取。覆寫只作用在可寫的那一半（`config.json` 與 profile 子目錄），而且只在
`WHISPERFLOW_E2E=1` 時生效，所以誤設的環境變數不可能改到正常啟動的路徑。

路徑只有一個解析點：`src/main/path-resolver.js` 的 `getPythonConfigDir()`。這很
重要——`preflight-checker.js` 與 `ipc-handlers.js` 都要組出 config 路徑，而
`ipc-handlers.js` 裡原本有 11 處各自組（包含 `config:write` 與每一個 profile
操作），只修其中一處會讓其餘繼續讀寫真實檔案。

**已知邊界：隔離只到 Electron 這一側。** `bridge/run_cli.py` 在 Python 端自己組
`PYTHON_DIR / "config" / "config.json"`，不認得 `WHISPERFLOW_E2E_CONFIG_DIR`。
目前沒有任何 spec 會真的轉錄，所以這不是活的問題；但如果你要新增一個會啟動
轉錄的 spec，Python 會讀真實的 config 而 UI 讀隔離的那份——屆時要把 config 路徑
一併傳給 bridge。

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
