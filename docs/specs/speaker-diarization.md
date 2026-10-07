# 規格書：WhisperFlow Studio 講者辨識（Speaker Diarization）

- 撰寫日期：2026-10-07
- 對象版本：v1.16.7 之後（預計 v1.17.0）
- 參考實作：`docs/specs/diarization_reference.py`

## 0. 工作方式

- 先用 Plan 模式：讀完第 7 節的必讀檔案後，提出分階段的實作計畫（每階段改哪些檔案、補哪些測試），等我確認再動手。
- 第 9 節的待確認決策，請在計畫裡逐條給建議，等我回覆。
- 第 10 節是預計的檔案異動總覽，Plan 時可以提出調整。
- 分階段 commit。不要 bump 版本、不要打 tag、不要發 release。
- 第 3 節是已經實測驗證過的事實，不需要重新研究，也不要改用其他引擎。
- 參考實作 `docs/specs/diarization_reference.py` 已實測可用。可以參考，但請依專案風格重寫並補上測試。

## 1. 背景與目標

WhisperFlow Studio 用 faster-whisper 產生字幕，但不知道「誰在講話」。目標是新增可選的講者辨識：在字幕每段前面標上講者標籤（例如 `[Speaker 1]`），適用於演講 Q&A、訪談和會議錄音。

備註：Python 核心改寫自 aadnk 的 faster-whisper-webui。原專案有 pyannote 版的 diarization，當初被移除了（見 `NOTICES.md`）。這次不走 pyannote，理由見第 3 節。

## 2. 範圍

要做：

- 設定開關、講者人數（自動或指定）、進階門檻、標籤格式
- 首次使用時自動下載模型（比照 Silero VAD 的流程與提示）
- SRT／VTT／TXT 加講者前綴；JSON 加結構化欄位
- 預覽與字幕編輯器能顯示並保留講者標籤
- 舊使用者升級後，自動補裝新的 Python 依賴
- 順手修正 PyAV 19 相容性（4.0 節）

v1 不做（可以記在 TODO）：

- 講者改名、手動改派講者的 UI
- 即時（streaming）辨識
- 讓使用者切換聲紋模型
- 重疊語音（兩人同時講話）的特別處理

## 3. 已驗證事實（2026-10-07 實測）

### 3.1 引擎選擇

- 使用 **sherpa-onnx**（Apache-2.0，PyPI 最新版 1.13.8，2026-09-10 發布）。唯一的依賴是 `sherpa-onnx-core`，wheel 約 10 MB。macOS arm64、macOS x86_64、universal2、Windows x64、Linux x86_64／aarch64 都有 wheel。不需要 torch，也不需要 Hugging Face token。
- 不使用 pyannote.audio：4.0.7 要求 `torch>=2.8.0`、`torchaudio>=2.8.0`、`torchcodec>=0.7.0`，但 PyTorch 最後一個有 macOS x86_64 wheel 的版本是 2.2.2。本 App 有發 Intel Mac 版，會裝不起來。此外 community-1 模型是 gated，每個使用者都得自己去 HF 同意條款。
- 不使用 NVIDIA Nemotron 3 Diarization／NeMo：官方執行環境是 NVIDIA GPU，不適合跨平台的桌面 App。

### 3.2 sherpa-onnx 1.13.8 Python API

- `OfflineSpeakerDiarizationConfig(segmentation=..., embedding=..., clustering=..., min_duration_on=0.3, min_duration_off=0.5)`，有 `validate()` 方法
- `OfflineSpeakerSegmentationModelConfig(pyannote=OfflineSpeakerSegmentationPyannoteModelConfig(model=<path>), num_threads=..., provider="cpu")`
- `SpeakerEmbeddingExtractorConfig(model=<path>, num_threads=..., provider="cpu")`
- `FastClusteringConfig(num_clusters=-1, threshold=0.5)`，`num_clusters=-1` 代表自動判斷人數
- `OfflineSpeakerDiarization(config).process(samples, callback=fn)`：`samples` 是 16 kHz mono float32 的一維陣列；`callback(processed_chunks, num_chunks)` 回傳 0 代表繼續，回傳非 0 會中止
- 結果要先呼叫 `.sort_by_start_time()`，每段有 `.start`、`.end`、`.speaker`
- **注意**：`speaker` 是原始的 cluster id，編號不連續（4 個人可能回傳 0、1、2、7），必須依首次出現的順序重新編號成 0..N-1

