<!-- download-guide -->
## Which file should I download?

Pick the file that matches your operating system. You only need **one**.

| Platform | Download | Notes |
|---|---|---|
| **macOS (Apple Silicon)** M1/M2/M3/M4 | `WhisperFlow-Studio-__VERSION__-mac-arm64.dmg` | Any Mac made since late 2020 |
| **macOS (Intel)** | `WhisperFlow-Studio-__VERSION__-mac-x64.dmg` | Older Intel-based Macs |
| **Windows 10/11** (64-bit) | `WhisperFlow-Studio-__VERSION__-win-x64.exe` | NSIS installer, supports in-app auto-update |
| **Linux** (x86_64) | `WhisperFlow-Studio-__VERSION__-linux-x86_64.AppImage` | Portable binary, `chmod +x` then run |

> **Not sure which Mac you have?** Click the Apple menu > About This Mac. If it says "Chip: Apple M..." pick **arm64**. If it says "Processor: Intel..." pick **x64**.

<details>
<summary>What are all the other files?</summary>

- **Versioned filenames** (`*-__VERSION__-*.dmg` etc.) are byte-for-byte identical to the stable-name files above, just with the version number in the filename.
- **`latest.yml` / `latest-mac.yml` / `latest-linux.yml`** are metadata for the app's built-in auto-updater. You do not need to download these.
- **Source code (zip / tar.gz)** is GitHub's automatic source snapshot, only needed if you want to build from source.

</details>

---
