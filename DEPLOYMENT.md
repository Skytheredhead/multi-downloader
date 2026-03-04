# Production Deployment (Split Frontend/Backend)

This app is deployed in split mode:

- Frontend: Vercel on `https://dl.67mc.org`
- Backend: Server on `https://dlapi.67mc.org` (Cloudflare Tunnel -> `localhost:4928`)

## 1) Backend server prerequisites

Install on your server:

- Node.js 20+
- `yt-dlp`
- `ffmpeg`

Run backend from repo root:

```bash
npm install
npm run build
NODE_ENV=production node server.cjs
```

## 2) Backend secrets/config (`local-secrets.txt`)

Create/update `local-secrets.txt` in repo root.

Use this minimum set:

```txt
# Required for split FE/BE deploy
CORS_ALLOWED_ORIGINS=https://dl.67mc.org

# Optional explicit API review links
ACCESS_REVIEW_BASE_URL=https://dlapi.67mc.org

# Default proxy (already defaulted in code, but explicit is clearer)
DOWNLOAD_PROXY=socks5://127.0.0.1:40000

# Optional: reconnect proxy/VPN on YouTube bot-check failures
# PROXY_RESTART_CMD=sudo systemctl restart warp-svc
# PROXY_RESTART_TIMEOUT_MS=45000
# PROXY_RESTART_WAIT_MS=5000
# PROXY_RESTART_COOLDOWN_MS=45000

# Optional: YouTube auth cookies for yt-dlp
# YTDLP_COOKIES_FILE=/absolute/path/to/youtube-cookies.txt
# YTDLP_COOKIES_FROM_BROWSER=chrome

# Existing auth/email settings should remain here
# AUTH_USERNAME=...
# AUTH_PASSWORD_HASH=...
# GMAIL_USER=...
# GMAIL_APP_PASSWORD=...
# ACCESS_ALERT_TO=...
# DATA_ENCRYPTION_KEY=...
```

Restart backend after editing.

## 3) Cloudflare Tunnel (`dlapi.67mc.org`)

Use the sample config in `deploy/cloudflared/config.example.yml`.

Key point: route `dlapi.67mc.org` -> `http://localhost:4928`.

## 4) Frontend on Vercel (`dl.67mc.org`)

Connect this GitHub repo to Vercel.

Set Vercel project env var:

- `NEXT_PUBLIC_BACKEND_API_BASE=https://dlapi.67mc.org/api`

Then deploy and attach custom domain `dl.67mc.org`.

## 5) DNS mapping

- `dl.67mc.org` -> Vercel
- `dlapi.67mc.org` -> Cloudflare Tunnel

## 6) Verification checklist

1. Open `https://dl.67mc.org/login`
2. Login and verify session persists on refresh
3. Submit a download and watch progress (SSE)
4. Open `/history` and `/stats`
5. Confirm no CORS errors in browser devtools
6. Confirm backend health endpoint:
   - `https://dlapi.67mc.org/api/health`

## 7) Monitoring and backups

Watch backend logs for:

- CORS rejects
- SMTP errors
- yt-dlp/ffmpeg failures
- auth/session errors

Back up these files/directories regularly:

- `downloads/users/`
- `user-accounts.json`
- `access-requests.json`
- `stats-store.json`