### 3.3 模型（從 k2-fsa/sherpa-onnx 的 GitHub Releases 下載，不經過 HF）

切段模型（pyannote segmentation-3.0，MIT，© CNRS）：

- URL：<https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2>
- 壓縮檔 6,958,444 bytes
- sha256：`24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488`
- 解壓後使用 `sherpa-onnx-pyannote-segmentation-3-0/model.onnx`（5,992,913 bytes，sha256：`220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079`）
- 不要用同目錄下的 `model.int8.onnx`：實測在 4 人樣本上會多切出 1 個人

聲紋模型（3D-Speaker CAM++ 中英版）：

- URL：<https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx>
- release tag 裡的 `recongition` 拼字原本就是這樣，不要修正
- 28,281,164 bytes
- sha256：`aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2`

### 3.4 實測結果

測試檔：sherpa-onnx 官方的 4 人中文樣本，56.9 秒，2 個 CPU 執行緒。

- 下載網址：<https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/0-four-speakers-zh.wav>
- CAM++ 中英版、自動人數：正確判斷出 4 人，約 8 秒
- 3D-Speaker ERes2Net 中文版：門檻 0.5 自動判斷會切成 7 人，指定 4 人才正確。所以 UI 一定要提供「講者人數」選項
- 用本專案的 `whisperflow.vad.base.load_audio()`（ffmpeg CLI，輸出 16 kHz mono float32）餵給 sherpa-onnx，可以正常運作

### 3.5 既有程式行為（已讀原始碼確認）

- `Transcriber._run_vad()` 回傳的 segments 已經對齊全域時間軸；`vad/base.py` 的 `adjust_timestamps()` 會連 `words` 一起位移
- `FasterWhisperCallback.invoke()` 已經會把 `s.words` 序列化成 `{start, end, word, probability}`，但目前 decode options 沒有開 `word_timestamps`，所以 words 是空的
- `subtitles/writers.py` 的 `_prepare_cues()` 在有 words 時，會改用 words 組出文字
- 設定面板看起來是依 `config.metadata.json` 的 `fieldGroups` 和 config 內容自動產生 UI（Plan 時請確認）；`config-manager.js` 的 `normalizeConfig()` 會把 `config.example.json` 的新欄位合併進舊使用者的設定
- `venv-installer.js` 的 `isVenvInitialized()` 只檢查 `.whisperflow-installed` 標記檔存不存在，不會察覺 `requirements.txt` 有變動。所以舊使用者升級後，不會自動裝到新依賴
- 預覽用的 `transcript-reader.js` 優先讀 JSON，但只取 start／end／text。字幕編輯器透過 `subtitle-writer.js`，用編輯後的 segments 重新產生 SRT／VTT／TXT，JSON 則只 patch text
- CI 的 Python 單元測試只安裝 `pytest`、`ffmpeg-python`、`numpy`

## 4. 實作需求

### 4.0 PyAV 19 相容性修正（獨立 commit，最先做）

- 問題：PyAV 19.0.0（2026-09-29 發布）移除了 `av.open()` 的 `metadata_errors` 參數，但 faster-whisper 1.2.1 的 `decode_audio()` 仍然會傳這個參數，導致 TypeError。已實測 av 18.1.0 正常、19.0.1 會失敗。
- 觸發路徑：`vad == "none"` 而且沒有平行裝置時，`Transcriber._run_vad()` 會把檔案路徑直接交給 faster-whisper，新安裝的使用者會在這裡失敗。silero 和 periodic 走的是自家的 ffmpeg loader，不受影響。
- 修法：`python/requirements.txt` 加上 `av<19`，並加註解說明原因，以及什麼時候可以解除（faster-whisper 發布修正版之後）。
- Plan 時也請評估：none 路徑要不要改用自家的 `load_audio()`，當作第二層保險。

### 4.1 Python 依賴與環境升級

