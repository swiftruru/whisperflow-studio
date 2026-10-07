# 規格包

這個資料夾放 WhisperFlow Studio 各功能的規格與參考資料，給 Claude Code 規劃與實作用。目前有兩包：「講者辨識（Speaker Diarization）」與「字幕切段（Subtitle Segmentation）」，兩者都已實作完成，程式註解會直接引用這裡的檔名。

## 檔案

| 檔案 | 內容 |
|---|---|
| `speaker-diarization.md` | 規格書：背景、已驗證事實、實作需求、測試、驗收標準、待確認決策、檔案異動總覽 |
| `diarization_reference.py` | 參考實作：sherpa-onnx 引擎包裝與 `assign_speakers()`，2026-10-07 實測可用，不會被 App import |
| `subtitle-segmentation.md` | 規格書：背景、已驗證事實、實作需求、測試、驗收標準、待確認決策、檔案異動總覽 |
| `segmentation_reference.py` | 參考實作：依字數比例內插時間的切段原型，2026-10-07 在 408 則字幕上實測，不會被 App import |
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

字幕切段那一包是用同樣的方式放進來的（`subtitle-segmentation.md` 與 `segmentation_reference.py`）。

終端機可以這樣做：

```bash
unzip whisperflow-diarization-spec.zip -d /path/to/whisperflow-studio
```

## 給 Claude Code 的開場 prompt

講者辨識：

```text
請先閱讀 docs/specs/speaker-diarization.md（規格書）與 docs/specs/diarization_reference.py（參考實作），再依規格第 7 節讀完必讀檔案。
先不要寫程式：用 Plan 模式提出分階段的實作計畫，並針對第 9 節的待確認決策逐條給建議，等我確認後再開始實作。
```

字幕切段：

```text
請先閱讀 docs/specs/subtitle-segmentation.md（規格書）與 docs/specs/segmentation_reference.py（參考實作），再依規格第 7 節讀完必讀檔案，尤其是講者辨識目前的實作。
先不要寫程式：用 Plan 模式整理講者辨識的實作現況和本規格有出入的地方，提出分階段的實作計畫，並針對第 9 節的待確認決策逐條給建議，等我確認後再開始實作。
```

## 備註

- 講者辨識規格第 3 節的版本號、檔案大小與 sha256，以及字幕切段規格第 3 節的實測數據，都是 2026-10-07 實測的結果。
- 功能做完後，這個資料夾要不要留在 repo 裡，由你決定。
