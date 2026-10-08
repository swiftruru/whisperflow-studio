# 規格書：WhisperFlow Studio 字幕切段（Subtitle Segmentation）

- 撰寫日期：2026-10-07
- 前提：講者辨識（`docs/specs/speaker-diarization.md`）已完成並合併
- 參考實作：`docs/specs/segmentation_reference.py`

## 0. 工作方式

- 這是接續講者辨識的新功能。開始前先讀講者辨識的實作現況（第 7 節），把它和本規格有出入的地方列出來，例如 `word_timestamps` 在什麼條件下開啟、講者前綴的格式與加法、JSON 結構、JS 端怎麼帶講者標籤，並在 Plan 裡提出調整方式。
- 用 Plan 模式提出分階段的實作計畫（每階段改哪些檔案、補哪些測試），第 9 節的待確認決策逐條給建議，等我確認再動手。
- 第 10 節是預計的檔案異動總覽，Plan 時可以提出調整。
- 分階段 commit。不要 bump 版本、不要打 tag、不要發 release。
- 第 3 節是已經驗證過的事實，不需要重新研究。

## 1. 背景與問題

- 目前 `subtitles/writers.py` 的 `_prepare_cues()` 是「一個 Whisper segment 輸出一則字幕」。設定面板的「單行最大字元」（`max_line_width`）只會在同一則字幕裡折行，不會把它切成多則。
- Whisper 的 segment 常常很長。以 2026-10-07 一場 1 小時 4 分的演講錄影為例：408 則字幕中，31% 超過 7 秒，38% 需要 3 行以上才放得下，最長一則 30 秒。其中 36:18 那一則有 303 個字元、長達 20.7 秒，就算把「單行最大字元」設成 42，也只會折成 8 行左右。
- 目標：依業界字幕規範，把字幕切成短 cue。時間點直接用 word timestamps，所以是準的，不需要估算。

## 2. 範圍

要做：

- 依 word timestamps 重新切段：可以跨 Whisper segment，但不跨講者
- 每則字幕最多 2 行，兩行盡量等長
- 時間點規則：最短與最長顯示時間、閱讀速度、不重疊
- 中文（CJK）與英文各自的字數規則
- 設定、CLI、i18n
- 預覽與字幕編輯器能正確顯示並保留切段結果
- 切段統計寫進 log

不做（v1 不處理，可以記在 TODO）：

- 依畫面內容調整字幕位置
- 依鏡頭轉換（shot change）對齊切點
- 自動翻譯
- 改寫或精簡文字：只調整切點與換行，不更動任何一個字

## 3. 已驗證事實（2026-10-07）

### 3.1 字幕規範（Netflix Timed Text Style Guide）

- 每則最多 2 行；每則最短 5/6 秒、最長 7 秒
- 換行位置：在標點之後、連接詞之前、介系詞之前；不要拆開冠詞與名詞、名與姓、主詞與動詞
- 英文：每行最多 42 字元；成人節目閱讀速度每秒最多 20 字元
- 繁體中文：每行最多 16 字；成人節目閱讀速度每秒最多 9 字
- 來源：
  - <https://partnerhelp.netflixstudios.com/hc/en-us/articles/215758617-Timed-Text-Style-Guide-General-Requirements>
  - <https://partnerhelp.netflixstudios.com/hc/en-us/articles/217350977-English-USA-Timed-Text-Style-Guide>
  - <https://partnerhelp.netflixstudios.com/hc/en-us/articles/215994807-Chinese-Traditional-Timed-Text-Style-Guide>

### 3.2 既有程式行為（v1.16.7 時點已讀原始碼確認；講者辨識合併後請重新確認）

- `_prepare_cues()`：一個 segment 一則 cue。有 words 時用 words 組出文字並依 `max_line_width` 折行，沒有 words 時用 segment 的 text
- `FasterWhisperCallback.invoke()` 會把 `s.words` 序列化成 `{start, end, word, probability}`
- `vad/base.py` 的 `adjust_timestamps()` 會把 words 一起位移到全域時間軸
- faster-whisper 1.2.1 的 `WhisperModel.transcribe()` 支援 `word_timestamps` 參數
- faster-whisper 的英文 word 帶有前導空白（例如 `" we"`），中文通常沒有。組字一律用 `"".join(w["word"] for w in words)`，才能同時保留兩種慣例
- `subtitle-writer.js` 會用編輯後的 segments 重新產生 SRT／VTT／TXT，JSON 則依 index 只 patch text
- `transcript-reader.js` 優先讀取 JSON 的 segments