- `requirements.txt` 加上 `sherpa-onnx>=1.13.8,<2`。
- 解決「舊 venv 不會補裝」的問題。建議做法：把 `requirements.txt` 的雜湊值寫進標記檔（或另存一個檔），啟動時比對，不一致就跑一次增量的 `pip install -r requirements.txt`，沿用既有的安裝進度 UI，以及 `venv:status`／`venv:initialize` 流程。
- Plan 時請說明會改哪些地方（`venv-installer.js`、`ipc-handlers.js`、`src/renderer/lib/venv-bootstrap.js`），以及如何相容舊的標記檔。
- Python 端：如果開啟了 diarization，但 `import sherpa_onnx` 失敗，要送出可辨識的錯誤（新的 error code，例如 `DIARIZATION_DEPENDENCY_MISSING`），訊息引導使用者重新初始化環境。

### 4.2 新模組 `python/whisperflow/diarization.py`

- `SpeakerTurn(start, end, speaker)` dataclass。speaker 從 0 開始，依首次出現的順序編號。
- `SherpaDiarizer`：建構時載入兩個模型。
  - `diarize_file(path, on_progress)`：用 `vad.base.load_audio()` 讀取音訊
  - `diarize_samples(samples, on_progress)`：執行辨識並重新編號
- `import sherpa_onnx` 一律延遲到真正要用時才執行，確保 CI（沒裝 sherpa-onnx）可以正常 import 這個模組、跑純 Python 測試。
- `assign_speakers(segments, turns, split_on_change=True, min_run_words=2)`：
  - 有 words 時：每個字取「時間重疊最多」的講者；完全沒有重疊時，取最近的 turn
  - 平滑處理：長度小於 `min_run_words` 的孤立片段，如果前後是同一位講者就併回去；夾在兩位不同講者中間的則保留
  - `split_on_change=True` 時，一段話中途換人就拆成多段：第一段沿用原本的 start，最後一段沿用原本的 end，中間的邊界用字的時間；每段的 text 由該段的 words 串接而成
  - 沒有 words 時：整段指派給重疊時間最多的講者
  - turns 為空時，原樣回傳
- 執行緒數：預設依 CPU 核心數取合理值（例如 `min(4, os.cpu_count())`），Plan 時可以提出建議。

### 4.3 模型下載與快取

- 比照 Silero VAD 的做法：首次啟用時自動下載，存放在 managed models 目錄底下的子目錄（例如 `<models_dir>/diarization/`），這樣「清除所有模型」時也會一併清掉。
- 下載只用標準函式庫（urllib + tarfile 的 bz2）。要驗證 sha256，先寫入暫存檔再原子改名；失敗時要清掉下載到一半的檔案。
- 下載過程中送出 stage 事件，文案風格比照 `events:stage.loadingVad`，並提示檔案大小（約 35 MB，僅首次）。已經快取時，改送較短的「準備講者辨識」文案。
- 下載失敗（離線、雜湊不符）時，送出新的 error code（例如 `DIARIZATION_MODEL_DOWNLOAD_FAILED`），訊息附上手動下載的網址和要放置的路徑。
- Plan 時評估要不要在「模型」分頁顯示這兩個檔案的狀態（v1 可以不做）。

### 4.4 設定

`TranscribeConfig` 新增以下欄位（名稱可以在 Plan 時微調）：

- `diarize: bool = False`
- `diarize_num_speakers: int = 0`（0 代表自動，傳給 sherpa 時轉成 -1）
- `diarize_threshold: float = 0.5`（放在 advanced 區）
- `speaker_label_template: str = "Speaker {n}"`（n 從 1 開始；說明文字提示可以改成「講者 {n}」。格式有誤時退回預設值，並記一筆 warning）

需要同步更新的地方：

- `config.example.json`、`config.metadata.json`（新增 fieldGroup，例如 `diarization`，或併進既有群組，Plan 時提出建議）
- `locales/en` 與 `locales/zh-TW` 的 `settings.json`：groups 和 fields 的文案
- CLI 新增 `--diarize`、`--num-speakers`、`--diarize-threshold`、`--speaker-label-template`。注意：`cli.py` 現有的部分參數，預設值會蓋掉設定檔的值。新參數一律用 `default=None`，只有使用者明確指定時才覆寫。

### 4.5 管線整合（`transcriber.py`）

