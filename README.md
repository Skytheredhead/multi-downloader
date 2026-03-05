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
# proxy is off by default; set only if you want one
# DOWNLOAD_PROXY=socks5://127.0.0.1:40000
```

Full deployment guide:

- `DEPLOYMENT.md`
- `deploy/cloudflared/config.example.yml`
- `deploy/systemd/multi-downloader.service.example`
- `.env.vercel.example`

## Proxy (Optional)

Proxying is disabled by default. To enable it in `local-secrets.txt`:

```txt
# enable
DOWNLOAD_PROXY=socks5://127.0.0.1:40000

# disable proxy explicitly
DOWNLOAD_PROXY=off
```

`YTDLP_PROXY` is also accepted as a fallback env var.

## Auto Proxy Reconnect (Bot-Check Recovery)

When YouTube returns "Sign in to confirm you're not a bot", backend retries can optionally restart your proxy/VPN first.

Add this to `local-secrets.txt`:

```txt
# Example: reconnect your VPN/proxy service
PROXY_RESTART_CMD=sudo systemctl restart warp-svc

# Optional timing controls (milliseconds)
PROXY_RESTART_TIMEOUT_MS=45000
PROXY_RESTART_WAIT_MS=5000
PROXY_RESTART_COOLDOWN_MS=45000
```

Notes:

- `PROXY_RESTART_CMD` is not set by default.
- The command must run non-interactively (no password prompt).
- On matching YouTube bot-check failures, server will:
  1) restart proxy once, 2) retry via proxy, 3) retry without proxy.

## YouTube Cookies (Optional)

If YouTube still blocks downloads, configure one auth source:

```txt
# Option A: Netscape cookies file path
YTDLP_COOKIES_FILE=/absolute/path/to/youtube-cookies.txt

# Option B: import from browser profile (yt-dlp syntax)
# YTDLP_COOKIES_FROM_BROWSER=chrome
```

Optional:

```txt
# custom request shaping
# YTDLP_USER_AGENT=Mozilla/5.0 ...
# YTDLP_EXTRACTOR_ARGS=youtube:player_client=android,web
```

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