### 3.3 參考實作的實測結果

`segmentation_reference.py` 是在沒有 word timestamps 的情況下，直接讀 VTT 文字、依字數比例內插時間做出來的版本。拿 2026-10-07 那份字幕測試的結果：

- 408 則變成 727 則
- 超過 7 秒：0 則；超過 2 行：0 則；每行都不超過 42 字元；沒有重疊
- 切前切後的文字完全相同（7011 個字）

證實有效、請沿用或改良的啟發式：

- 先把「同一講者、間隔 ≤ 1 秒」的連續內容接成一段（run），再在 run 裡切。這樣一句話就不會被 Whisper 的 segment 邊界卡在 "the" 後面
- 切點的優先順序：句尾標點 > 逗號類標點 > 連接詞或介系詞之前；行尾避免出現冠詞、介系詞、所有格（參考實作裡的 `GOOD_START`／`BAD_END` 清單）
- 折行時兩行盡量等長，並對標點和片語邊界加權
- 「字很少、時間很長」（例如每秒不到 8 字元）代表後面是靜音或掌聲。這種情況不要再切，直接把結束時間截在 7 秒
- 太短的 cue 先嘗試和同講者的鄰居合併；合併後會超出限制的話，就往後面的空檔延長，但絕不重疊

估算版的限制：時間點是內插出來的。正式版改用 word timestamps 之後，就不需要內插。

### 3.4 真實測試句

2026-10-07 錄影中 36:18.848 → 36:39.548（20.7 秒、303 字元）的原始 segment：

```text
If we have a more accurate estimation of a main effect, it can reduce, it can support the decision making in the future and can reduce the logistic cost. So we argue that this, it is cheaper than the partial dependence plot. And it is much more cheaper than if you do a real experiment in the real life.
```

參考實作的切法（可以當成合理結果的參考，不必完全一致）：

```text
If we have a more accurate estimation
of a main effect, it can reduce,

it can support the decision making in the
future and can reduce the logistic cost.

So we argue that this, it is cheaper
than the partial dependence plot.

And it is much more cheaper than if you do
a real experiment in the real life.
```

## 4. 實作需求

### 4.1 管線位置

- 處理順序：`_run_vad()` → 講者辨識（若開啟）→ 切段（若開啟）→ `_write_outputs()`
- 建議新增模組 `python/whisperflow/subtitles/segmentation.py`，純 Python、不依賴 numpy 以外的套件，CI 可以直接測
- 只要切段開啟，decode options 就必須帶 `word_timestamps=True`，不管講者辨識有沒有開

### 4.2 切段演算法

輸入是所有 segments 的 words（已在全域時間軸上），以及每個 word 的講者（若有）。

- 先組成 run：同一講者、相鄰兩字的間隔 ≤ 1.0 秒（可設定）。run 與 run 之間是硬邊界
- 在 run 裡切成 cue，硬性條件：
  - 每則 ≤ `max_lines` 行，每行 ≤ 每行字數上限（講者前綴的寬度要算進第一行）
  - 每則時長 ≤ `max_duration`（7 秒），只有在無法再切時例外（例如單一個字本身就超過）
  - 不更動任何文字：所有 cue 的 words 依序串起來，必須和輸入完全相同
- 軟性偏好，用評分來選切點：
  - 句尾標點 > 逗號類標點 > 停頓（字與字的間隔越長越好，≥ 0.3 秒明顯加分）> 片語邊界
  - 避免行尾是冠詞或介系詞
  - 避免切出只有一兩個字的 cue
- 建議在 run 內用動態規劃（類似文字排版的最佳斷行）找總成本最低的切法；Plan 時可以提出其他做法

時間點規則：

- cue 的開始 = 第一個字的 start；結束 = 最後一個字的 end
- 短於 `min_duration`（5/6 秒）時，往後延長到下一則開始之前，並保留至少約 0.08 秒的間隔
- 閱讀速度超過上限（英文每秒 20 字元、中文每秒 9 字）時，同樣往後面的空檔延長；延長後仍然超標就接受，只記進統計
- 字少、時間長（中間有長靜音）時，結束時間截在 `max_duration`
- 任兩則不重疊，時間單調遞增