- `_build_decode_options()`：`diarize` 開啟時加上 `word_timestamps=True`；關閉時維持現狀。
- `run()`：在 `_run_vad()` 之後、`_write_outputs()` 之前，依序做：確保模型已下載 → 送出 stage `diarizing` → 執行 diarization → 用 `assign_speakers()` 改寫 `result["segments"]`。
- 每個 segment 新增 `speaker`（int，從 0 開始）和 `speaker_label`（套用 template 後的字串）。
- `events.py` 新增 stage 常數（例如 `STAGE_DIARIZING = "diarizing"`），並在 `locales/*/events.json` 補上對應文案。進度值要落在 Whisper 完成和寫檔（92）之間，sherpa 的 callback 需要節流。
- 回歸要求：`diarize` 關閉時，整條管線的輸出必須與現在完全相同。

### 4.6 輸出格式

- SRT／VTT／TXT：有 `speaker_label` 的 cue，在第一行開頭加上 `[{speaker_label}] `。`max_line_width` 折行時，前綴要算進第一行的長度。
- VTT 不使用 `<v>` 標籤，因為 App 自己的 VTT 預覽是用 SRT parser 解析，標籤會原樣露出。
- JSON：segments 的 text 保持乾淨，另外附上 `speaker` 和 `speaker_label`；words 也要帶 `speaker`。
- 前綴格式定義成單一常數，Python 和 JS 兩邊保持一致。
- **絕對不要**從 SRT／VTT 的文字反向解析講者。Whisper 會產生 `[Music]`、`[音樂]` 這類方括號內容，會被誤判成講者。

### 4.7 預覽與字幕編輯器（Electron）

- `transcript-reader.js`：讀 JSON 時一併帶出 `speakerLabel`。讀 SRT／VTT 的 fallback 路徑不做解析（前綴本來就在文字裡，照常顯示即可）。
- 預覽卡與字幕編輯器：有 `speakerLabel` 時，以唯讀標籤（chip）顯示在文字前面，編輯時只改文字。
- `subtitle-writer.js`：`generateSrt`／`generateVtt`／`generateTxt` 遇到 `speakerLabel` 時，加上同樣的前綴。`patchJsonWithEdits` 只改 text，保留 `speaker` 和 `speaker_label`。
- 確認編輯後存檔時，SRT／VTT／TXT 的講者前綴不會消失。

### 4.8 文件

- README（中英文版）的功能列表補上講者辨識，包含首次下載模型的說明。
- `NOTICES.md` 補上：
  - sherpa-onnx（Apache-2.0，執行期依賴）
  - pyannote segmentation-3.0（MIT，© CNRS，執行期下載，不打包進 App）
  - 3D-Speaker CAM++ 模型（執行期下載）。3D-Speaker 的程式碼是 Apache-2.0，但 README 沒有寫明模型本身的授權，請列為「待我確認」，不要自行下結論。
- 草擬 `changelog/v1.17.0.md`，格式比照既有的 changelog（Added／Changed／Fixed／Tests，並附檔案連結）。

## 5. 測試

### 5.1 Python（pytest，必須在只裝了 pytest、ffmpeg-python、numpy 的 CI 上通過）

- `test_diarization.py` 涵蓋 `assign_speakers` 的各種情境：
  - 單一講者，不拆段
  - 乾淨換手，拆成兩段
  - 邊界抖動的單字被吸收
  - 三段輪流發言
  - 沒有 words 時，用整段重疊時間判斷
  - turns 為空
  - 重新編號（0, 1, 2, 7 → 0, 1, 2, 3）
- 需要 sherpa-onnx 的測試，用 `pytest.importorskip("sherpa_onnx")`。
- 模型下載：mock 掉網路，測試 sha256 驗證失敗、tar 解壓、原子寫入、已快取時不重新下載。
- `test_writers.py`：有／無講者時的 SRT／VTT／TXT 輸出，以及前綴與 `max_line_width` 的互動。
- `test_config.py`：新欄位的型別轉換（`"0"`、`"true"`、`"0.45"`）。
- `npm run i18n:lint` 必須通過。

### 5.2 手動驗收（我會親自做）

- 關閉 diarization：輸出與 v1.16.7 逐位元組相同
- 開啟 diarization、自動人數：3.4 節的 4 人樣本得到 4 位講者
- 指定人數有效；首次下載有提示；第二次不會重新下載；離線時錯誤訊息清楚
- 舊 venv 升級後，自動補裝 sherpa-onnx
- 編輯字幕後，講者前綴仍然保留
- 在全新環境中，`vad=none` 不再因為 PyAV 而失敗

## 6. 驗收標準

