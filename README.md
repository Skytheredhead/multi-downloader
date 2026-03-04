# multi-downloader

yt-dlp based downloader with auth, request-access flow, history, and stats.

## Quick Start (Linux First)

Use this section if you are running on Ubuntu/Debian Linux.

Important: Copy only the command lines, not the markdown headers/text.

### Linux (Ubuntu/Debian) Step-by-Step

1) Fix terminal state if paste got weird:

```bash
stty sane
```

2) Install `nvm` and Node 20:

```bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] || curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm install 20
nvm use 20
node -v
```

3) Install system dependencies:

```bash
sudo apt update
sudo apt install -y ffmpeg yt-dlp curl
```

4) Start the app:

```bash
cd ~/Documents/GitHub/multi-downloader
npm install
node server.cjs
```

5) Open:

`http://localhost:4928`

## Other OS

### macOS (Homebrew, one-liner)

```bash
cd /Users/skylarenns/Desktop/multi-downloader && brew install node ffmpeg yt-dlp && npm install && node server.cjs
```

### Windows (PowerShell + winget, one-liner)

```powershell
cd C:\path\to\multi-downloader; winget install -e --id OpenJS.NodeJS.LTS; winget install -e --id Gyan.FFmpeg; winget install -e --id yt-dlp.yt-dlp; npm install; node server.cjs
```

## Production Split Deploy (Vercel + Server)

This repo is configured for:

- Frontend on `https://dl.67mc.org` (Vercel)
- Backend on `https://dlapi.67mc.org` (your server via Cloudflare Tunnel)

Important production env var on Vercel:

```txt
NEXT_PUBLIC_BACKEND_API_BASE=https://dlapi.67mc.org/api
```

Backend minimum for split mode in `local-secrets.txt`:

```txt
CORS_ALLOWED_ORIGINS=https://dl.67mc.org
DOWNLOAD_PROXY=socks5://127.0.0.1:40000
```

Full deployment guide:

- `DEPLOYMENT.md`
- `deploy/cloudflared/config.example.yml`
- `deploy/systemd/multi-downloader.service.example`
- `.env.vercel.example`

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