word timestamps 的穩健處理：

- 零長度、時間反序的字
- 時間橫跨長靜音的字
- 缺少 words 的 segment：退回「依字數比例內插」，做法同參考實作

### 4.3 中文與英文規則

- 依 `result["language"]`（Whisper 偵測到的語言，或使用者指定的語言）決定預設規則：zh／ja／ko 用 CJK 規則，其他語言用拉丁文字規則
- 拉丁文字：每行 42 字元、每秒 20 字元，只能在字與字之間切
- CJK：每行 16 字、每秒 9 字，任兩個字之間都可以切
  - 句尾標點「。！？」、逗號類「，、；：」
  - 沒有標點時，更依賴停頓來決定切點
- 中英混排時的字寬計法（例如全形算 1、半形算 0.5），請在 Plan 時提出建議
- 日文、韓文的業界字數規範和中文不同，v1 先共用 CJK 規則，並在設定說明中註明

### 4.4 折行

- 每則最多 2 行，兩行盡量等長
- 偏好在標點之後、連接詞或介系詞之前換行
- 講者辨識加的講者前綴，寬度要算進第一行
- 換行結果的保存方式，見第 9 節決策 2

### 4.5 講者前綴

- 切段後 cue 會變多。如果講者辨識目前是每一則都加前綴，畫面會很吵，建議改成只在換人時的第一則加（第 9 節決策 3）

### 4.6 輸出格式

- SRT／VTT：使用切段後的 cue
- JSON：`segments` 改存切段後的 cue，每則帶自己的 words、`speaker`、`speaker_label`，這樣預覽、編輯器、存檔重產都會沿用切段結果。另外在頂層加一個 `segmentation` 欄位，記錄這次使用的參數（第 9 節決策 1）
- TXT：TXT 是逐字稿用途，不應該變成一行一則字幕。建議把同講者的連續 cue 合併成段落，段落開頭放講者標籤（第 9 節決策 4）

### 4.7 預覽與字幕編輯器

- 確認預覽與編輯器都能正確顯示多行的 cue
- 編輯後存檔，切段結果和換行都不會被破壞
- 編輯器存檔時不重新切段，使用者改過的內容照原樣保存

### 4.8 設定與 CLI

- `subtitle_segmentation: bool`（預設值見第 9 節決策 5）
- `max_line_width`：沿用既有欄位，當作「每行字數上限」。留空時依語言自動用 42 或 16。設定說明的文字要同步更新（目前寫的是「超過會自動折行」）
- `subtitle_max_lines: int = 2`
- `subtitle_max_duration: float = 7.0`
- `subtitle_min_duration: float = 0.833`
- 進階參數（可以放在 advanced 區，或先不開放到 UI）：停頓門檻、閱讀速度上限
- 需要同步更新：
  - `config.example.json`、`config.metadata.json`
  - `locales/en` 與 `locales/zh-TW` 的 `settings.json`
  - CLI 參數：一律 `default=None`，只有使用者明確指定時才覆寫設定檔

### 4.9 統計 log

寫檔之後，在 log 印一行摘要，例如：

```text
字幕切段：共 727 則，超過 7 秒 0 則，超過 2 行 0 則，閱讀速度超標 11 則，最長 7.0 秒
```

### 4.10 文件

- README（中英文版）補上功能說明，並說明「單行最大字元」的新語意
- changelog：這份規格的實作併進了尚未發佈的 `changelog/v1.17.0.md`，而非另開新版

## 5. 測試

### 5.1 Python（pytest，必須在只裝了 pytest、ffmpeg-python、numpy 的 CI 上通過）

- 真實案例：用 3.4 節的句子配上合成的 word 時間，確認切出來的 cue 都符合規範，而且切點落在句尾
- 文字守恆：隨機產生輸入，切段前後 words 串起來的結果必須完全相同
- 時間：單調遞增、不重疊、開始時間等於第一個字的 start、只會往空檔延長
- 規則：每行字數、行數、7 秒、5/6 秒、閱讀速度延長
- 講者：不跨講者合併；前綴只出現在換人的第一則（依決策 3）；前綴寬度有算進第一行
- CJK：沒有空白的中文，分成有標點、沒標點兩種情況
- 缺 words 時的 fallback
- 回歸：`subtitle_segmentation` 關閉時，輸出與講者辨識版本逐位元組相同