- 第 5 節全部通過
- 新文案中英文都有，沒有硬編碼字串
- 除了 sherpa-onnx 之外，沒有新增其他大型依賴；Intel Mac 可以正常安裝
- diarization 關閉時，行為完全沒有差異

## 7. 必讀檔案

- `python/whisperflow/`：`transcriber.py`、`cli.py`、`config.py`、`events.py`、`models/manager.py`、`models/faster_whisper_backend.py`、`vad/base.py`（`adjust_timestamps`、`load_audio`）、`subtitles/writers.py`、`tests/`
- `python/config/config.example.json`、`python/config/config.metadata.json`、`python/requirements.txt`
- `src/main/`：`venv-installer.js`、`ipc-handlers.js`、`transcript-reader.js`、`subtitle-writer.js`、`error-catalog.js`
- `src/renderer/`：`lib/venv-bootstrap.js`、`components/settings-panel.js`、`components/transcript-preview.js`、`components/subtitle-editor.js`
- `locales/*/`：`settings.json`、`events.json`、`errors.json`
- `NOTICES.md`，以及 `changelog/` 底下最近幾篇
- `docs/specs/diarization_reference.py`

## 8. 建議開發順序

- Phase 0：PyAV 版本限制
- Phase 1：Python 核心（模組、模型下載、設定、管線、輸出）加上測試
- Phase 2：Electron（venv 升級、設定 UI、預覽與編輯器、錯誤碼、i18n）
- Phase 3：文件（README、NOTICES、changelog 草稿）

## 9. 待確認決策（請在 Plan 中逐條給建議）

1. 標籤預設文字：固定用 `Speaker {n}`，還是依 UI 語言帶入「講者 {n}」？
2. 設定要放在新群組 `diarization`，還是併進 `output`？
3. 模型要不要在「模型」分頁列出，並提供手動下載？
4. venv 依賴變動的偵測方式，以及如何相容舊的標記檔
5. `vad=none` 是否改走自家的 `load_audio()`，作為 `av<19` 之外的第二層保險
6. 預設的執行緒數

## 10. 預計檔案異動總覽

以下是依規格推估的異動範圍，Plan 時可以依實際程式碼調整（例如模型下載邏輯要放在 `diarization.py` 還是 `models/` 底下）。

```text
whisperflow-studio/
├── docs/specs/
│   ├── README.md                       新增：使用說明與給 Claude Code 的開場 prompt
│   ├── speaker-diarization.md          新增：本規格書
│   └── diarization_reference.py        新增：已驗證的參考實作
├── python/
│   ├── requirements.txt                修改：av<19、sherpa-onnx
│   ├── config/
│   │   ├── config.example.json         修改：新設定欄位
│   │   └── config.metadata.json        修改：新 fieldGroup
│   └── whisperflow/
│       ├── diarization.py              新增：引擎包裝、assign_speakers
│       ├── models/manager.py           修改或另開新檔：講者模型下載與快取
│       ├── transcriber.py              修改：word_timestamps、diarizing 階段
│       ├── config.py                   修改：新欄位
│       ├── cli.py                      修改：新 CLI 參數
│       ├── events.py                   修改：STAGE_DIARIZING
│       ├── subtitles/writers.py        修改：講者前綴
│       └── tests/
│           ├── test_diarization.py     新增
│           ├── test_writers.py         修改
│           └── test_config.py          修改
├── src/
│   ├── main/
│   │   ├── venv-installer.js           修改：requirements 雜湊比對、增量安裝
│   │   ├── ipc-handlers.js             修改：venv 狀態回報
│   │   ├── transcript-reader.js        修改：帶出 speakerLabel
│   │   ├── subtitle-writer.js          修改：重產字幕時保留前綴
│   │   └── error-catalog.js            修改：新 error code
│   └── renderer/
│       ├── lib/venv-bootstrap.js       修改：依賴更新流程
│       └── components/
│           ├── settings-panel.js       視需要：若 UI 不是全自動產生
│           ├── transcript-preview.js   修改：講者 chip
│           └── subtitle-editor.js      修改：講者 chip（唯讀）
├── locales/
│   ├── en/        settings.json、events.json、errors.json    修改
│   └── zh-TW/     settings.json、events.json、errors.json    修改
├── README.md、README.zh-TW.md          修改：功能說明
├── NOTICES.md                          修改：新元件授權
└── changelog/v1.17.0.md                新增：草稿
```
