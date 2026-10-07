# 講者辨識規格包

這個資料夾是 WhisperFlow Studio「講者辨識（Speaker Diarization）」功能的規格與參考資料，給 Claude Code 規劃與實作用。

## 檔案

| 檔案 | 內容 |
|---|---|
| `speaker-diarization.md` | 規格書：背景、已驗證事實、實作需求、測試、驗收標準、待確認決策、檔案異動總覽 |
| `diarization_reference.py` | 參考實作：sherpa-onnx 引擎包裝與 `assign_speakers()`，2026-10-07 實測可用，不會被 App import |
| `README.md` | 本說明 |

## 放置方式

把壓縮檔解壓到 repo 根目錄，會得到：

```text
whisperflow-studio/
└── docs/specs/
    ├── README.md
    ├── speaker-diarization.md
    └── diarization_reference.py
```

終端機可以這樣做：

```bash
unzip whisperflow-diarization-spec.zip -d /path/to/whisperflow-studio
```

## 給 Claude Code 的開場 prompt

```text
請先閱讀 docs/specs/speaker-diarization.md（規格書）與 docs/specs/diarization_reference.py（參考實作），再依規格第 7 節讀完必讀檔案。
先不要寫程式：用 Plan 模式提出分階段的實作計畫，並針對第 9 節的待確認決策逐條給建議，等我確認後再開始實作。
```

## 備註

- 規格第 3 節的版本號、檔案大小與 sha256 都是 2026-10-07 實測的結果。
- 功能做完後，這個資料夾要不要留在 repo 裡，由你決定。
