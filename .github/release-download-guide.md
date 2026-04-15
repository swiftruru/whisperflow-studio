<!-- download-guide -->
## 📦 Which file should I download? / 我該下載哪一個？

Pick the file that matches your operating system — you only need **one**. Everything else in the Assets list is either a build for a different platform, a duplicate stable alias, or auto-update metadata you can ignore.

請挑選符合你作業系統的檔案，**只需要下載一個**。Assets 清單裡其他檔案分別是其他平台的版本、穩定別名，或給內建自動更新使用的描述檔，都可以忽略。

| Your system / 作業系統 | Download / 下載 | Notes / 備註 |
|---|---|---|
| 🍎 **macOS — Apple Silicon** (M1 / M2 / M3 / M4) | `WhisperFlow-Studio-__VERSION__-mac-arm64.dmg` | Any Mac made since late 2020 / 2020 末之後的 Mac |
| 🍎 **macOS — Intel** | `WhisperFlow-Studio-__VERSION__-mac-x64.dmg` | Older Intel-based Macs / 舊款 Intel Mac |
| 🪟 **Windows 10 / 11** (64-bit) | `WhisperFlow-Studio-__VERSION__-win-x64.exe` | NSIS installer, supports in-app auto-update / 支援 App 內自動更新 |
| 🐧 **Linux** (x86_64) | `WhisperFlow-Studio-__VERSION__-linux-x86_64.AppImage` | Portable binary — `chmod +x` then double-click / 免安裝，下載後 `chmod +x` 即可執行 |

> **Not sure which Mac you have?** Click  → About This Mac. "Chip: Apple M…" → pick **arm64**. "Processor: Intel…" → pick **x64**.
> **不確定 Mac 種類？** 點左上角  → 關於這台 Mac。顯示「晶片：Apple M…」選 **arm64**；顯示「處理器：Intel…」選 **x64**。

<details>
<summary>What are all the other files? / 其他那些檔案是什麼？</summary>

- **`WhisperFlow-Studio-__VERSION__-*.dmg / .exe / .AppImage`** — the same builds as the stable-name files above, just with the version number baked into the filename. Either works; they're byte-for-byte identical. 跟上面表格裡的穩定別名是同一份 build，只是檔名帶了版本號，兩者完全一樣。
- **`latest.yml` / `latest-mac.yml` / `latest-linux.yml`** — metadata consumed by the app's built-in auto-updater to verify downloaded installers. **You don't need to click these.** / 給 App 內建自動更新使用的描述檔，**一般使用者不需要下載**。
- **`Source code (zip / tar.gz)`** — GitHub's automatic source snapshot. Only useful if you want to build from source. / GitHub 自動產生的原始碼快照，只有要從原始碼自行編譯時才需要。

</details>

---
