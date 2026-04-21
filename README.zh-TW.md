<!-- markdownlint-disable MD033 MD041 -->
<!--
  Inline HTML is intentional in this file: GitHub-flavored markdown has no
  alignment primitives, so the centered header, badge rows, and download
  buttons below all rely on <p align="center"> and <img>.  The lint
  directive above silences MD033 (no-inline-html) for this README only.
-->

<p align="center">
  <a href="README.md">English</a> ·
  <strong>繁體中文</strong>
</p>

<h1 align="center">🎙️ WhisperFlow Studio</h1>

<p align="center">
  <strong>自給自足的桌面語音轉錄工具，支援 macOS、Windows 與 Linux</strong><br>
  指向資料夾、掃描尚無字幕的檔案、按下執行即可。無需額外的 Python 專案、無需 Poetry、無需設定路徑。
</p>

<p align="center">
  <a href="https://github.com/swiftruru/whisperflow-studio/actions/workflows/release.yml"><img src="https://img.shields.io/github/actions/workflow/status/swiftruru/whisperflow-studio/release.yml?label=build&logo=github&style=flat-square" alt="Build"></a>
  <a href="https://github.com/swiftruru/whisperflow-studio/releases/latest"><img src="https://img.shields.io/github/v/release/swiftruru/whisperflow-studio?label=release&color=orange&style=flat-square" alt="Release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License"></a>
  <img src="https://img.shields.io/badge/platforms-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey?style=flat-square" alt="Platforms">
  <img src="https://img.shields.io/badge/i18n-zh--TW%20%7C%20en-ff69b4?style=flat-square" alt="i18n">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Electron-35-47848F?logo=electron&logoColor=white&style=flat-square" alt="Electron 35">
  <img src="https://img.shields.io/badge/Vanilla%20JS-ESM-F7DF1E?logo=javascript&logoColor=black&style=flat-square" alt="Vanilla JS">
  <img src="https://img.shields.io/badge/Python-3.10+-3776AB?logo=python&logoColor=white&style=flat-square" alt="Python 3.10+">
  <img src="https://img.shields.io/badge/faster--whisper-0.10+-4B8BBE?style=flat-square" alt="faster-whisper">
  <img src="https://img.shields.io/badge/CTranslate2-3.24+-ff9800?style=flat-square" alt="CTranslate2">
  <img src="https://img.shields.io/badge/PyTorch-2.1+-EE4C2C?logo=pytorch&logoColor=white&style=flat-square" alt="PyTorch">
  <img src="https://img.shields.io/badge/Silero%20VAD-latest-6DB33F?style=flat-square" alt="Silero VAD">
</p>

---

## 📦 下載

每次發行版本都會自動建置預編譯安裝檔，請依平台選擇：

<p align="center">
  <a href="https://github.com/swiftruru/whisperflow-studio/releases/latest/download/WhisperFlow-Studio-mac-arm64.dmg">
    <img src="https://img.shields.io/badge/download-macOS%20Apple%20Silicon-000000?logo=apple&logoColor=white&style=for-the-badge" alt="macOS Apple Silicon">
  </a>
  &nbsp;
  <a href="https://github.com/swiftruru/whisperflow-studio/releases/latest/download/WhisperFlow-Studio-mac-x64.dmg">
    <img src="https://img.shields.io/badge/download-macOS%20Intel-8a8a8a?logo=apple&logoColor=white&style=for-the-badge" alt="macOS Intel">
  </a>
  &nbsp;
  <a href="https://github.com/swiftruru/whisperflow-studio/releases/latest/download/WhisperFlow-Studio-win-x64.exe">
    <img src="https://img.shields.io/badge/download-Windows%20Installer-0078D6?logo=windows&logoColor=white&style=for-the-badge" alt="Windows Installer">
  </a>
  &nbsp;
  <a href="https://github.com/swiftruru/whisperflow-studio/releases/latest/download/WhisperFlow-Studio-linux-x86_64.AppImage">
    <img src="https://img.shields.io/badge/download-Linux%20AppImage-FCC624?logo=linux&logoColor=black&style=for-the-badge" alt="Linux AppImage">
  </a>
</p>

<p align="center">
  <sub>
    🔒 由 GitHub Actions 根據標籤 commit 建置，檔案雜湊與 workflow 上傳的結果完全相符。<br>
    🐍 首次啟動時會自動於 app data 目錄下建立本機 Python 虛擬環境並安裝 <code>faster-whisper</code>、<code>torch</code> 等套件——初次安裝約需 5–10 分鐘。
  </sub>
</p>

### 🍎 macOS：顯示「WhisperFlow Studio.app 已毀損，無法打開」

**App 並未損壞**——macOS 對所有未以付費 Apple Developer ID 簽署的 App 都會顯示此訊息，而本專案刻意略過此簽署（憑證為興趣專案負擔不起的每年 USD 99）。你的瀏覽器會為下載的 `.dmg` 標記 `com.apple.quarantine` 屬性，Gatekeeper 便會拒絕啟動任何未經 Apple 公證的隔離 App。

