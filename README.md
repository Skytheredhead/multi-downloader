# multi-downloader

yt-dlp based downloader with auth, request-access flow, history, and stats.

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