### 5.2 JS

- 如果決策 2 需要在 JS 端重做折行，就用 Node 內建的 `node --test`（不新增依賴），確認 Python 與 JS 對同一組測資的輸出一致

### 5.3 手動驗收（我會親自做）

- 用 2026-10-07 那場演講錄影（約 1 小時 4 分）跑一次，統計 log 應該顯示超過 7 秒 0 則、超過 2 行 0 則
- 抽查 36:18 附近（原本 303 字元那一則），以及 23:01 附近密集的問答段落
- 和估算版 `2026-10-07_13-50-21_corrected_short.vtt` 對照，正式版的時間點應該更貼合語音
- `npm run i18n:lint` 通過

## 6. 驗收標準

- 第 5 節全部通過
- 切段開啟時，不違反任何硬性條件（單一個字本身就超過限制的情況除外）
- 切段關閉時，行為完全沒有差異
- 新文案中英文都有，沒有硬編碼字串

## 7. 必讀檔案

- `docs/specs/speaker-diarization.md`，以及講者辨識相關的 commit
- `docs/specs/segmentation_reference.py`
- `python/whisperflow/`：`transcriber.py`、`subtitles/writers.py`、`models/faster_whisper_backend.py`、`vad/base.py`、`config.py`、`cli.py`、講者辨識模組、`tests/`
- `python/config/config.example.json`、`python/config/config.metadata.json`
- `src/main/`：`transcript-reader.js`、`subtitle-writer.js`
- `src/renderer/components/`：`transcript-preview.js`、`subtitle-editor.js`、`settings-panel.js`
- `locales/*/`：`settings.json`、`events.json`

## 8. 建議開發順序

- Phase 1：切段模組與單元測試（純 Python）
- Phase 2：接進管線、設定、CLI、統計 log
- Phase 3：輸出格式（JSON、TXT）、預覽與字幕編輯器
- Phase 4：文件與 changelog 草稿

## 9. 待確認決策（請在 Plan 中逐條給建議）

1. JSON 的 `segments` 改存切段後的 cue（建議），還是保留原始 segments、另外存一份 `cues`？
2. 換行要直接存在 cue 的 text 裡（用 `\n`；編輯器可以直接改換行，JS 端也不用重做折行；建議），還是 text 維持單行，由各個輸出端自己折行？
3. 講者前綴每一則都加，還是只在換人時加（建議）？
4. TXT 要合併成講者段落（建議），還是維持一則一行？
5. `subtitle_segmentation` 預設開啟（建議，因為這樣才符合字幕規範；但舊使用者升級後輸出會改變，changelog 要寫清楚），還是預設關閉？
6. 中英混排時的字寬計法

## 10. 預計檔案異動總覽

以下是依規格推估的異動範圍，Plan 時可以依講者辨識完成後的實際程式碼調整。

```text
whisperflow-studio/
├── docs/specs/
│   ├── subtitle-segmentation.md        新增：本規格書
│   └── segmentation_reference.py       新增：參考實作（估時間版）
├── python/
│   ├── config/
│   │   ├── config.example.json         修改：新設定欄位
│   │   └── config.metadata.json        修改：設定分組
│   └── whisperflow/
│       ├── subtitles/
│       │   ├── segmentation.py         新增：切段與折行
│       │   └── writers.py              修改：改用切段後的 cue、TXT 段落
│       ├── transcriber.py              修改：管線位置、word_timestamps 條件、統計 log
│       ├── config.py                   修改：新欄位
│       ├── cli.py                      修改：新 CLI 參數
│       └── tests/
│           ├── test_segmentation.py    新增
│           └── test_writers.py         修改
├── src/
│   ├── main/
│   │   ├── transcript-reader.js        視需要：多行 cue
│   │   └── subtitle-writer.js          視需要：依決策 2、3 調整
│   └── renderer/components/
│       ├── transcript-preview.js       視需要：多行顯示
│       └── subtitle-editor.js          視需要：多行編輯
├── locales/
│   ├── en/        settings.json、events.json    修改
│   └── zh-TW/     settings.json、events.json    修改
├── README.md、README.zh-TW.md          修改：功能說明
└── changelog/v1.18.0.md                新增：草稿
```
