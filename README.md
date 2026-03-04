# multi-downloader

yt-dlp based downloader with auth, request-access flow, history, and stats.

## One Copy/Paste Quick Start

Run these from the project folder.

### macOS (Homebrew)

```bash
cd /Users/skylarenns/Desktop/multi-downloader && brew install node ffmpeg yt-dlp && npm install && node server.cjs
```

### Linux (Debian/Ubuntu)

```bash
cd /path/to/multi-downloader && sudo apt update && sudo apt install -y nodejs npm ffmpeg yt-dlp && npm install && node server.cjs
```

### Windows (PowerShell + winget)

```powershell
cd C:\path\to\multi-downloader; winget install -e --id OpenJS.NodeJS.LTS; winget install -e --id Gyan.FFmpeg; winget install -e --id yt-dlp.yt-dlp; npm install; node server.cjs
```

### If dependencies are already installed

```bash
cd /Users/skylarenns/Desktop/multi-downloader && npm install && node server.cjs
```

Then open: `http://localhost:4928`

## Default Proxy

Downloads are routed through this proxy by default:

`socks5://127.0.0.1:40000`

This is applied to yt-dlp via `--proxy` on every download.

## Proxy Override

You can override or disable it in `local-secrets.txt`:

```txt
# override
DOWNLOAD_PROXY=socks5://127.0.0.1:40000

# disable proxy explicitly
# DOWNLOAD_PROXY=off
```

`YTDLP_PROXY` is also accepted as a fallback env var.

## Run

```bash
npm install
node server.cjs
```

Open:

`http://localhost:4928`

## Notes

- Requires `yt-dlp` and `ffmpeg` in PATH.
- App listens on port `4928`.