**解決方式（每次安裝僅需一次）**：將 App 拖入 `/Applications`，然後在終端機執行：

```bash
xattr -cr "/Applications/WhisperFlow Studio.app"
```

這會移除隔離旗標。處理後 App 可正常啟動，並且不需要再重做——直到你安裝新版本為止。

> <sub>以前不需要這一步？近期 macOS 版本（Sonoma 14.5+ / Sequoia）加強了 Gatekeeper 的管控。過去對 ad-hoc 簽署 App 可用的「右鍵 → 打開」繞過方式已被淘汰，目前 `xattr` 指令是所有透過瀏覽器下載的未簽署 App 的標準解法。</sub>

---

## 概覽

專為快速、精準的語音轉文字所設計的自給自足桌面 App。指向資料夾、掃描尚無字幕的檔案，即可自動為缺少的項目產生 `.srt` / `.vtt` / `.txt` / `.json`——底層全由 [faster-whisper](https://github.com/SYSTRAN/faster-whisper) 驅動，並運行在 App 自己打包的 Python 環境中。不需安裝外部工具、不需設定路徑、不需再 clone 其他專案。

採用 Electron 35、純 JS（vanilla JS）的 renderer，以及從頭打造、放置於 [`python/whisperflow/`](python/whisperflow/) 的 Python 轉錄核心。

---

## 功能流程

| 步驟 | 動作 |
|------|------|
| 1 | 將 App 指向含有影音檔的資料夾 |
| 2 | **掃描缺少字幕** — 建立尚無 `.srt` / `.vtt` 伴隨檔的影音檔佇列 |
| 3 | **開始轉錄** — 將目前的佇列檔案送入內建的 `whisperflow` Python 套件處理 |
| 4 | 監看批次佇列，依需求 **暫停 / 繼續 / 跳過目前 / 停止批次** |
| 5 | 啟用 **自動循環** 讓批次持續處理佇列，直到全數完成 |

即時主控台面板會將 Python 的輸出（stdout + stderr）直接串流到 UI，不必另開終端機即可掌握轉錄進度。

---

## 功能特色

### 核心

- **自給自足的轉錄核心** — [`python/whisperflow/`](python/whisperflow/) 是重寫、依賴完全隔離的 Python 套件，統籌 faster-whisper、Silero VAD、片段合併、字幕輸出器。不需外部專案。
- **批次影音掃描** — 以遞迴方式建立尚無字幕伴隨檔的影音佇列
- **模型管理分頁** — 在 App 管理的目錄中列出 / 下載 / 刪除 faster-whisper 模型；所有權重都放在 Electron 的 `userData/models/`，不會佔用你的全域 HuggingFace 快取。下載會將即時進度（百分比、位元組數、速度、ETA）串流到 Models 分頁的常駐卡片與標題列脈動式標記中，不會再對著停滯的「Downloading…」字樣乾等 15 分鐘。可在中途取消、稍後重試；`huggingface_hub` 內建的續傳功能會從上次中斷處接續
- **首次啟動 venv 自動建置** — App 會在首次啟動時自動建立 Python 虛擬環境（`python/.venv`）並安裝 `requirements.txt`
- **結構化執行事件** — bridge 會發送可機器解析的階段事件（`preparing`、`loading-model`、`transcribing`、`writing-subtitle`、`completed`、`failed`）來驅動進度 UI
- **多 GPU 平行轉錄** — 延續自上游架構，可在 Linux / Windows 上跨 CUDA 裝置分派工作
- **預檢（Preflight）** — 執行前驗證內建 Python 環境、`whisperflow` 套件、`ffmpeg` / `ffprobe`、以及影音根目錄；若缺少 ffmpeg，可透過偵測到的系統套件管理工具一鍵安裝
- **設定面板** — 在 App 內直接調整模型、語言、VAD、初始提示、裝置、計算類型，並以 UI 語言提供每個欄位的內嵌說明。依語意分組為卡片（一般 / 模型 / 轉錄 / 輸出 / VAD / 進階），並於頂部提供「轉錄 ↔ App」分段切換。App 內所有 `<select>` 都改用配合主題色的自訂下拉選單，展開時會符合奶油 / 琥珀色調色盤，而非退回 OS 原生樣式
- **輸出格式與翻譯控制** — Whisper 所有輸出格式（`.srt` / `.vtt` / `.txt` / `.json`）、輸出目錄、字幕最長行寬、覆寫策略（覆寫 / 略過 / 重新命名加後綴）、以及 Whisper 內建的 `task=translate`（翻譯為英文）均以勾選框 / 下拉選單方式在 Settings 分頁公開
- **進階 Whisper 解碼參數** — `beam_size`、`best_of`、`temperature`、`condition_on_previous_text`、`no_speech_threshold`、`logprob_threshold`、`compression_ratio_threshold` 等皆集中於預設收合的「進階」區塊，供進階調校
- **HuggingFace 快取匯入** — Models 分頁會掃描 `~/.cache/huggingface/hub/` 中既有的 faster-whisper 模型，並以硬連結（hard-link）一鍵匯入 App 管理資料夾（無須重新下載）

### 使用體驗（UX）

- **自動循環模式** — 掃描一次建立批次佇列，之後就持續處理直到完成
- **System Check 面板** — 主動揭示會阻擋使用的設定問題，並直接連結到對應的設定欄位
- **狀態感知的批次進度卡** — 僅在工作執行中或暫停時顯示，避免閒置 / 完成狀態佔用主欄位空間。卡片上會顯示階段標記、目前檔案（`N/總數 · 檔名`）、完整狀態計數、每批次掃描摘要、經過時間 / ETA、正在執行的階段訊息（例如 `Whisper transcribing · model large-v2`），以及針對目前檔案的一鍵「於檔案管理員顯示」按鈕
- **佇列面板** — 列出待處理 / 執行中 / 暫停 / 完成 / 已略過 / 失敗項目，具搜尋、狀態標記、以及 header 層級的 **重試失敗** / **清除已完成** 動作（與「總檔案」標記並列，才不會和單項操作按鈕互相搶佔）
- **單項佇列控制** — 可直接從佇列列表重試、移除、上移 / 下移
- **附加模式掃描** — 掃描新資料夾時，既有的 pending / running / paused / failed 工作會保留，只會加入尚未佇列的檔案；已完成項目（`done` / `skipped`）在每次掃描開始時自動清除，使佇列不會無止盡累積。主控台記錄會明確顯示分類結果（「新增 X、已在佇列 Y、已有字幕 Z」）
- **檔案存在性保護** — 三層防護避免已刪除的影音檔拖累整批：執行前驗證會在呼叫 Python 之前將缺檔標為 `file-not-found`；批次進行中會透過 stat 檢查跳過已消失的檔案並推進到下一個可執行項目；下次掃描時會自動移除這些項目，保持佇列整潔
- **佇列持久化** — 佇列狀態會在 App 重啟後還原，pending / skipped / failed 的工作不會遺失
- **暫停 / 繼續 / 跳過目前 / 停止批次** — 可控制目前的轉錄工作而不影響其他佇列項目；「跳過」與「停止」執行前會再次確認，避免誤丟已完成的進度
- **轉錄預覽卡** — 每個工作完成後，Main 分頁會顯示片段預覽（附時間碼）、搜尋、全部複製 / 單段複製、以及於檔案管理員顯示；下一個佇列檔案開始時會自動關閉
- **App 內字幕編輯器** — 可從轉錄預覽頁尾或任一成功歷史列的鉛筆圖示開啟。可直接編輯片段文字（時間戳維持唯讀以避免誤傷時間軸），具備完整的復原 / 重做歷史（儲存後仍保留；⌘Z / ⌘⇧Z 鍵盤快速鍵、200 筆堆疊）、Cmd/Ctrl+F 尋找並取代（含大小寫切換與計數）、IME 感知的鍵盤事件處理（注音 / 拼音 / 假名皆可正常輸入），以及每次覆寫前在暫存資料夾備份原檔。按一次「儲存」就會依你在 **設定 → 字幕輸出** 中所啟用的格式同步更新（`.srt` / `.vtt` / `.txt` / `.json`）——JSON 會逐欄位修改，確保 Whisper 的 `logprob` / `id` / `duration` 等中繼資料完整保留
- **批次完成摘要** — 批次結束時會在主控台輸出綠色摘要，含完成 / 失敗 / 略過數量與總耗時；進度卡 headline 會同步更新相同統計
- **加強版系統通知** — 批次完成的 OS 通知包含完成 / 失敗數量與總耗時
- **輸出檔快速存取** — 已完成的佇列項目與歷史列都會顯示「於檔案管理員顯示」按鈕，方便於系統檔案管理員中開啟輸出
- **拖放檔案** — 將單一影音檔拖入目錄卡片即可直接加入佇列；拖入檔案時，影音資料夾路徑也會吸附到該檔案的父目錄，即便檔案已在佇列中也能反映你的操作意圖。Toast 會提供具體原因（`已在佇列`、`已有字幕`、`不支援的格式`）而非含糊訊息
- **「以 WhisperFlow 開啟」檔案關聯** — 作業系統會為 mp4 / mov / mkv / mp3 / wav / m4a / flac 建立檔案關聯，雙擊檔案會自動加入佇列；具單實例鎖，再次雙擊不會多開視窗
- **轉錄歷史** — 跨工作階段保存最近 10 個轉錄檔案（✓ / ✗）。會在啟動時、每次新增紀錄後、以及按下歷史標題列中的 **重新整理** 按鈕時，自動清除陳舊項目（影音檔**與**字幕輸出皆已不存在），讓你不會看到對應檔案已被刪除的列。採取保守原則：只要來源影音或字幕仍在磁碟上，對應的列就會保留
- **最近目錄下拉** — 最近使用的 5 個目錄藏於 **Browse…** 旁的 `▾` 按鈕後，避免在不需要時佔用垂直空間。下拉會自動清除已被刪除的資料夾，避免選到過期路徑導致預檢失敗
- **設定檔管理** — 可於 **設定 → 轉錄** 中建立 / 重新命名 / 刪除轉錄設定檔（設定檔會快照整份轉錄設定，與其所捕捉的參數放在一起）。選單為配合主題色的下拉，「以目前狀態另存新設定檔」僅在表單有未儲存變更時才會出現，且會以這些變更作為新設定檔的初始值，而不會影響目前使用中的設定檔。編輯中切換設定檔會先確認是否覆蓋未儲存的變更
- **Toast 通知** — 為每個動作提供成功 / 資訊 / 錯誤回饋
- **結構化錯誤 UI** — 執行期錯誤會被正規化為可執行的橫幅 / 對話框，而非原始 stderr 輸出

### 主控台工具

- **記錄等級過濾** — All / Error / Warn / OK
- **主控台搜尋** — Cmd+F 搜尋記錄，顯示符合筆數
- **複製 / 另存記錄 / 清除 / 自動捲動鎖定**
- **診斷匯出** — 在 About 分頁按一次即可複製 / 另存為檔案，內含 App 版本、Electron/Node/Chrome 版本、OS/CPU/記憶體、venv 狀態、GPU 偵測（CUDA/MPS）、模型資料夾使用量、遮罩過的設定、以及最近 500 行主控台輸出——適合回報 bug 時使用。家目錄路徑會自動替換為 `~`

### 外觀

- **亮色 / 暗色主題切換** — 日間為奶油黃粉彩、夜間為暖色的 **Cocoa Cream**；兩套色票屬同一色調家族，切換時的感受像是「同一個 App 把燈調暗」，而非兩個不同的 App
- **柔和可可暗色模式** — 中等偏暗、暖中性色調的表面（不是近黑、也不是飽和棕色）、奶油白文字，保留亮色主題一致的品牌黃強調色；整體更舒適、易讀，而非壓迫
- **預設為亮色** — 首次啟動一律使用奶油黃亮色調色盤，無論 OS 是否為暗色模式，讓新使用者先看到主要設計意圖。可隨時透過 App 內切換為暗色；選擇會持久化於 `localStorage`，之後每次啟動都會套用
- **無障礙控制** — 字級（小 / 一般 / 大 / 特大）與高對比模式可於 設定 → App 設定；即時套用、持久化於 `localStorage`、並於啟動時讀取，避免預設樣式閃現

### 關於頁

- **專屬 About 分頁** — 英雄區塊含 App 圖示與版本徽章（由 `package.json` 透過 IPC 讀取）、作者卡片（含字母縮寫頭像佔位）、依功能區分的技術堆疊卡、專屬的 **軟體更新** 卡片（含一鍵「檢查更新」按鈕）、**版本歷史** 卡片（從內附的 `changelog/v*.md` 渲染的 App 內版本紀錄檢視器），以及含 `NOTICES.md` 與 GitHub Issues 連結的致謝與授權卡
- **一鍵外部連結** — GitHub 儲存庫、個人網站、通知檔、issue 回報皆透過沙盒化的 `shell:open-external` IPC（僅限 http(s)）
- **完整雙語** — `about` 命名空間與其他 16 個並列，可即時隨標題列的語言切換同步

### App 內更新

- **啟動 5 秒被動檢查** — 每次啟動時，更新器會靜默查詢 GitHub Releases，只有在真的有新版本時才顯示更新對話框；否則你什麼都不會看到
- **手動「檢查更新…」** — 同時提供於原生應用選單（VS Code 風格，macOS 在 App 選單、Windows/Linux 在 Help 選單）與 About 分頁的「軟體更新」卡；手動檢查永遠會有回饋，包含「已是最新版」的 toast
- **三鍵更新對話框** — 配合主題色的模態框，含 **立即更新** / **略過此版本** / **稍後提醒**；略過某版會靜默忽略直到更新的版本釋出，「稍後提醒」則單純關閉、不儲存狀態
- **平台感知策略** — Windows NSIS installer 透過 `electron-updater` 進行完整自動下載 + SHA-512 驗證 + 安裝 + 重啟；macOS DMG、Windows portable 與 Linux AppImage 則導向 GitHub 釋出頁面，因為未簽署或不可覆寫的 installer 無法安全自動安裝
- **說明面板與首次啟動導覽** — 新增的標題列 Help 按鈕可開啟 App 內說明面板，提供雙語文章；首次啟動會以五步驟 spotlight 導覽帶使用者經歷目錄選擇、模型管理、掃描、轉錄、佇列，並由 `hasSeenOnboarding` 與預檢狀態把關，確保不會在初始化階段觸發

### 國際化（zh-TW / en）

- **正式版 i18n 架構** — 建構在 [i18next](https://www.i18next.com/) 之上，具 19 個功能命名空間（`common`、`sidebar`、`preflight`、`settings`、`queue`、`progress`、`models`、`console`、`controls`、`dialogs`、`errors`、`events`、`toasts`、`about`、`help`、`updater`、`downloads`、`changelog`、`transcript`）。每種語言約 915 個鍵。
- **標題列語言切換** — 一鍵在台灣繁體中文與英文之間切換；所有靜態 HTML、動態元件、Python 執行事件、以及 Electron 原生對話框皆可即時切換、不需重啟
- **首次啟動自動偵測** — 以 `app.getLocale()` 為依據，中文系統預設 `zh-TW`、英文系統預設 `en`，fallback 為 `zh-TW`
- **以鍵為基礎的主程序 → renderer 約定** — `createAppError` / `createPreflightCheck` / Python `[WhisperFlowEvent]` 皆攜帶 `messageKey` + `messageParams` 而非原始字串，renderer 在顯示時才在地化，切換語言可即時更新已顯示的錯誤橫幅 / 預檢項目
- **Data attribute DOM binding** — 靜態 HTML 使用 `data-i18n="ns:key"` / `data-i18n-attr="placeholder=ns:key"`，由一個 80 行的 translator 模組在每次語言切換時走訪節點
- **逐欄位參數說明** — Settings 分頁的每個設定皆附簡短的內嵌解釋（已在地化），讓非專業使用者也能理解每個旋鈕的意義
- **CI 中有 i18n lint** — `npm run i18n:lint` 會比對每個語言下每個 JSON 命名空間，發現缺鍵或結構不一致即讓 build 失敗，確保不會釋出不完整的翻譯

### 鍵盤快速鍵

所有六個 App 動作的快速鍵都可於 設定 → App → 鍵盤快速鍵 中**自訂**，每台裝置各自記錄（點一下快速鍵、按新的組合鍵、Esc 取消）。另外兩個則為固定綁定：

| 快速鍵 | 動作 | 可自訂 |
|--------|------|:---:|
| `Cmd+R` | 執行轉錄 | ✓ |
| `Cmd+Shift+S` | 掃描缺少字幕 | ✓ |
| `Cmd+.` | 停止批次 | ✓ |
| `Cmd+S` | 儲存設定（Settings 分頁為作用中時） | ✓ |
| `Cmd+K` | 清除主控台 | ✓ |
| `Cmd+F` | 開啟主控台搜尋 | ✓ |
| `Escape` | 關閉主控台搜尋 | — |
| `?` | 顯示鍵盤快速鍵面板 | — |

兩個系統層級的全域快速鍵（即使 WhisperFlow 未在前景也可作用）：

| 快速鍵 | 動作 |
|--------|------|
| `Cmd+Alt+T` | 顯示 / 聚焦 WhisperFlow 視窗 |
| `Cmd+Alt+R` | 開始一次轉錄執行 |

---

## 先決條件

| 需求 | 說明 |
|------|------|
| **Node.js** ≥ 18 | 執行 Electron App 所需 |
| **Python** ≥ 3.10 | 僅用於首次啟動時自動建置 App 自己的虛擬環境。需可於 PATH 上找到，或於 `settings.json` 的 `pythonPath` 指定。 |
| **ffmpeg** | 執行期音訊解碼所需。若缺少，預檢面板會顯示「**安裝 ffmpeg**」按鈕，能偵測可用的套件管理工具（Homebrew / winget / Scoop / Chocolatey / apt / dnf / pacman）並一鍵安裝——或把需要管理員權限的指令複製給你。安裝可中途取消，對話框會確認二進位確實存在後才宣告成功。 |

> **不需要額外的 faster-whisper-webui**。過去版本需要另一個 Python 專案與 Poetry 安裝。v1.4.0 將轉錄核心重寫到 `python/whisperflow/` 並改用 App 內的 venv，因此只需要系統 PATH 上有 Python 3.10+ 即可。

---

## 安裝

### 1. 安裝 Node 依賴

```bash
npm install
```

### 2. 設定本機 App（可選）

```bash
cp settings.example.json settings.json
```

`settings.json` 為可攜式覆寫設定。通常唯一需要動的鍵是 `pythonPath`：

```json
{
  "pythonPath": null
}
```

- `null`（預設）→ 自動從 PATH 與常見安裝位置偵測系統 Python 3
- 若你的 Python 3.10+ 安裝在非標準位置，才需要填入字串路徑

### 3. 執行

```bash
npm run dev
# 或
npm start
```

### 4. 首次啟動啟動程序

首次啟動時 **System Check** 面板會顯示警告：

> **Python 虛擬環境尚未建立** · 第一次執行轉錄時會自動建立 `python/.venv/` 並安裝依賴（約數百 MB）。

點擊 **立即建立環境** 執行：

1. `python3 -m venv python/.venv`
2. `pip install --upgrade pip`
3. `pip install -r python/requirements.txt`

此步驟會下載 `faster-whisper`、`ctranslate2`、`torch`、`torchaudio` 以及其他小型依賴，依網路速度約 2–10 分鐘。

進度會即時串流至主控台面板。

### 5. 下載模型

開啟 **Models** 分頁，按你要的模型旁的 **下載**（例如 `large-v2`）。模型會下載至：

- **macOS**：`~/Library/Application Support/WhisperFlow Studio/models/`
- **Windows**：`%APPDATA%/WhisperFlow Studio/models/`
- **Linux**：`~/.config/WhisperFlow Studio/models/`

Silero VAD 權重會放在同一個目錄下（位於 `torch_hub/`），不會污染你的全域 `~/.cache/`。

---

## 專案結構

```
whisperflow-studio/
├── bridge/
│   └── run_cli.py                 # Electron → whisperflow 的薄適配層（約 90 行）
├── python/
│   ├── pyproject.toml             # 內附 Python 專案中繼資料
│   ├── requirements.txt           # venv 依賴列表
│   ├── config/
│   │   ├── config.example.json    # 追蹤的本機執行期設定範本
│   │   ├── config.metadata.json   # UI enum 選項、內附 Python 中繼資料
│   │   └── config.json            # 主要的轉錄設定（單一真實來源）
│   ├── config_setting.py          # 供 Electron 呼叫的影音掃描輔助
│   ├── config_metadata.py         # 讀取共用中繼資料的 Python 輔助
│   ├── subtitle_utils.py          # 掃描時用的字幕偵測輔助
│   └── whisperflow/               # 轉錄核心
│       ├── cli.py                 # argparse 進入點 + --list-models / --download-model / --delete-model
│       ├── transcriber.py         # 協調者：載入模型 → VAD → whisper → 寫入輸出
│       ├── config.py              # TranscribeConfig dataclass
│       ├── events.py              # [WhisperFlowEvent] JSON 發送器
│       ├── languages.py           # 完整的 Whisper-99 語言表
│       ├── progress.py            # ProgressListener 協定 + SubTaskProgressListener
│       ├── audio/source.py        # 本機檔案的 AudioSource 封裝
│       ├── subtitles/writers.py   # SRT / VTT / TXT writer
│       ├── models/
│       │   ├── registry.py        # 內建 faster-whisper 模型目錄
│       │   ├── manager.py         # 跨平台模型資料夾 + 下載 / 列出 / 刪除
│       │   ├── cache.py           # Thread-safe 模型快取
│       │   ├── whisper_container.py
│       │   └── faster_whisper_backend.py
│       ├── vad/
│       │   ├── base.py            # AbstractVadTranscription + merge/gap helpers
│       │   ├── silero.py          # Silero VAD（torch.hub 釘在管理目錄）
│       │   ├── periodic.py        # 定時間隔 fallback VAD
│       │   ├── parallel.py        # 多 GPU 平行驅動器（CUDA）
│       │   └── segments.py        # merge_timestamps()
│       ├── prompts/
│       │   ├── base.py            # PromptStrategy 協定 + InitialPromptMode enum
│       │   ├── prepend.py         # Prepend-all / prepend-first
│       │   └── json_prompt.py     # 以 JSON 驅動的逐段提示
│       └── tests/                 # pytest 單元測試（46 項，輕量化）
├── preload/
│   └── preload.js                 # Electron contextBridge（window.electronAPI）
├── src/
│   ├── main/
│   │   ├── main.js                # App bootstrap、視窗建立
│   │   ├── ipc-handlers.js        # 所有 IPC 通道（設定、fs、runner、模型、venv）
│   │   ├── config-metadata.js     # 讀取共用 config 中繼資料
│   │   ├── preflight-checker.js   # 環境檢查（venv、whisperflow 套件、影音根目錄）
│   │   ├── venv-installer.js      # 首次啟動建立 venv + pip install
│   │   ├── queue-manager.js       # 批次佇列狀態與工作生命週期
│   │   ├── queue-storage.js       # 將佇列狀態持久化至 userData
│   │   ├── runner-event.js        # [WhisperFlowEvent] 解析器
│   │   ├── runner-metrics.js      # 經過時間 / ETA 輔助
│   │   ├── python-runner.js       # 啟動內附 venv python、串流 stdio
│   │   ├── config-manager.js      # 讀寫 config.json
│   │   └── path-resolver.js       # 尋找 venv python 與系統 python
│   └── renderer/
│       ├── index.html
│       ├── index.js
│       ├── styles.css
│       └── components/
│           ├── controls-bar.js
│           ├── preflight-panel.js
│           ├── queue-panel.js
│           ├── settings-panel.js   # Whisper 設定表單、動態模型下拉
│           ├── model-manager.js    # Models 分頁：列出 / 下載 / 刪除
│           ├── console-log.js
│           ├── profile-switcher.js
│           ├── error-banner.js
│           ├── error-dialog.js
│           ├── error-actions.js
│           ├── error-state.js
│           ├── history.js
│           ├── queue-state.js
│           ├── queue-view-state.js
│           └── toast.js
├── NOTICES.md                     # 第三方來源標示（上游為 Apache 2.0）
├── settings.json                  # 本機可攜式設定（gitignored）
├── settings.example.json          # 範本
└── package.json
```

---

## 設定

### `settings.json`（可攜式、gitignored）

開發時儲存在專案根目錄；打包後的建置會放在 Electron `userData`。

| 鍵 | 型別 | 說明 |
|----|------|------|
| `pythonPath` | string 或 null | 用於 venv 建置的系統 Python 3.10+ 絕對路徑；`null` = 自動偵測 |

### `python/config/config.json`

Whisper 轉錄設定。透過 App 內的 **Settings** 分頁編輯。`python/config/config.example.json` 為追蹤的範本；`config.json` 是你的本機工作副本。

| 鍵 | 說明 |
|----|------|
| `model` | Whisper 模型名稱（`tiny`、`base`、`small`、`medium`、`large-v1`、`large-v2`、`large-v3`）。只有已下載的模型會出現在 Settings 下拉中。 |
| `models_dir` | 管理中的模型資料夾；自動由 Electron 的 `userData/models/` 填入。 |
| `device` | `auto`、`cpu`、或 `cuda`。 |
| `compute_type` | `auto`、`float16`、`float32`、`int8`、`int8_float16`、`int8_float32`。 |
| `vad` | 語音活動偵測策略：`none`、`silero-vad`、`silero-vad-skip-gaps`、`silero-vad-expand-into-gaps`、`periodic-vad`。 |
| `vad_merge_window` | 連續語音片段合併的靜音視窗長度（秒）。 |
| `vad_max_merge_size` | 合併後片段的最長長度（秒）。 |
| `vad_padding` | 每個偵測到的語音片段周圍所加的 padding（秒）。 |
| `vad_prompt_window` | 滾動提示視窗長度（秒）。 |
| `language` | 目標語言（人類可讀名稱；留空則自動偵測）。 |
| `initial_prompt` | 給 Whisper 的提示文字（例如輸出繁中時可填 `台灣繁體中文`）。 |
| `initial_prompt_mode` | `prepend_all_segments`、`prepend_first_segment`、或 `json_prompt_mode`。 |
| `media_root_path` | 要掃描影音檔的目錄。 |
| `media_file_name` / `media_file_path` | 會與當前佇列項目保持同步，供 bridge 相容使用。 |
| `missing_count` | 最近一次掃描後剩下的佇列大小。 |

> 佇列狀態本身存在 Electron 主程序（`queue-manager.js`）中，而不是 `config.json`。持久化的佇列快照獨立存於 Electron `userData/queue-state.json`。
>
> 在 Settings 分頁選擇語言會自動填入適合的 `initial_prompt` 預設。

### `python/config/config.metadata.json`

Electron 與 Python 共用、但不可由使用者編輯的 App 常數中繼資料：

- Settings 表單的 enum 選項（含由 Model Manager 動態供給的 `model` 下拉）
- 語言對應的 prompt 預設
- browse / scan 的影音檔副檔名
- 字幕偵測用的副檔名
- 內附 Python 中繼資料（venv 目錄名稱、requirements 檔、Python 最低版本）
- 已知的系統 Python 路徑（供 venv 建置）

---

## 使用方式

### 選擇影音目錄

- **Browse** — 按 Browse 按鈕開啟資料夾挑選器
- **拖放資料夾** — 將資料夾拖入目錄卡片即可作為影音根目錄
- **拖放檔案** — 將單一影音檔拖入目錄卡片即可直接加入轉錄佇列（支援格式會被驗證；重複檔與已有字幕者會略過）

### 模型管理

1. 開啟 **Models** 分頁
2. 檢視內建模型目錄（大小、repo id、說明）
3. 按要下載的模型旁的 **下載**，即可下載至管理目錄
4. 已安裝的模型會顯示綠色標記；按 **刪除** 即可移除

未下載的模型不會出現在 Settings 分頁的 `model` 下拉——先下載、再選擇。

### 掃描 → 轉錄流程

1. 設定影音目錄
2. 按 **掃描缺少字幕**
3. 按 **開始轉錄**
4. 工作執行中可 **暫停 / 繼續 / 跳過目前 / 停止批次**
5. 觀察 **批次進度** 顯示目前階段、經過時間、ETA 以及 Python 傳回的階段訊息

### System Check / 預檢

預檢會驗證：

- `config.json` 是否可讀
- 內附的 `whisperflow` Python 套件是否存在
- 內附 venv 是否已初始化（否則會顯示警告，附 **立即建立環境** 按鈕）
- 影音根目錄是否存在
- Bridge scripts 是否存在

錯誤會阻擋轉錄；警告（如「venv 未初始化」）不會——使用者可按內嵌的動作關閉。

### 重啟恢復

- 佇列狀態會持久化於 Electron `userData/queue-state.json`
- App 重啟後，`running` 工作會還原為 `failed` 並附中斷訊息
- `paused` 工作會還原為 `pending`

### 進度模型

- `python/whisperflow/events.py` 會向 stdout 輸出 `[WhisperFlowEvent]` JSON 行
- Electron 主程序（`runner-event.js`）解析後，更新佇列狀態的 `stage`、`progress`、`stageMessage`、`elapsedSeconds`、`etaSeconds`
- renderer 則使用佇列狀態驅動可視化的進度 UI

---

## 搬移 App

執行期設定都存在 `settings.json` 與 `python/config/config.json`，而內附 venv 也在專案目錄內，因此你可以將專案資料夾搬到任何地方：

1. 把資料夾搬到新位置
2. 執行 `npm install` 還原 `node_modules`
3. 若 `python/.venv/` 隨專案一起被搬移，其中可能包含原位置的絕對路徑——將它刪除並從 System Check 面板重新執行建置
4. `npm run dev`

---

## 建置發佈版本

```bash
npm run build:mac    # macOS .dmg
npm run build:win    # Windows installer
npm run build:linux  # Linux AppImage
```

輸出會放在 `dist/`。

> 發佈建置**不會**打包預先建好的 venv。安裝後的 App 只會帶著 `python/whisperflow/` 與 `python/requirements.txt`；使用者首次啟動才會在本機建置 venv。如此可將安裝檔控制在 ~200 MB 以內（而非 ~2 GB），並避免跨機器搬移 venv 的問題。

---

## 開發

執行 Python 單元測試（46 項，輕量——不需要 torch）：

```bash
cd python
python3 -m venv .venv-test
.venv-test/bin/pip install pytest ffmpeg-python numpy
.venv-test/bin/python -m pytest whisperflow/tests/ -q
```

每次發佈的 CI 都會跑同一套測試——見 [`.github/workflows/release.yml`](.github/workflows/release.yml)。

### 新增翻譯

`locales/` 目錄依功能命名空間切分（`common.json`、`preflight.json`……），並有並列的 `zh-TW/` 與 `en/` 子目錄。要新增鍵或新增語言：

1. 把鍵同時加入兩種語言（例如 `locales/zh-TW/settings.json` 與 `locales/en/settings.json`）——`npm run i18n:lint` 會拒絕只有單邊有鍵的 build。
2. 在 HTML 中以 `data-i18n="ns:key.path"`（給 textContent）或 `data-i18n-attr="placeholder=ns:key"`（給 attribute）連結。
3. 在 JS 中從 `../lib/i18n.js` 匯入 `t`，並以 `t('ns:key.path', { params })` 呼叫。
4. 動態元件應註冊 `window.addEventListener('app:language-changed', rerender)`，以便使用者在標題列切換語言時重新渲染。
5. 執行 `npm run i18n:lint` 驗證兩語言的鍵集合是否一致。

完整範例請見 [locales/zh-TW/](locales/zh-TW/) 與 [src/renderer/lib/i18n.js](src/renderer/lib/i18n.js)。

---

## 技術堆疊

| 層級 | 技術 |
|------|------|
| 桌面殼層 | Electron 35 |
| Renderer | Vanilla JS（ES modules），無框架 |
| 樣式 | CSS custom properties、奶油黃粉彩色票（亮 + 暗） |
| 轉錄核心 | `whisperflow` 套件 → faster-whisper + CTranslate2 + Silero VAD |
| Python 環境 | 首次啟動建立的本機 `python/.venv/`（無 poetry、無外部專案） |
| 設定 I/O | 透過 `fs` 讀寫 JSON 檔（`python/config/config.json`、`settings.json`） |
| Python 子程序 | `child_process.spawn` 搭配 `PYTHONUNBUFFERED=1` |
| ANSI 去除 | `strip-ansi@6.0.1`（釘版的 CJS 組建） |
| 打包 | electron-builder |

---

## 致謝

WhisperFlow Studio 的轉錄核心最初衍生（為重寫而非直接複製）自 [aadnk/faster-whisper-webui](https://gitlab.com/aadnk/faster-whisper-webui)，該專案採 Apache License 2.0 授權。Gradio WebUI 層、YouTube 下載器、說話人分離（diarization）以及 HuggingFace 轉換器皆已移除；VAD / 合併 / 提示策略 / 轉錄邏輯則被重寫成具乾淨型別註解 API 的 `whisperflow` 套件。完整標示請見 [NOTICES.md](NOTICES.md)。

執行期轉錄由 [faster-whisper](https://github.com/SYSTRAN/faster-whisper)（MIT）與 [CTranslate2](https://github.com/OpenNMT/CTranslate2)（MIT）驅動，使用 [OpenAI Whisper](https://github.com/openai/whisper) 模型權重（MIT）。語音活動偵測使用 [Silero VAD](https://github.com/snakers4/silero-vad)（MIT）。
