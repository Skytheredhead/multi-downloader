const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");
const readline = require("readline");
const nodemailer = require("nodemailer");
const net = require("net");
const next = require("next");

const PORT = 4928;
const ROOT = __dirname;
const LOCAL_SECRETS_FILE = path.join(ROOT, "local-secrets.txt");
const DOWNLOADS_DIR = path.join(ROOT, "downloads");
const USERS_DOWNLOADS_DIR = path.join(DOWNLOADS_DIR, "users");

function loadLocalSecrets(filePath) {
  if (!fs.existsSync(filePath)) return;
  let raw = "";
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return;
  }

  for (const lineRaw of raw.split(/\r?\n/)) {
    const line = String(lineRaw || "").trim();
    if (!line || line.startsWith("#")) continue;
    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const idx = normalized.indexOf("=");
    if (idx <= 0) continue;
    const key = normalized.slice(0, idx).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = normalized.slice(idx + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined || process.env[key] === "") {
      process.env[key] = value;
    }
  }
}

loadLocalSecrets(LOCAL_SECRETS_FILE);

const SESSION_COOKIE = "md_session";
const SESSION_TTL_HOURS = Math.max(1, Number(process.env.SESSION_TTL_HOURS || 24 * 30));
const SESSION_TTL_MS = SESSION_TTL_HOURS * 60 * 60 * 1000;
const EMAIL_TIMEOUT_MS = 15000;
const ACCESS_REVIEW_TOKEN_TTL_MS = 48 * 60 * 60 * 1000;

const DOWNLOAD_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const USER_STORAGE_CAP_BYTES = 10 * 1024 * 1024 * 1024;

const LOGIN_RATE_LIMIT = { perMinute: 5, failBlockThreshold: 10, blockForMs: 60 * 60 * 1000 };
const ACCESS_REQUEST_LIMIT = { per15Minutes: 2, windowMs: 15 * 60 * 1000 };
const FORGOT_PASSWORD_LIMIT = { per15Minutes: 2, windowMs: 15 * 60 * 1000 };
const DOWNLOAD_LIMIT = { perMinute: 10, perHour: 25 };
const PASSWORD_RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

const AUTH_USERNAME = process.env.AUTH_USERNAME || "";
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || "";
const AUTH_PASSWORD_HASH = process.env.AUTH_PASSWORD_HASH || "";

const GMAIL_USER = process.env.GMAIL_USER || "stemsplat@gmail.com";
const GMAIL_APP_PASSWORD = String(process.env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, "");
const ACCESS_ALERT_TO = process.env.ACCESS_ALERT_TO || "skytheredhead@gmail.com";
const SMTP_HOST = process.env.SMTP_HOST || "smtp.gmail.com";
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = String(process.env.SMTP_SECURE || "false").toLowerCase() === "true";
const DATA_ENCRYPTION_KEY_RAW = String(process.env.DATA_ENCRYPTION_KEY || "").trim();
const DATA_ENCRYPTION_KEY = DATA_ENCRYPTION_KEY_RAW
  ? crypto.createHash("sha256").update(DATA_ENCRYPTION_KEY_RAW).digest()
  : null;
const DATA_ENCRYPTION_PREFIX = "encv1";
const ACCESS_REVIEW_BASE_URL = String(process.env.ACCESS_REVIEW_BASE_URL || "").replace(/\/+$/, "");
const CORS_ALLOWED_ORIGINS = String(
  process.env.CORS_ALLOWED_ORIGINS ||
    "http://localhost:3000,http://127.0.0.1:3000,http://localhost:4928"
)
  .split(",")
  .map(value => value.trim())
  .filter(Boolean);
const ACCESS_REQUESTS_FILE = path.join(ROOT, "access-requests.json");
const USER_ACCOUNTS_FILE = path.join(ROOT, "user-accounts.json");
const STATS_STORE_FILE = path.join(ROOT, "stats-store.json");
const STATS_MAX_RECORDS = 10000;
const VIDEO_ACCEL_MODE = String(process.env.VIDEO_ACCEL_MODE || "auto").toLowerCase();

const VALID_TYPES = new Set(["a+v", "a", "v"]);
const VALID_QUALITIES = new Set(["hq", "mq", "lq"]);
const VIDEO_CODECS = new Set(["h264", "h265", "mov", "webm"]);
const AUDIO_CODECS = new Set(["wav", "mp3 (320)", "mp3 (128)"]);
const VIDEO_THUMBNAIL_EXTS = new Set([
  ".mp4",
  ".mkv",
  ".webm",
  ".mov",
  ".avi",
  ".m4v",
  ".mpg",
  ".mpeg"
]);
const AUDIO_OUTPUT_EXTS = new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg", ".opus", ".flac"]);
const MEDIA_OUTPUT_EXTS = new Set([...VIDEO_THUMBNAIL_EXTS, ...AUDIO_OUTPUT_EXTS]);
const IMAGE_THUMBNAIL_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);

const jobs = new Map();
const sessions = new Map();
const loginStateByIp = new Map();
const accessRequestsByIp = new Map();
const forgotPasswordEventsByIp = new Map();
const downloadEventsByIp = new Map();
const downloadEventsByAccount = new Map();
const accessRequestById = new Map();
const passwordResetById = new Map();
const activeAccountsByUsername = new Map();
const pendingAccountsById = new Map();
let statsStore = { downloads: [] };

let mailTransport = null;
let warnedMissingDataEncryptionKey = false;
const NVIDIA_TRANSCODE_AVAILABLE = detectNvidiaTranscodeSupport();

function detectNvidiaTranscodeSupport() {
  if (VIDEO_ACCEL_MODE === "off" || VIDEO_ACCEL_MODE === "none") return false;
  if (VIDEO_ACCEL_MODE !== "auto" && VIDEO_ACCEL_MODE !== "on" && VIDEO_ACCEL_MODE !== "true") {
    return false;
  }

  try {
    const check = spawnSync("ffmpeg", ["-hide_banner", "-encoders"], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 4000
    });
    const output = `${check.stdout || ""}\n${check.stderr || ""}`;
    return /h264_nvenc/i.test(output) && /hevc_nvenc/i.test(output);
  } catch {
    return false;
  }
}

function normalizeIp(raw) {
  if (!raw || typeof raw !== "string") return "unknown";
  const value = raw.split(",")[0].trim();
  if (!value) return "unknown";
  if (value.startsWith("::ffff:")) return value.slice(7);
  return value;
}

function sourceLabelFromUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || ""));
    const host = parsed.hostname.replace(/^www\./i, "");
    const shortPath = parsed.pathname && parsed.pathname !== "/" ? parsed.pathname : "";
    const combined = `${host}${shortPath}`;
    return combined.length > 160 ? `${combined.slice(0, 157)}...` : combined;
  } catch {
    const fallback = String(rawUrl || "").trim();
    return fallback.length > 160 ? `${fallback.slice(0, 157)}...` : fallback;
  }
}

function extractYouTubeVideoId(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || "").trim());
    const host = parsed.hostname.toLowerCase();

    if (host === "youtu.be") {
      const id = parsed.pathname.replace(/^\/+/, "").split("/")[0];
      return /^[A-Za-z0-9_-]{6,}$/.test(id) ? id : "";
    }

    if (host.endsWith("youtube.com")) {
      const watchId = parsed.searchParams.get("v");
      if (watchId && /^[A-Za-z0-9_-]{6,}$/.test(watchId)) return watchId;

      const parts = parsed.pathname.replace(/^\/+/, "").split("/");
      if (parts.length >= 2 && (parts[0] === "shorts" || parts[0] === "embed")) {
        const id = parts[1];
        return /^[A-Za-z0-9_-]{6,}$/.test(id) ? id : "";
      }
    }
  } catch {
    // ignore URL parse failures
  }
  return "";
}

function fallbackRemoteThumbnailUrl(rawUrl) {
  const id = extractYouTubeVideoId(rawUrl);
  if (!id) return "";
  return `https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg`;
}

function isAllowedCorsOrigin(origin) {
  if (!origin) return false;
  if (CORS_ALLOWED_ORIGINS.includes(origin)) return true;
  try {
    const parsed = new URL(origin);
    return parsed.hostname.endsWith(".vercel.app");
  } catch {
    return false;
  }
}

function appendVaryHeader(res, key) {
  const current = String(res.getHeader("Vary") || "");
  if (!current) {
    res.setHeader("Vary", key);
    return;
  }
  const parts = current.split(",").map(part => part.trim()).filter(Boolean);
  if (!parts.includes(key)) {
    parts.push(key);
    res.setHeader("Vary", parts.join(", "));
  }
}

function applyCors(req, res, next) {
  const origin = String(req.headers.origin || "");
  if (isAllowedCorsOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    appendVaryHeader(res, "Origin");
  }

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  next();
}

function getClientIp(req) {
  const cfIp = req.headers["cf-connecting-ip"];
  if (typeof cfIp === "string" && cfIp.trim()) return normalizeIp(cfIp);

  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.trim()) return normalizeIp(xff);

  if (typeof req.ip === "string") return normalizeIp(req.ip);
  return "unknown";
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const cookies = {};

  if (!header) return cookies;

  const pairs = header.split(";");
  for (const pair of pairs) {
    const idx = pair.indexOf("=");
    if (idx <= 0) continue;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    cookies[key] = decodeURIComponent(val);
  }

  return cookies;
}

function setSessionCookie(req, res, sessionId) {
  const secure = req.secure || String(req.headers["x-forwarded-proto"] || "").includes("https");
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}`,
    "Path=/",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    "HttpOnly",
    "SameSite=Strict"
  ];

  if (secure) parts.push("Secure");

  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearSessionCookie(req, res) {
  const secure = req.secure || String(req.headers["x-forwarded-proto"] || "").includes("https");
  const parts = [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Strict"
  ];

  if (secure) parts.push("Secure");

  res.setHeader("Set-Cookie", parts.join("; "));
}

function safeEqualString(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function encryptStoredValue(input) {
  const value = String(input || "");
  if (!DATA_ENCRYPTION_KEY || !value) return value;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", DATA_ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${DATA_ENCRYPTION_PREFIX}:${iv.toString("base64url")}:${tag.toString("base64url")}:${encrypted.toString("base64url")}`;
}

function decryptStoredValue(input) {
  const value = String(input || "");
  if (!value) return "";
  if (!value.startsWith(`${DATA_ENCRYPTION_PREFIX}:`)) return value;

  if (!DATA_ENCRYPTION_KEY) {
    if (!warnedMissingDataEncryptionKey) {
      console.log("WARNING: encrypted account data detected but DATA_ENCRYPTION_KEY is not set.");
      warnedMissingDataEncryptionKey = true;
    }
    return "";
  }

  const parts = value.split(":");
  if (parts.length !== 4) return "";

  try {
    const iv = Buffer.from(parts[1], "base64url");
    const tag = Buffer.from(parts[2], "base64url");
    const encrypted = Buffer.from(parts[3], "base64url");
    const decipher = crypto.createDecipheriv("aes-256-gcm", DATA_ENCRYPTION_KEY, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString("utf8");
  } catch {
    return "";
  }
}

function readIdentityField(record, plainKey, encryptedKey) {
  const plain = String(record?.[plainKey] || "").trim();
  if (plain) return plain;
  const encrypted = String(record?.[encryptedKey] || "").trim();
  if (!encrypted) return "";
  return String(decryptStoredValue(encrypted) || "").trim();
}

function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function verifyPasswordHash(password, hashValue) {
  const hash = String(hashValue || "");
  if (!hash) return false;

  if (hash.startsWith("scrypt$")) {
    const parts = hash.split("$");
    if (parts.length !== 3 || parts[0] !== "scrypt") return false;

    try {
      const salt = Buffer.from(parts[1], "hex");
      const expected = Buffer.from(parts[2], "hex");
      const actual = crypto.scryptSync(password, salt, expected.length);
      return crypto.timingSafeEqual(actual, expected);
    } catch {
      return false;
    }
  }

  return safeEqualString(password, hash);
}

function hashPasswordForStorage(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password || ""), salt, 32);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

function verifyEnvAdminPassword(password) {
  if (AUTH_PASSWORD_HASH) {
    return verifyPasswordHash(password, AUTH_PASSWORD_HASH);
  }

  if (!AUTH_PASSWORD) return false;
  return safeEqualString(password, AUTH_PASSWORD);
}

function authConfigured() {
  return Boolean(AUTH_USERNAME && (AUTH_PASSWORD || AUTH_PASSWORD_HASH));
}

function makeSession(username) {
  const id = crypto.randomUUID();
  const now = Date.now();

  sessions.set(id, {
    id,
    username,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: now + SESSION_TTL_MS
  });

  return id;
}

function readValidSession(req) {
  const cookies = parseCookies(req);
  const sessionId = cookies[SESSION_COOKIE];
  if (!sessionId) return null;

  const session = sessions.get(sessionId);
  if (!session) return null;

  const now = Date.now();
  if (session.expiresAt <= now) {
    sessions.delete(sessionId);
    return null;
  }

  session.lastSeenAt = now;
  session.expiresAt = now + SESSION_TTL_MS;
  return session;
}

function requireAuth(req, res, next) {
  const session = readValidSession(req);
  if (!session) {
    res.status(401).json({ ok: false, error: "Authentication required." });
    return;
  }

  req.auth = session;
  next();
}

function getOrCreateLoginState(ip) {
  if (!loginStateByIp.has(ip)) {
    loginStateByIp.set(ip, {
      attempts: [],
      failedStreak: 0,
      blockedUntil: 0
    });
  }

  return loginStateByIp.get(ip);
}

function pruneRecent(events, windowMs, now) {
  return events.filter(ts => now - ts <= windowMs);
}

function checkLoginRate(ip) {
  const now = Date.now();
  const state = getOrCreateLoginState(ip);

  if (state.blockedUntil > now) {
    const waitSeconds = Math.ceil((state.blockedUntil - now) / 1000);
    return {
      allowed: false,
      error: `Too many failed logins. Try again in ${waitSeconds}s.`
    };
  }

  state.attempts = pruneRecent(state.attempts, 60 * 1000, now);

  if (state.attempts.length >= LOGIN_RATE_LIMIT.perMinute) {
    return {
      allowed: false,
      error: "Too many login attempts from this IP. Limit is 5 per minute."
    };
  }

  state.attempts.push(now);
  return { allowed: true, state };
}

function registerFailedLogin(state) {
  state.failedStreak += 1;
  if (state.failedStreak >= LOGIN_RATE_LIMIT.failBlockThreshold) {
    state.blockedUntil = Date.now() + LOGIN_RATE_LIMIT.blockForMs;
    state.failedStreak = 0;
  }
}

function registerSuccessfulLogin(state) {
  state.failedStreak = 0;
  state.blockedUntil = 0;
}

function consumeWindowLimit(map, key, limit, windowMs) {
  const now = Date.now();
  const prior = map.get(key) || [];
  const fresh = pruneRecent(prior, windowMs, now);

  if (fresh.length >= limit) {
    map.set(key, fresh);
    return false;
  }

  fresh.push(now);
  map.set(key, fresh);
  return true;
}

function getMailTransport() {
  if (!GMAIL_APP_PASSWORD) return null;

  if (!mailTransport) {
    mailTransport = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      requireTLS: !SMTP_SECURE,
      auth: {
        user: GMAIL_USER,
        pass: GMAIL_APP_PASSWORD
      },
      connectionTimeout: EMAIL_TIMEOUT_MS,
      greetingTimeout: EMAIL_TIMEOUT_MS,
      socketTimeout: EMAIL_TIMEOUT_MS,
      tls: { minVersion: "TLSv1.2", servername: SMTP_HOST }
    });
  }

  return mailTransport;
}

async function sendMailWithTimeout(mailOptions) {
  const transport = getMailTransport();
  if (!transport) {
    throw new Error("Email is not configured. Set GMAIL_APP_PASSWORD.");
  }

  try {
    await transport.verify();
  } catch (error) {
    throw new Error(`SMTP verify failed: ${error?.message || "unknown error"}`);
  }

  const sendPromise = transport.sendMail(mailOptions);

  let timerId;
  const timeoutPromise = new Promise((_, reject) => {
    timerId = setTimeout(() => {
      reject(new Error("Email delivery timed out. Check Gmail app password and retry."));
    }, EMAIL_TIMEOUT_MS);
  });

  try {
    await Promise.race([sendPromise, timeoutPromise]);
  } catch (error) {
    throw new Error(`SMTP send failed: ${error?.message || "unknown error"}`);
  } finally {
    clearTimeout(timerId);
  }
}

async function sendAccessRequestEmail(record, meta) {
  const allowUrl = `${meta.baseUrl}/auth/request-access/review/${encodeURIComponent(record.id)}/allow?token=${encodeURIComponent(record.allowToken)}`;
  const denyUrl = `${meta.baseUrl}/auth/request-access/review/${encodeURIComponent(record.id)}/deny?token=${encodeURIComponent(record.denyToken)}`;

  const requestLocal = new Date(record.requestTime).toLocaleString();
  const clientInfo = parseClientInfo(record.userAgent);
  const ipText = record.ip ? record.ip : "Unavailable";
  const clientSummary = `${clientInfo.os} / ${clientInfo.browser}`;

  const text = [
    "dl.67mc.org access request",
    "",
    `Time received: ${requestLocal}`,
    `Username: ${record.username}`,
    `Email: ${record.email}`,
    `IP: ${ipText}`,
    `Client: ${clientSummary}`,
    `User-Agent: ${clientInfo.rawUserAgent}`,
    "Link expires after 48 hours.",
    "",
    `ALLOW: ${allowUrl}`,
    `DENY: ${denyUrl}`
  ].join("\n");

  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.45;color:#111">
      <p><strong>dl.67mc.org access request</strong></p>
      <table cellpadding="4" cellspacing="0" style="border-collapse:collapse">
        <tr><td><strong>Time received</strong></td><td>${escapeHtml(requestLocal)}</td></tr>
        <tr><td><strong>Username</strong></td><td>${escapeHtml(record.username)}</td></tr>
        <tr><td><strong>Email</strong></td><td>${escapeHtml(record.email)}</td></tr>
        <tr><td><strong>IP</strong></td><td>${escapeHtml(ipText)}</td></tr>
        <tr><td><strong>Client</strong></td><td>${escapeHtml(clientSummary)}</td></tr>
        <tr><td><strong>User-Agent</strong></td><td>${escapeHtml(clientInfo.rawUserAgent)}</td></tr>
      </table>
      <p style="margin-top:10px">Link expires after 48 hours.</p>
      <div style="margin-top:16px">
        <a href="${allowUrl}" style="display:inline-block;padding:10px 16px;background:#15803d;color:#fff;text-decoration:none;border-radius:4px;margin-right:8px">Allow</a>
        <a href="${denyUrl}" style="display:inline-block;padding:10px 16px;background:#b91c1c;color:#fff;text-decoration:none;border-radius:4px">Deny</a>
      </div>
    </div>
  `;

  try {
    await sendMailWithTimeout({
      from: GMAIL_USER,
      to: ACCESS_ALERT_TO,
      subject: "dl.67mc.org access request",
      text,
      html
    });
  } catch (error) {
    const detail = error?.message || "Unknown email error";
    throw new Error(`Unable to send access email via Gmail SMTP. ${detail}`);
  }
}

async function sendDecisionEmailToRequester(record, action, reason = "") {
  const subject =
    action === "allow"
      ? "Your dl.67mc.org access request was approved"
      : "Your dl.67mc.org access request was denied";

  const body =
    action === "allow"
      ? [
          "Hello,",
          "",
          "Your account was approved on dl.67mc.org.",
          "",
          "If this wasn't expected, ignore this email."
        ].join("\n")
      : [
          "Hello,",
          "",
          "Your account request was denied on dl.67mc.org.",
          "",
          `Reason: ${reason || "No reason was provided."}`
        ].join("\n");

  try {
    await sendMailWithTimeout({
      from: GMAIL_USER,
      to: record.email,
      subject,
      text: body
    });
  } catch (error) {
    const detail = error?.message || "Unknown email error";
    throw new Error(`Unable to send requester decision email. ${detail}`);
  }
}

async function sendPasswordResetEmail(record, meta) {
  const resetUrl = `${meta.baseUrl}/auth/reset-password/${encodeURIComponent(record.id)}?token=${encodeURIComponent(record.token)}`;
  const expiresMinutes = Math.max(1, Math.round(PASSWORD_RESET_TOKEN_TTL_MS / (60 * 1000)));

  const text = [
    "dl.67mc.org password reset",
    "",
    `A password reset was requested for username: ${record.username}`,
    "",
    `Reset link: ${resetUrl}`,
    "",
    `This link expires in ${expiresMinutes} minutes.`
  ].join("\n");

  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.45;color:#111">
      <p><strong>dl.67mc.org password reset</strong></p>
      <p>A password reset was requested for <strong>${escapeHtml(record.username)}</strong>.</p>
      <p>
        <a href="${resetUrl}" style="display:inline-block;padding:10px 16px;background:#5b21b6;color:#fff;text-decoration:none;border-radius:4px">
          Reset Password
        </a>
      </p>
      <p style="font-size:13px;color:#555">This link expires in ${expiresMinutes} minutes.</p>
    </div>
  `;

  try {
    await sendMailWithTimeout({
      from: GMAIL_USER,
      to: record.email,
      subject: "dl.67mc.org password reset",
      text,
      html
    });
  } catch (error) {
    const detail = error?.message || "Unknown email error";
    throw new Error(`Unable to send password reset email. ${detail}`);
  }
}

async function sendBugReportEmail(report) {
  const lines = [
    "dl.67mc.org bug report",
    "",
    `Time: ${new Date().toLocaleString()}`,
    `User: ${report.username || "unknown"}`,
    `IP: ${report.ip || "unknown"}`,
    `Error code: ${report.errorCode || "unknown_error"}`,
    report.message ? `Message: ${report.message}` : "",
    report.jobId ? `Job ID: ${report.jobId}` : "",
    report.url ? `URL: ${report.url}` : "",
    report.type ? `Type: ${report.type}` : "",
    report.quality ? `Quality: ${report.quality}` : "",
    report.codec ? `Codec: ${report.codec}` : "",
    report.userAgent ? `User-Agent: ${report.userAgent}` : "",
    "",
    "Recent actions:",
    ...(Array.isArray(report.actions) && report.actions.length > 0
      ? report.actions.map((item, index) => `${index + 1}. ${item}`)
      : ["(none)"])
  ].filter(Boolean);

  try {
    await sendMailWithTimeout({
      from: GMAIL_USER,
      to: ACCESS_ALERT_TO,
      subject: `dl.67mc.org bug report: ${String(report.errorCode || "unknown_error").slice(0, 80)}`,
      text: lines.join("\n")
    });
  } catch (error) {
    const detail = error?.message || "Unknown email error";
    throw new Error(`Unable to send bug report email. ${detail}`);
  }
}

function checkDownloadRateLimit({ username, ip }) {
  const now = Date.now();

  const accountEvents = pruneRecent(downloadEventsByAccount.get(username) || [], 60 * 60 * 1000, now);
  const ipEvents = pruneRecent(downloadEventsByIp.get(ip) || [], 60 * 60 * 1000, now);

  const accountLastMinute = accountEvents.filter(ts => now - ts <= 60 * 1000).length;
  const ipLastMinute = ipEvents.filter(ts => now - ts <= 60 * 1000).length;

  if (accountLastMinute >= DOWNLOAD_LIMIT.perMinute) {
    return { allowed: false, error: "Download limit reached for this account (10/min)." };
  }

  if (ipLastMinute >= DOWNLOAD_LIMIT.perMinute) {
    return { allowed: false, error: "Download limit reached for this IP (10/min)." };
  }

  if (accountEvents.length >= DOWNLOAD_LIMIT.perHour) {
    return { allowed: false, error: "Download limit reached for this account (25/hr)." };
  }

  if (ipEvents.length >= DOWNLOAD_LIMIT.perHour) {
    return { allowed: false, error: "Download limit reached for this IP (25/hr)." };
  }

  accountEvents.push(now);
  ipEvents.push(now);
  downloadEventsByAccount.set(username, accountEvents);
  downloadEventsByIp.set(ip, ipEvents);

  return { allowed: true };
}

function userKey(username) {
  return encodeURIComponent(String(username || "").trim().toLowerCase());
}

function getUserRoot(username) {
  return path.join(USERS_DOWNLOADS_DIR, userKey(username));
}

function getUserManifestPath(username) {
  return path.join(getUserRoot(username), "manifest.json");
}

function ensureUserRoot(username) {
  fs.mkdirSync(getUserRoot(username), { recursive: true });
}

function readJsonFile(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function normalizeQualityValue(value) {
  const quality = String(value || "").trim().toLowerCase();
  return VALID_QUALITIES.has(quality) ? quality : "";
}

function normalizeMediaTypeValue(value) {
  const mediaType = String(value || "").trim();
  return VALID_TYPES.has(mediaType) ? mediaType : "";
}

function formatDurationFromSeconds(value) {
  const seconds = Number(value || 0);
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const whole = Math.round(seconds);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function sanitizeStatsEntry(item) {
  if (!item || typeof item !== "object") return null;
  const username = normalizeUsername(item.username);
  const title = String(item.title || "").trim();
  const sourceUrl = String(item.sourceUrl || "").trim();
  const mediaType = normalizeMediaTypeValue(item.mediaType) || "a+v";
  const quality = normalizeQualityValue(item.quality) || "hq";
  const createdAt = Number(item.createdAt || 0);
  if (!username || !title || !sourceUrl || !createdAt) return null;

  const durationSecRaw = Number(item.durationSec || 0);
  const durationSec = Number.isFinite(durationSecRaw) && durationSecRaw > 0 ? durationSecRaw : 0;
  const sizeBytesRaw = Number(item.sizeBytes || 0);
  const sizeBytes = Number.isFinite(sizeBytesRaw) && sizeBytesRaw > 0 ? sizeBytesRaw : 0;
  const avgSpeedMBpsRaw = Number(item.avgSpeedMBps || 0);
  const maxSpeedMBpsRaw = Number(item.maxSpeedMBps || 0);
  const minSpeedMBpsRaw = Number(item.minSpeedMBps || 0);
  const avgSpeedMBps = Number.isFinite(avgSpeedMBpsRaw) && avgSpeedMBpsRaw > 0 ? avgSpeedMBpsRaw : 0;
  const maxSpeedMBps = Number.isFinite(maxSpeedMBpsRaw) && maxSpeedMBpsRaw > 0 ? maxSpeedMBpsRaw : 0;
  const minSpeedMBps = Number.isFinite(minSpeedMBpsRaw) && minSpeedMBpsRaw > 0 ? minSpeedMBpsRaw : 0;

  return {
    username,
    title: title.slice(0, 240),
    sourceUrl: sourceUrl.slice(0, 1200),
    mediaType,
    quality,
    durationSec,
    sizeBytes,
    avgSpeedMBps,
    maxSpeedMBps,
    minSpeedMBps,
    createdAt
  };
}

function loadStatsFromDisk() {
  const data = readJsonFile(STATS_STORE_FILE, { downloads: [] });
  const rawDownloads = Array.isArray(data?.downloads) ? data.downloads : [];
  const sanitized = rawDownloads
    .map(sanitizeStatsEntry)
    .filter(Boolean)
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
    .slice(0, STATS_MAX_RECORDS);

  statsStore = { downloads: sanitized };
}

function saveStatsToDisk() {
  const downloads = Array.isArray(statsStore?.downloads) ? statsStore.downloads : [];
  writeJsonFile(STATS_STORE_FILE, { downloads: downloads.slice(0, STATS_MAX_RECORDS) });
}

function recordDownloadStat({
  username,
  title,
  sourceUrl,
  mediaType,
  quality,
  durationSec,
  sizeBytes,
  avgSpeedMBps,
  maxSpeedMBps,
  minSpeedMBps,
  createdAt
}) {
  const entry = sanitizeStatsEntry({
    username,
    title,
    sourceUrl,
    mediaType,
    quality,
    durationSec,
    sizeBytes,
    avgSpeedMBps,
    maxSpeedMBps,
    minSpeedMBps,
    createdAt
  });
  if (!entry) return;

  const prior = Array.isArray(statsStore?.downloads) ? statsStore.downloads : [];
  statsStore.downloads = [entry, ...prior].slice(0, STATS_MAX_RECORDS);
  saveStatsToDisk();
}

function buildStatsSnapshot() {
  const downloads = Array.isArray(statsStore?.downloads) ? statsStore.downloads : [];
  const sorted = [...downloads].sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
  const now = Date.now();

  const typeCounts = { a: 0, v: 0, "a+v": 0 };
  const qualityCounts = { hq: 0, mq: 0, lq: 0 };
  const leaderboard = new Map();
  const userRecent = new Map();
  const domains = new Map();
  const uniqueUsers = new Set();
  let totalSizeBytes = 0;
  let speedAverageSum = 0;
  let speedAverageCount = 0;
  let topDownloadSpeedMBps = 0;
  let lowestDownloadSpeedMBps = 0;
  let last24hDownloads = 0;
  let last7dDownloads = 0;
  let last30dDownloads = 0;

  for (const item of sorted) {
    const type = normalizeMediaTypeValue(item.mediaType) || "a+v";
    const quality = normalizeQualityValue(item.quality) || "hq";
    typeCounts[type] = (typeCounts[type] || 0) + 1;
    qualityCounts[quality] = (qualityCounts[quality] || 0) + 1;
    totalSizeBytes += Number(item.sizeBytes || 0);
    const avgSpeed = Number(item.avgSpeedMBps || 0);
    const maxSpeed = Number(item.maxSpeedMBps || 0);
    const minSpeed = Number(item.minSpeedMBps || 0);
    if (avgSpeed > 0) {
      speedAverageSum += avgSpeed;
      speedAverageCount += 1;
    }
    if (maxSpeed > 0) {
      topDownloadSpeedMBps = Math.max(topDownloadSpeedMBps, maxSpeed);
    }
    if (minSpeed > 0) {
      if (lowestDownloadSpeedMBps <= 0) lowestDownloadSpeedMBps = minSpeed;
      else lowestDownloadSpeedMBps = Math.min(lowestDownloadSpeedMBps, minSpeed);
    }

    const createdAt = Number(item.createdAt || 0);
    if (createdAt > 0) {
      if (now - createdAt <= 24 * 60 * 60 * 1000) last24hDownloads += 1;
      if (now - createdAt <= 7 * 24 * 60 * 60 * 1000) last7dDownloads += 1;
      if (now - createdAt <= 30 * 24 * 60 * 60 * 1000) last30dDownloads += 1;
    }

    const username = normalizeUsername(item.username);
    if (username) {
      uniqueUsers.add(username);
      leaderboard.set(username, (leaderboard.get(username) || 0) + 1);
      if (!userRecent.has(username)) userRecent.set(username, createdAt);
    }

    try {
      const host = new URL(String(item.sourceUrl || "")).hostname.replace(/^www\./i, "").toLowerCase();
      if (host) domains.set(host, (domains.get(host) || 0) + 1);
    } catch {
      // ignore bad URLs in historical stats
    }
  }

  const videoDurationSamples = sorted
    .filter(item => {
      const type = normalizeMediaTypeValue(item.mediaType) || "a+v";
      return (type === "v" || type === "a+v") && Number(item.durationSec || 0) > 0;
    })
    .map(item => Number(item.durationSec || 0));

  const averageVideoLengthSec = videoDurationSamples.length
    ? videoDurationSamples.reduce((sum, value) => sum + value, 0) / videoDurationSamples.length
    : 0;
  const averageDownloadSizeBytes = sorted.length ? totalSizeBytes / sorted.length : 0;
  const averageDownloadSpeedMBps = speedAverageCount > 0 ? speedAverageSum / speedAverageCount : 0;

  const last10 = sorted
    .filter(item => {
      const type = normalizeMediaTypeValue(item.mediaType) || "a+v";
      return type === "v" || type === "a+v";
    })
    .slice(0, 10)
    .map(item => ({
      title: item.title,
      sourceUrl: item.sourceUrl,
      username: item.username,
      mediaType: item.mediaType,
      quality: item.quality,
      durationSec: Number(item.durationSec || 0),
      createdAt: Number(item.createdAt || 0)
    }));

  const topUsers = Array.from(leaderboard.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([username, count]) => ({ username, count }));

  const mostRecentlyUsedUsers = Array.from(userRecent.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([username, lastAt]) => ({ username, lastAt }));

  const topDomains = Array.from(domains.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([domain, count]) => ({ domain, count }));

  return {
    totalDownloads: sorted.length,
    uniqueUsers: uniqueUsers.size,
    totalSizeBytes,
    averageDownloadSizeBytes,
    averageDownloadSpeedMBps,
    topDownloadSpeedMBps,
    lowestDownloadSpeedMBps,
    last24hDownloads,
    last7dDownloads,
    last30dDownloads,
    averageVideoLengthSec,
    averageVideoLengthLabel: formatDurationFromSeconds(averageVideoLengthSec),
    last10Downloads: last10,
    topUsers,
    mostRecentlyUsedUsers,
    topDomains,
    mediaTypeCounts: typeCounts,
    qualityCounts
  };
}

function escapeHtml(input) {
  return String(input || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function makeAccessReviewToken() {
  return crypto.randomBytes(32).toString("hex");
}

function getRequestBaseUrl(req) {
  if (ACCESS_REVIEW_BASE_URL) return ACCESS_REVIEW_BASE_URL;
  const protoRaw = String(req.headers["x-forwarded-proto"] || req.protocol || "http");
  const hostRaw = String(req.headers["x-forwarded-host"] || req.headers.host || `localhost:${PORT}`);
  const proto = protoRaw.split(",")[0].trim() || "http";
  const host = hostRaw.split(",")[0].trim() || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

function isPublicIpCandidate(ip) {
  if (!ip || ip === "unknown") return false;
  if (ip === "::1" || ip === "127.0.0.1") return false;

  const version = net.isIP(ip);
  if (version === 4) {
    if (ip.startsWith("10.")) return false;
    if (ip.startsWith("192.168.")) return false;
    if (ip.startsWith("127.")) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return false;
    if (ip.startsWith("169.254.")) return false;
    return true;
  }

  if (version === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return false;
    if (lower.startsWith("fc") || lower.startsWith("fd")) return false;
    if (lower.startsWith("fe80:")) return false;
    return true;
  }

  return false;
}

function getEmailDisplayIp(req) {
  const candidate = getClientIp(req);
  return isPublicIpCandidate(candidate) ? candidate : "";
}

function parseClientInfo(userAgentRaw) {
  const ua = String(userAgentRaw || "");
  const lower = ua.toLowerCase();

  let os = "Unknown OS";
  if (lower.includes("windows nt")) os = "Windows";
  else if (lower.includes("mac os x") || lower.includes("macintosh")) os = "macOS";
  else if (lower.includes("android")) os = "Android";
  else if (lower.includes("iphone") || lower.includes("ipad") || lower.includes("ios")) os = "iOS";
  else if (lower.includes("linux")) os = "Linux";

  let browser = "Unknown Browser";
  if (lower.includes("edg/")) browser = "Microsoft Edge";
  else if (lower.includes("opr/") || lower.includes("opera")) browser = "Opera";
  else if (lower.includes("firefox/")) browser = "Firefox";
  else if (lower.includes("chrome/") && !lower.includes("edg/")) browser = "Chrome";
  else if (lower.includes("safari/") && !lower.includes("chrome/")) browser = "Safari";

  return {
    os,
    browser,
    rawUserAgent: ua || "unknown"
  };
}

function loadAccessRequestsFromDisk() {
  const records = readJsonFile(ACCESS_REQUESTS_FILE, []);
  if (!Array.isArray(records)) return;

  for (const item of records) {
    if (!item || typeof item !== "object") continue;
    const id = String(item.id || "").trim();
    const email = normalizeEmail(readIdentityField(item, "email", "emailEnc"));
    const username = normalizeUsername(readIdentityField(item, "username", "usernameEnc"));
    if (!id || !email) continue;

    accessRequestById.set(id, {
      id,
      username,
      email,
      pendingAccountId: String(item.pendingAccountId || ""),
      ip: String(item.ip || "unknown"),
      userAgent: String(item.userAgent || ""),
      requestTime: Number(item.requestTime || 0),
      status: String(item.status || "pending"),
      reviewTime: Number(item.reviewTime || 0),
      reviewReason: String(item.reviewReason || ""),
      allowToken: String(item.allowToken || ""),
      denyToken: String(item.denyToken || ""),
      tokenExpiresAt: Number(item.tokenExpiresAt || 0)
    });
  }
}

function saveAccessRequestsToDisk() {
  const records = Array.from(accessRequestById.values())
    .sort((a, b) => Number(b.requestTime || 0) - Number(a.requestTime || 0))
    .slice(0, 1000)
    .map(record => ({
      id: record.id,
      usernameEnc: encryptStoredValue(record.username),
      emailEnc: encryptStoredValue(record.email),
      pendingAccountId: String(record.pendingAccountId || ""),
      ip: String(record.ip || "unknown"),
      userAgent: String(record.userAgent || ""),
      requestTime: Number(record.requestTime || 0),
      status: String(record.status || "pending"),
      reviewTime: Number(record.reviewTime || 0),
      reviewReason: String(record.reviewReason || ""),
      allowToken: String(record.allowToken || ""),
      denyToken: String(record.denyToken || ""),
      tokenExpiresAt: Number(record.tokenExpiresAt || 0)
    }));
  writeJsonFile(ACCESS_REQUESTS_FILE, records);
}

function loadAccountsFromDisk() {
  activeAccountsByUsername.clear();
  pendingAccountsById.clear();

  const data = readJsonFile(USER_ACCOUNTS_FILE, { active: [], pending: [] });
  const active = Array.isArray(data.active) ? data.active : [];
  const pending = Array.isArray(data.pending) ? data.pending : [];

  for (const item of active) {
    if (!item || typeof item !== "object") continue;
    const username = normalizeUsername(readIdentityField(item, "username", "usernameEnc"));
    const email = normalizeEmail(readIdentityField(item, "email", "emailEnc"));
    const passwordHash = String(item.passwordHash || "");
    if (!username || !email || !passwordHash) continue;

    activeAccountsByUsername.set(username, {
      id: String(item.id || crypto.randomUUID()),
      username,
      email,
      passwordHash,
      createdAt: Number(item.createdAt || Date.now()),
      approvedAt: Number(item.approvedAt || Date.now())
    });
  }

  for (const item of pending) {
    if (!item || typeof item !== "object") continue;
    const id = String(item.id || "").trim();
    const username = normalizeUsername(readIdentityField(item, "username", "usernameEnc"));
    const email = normalizeEmail(readIdentityField(item, "email", "emailEnc"));
    const passwordHash = String(item.passwordHash || "");
    if (!id || !username || !email || !passwordHash) continue;

    pendingAccountsById.set(id, {
      id,
      username,
      email,
      passwordHash,
      createdAt: Number(item.createdAt || Date.now()),
      requestId: String(item.requestId || "")
    });
  }
}

function saveAccountsToDisk() {
  const active = Array.from(activeAccountsByUsername.values()).map(account => ({
    id: String(account.id || crypto.randomUUID()),
    usernameEnc: encryptStoredValue(account.username),
    emailEnc: encryptStoredValue(account.email),
    passwordHash: String(account.passwordHash || ""),
    createdAt: Number(account.createdAt || Date.now()),
    approvedAt: Number(account.approvedAt || Date.now())
  }));
  const pending = Array.from(pendingAccountsById.values()).map(account => ({
    id: String(account.id || crypto.randomUUID()),
    usernameEnc: encryptStoredValue(account.username),
    emailEnc: encryptStoredValue(account.email),
    passwordHash: String(account.passwordHash || ""),
    createdAt: Number(account.createdAt || Date.now()),
    requestId: String(account.requestId || "")
  }));
  writeJsonFile(USER_ACCOUNTS_FILE, { active, pending });
}

function findActiveAccountByUsername(username) {
  return activeAccountsByUsername.get(normalizeUsername(username)) || null;
}

function findActiveAccountByEmail(email) {
  const normalized = normalizeEmail(email);
  for (const account of activeAccountsByUsername.values()) {
    if (account.email === normalized) return account;
  }
  return null;
}

function findActiveAccountByIdentifier(identifier) {
  const value = String(identifier || "").trim();
  if (!value) return null;
  return findActiveAccountByUsername(value) || findActiveAccountByEmail(value);
}

function hasActiveAccountByEmail(email) {
  return Boolean(findActiveAccountByEmail(email));
}

function findPendingAccountByUsername(username) {
  const normalized = normalizeUsername(username);
  for (const account of pendingAccountsById.values()) {
    if (account.username === normalized) return account;
  }
  return null;
}

function findPendingAccountByEmail(email) {
  const normalized = normalizeEmail(email);
  for (const account of pendingAccountsById.values()) {
    if (account.email === normalized) return account;
  }
  return null;
}

function createPendingAccount({ username, email, requestedPassword, requestId }) {
  const normalizedUsername = normalizeUsername(username);
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedUsername || !normalizedEmail || !requestedPassword) {
    return { error: "Invalid pending account details." };
  }

  if (findActiveAccountByUsername(normalizedUsername) || hasActiveAccountByEmail(normalizedEmail)) {
    return { error: "An account with this username or email already exists." };
  }

  if (findPendingAccountByUsername(normalizedUsername) || findPendingAccountByEmail(normalizedEmail)) {
    return { error: "An access request for this username or email is already pending." };
  }

  const pending = {
    id: crypto.randomUUID(),
    username: normalizedUsername,
    email: normalizedEmail,
    passwordHash: hashPasswordForStorage(requestedPassword),
    createdAt: Date.now(),
    requestId: String(requestId || "")
  };

  pendingAccountsById.set(pending.id, pending);
  saveAccountsToDisk();

  return { account: pending };
}

function deletePendingAccount(pendingAccountId) {
  if (!pendingAccountId) return;
  pendingAccountsById.delete(String(pendingAccountId));
  saveAccountsToDisk();
}

function approvePendingAccount(pendingAccountId) {
  const pending = pendingAccountsById.get(String(pendingAccountId || ""));
  if (!pending) return { error: "Pending account not found." };

  if (findActiveAccountByUsername(pending.username) || hasActiveAccountByEmail(pending.email)) {
    pendingAccountsById.delete(pending.id);
    saveAccountsToDisk();
    return { error: "Username or email is already active." };
  }

  const active = {
    id: crypto.randomUUID(),
    username: pending.username,
    email: pending.email,
    passwordHash: pending.passwordHash,
    createdAt: pending.createdAt,
    approvedAt: Date.now()
  };

  activeAccountsByUsername.set(active.username, active);
  pendingAccountsById.delete(pending.id);
  saveAccountsToDisk();

  return { account: active };
}

function createAccessRequestRecord({
  username,
  email,
  pendingAccountId,
  ip,
  userAgent
}) {
  const id = crypto.randomUUID();
  const now = Date.now();

  const record = {
    id,
    username,
    email,
    pendingAccountId: String(pendingAccountId || ""),
    ip,
    userAgent,
    requestTime: now,
    status: "pending",
    reviewTime: 0,
    reviewReason: "",
    allowToken: makeAccessReviewToken(),
    denyToken: makeAccessReviewToken(),
    tokenExpiresAt: now + ACCESS_REVIEW_TOKEN_TTL_MS
  };

  accessRequestById.set(id, record);
  saveAccessRequestsToDisk();

  return record;
}

function makePasswordResetToken() {
  return crypto.randomBytes(32).toString("hex");
}

function purgePasswordResetsForUsername(username) {
  const normalized = normalizeUsername(username);
  for (const [id, record] of passwordResetById.entries()) {
    if (normalizeUsername(record.username) === normalized) {
      passwordResetById.delete(id);
    }
  }
}

function createPasswordResetRecord(account) {
  const id = crypto.randomUUID();
  const token = makePasswordResetToken();
  const now = Date.now();
  const record = {
    id,
    username: account.username,
    email: account.email,
    token,
    createdAt: now,
    expiresAt: now + PASSWORD_RESET_TOKEN_TTL_MS
  };
  purgePasswordResetsForUsername(account.username);
  passwordResetById.set(id, record);
  return record;
}

function validatePasswordResetToken(record, token) {
  if (!record) return "Invalid reset request.";
  if (Date.now() > Number(record.expiresAt || 0)) return "This reset link has expired.";
  if (!token || !safeEqualString(token, record.token)) return "Invalid reset token.";
  return null;
}

function revokeSessionsForUsername(username) {
  const normalized = normalizeUsername(username);
  for (const [id, session] of sessions.entries()) {
    if (normalizeUsername(session.username) === normalized) {
      sessions.delete(id);
    }
  }
}

function validateAccessReviewToken(record, action, token) {
  if (!record) return "Invalid request.";
  if (record.status !== "pending") return `This request was already ${record.status}.`;
  if (Date.now() > Number(record.tokenExpiresAt || 0)) return "This review link has expired.";

  const expectedToken = action === "allow" ? record.allowToken : record.denyToken;
  if (!token || !expectedToken || !safeEqualString(token, expectedToken)) {
    return "Invalid review token.";
  }

  return null;
}

function finalizeAccessReview(record, action, reason = "") {
  record.status = action;
  record.reviewTime = Date.now();
  record.reviewReason = String(reason || "");
  record.allowToken = "";
  record.denyToken = "";
  saveAccessRequestsToDisk();
}

function renderThemedPage({ title = "dl.67mc.org", body = "", footer = "" }) {
  const safeTitle = escapeHtml(title);
  return `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${safeTitle}</title>
    <style>
      html, body {
        margin: 0;
        min-height: 100%;
        background: linear-gradient(145deg, #06040b 0%, #120a1e 52%, #0a0711 100%);
        color: #e7ecef;
        font-family: "Nunito Sans", "Segoe UI", Tahoma, sans-serif;
      }
      body {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        box-sizing: border-box;
      }
      .wrap {
        width: min(640px, 100%);
        border-radius: 14px;
        background: rgba(25, 15, 41, 0.62);
        backdrop-filter: blur(12px) saturate(110%);
        -webkit-backdrop-filter: blur(12px) saturate(110%);
        border: 1px solid rgba(255, 255, 255, 0.08);
        box-shadow: 0 8px 26px rgba(0, 0, 0, 0.28);
        padding: 18px;
      }
      .title {
        font-size: 28px;
        letter-spacing: 0.5px;
        margin: 0 0 8px 0;
        color: #f2edff;
        text-shadow: 0 8px 40px rgba(0, 0, 0, 0.45);
      }
      .body {
        font-size: 14px;
        line-height: 1.45;
        color: #efe7ff;
      }
      .footer {
        margin-top: 12px;
        font-size: 12px;
        color: #d6c9eb;
        opacity: 0.85;
      }
      textarea {
        width: 100%;
        min-height: 170px;
        resize: vertical;
        border-radius: 10px;
        border: 1px solid rgba(255, 255, 255, 0.12);
        background: rgba(31, 17, 50, 0.62);
        color: #efe7ff;
        padding: 10px 12px;
        box-sizing: border-box;
        margin-top: 10px;
        margin-bottom: 10px;
        outline: none;
      }
      button {
        height: 42px;
        border-radius: 10px;
        border: 1px solid rgba(255, 255, 255, 0.16);
        background: rgba(255, 255, 255, 0.17);
        color: #fff;
        font-size: 14px;
        cursor: pointer;
        min-width: 110px;
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="title">${safeTitle}</div>
      <div class="body">${body}</div>
      ${footer ? `<div class="footer">${footer}</div>` : ""}
    </div>
  </body>
</html>`;
}

function renderSimpleHtmlPage(bodyHtml) {
  const safe = String(bodyHtml || "");
  return renderThemedPage({
    title: "dl.67mc.org",
    body: safe
  });
}

function renderDenyFormPage(token) {
  return renderThemedPage({
    title: "Deny Request",
    body: `<form method="POST"><textarea name="reason" placeholder="Reason..."></textarea><input type="hidden" name="token" value="${escapeHtml(token)}" /><button type="submit">Send</button></form>`
  });
}

function renderPasswordResetFormPage({ token }) {
  return renderThemedPage({
    title: "Reset Password",
    body: `
      <form method="POST">
        <input
          type="password"
          name="password"
          placeholder="New password"
          minlength="8"
          required
          style="width:100%;height:44px;border-radius:10px;border:1px solid rgba(255,255,255,0.12);background:rgba(31,17,50,0.62);color:#efe7ff;padding:0 12px;box-sizing:border-box;outline:none"
        />
        <input type="hidden" name="token" value="${escapeHtml(token)}" />
        <button type="submit" style="margin-top:10px">Update Password</button>
      </form>
    `,
    footer: "Password must be at least 8 characters."
  });
}

function renderCenteredResultPage(title, subtitle = "") {
  const safeTitle = escapeHtml(title);
  const safeSubtitle = escapeHtml(subtitle);
  return `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${safeTitle}</title>
    <style>
      html, body {
        margin: 0;
        min-height: 100%;
        background: linear-gradient(145deg, #06040b 0%, #120a1e 52%, #0a0711 100%);
        color: #e7ecef;
        font-family: "Nunito Sans", "Segoe UI", Tahoma, sans-serif;
      }
      body {
        display: flex;
        align-items: center;
        justify-content: center;
        text-align: center;
      }
      .wrap {
        width: min(620px, calc(100% - 40px));
        border-radius: 14px;
        background: rgba(25, 15, 41, 0.62);
        backdrop-filter: blur(12px) saturate(110%);
        -webkit-backdrop-filter: blur(12px) saturate(110%);
        border: 1px solid rgba(255, 255, 255, 0.08);
        box-shadow: 0 8px 26px rgba(0, 0, 0, 0.28);
        padding: 24px;
      }
      .title {
        font-size: 28px;
        letter-spacing: 0.5px;
        margin-bottom: 10px;
        color: #f2edff;
        text-shadow: 0 8px 40px rgba(0, 0, 0, 0.45);
      }
      .sub { font-size: 14px; color: #efe7ff; opacity: 0.85; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="title">${safeTitle}</div>
      <div class="sub">${safeSubtitle}</div>
    </div>
    <script>
      (function () {
        var remaining = 5;
        var sub = document.querySelector('.sub');
        function update() {
          if (sub) sub.textContent = 'Tab will close in ' + remaining + ' seconds';
        }
        update();
        var timer = setInterval(function () {
          remaining -= 1;
          if (remaining <= 0) {
            clearInterval(timer);
            window.close();
            setTimeout(function () {
              if (sub) sub.textContent = 'You can close this tab now.';
            }, 300);
            return;
          }
          update();
        }, 1000);
      })();
    </script>
  </body>
</html>`;
}

function resolveSafePath(baseDir, relativePath) {
  const base = path.resolve(baseDir);
  const target = path.resolve(baseDir, relativePath);
  if (target === base) return null;
  if (!target.startsWith(`${base}${path.sep}`)) return null;
  return target;
}

function toUserRelativePath(userRoot, absPath) {
  const rel = path.relative(userRoot, absPath).split(path.sep).join("/");
  if (!rel || rel.startsWith("..")) return "";
  return rel;
}

function ensureThumbnailForFile(userRoot, absPath, preferredRelativePath = "") {
  const ext = path.extname(absPath).toLowerCase();
  const existing = preferredRelativePath
    ? resolveSafePath(userRoot, preferredRelativePath)
    : null;

  // Preserve provider-supplied thumbnails (important for audio-only downloads).
  if (existing && fs.existsSync(existing)) {
    return preferredRelativePath;
  }

  if (IMAGE_THUMBNAIL_EXTS.has(ext)) {
    return toUserRelativePath(userRoot, absPath);
  }

  if (!VIDEO_THUMBNAIL_EXTS.has(ext)) {
    return "";
  }

  const parsed = path.parse(absPath);
  const thumbPath = path.join(parsed.dir, `${parsed.name}.thumb.jpg`);

  try {
    const run = spawnSync(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        "00:00:00.500",
        "-i",
        absPath,
        "-frames:v",
        "1",
        "-vf",
        "scale=360:-1",
        thumbPath
      ],
      { cwd: ROOT, timeout: 20000 }
    );

    if (run.status === 0 && fs.existsSync(thumbPath)) {
      return toUserRelativePath(userRoot, thumbPath);
    }
  } catch {
    // ignore thumbnail generation failures
  }

  return "";
}

function createAudioCoverWithIcon(sourceImagePath) {
  if (!sourceImagePath || !fs.existsSync(sourceImagePath)) return "";
  const parsed = path.parse(sourceImagePath);
  const outputPath = path.join(parsed.dir, `${parsed.name}.audio-cover.jpg`);
  const filterGraph =
    "eq=brightness=-0.18:saturation=0.9,drawtext=text='♪':fontcolor=white:fontsize=h*0.24:x=(w-text_w)/2:y=(h-text_h)/2:shadowcolor=black@0.9:shadowx=4:shadowy=4";

  try {
    const run = spawnSync(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        sourceImagePath,
        "-vf",
        filterGraph,
        "-q:v",
        "2",
        outputPath
      ],
      { cwd: ROOT, timeout: 20000 }
    );

    if (run.status === 0 && fs.existsSync(outputPath)) {
      return outputPath;
    }
  } catch {
    // ignore cover render failures
  }

  return "";
}

function embedMp3CoverArt(audioPath, coverPath) {
  if (!audioPath || !coverPath) return false;
  if (!fs.existsSync(audioPath) || !fs.existsSync(coverPath)) return false;

  const parsed = path.parse(audioPath);
  const tempOut = path.join(parsed.dir, `${parsed.name}.covertmp${parsed.ext}`);

  try {
    const run = spawnSync(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        audioPath,
        "-i",
        coverPath,
        "-map",
        "0:a:0",
        "-map",
        "1:v:0",
        "-c:a",
        "copy",
        "-c:v",
        "mjpeg",
        "-id3v2_version",
        "3",
        "-metadata:s:v",
        "title=Album cover",
        "-metadata:s:v",
        "comment=Cover (front)",
        "-disposition:v:0",
        "attached_pic",
        tempOut
      ],
      { cwd: ROOT, timeout: 30000 }
    );

    if (run.status === 0 && fs.existsSync(tempOut)) {
      fs.renameSync(tempOut, audioPath);
      return true;
    }
  } catch {
    // ignore embed failures
  }

  try {
    if (fs.existsSync(tempOut)) fs.rmSync(tempOut, { force: true });
  } catch {
    // ignore cleanup issues
  }

  return false;
}

function cleanupEmptyParents(startDir, stopDir) {
  const stop = path.resolve(stopDir);
  let current = path.resolve(startDir);

  while (current.startsWith(`${stop}${path.sep}`)) {
    try {
      if (fs.readdirSync(current).length > 0) break;
      fs.rmdirSync(current);
    } catch {
      break;
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function loadUserManifest(username) {
  ensureUserRoot(username);
  const manifestPath = getUserManifestPath(username);
  const parsed = readJsonFile(manifestPath, []);
  if (!Array.isArray(parsed)) return [];
  return parsed;
}

function saveUserManifest(username, entries) {
  ensureUserRoot(username);
  writeJsonFile(getUserManifestPath(username), entries);
}

function pruneUserDownloads(username) {
  const now = Date.now();
  const userRoot = getUserRoot(username);
  const entries = loadUserManifest(username);
  const kept = [];
  let changed = false;

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      changed = true;
      continue;
    }

    const id = String(entry.id || "").trim();
    const fileName = String(entry.fileName || "").trim();
    const relativePath = String(entry.relativePath || "").trim();
    const thumbnailRelativePath = String(entry.thumbnailRelativePath || "").trim();
    const sourceUrl = String(entry.sourceUrl || "").trim();
    const mediaTypeRaw = String(entry.mediaType || "").trim();
    const qualityRaw = String(entry.quality || "").trim();
    const titleRaw = String(entry.title || "").trim();
    const createdAt = Number(entry.createdAt || 0);

    if (!id || !relativePath || !createdAt) {
      changed = true;
      continue;
    }

    const absPath = resolveSafePath(userRoot, relativePath);
    if (!absPath) {
      changed = true;
      continue;
    }

    const expired = now - createdAt > DOWNLOAD_RETENTION_MS;
    const exists = fs.existsSync(absPath);

    if (expired || !exists) {
      changed = true;
      if (exists) {
        try {
          fs.rmSync(absPath, { force: true });
          cleanupEmptyParents(path.dirname(absPath), userRoot);
        } catch {
          // ignore file deletion errors during retention cleanup
        }
      }
      continue;
    }

    let sizeBytes = Number(entry.sizeBytes || 0);
    if (!Number.isFinite(sizeBytes) || sizeBytes < 0) {
      try {
        sizeBytes = fs.statSync(absPath).size;
      } catch {
        sizeBytes = 0;
      }
      changed = true;
    }

    const finalThumbnailRelativePath = ensureThumbnailForFile(
      userRoot,
      absPath,
      thumbnailRelativePath
    );
    if (finalThumbnailRelativePath !== thumbnailRelativePath) {
      changed = true;
    }

    kept.push({
      id,
      fileName: fileName || path.basename(absPath),
      relativePath,
      sizeBytes,
      createdAt,
      thumbnailRelativePath: finalThumbnailRelativePath,
      externalThumbnailUrl: String(entry.externalThumbnailUrl || "").trim(),
      sourceUrl,
      mediaType: VALID_TYPES.has(mediaTypeRaw) ? mediaTypeRaw : inferMediaTypeFromPath(absPath),
      quality: VALID_QUALITIES.has(qualityRaw) ? qualityRaw : "hq",
      title: titleRaw || displayTitleFromFilename(fileName || path.basename(absPath))
    });
  }

  kept.sort((a, b) => b.createdAt - a.createdAt);

  if (changed || kept.length !== entries.length) {
    saveUserManifest(username, kept);
  }

  return kept;
}

function getUserStorageStatus(username) {
  const entries = pruneUserDownloads(username);
  const usageBytes = entries.reduce((sum, item) => sum + (Number(item.sizeBytes) || 0), 0);

  return {
    entries,
    usageBytes,
    capBytes: USER_STORAGE_CAP_BYTES,
    exceedsCap: usageBytes > USER_STORAGE_CAP_BYTES
  };
}

function appendUserDownloadRecord(
  username,
  {
    id,
    filePath,
    createdAt,
    thumbnailPath = "",
    externalThumbnailUrl = "",
    sourceUrl = "",
    mediaType = "",
    quality = "",
    title = ""
  }
) {
  const userRoot = getUserRoot(username);
  const relativePath = path.relative(userRoot, filePath).split(path.sep).join("/");
  if (!relativePath || relativePath.startsWith("..")) return false;

  let sizeBytes = 0;
  try {
    sizeBytes = fs.statSync(filePath).size;
  } catch {
    return false;
  }

  const entries = pruneUserDownloads(username).filter(entry => entry.id !== id);
  let thumbnailRelativePath = "";
  if (thumbnailPath) {
    const safeThumb = resolveSafePath(userRoot, thumbnailPath);
    if (safeThumb && fs.existsSync(safeThumb)) {
      thumbnailRelativePath = toUserRelativePath(userRoot, safeThumb);
    }
  }
  if (!thumbnailRelativePath) {
    thumbnailRelativePath = ensureThumbnailForFile(userRoot, filePath);
  }
  entries.unshift({
    id,
    fileName: path.basename(filePath),
    relativePath,
    sizeBytes,
    createdAt,
    thumbnailRelativePath,
    externalThumbnailUrl: String(externalThumbnailUrl || "").trim(),
    sourceUrl: String(sourceUrl || "").trim(),
    mediaType: mediaType && VALID_TYPES.has(mediaType) ? mediaType : inferMediaTypeFromPath(filePath),
    quality: VALID_QUALITIES.has(quality) ? quality : "hq",
    title: String(title || "").trim() || displayTitleFromFilename(path.basename(filePath))
  });
  saveUserManifest(username, entries);
  return true;
}

function clearUserDownloads(username) {
  const userRoot = getUserRoot(username);

  try {
    fs.rmSync(userRoot, { recursive: true, force: true });
  } catch {
    // ignore
  }

  fs.mkdirSync(userRoot, { recursive: true });
  saveUserManifest(username, []);

  for (const [jobId, job] of jobs.entries()) {
    if (job.ownerUsername === username) {
      if (job.status === "completed") {
        jobs.delete(jobId);
      } else {
        job.filePath = null;
      }
    }
  }
}

function deleteUserDownloadById(username, id) {
  const targetId = String(id || "").trim();
  if (!targetId) return false;

  const userRoot = getUserRoot(username);
  const entries = pruneUserDownloads(username);
  const index = entries.findIndex(item => item.id === targetId);
  if (index < 0) return false;

  const [entry] = entries.splice(index, 1);
  const candidatePaths = new Set([entry.relativePath, entry.thumbnailRelativePath].filter(Boolean));

  for (const relPath of candidatePaths) {
    const absPath = resolveSafePath(userRoot, relPath);
    if (!absPath || !fs.existsSync(absPath)) continue;
    try {
      fs.rmSync(absPath, { force: true });
      cleanupEmptyParents(path.dirname(absPath), userRoot);
    } catch {
      // ignore per-item cleanup failures
    }
  }

  saveUserManifest(username, entries);
  return true;
}

function withFilter(selector, filter) {
  if (!filter) return selector;
  return `${selector}[${filter}]`;
}

function videoSelectorsForQuality(quality, codec) {
  const codecFilterByCodec = {
    h264: "vcodec~='^(avc1|h264)'",
    h265: "vcodec~='^(hev1|hvc1|hevc|h265)'",
    webm: "ext='webm'"
  };

  const codecFilter = codecFilterByCodec[codec] || null;

  if (quality === "hq") {
    return [withFilter("bestvideo", codecFilter), "bestvideo", "best"];
  }

  if (quality === "mq") {
    return [
      withFilter("bestvideo[height<=720]", codecFilter),
      "bestvideo[height<=720]",
      "best[height<=720]"
    ];
  }

  return [
    withFilter("bestvideo[height<=360]", codecFilter),
    "bestvideo[height<=360]",
    "best[height<=360]"
  ];
}

function audioSelectorForQuality(quality) {
  if (quality === "lq") {
    return ["bestaudio[abr<=96]", "bestaudio", "best"];
  }

  return ["bestaudio", "best"];
}

function formatSelector(type, quality, codec) {
  if (type === "a") {
    return audioSelectorForQuality(quality).join("/");
  }

  const videoSelectors = videoSelectorsForQuality(quality, codec);

  if (type === "v") {
    return videoSelectors.join("/");
  }

  const audioSelectors = audioSelectorForQuality(quality);
  const combined = [];

  for (const v of videoSelectors) {
    for (const a of audioSelectors) {
      if (v === "best" || a === "best") continue;
      combined.push(`${v}+${a}`);
    }
  }

  combined.push(...videoSelectors);
  combined.push("best");

  return combined.join("/");
}

function buildVideoTranscodePostprocessorArgs(type, codec, useNvidia) {
  const parts = [];

  if (codec === "h265") {
    if (useNvidia) {
      parts.push("-c:v", "hevc_nvenc", "-preset", "p4", "-cq", "28");
    } else {
      parts.push("-c:v", "libx265", "-preset", "medium", "-crf", "28");
    }
  } else {
    if (useNvidia) {
      parts.push("-c:v", "h264_nvenc", "-preset", "p4", "-cq", "23");
    } else {
      parts.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "23");
    }
  }

  if (type === "a+v") {
    parts.push("-c:a", "aac", "-b:a", "192k");
  }

  return `ffmpeg:${parts.join(" ")}`;
}

function postProcessArgs(type, codec, options = {}) {
  const args = [];
  const transcode = Boolean(options.transcode);
  const useNvidia = Boolean(options.useNvidia);

  if (type === "a") {
    if (codec === "wav") {
      args.push("-x", "--audio-format", "wav", "--audio-quality", "0");
      return args;
    }

    if (codec === "mp3 (320)") {
      args.push(
        "-x",
        "--audio-format",
        "mp3",
        "--embed-thumbnail",
        "--postprocessor-args",
        "ffmpeg:-b:a 320k"
      );
      return args;
    }

    args.push(
      "-x",
      "--audio-format",
      "mp3",
      "--embed-thumbnail",
      "--postprocessor-args",
      "ffmpeg:-b:a 128k"
    );
    return args;
  }

  if (!transcode) {
    if (codec === "mov") {
      args.push("--remux-video", "mov");
      return args;
    }

    if (codec === "webm") {
      args.push("--remux-video", "webm");
      return args;
    }

    if (codec === "h264" || codec === "h265") {
      args.push("--remux-video", "mp4", "--merge-output-format", "mp4");
      return args;
    }

    return args;
  }

  if (codec === "mov") {
    args.push("--recode-video", "mov");
    args.push("--postprocessor-args", buildVideoTranscodePostprocessorArgs(type, "h264", useNvidia));
    return args;
  }

  if (codec === "webm") {
    args.push("--recode-video", "webm");
    return args;
  }

  if (codec === "h264") {
    args.push("--recode-video", "mp4");
    args.push("--postprocessor-args", buildVideoTranscodePostprocessorArgs(type, "h264", useNvidia));
    return args;
  }

  if (codec === "h265") {
    args.push("--recode-video", "mp4");
    args.push("--postprocessor-args", buildVideoTranscodePostprocessorArgs(type, "h265", useNvidia));
  }

  return args;
}

function validatePayload(body) {
  if (!body || typeof body !== "object") return "Missing request body.";
  const { url, type, quality, codec } = body;

  if (typeof url !== "string" || !/^https?:\/\//i.test(url.trim())) {
    return "A valid http(s) URL is required.";
  }

  if (!VALID_TYPES.has(type)) return `Invalid type: ${type}`;
  if (!VALID_QUALITIES.has(quality)) return `Invalid quality: ${quality}`;

  if (type === "a" && !AUDIO_CODECS.has(codec)) {
    return `Invalid audio codec: ${codec}`;
  }

  if (type !== "a" && !VIDEO_CODECS.has(codec)) {
    return `Invalid video codec: ${codec}`;
  }

  return null;
}

function sseWrite(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function emitJobUpdate(job, payload) {
  job.lastUpdate = payload;

  for (const client of job.clients) {
    sseWrite(client, payload);
  }
}

function setJobState(job, patch) {
  const next = {
    id: job.id,
    status: "status" in patch ? patch.status : job.status,
    message: "message" in patch ? patch.message : job.message,
    progress: "progress" in patch ? patch.progress : job.progress,
    downloadUrl: "downloadUrl" in patch ? patch.downloadUrl : job.downloadUrl,
    error: "error" in patch ? patch.error : job.error,
    speed: "speed" in patch ? patch.speed : job.speed,
    eta: "eta" in patch ? patch.eta : job.eta,
    totalSize: "totalSize" in patch ? patch.totalSize : job.totalSize,
    thumbnailUrl: "thumbnailUrl" in patch ? patch.thumbnailUrl : job.thumbnailUrl,
    title: "title" in patch ? patch.title : job.title,
    url: job.url,
    type: job.type,
    quality: job.quality,
    codec: job.codec,
    createdAt: job.createdAt
  };

  job.status = next.status;
  job.message = next.message;
  job.progress = next.progress;
  job.downloadUrl = next.downloadUrl;
  job.error = next.error;
  job.speed = next.speed;
  job.eta = next.eta;
  job.totalSize = next.totalSize;
  job.thumbnailUrl = next.thumbnailUrl;
  job.title = next.title;

  emitJobUpdate(job, next);
}

function listFilesRecursive(dir) {
  const result = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...listFilesRecursive(fullPath));
    } else if (entry.isFile()) {
      result.push(fullPath);
    }
  }

  return result;
}

function isPartialTempFile(filePath) {
  const base = path.basename(filePath).toLowerCase();
  if (base.includes(".part")) return true;
  if (/\.(f\d+|frag\d+)\./i.test(base)) return true;
  return false;
}

function isLikelyAuxiliaryImage(filePath) {
  const lowerName = path.parse(filePath).name.toLowerCase();
  if (lowerName.endsWith(".thumb")) return true;
  if (/(^|[-_.])(maxresdefault|hqdefault|mqdefault|sddefault|thumbnail|thumb|sprite|poster)([-_.]|$)/i.test(lowerName)) {
    return true;
  }
  return false;
}

function findNewestFile(dir) {
  if (!fs.existsSync(dir)) return null;
  const files = listFilesRecursive(dir).filter(candidate => !isPartialTempFile(candidate));
  const primary = files.filter(candidate => {
    const ext = path.extname(candidate).toLowerCase();
    return MEDIA_OUTPUT_EXTS.has(ext);
  });

  const pool = primary.length > 0
    ? primary
    : files.filter(candidate => IMAGE_THUMBNAIL_EXTS.has(path.extname(candidate).toLowerCase()));

  if (pool.length === 0) return null;

  if (primary.length === 0) {
    const ranked = pool
      .map(candidate => {
        let size = 0;
        let mtime = 0;
        try {
          const stat = fs.statSync(candidate);
          size = stat.size;
          mtime = stat.mtimeMs;
        } catch {
          // ignore stat issues and keep defaults
        }
        const auxPenalty = isLikelyAuxiliaryImage(candidate) ? 10 * 1024 * 1024 : 0;
        return { candidate, score: size - auxPenalty, mtime };
      })
      .sort((a, b) => b.score - a.score || b.mtime - a.mtime);

    return ranked[0]?.candidate || null;
  }

  let newest = pool[0];
  let newestMtime = fs.statSync(newest).mtimeMs;

  for (let i = 1; i < pool.length; i += 1) {
    const candidate = pool[i];
    const mtime = fs.statSync(candidate).mtimeMs;
    if (mtime > newestMtime) {
      newest = candidate;
      newestMtime = mtime;
    }
  }

  return newest;
}

function findProviderThumbnail(jobDir, mediaPath) {
  if (!fs.existsSync(jobDir)) return "";

  const mediaResolved = path.resolve(mediaPath);
  const mediaBaseName = path.parse(mediaPath).name;
  const images = listFilesRecursive(jobDir).filter(candidate => {
    const ext = path.extname(candidate).toLowerCase();
    if (!IMAGE_THUMBNAIL_EXTS.has(ext)) return false;
    if (path.resolve(candidate) === mediaResolved) return false;
    return true;
  });

  if (images.length === 0) return "";

  const ranked = images
    .map(candidate => {
      const parsed = path.parse(candidate);
      const lowerName = parsed.name.toLowerCase();
      let score = 0;
      if (parsed.name === mediaBaseName || parsed.name.startsWith(mediaBaseName)) score += 4;
      if (!lowerName.endsWith(".thumb")) score += 2;
      if (lowerName.includes("maxres") || lowerName.includes("hqdefault") || lowerName.includes("thumbnail")) {
        score += 1;
      }
      const mtime = fs.statSync(candidate).mtimeMs;
      return { candidate, score, mtime };
    })
    .sort((a, b) => b.score - a.score || b.mtime - a.mtime);

  return ranked[0]?.candidate || "";
}

function parseProgress(line) {
  const match = line.match(/\[download\]\s+([0-9]+(?:\.[0-9]+)?)%/i);
  if (!match) return null;
  const raw = Number(match[1]);
  if (!Number.isFinite(raw)) return null;
  return Math.max(0, Math.min(100, raw));
}

function parseSpeedMBps(speedText) {
  const text = String(speedText || "").trim();
  if (!text) return 0;
  const match = text.match(/^([0-9]+(?:\.[0-9]+)?)\s*([KMGTP]?i?B)\/s$/i);
  if (!match) return 0;

  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return 0;
  const unit = String(match[2] || "B").toUpperCase();
  const factorByUnit = {
    B: 1,
    KIB: 1024,
    MIB: 1024 * 1024,
    GIB: 1024 * 1024 * 1024,
    TIB: 1024 * 1024 * 1024 * 1024,
    KB: 1000,
    MB: 1000 * 1000,
    GB: 1000 * 1000 * 1000,
    TB: 1000 * 1000 * 1000 * 1000
  };
  const bytesPerSecond = value * (factorByUnit[unit] || 1);
  return bytesPerSecond / (1000 * 1000);
}

function parseDownloadStats(line) {
  const speedMatch = line.match(/\sat\s+([0-9.]+\s*[KMGTP]?i?B\/s)/i);
  const etaMatch = line.match(/\sETA\s+([0-9:]+)/i);
  const totalMatch = line.match(/\sof\s+~?\s*([0-9.]+\s*[KMGTP]?i?B)/i);

  return {
    speed: speedMatch ? speedMatch[1].replace(/\s+/g, "") : null,
    eta: etaMatch ? etaMatch[1] : null,
    totalSize: totalMatch ? totalMatch[1].replace(/\s+/g, "") : null
  };
}

function formatBinaryBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return null;
  if (value < 1024) return `${Math.round(value)}B`;

  const units = ["KiB", "MiB", "GiB", "TiB"];
  let amount = value / 1024;
  let unitIndex = 0;
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }

  const precision = amount >= 100 ? 0 : amount >= 10 ? 1 : 2;
  return `${amount.toFixed(precision)}${units[unitIndex]}`;
}

function stripFileExt(fileName) {
  const base = String(fileName || "").trim();
  const idx = base.lastIndexOf(".");
  if (idx <= 0) return base;
  return base.slice(0, idx);
}

function stripYtDlpIdSuffix(name) {
  return String(name || "").replace(/\s+\[[A-Za-z0-9_-]{6,}\]\s*$/u, "").trim();
}

function displayTitleFromFilename(fileName) {
  const withoutExt = stripFileExt(fileName);
  const cleaned = stripYtDlpIdSuffix(withoutExt);
  return cleaned || withoutExt || String(fileName || "").trim();
}

function inferMediaTypeFromPath(filePath) {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  if (AUDIO_OUTPUT_EXTS.has(ext)) return "a";
  return "a+v";
}

function probeMediaDurationSeconds(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return 0;
  try {
    const probe = spawnSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        filePath
      ],
      { cwd: ROOT, encoding: "utf8", timeout: 12000 }
    );

    if (probe.status !== 0) return 0;
    const raw = String(probe.stdout || "").trim();
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return 0;
    return parsed;
  } catch {
    return 0;
  }
}

function handleYtDlpLine(job, line) {
  const text = line.trim();
  if (!text) return;

  const progress = parseProgress(text);
  if (progress !== null) {
    const stats = parseDownloadStats(text);
    const speedMBps = parseSpeedMBps(stats.speed);
    if (speedMBps > 0) {
      job.downloadSpeed = job.downloadSpeed || {
        samples: 0,
        sumMBps: 0,
        maxMBps: 0,
        minMBps: 0
      };
      job.downloadSpeed.samples += 1;
      job.downloadSpeed.sumMBps += speedMBps;
      job.downloadSpeed.maxMBps = Math.max(job.downloadSpeed.maxMBps || 0, speedMBps);
      if (!job.downloadSpeed.minMBps || speedMBps < job.downloadSpeed.minMBps) {
        job.downloadSpeed.minMBps = speedMBps;
      }
    }
    const scaledProgress = Math.max(0, Math.min(95, progress * 0.95));
    setJobState(job, {
      status: "running",
      message: `Downloading... ${progress.toFixed(1)}%`,
      progress: scaledProgress,
      speed: stats.speed,
      eta: stats.eta,
      totalSize: stats.totalSize
    });
    return;
  }

  if (text.includes("Destination:")) {
    const destination = text.split("Destination:").slice(1).join("Destination:").trim();
    const inferredTitle = destination ? displayTitleFromFilename(path.basename(destination)) : "";
    setJobState(job, {
      status: "running",
      message: "Preparing output file...",
      speed: null,
      eta: null,
      title: inferredTitle || job.title
    });
    return;
  }

  if (
    text.includes("[Merger]") ||
    text.includes("[ExtractAudio]") ||
    text.includes("[VideoConvertor]") ||
    text.includes("[VideoRemuxer]") ||
    text.includes("[Fixup")
  ) {
    const message =
      text.includes("[Merger]") || text.includes("[VideoRemuxer]") || text.includes("[Fixup")
        ? "Remuxing media..."
        : text.includes("[VideoConvertor]")
          ? "Transcoding for compatibility..."
          : "Processing media...";
    setJobState(job, {
      status: "processing",
      message,
      progress: Math.max(95, Number(job.progress) || 0),
      speed: null,
      eta: null
    });
    return;
  }

  if (text.includes("has already been downloaded")) {
    setJobState(job, {
      status: "processing",
      message: "Reusing previously downloaded media...",
      progress: Math.max(95, Number(job.progress) || 0),
      speed: null,
      eta: null
    });
    return;
  }

  if (text.startsWith("ERROR:")) {
    setJobState(job, {
      status: "failed",
      message: "Download failed.",
      error: text.replace(/^ERROR:\s*/, ""),
      speed: null,
      eta: null
    });
  }
}

function buildYtDlpArgs({ url, type, quality, codec, jobDir, transcode, useNvidia, passThrough }) {
  const direct = Boolean(passThrough);
  const format = direct ? "best" : formatSelector(type, quality, codec);
  const args = [
    "--no-playlist",
    "--no-overwrites",
    "--newline",
    "-P",
    jobDir,
    "-o",
    "%(title).180B [%(id)s].%(ext)s",
    "-f",
    format
  ];

  if (!direct) {
    args.push("--write-thumbnail", "--convert-thumbnails", "jpg");
    args.push(...postProcessArgs(type, codec, { transcode, useNvidia }));
  }

  args.push(url);
  return args;
}

function shouldRetryWithTranscode(type, lines) {
  if (type === "a") return false;
  const text = lines.join("\n").toLowerCase();
  return (
    text.includes("ffmpeg") ||
    text.includes("videoremuxer") ||
    text.includes("videoconvertor") ||
    text.includes("postprocessing") ||
    text.includes("conversion failed") ||
    text.includes("could not write header") ||
    text.includes("invalid argument")
  );
}

function buildAttemptPlan(type) {
  const plan = [{ transcode: false, useNvidia: false, passThrough: false, label: "fast-remux" }];
  if (type === "a") return plan;

  if (NVIDIA_TRANSCODE_AVAILABLE) {
    plan.push({ transcode: true, useNvidia: true, passThrough: false, label: "gpu-transcode" });
  }
  plan.push({ transcode: true, useNvidia: false, passThrough: false, label: "cpu-transcode" });
  plan.push({ transcode: false, useNvidia: false, passThrough: true, label: "pass-through" });
  return plan;
}

function startJob({ url, type, quality, codec, ownerUsername, ownerIp }) {
  const id = crypto.randomUUID();
  const userRoot = getUserRoot(ownerUsername);
  const jobDir = path.join(userRoot, id);
  const createdAt = Date.now();

  fs.mkdirSync(jobDir, { recursive: true });

  const job = {
    id,
    ownerUsername,
    ownerIp,
    url,
    type,
    quality,
    codec,
    title: sourceLabelFromUrl(url),
    userRoot,
    status: "queued",
    message: "Queued...",
    progress: 0,
    error: null,
    speed: null,
    eta: null,
    totalSize: null,
    downloadSpeed: {
      samples: 0,
      sumMBps: 0,
      maxMBps: 0,
      minMBps: 0
    },
    thumbnailUrl: null,
    downloadUrl: null,
    filePath: null,
    createdAt,
    clients: new Set(),
    lastUpdate: {
      id,
      status: "queued",
      message: "Queued...",
      progress: 0,
      downloadUrl: null,
      error: null,
      speed: null,
      eta: null,
      totalSize: null,
      thumbnailUrl: null,
      title: sourceLabelFromUrl(url),
      url,
      type,
      quality,
      codec,
      createdAt
    }
  };

  jobs.set(id, job);

  const attempts = buildAttemptPlan(type);
  let attemptIndex = 0;

  const runAttempt = () => {
    const attempt = attempts[attemptIndex];
    const args = buildYtDlpArgs({
      url,
      type,
      quality,
      codec,
      jobDir,
      transcode: attempt.transcode,
      useNvidia: attempt.useNvidia,
      passThrough: attempt.passThrough
    });
    const attemptLines = [];

    const startMessage =
      attempt.label === "fast-remux"
        ? "Starting yt-dlp..."
        : attempt.label === "pass-through"
          ? "Retrying with direct download..."
        : attempt.useNvidia
          ? "Fast remux failed. Retrying with NVIDIA transcoding..."
          : "Fast remux failed. Retrying with CPU transcoding...";

    setJobState(job, {
      status: attempt.label === "fast-remux" ? "running" : "processing",
      message: startMessage,
      progress: 0,
      speed: null,
      eta: null,
      totalSize: null
    });

    const child = spawn("yt-dlp", args, {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"]
    });

    const stdoutReader = readline.createInterface({ input: child.stdout });
    const stderrReader = readline.createInterface({ input: child.stderr });

    const onLine = line => {
      const trimmed = String(line || "").trim();
      if (trimmed) {
        attemptLines.push(trimmed);
        if (attemptLines.length > 400) {
          attemptLines.shift();
        }
      }
      handleYtDlpLine(job, line);
    };

    stdoutReader.on("line", onLine);
    stderrReader.on("line", onLine);

    child.on("error", err => {
      setJobState(job, {
        status: "failed",
        message: "Failed to start yt-dlp.",
        error: err.message
      });
    });

    child.on("close", code => {
      stdoutReader.close();
      stderrReader.close();

      if (code !== 0) {
        const hasNextAttempt = attemptIndex + 1 < attempts.length;
        const canRetryFromRemux = !attempt.transcode && shouldRetryWithTranscode(type, attemptLines);
        const canRetryFromNvidia = attempt.transcode && attempt.useNvidia && hasNextAttempt;
        const canRetryFromCpu = attempt.transcode && !attempt.useNvidia && hasNextAttempt;

        if (hasNextAttempt && (canRetryFromRemux || canRetryFromNvidia || canRetryFromCpu)) {
          attemptIndex += 1;
          runAttempt();
          return;
        }

        if (job.status !== "failed") {
          setJobState(job, {
            status: "failed",
            message: "yt-dlp exited with an error.",
            error: `Exit code ${code}`
          });
        }
        return;
      }

      const filePath = findNewestFile(jobDir);

      if (!filePath) {
        setJobState(job, {
          status: "failed",
          message: "No output file was produced.",
          error: "yt-dlp completed but no downloadable file was found."
        });
        return;
      }

      job.filePath = filePath;
      const providerThumbPath = findProviderThumbnail(jobDir, filePath);
      const fallbackThumbUrl = providerThumbPath ? "" : fallbackRemoteThumbnailUrl(url);
      if (type === "a" && path.extname(filePath).toLowerCase() === ".mp3" && providerThumbPath) {
        const iconCoverPath = createAudioCoverWithIcon(providerThumbPath);
        if (iconCoverPath) {
          embedMp3CoverArt(filePath, iconCoverPath);
          try {
            fs.rmSync(iconCoverPath, { force: true });
          } catch {
            // ignore temp cover cleanup failures
          }
        }
      }
      let completedSize = job.totalSize;
      let completedSizeBytes = 0;
      try {
        const stat = fs.statSync(filePath);
        completedSizeBytes = Number(stat.size || 0);
        completedSize = formatBinaryBytes(stat.size) || completedSize;
      } catch {
        // ignore and keep prior size text
      }
      const durationSec = probeMediaDurationSeconds(filePath);
      const speedSamples = Number(job.downloadSpeed?.samples || 0);
      const avgSpeedMBps = speedSamples > 0
        ? Number(job.downloadSpeed.sumMBps || 0) / speedSamples
        : 0;
      const maxSpeedMBps = Number(job.downloadSpeed?.maxMBps || 0);
      const minSpeedMBps = Number(job.downloadSpeed?.minMBps || 0);

      appendUserDownloadRecord(ownerUsername, {
        id,
        filePath,
        createdAt: job.createdAt,
        thumbnailPath: providerThumbPath,
        externalThumbnailUrl: fallbackThumbUrl,
        sourceUrl: url,
        mediaType: type,
        quality,
        title: displayTitleFromFilename(path.basename(filePath))
      });
      recordDownloadStat({
        username: ownerUsername,
        title: displayTitleFromFilename(path.basename(filePath)),
        sourceUrl: url,
        mediaType: type,
        quality,
        durationSec,
        sizeBytes: completedSizeBytes,
        avgSpeedMBps,
        maxSpeedMBps,
        minSpeedMBps,
        createdAt: job.createdAt
      });

      setJobState(job, {
        status: "completed",
        message: "Download ready.",
        progress: 100,
        speed: null,
        eta: null,
        totalSize: completedSize || "available",
        title: displayTitleFromFilename(path.basename(filePath)),
        thumbnailUrl: providerThumbPath
          ? `/api/downloads/thumb/${encodeURIComponent(id)}`
          : (fallbackThumbUrl || `/api/downloads/thumb/${encodeURIComponent(id)}`),
        downloadUrl: `/api/jobs/${id}/file`
      });

      setTimeout(() => {
        const existing = jobs.get(id);
        if (existing && existing.clients.size === 0 && Date.now() - existing.createdAt > 60 * 60 * 1000) {
          jobs.delete(id);
        }
      }, 60 * 60 * 1000);
    });
  };

  runAttempt();

  return id;
}

function cleanupStaleState() {
  const now = Date.now();

  for (const [id, session] of sessions.entries()) {
    if (session.expiresAt <= now) sessions.delete(id);
  }

  for (const [ip, state] of loginStateByIp.entries()) {
    state.attempts = pruneRecent(state.attempts, 60 * 1000, now);
    if (state.attempts.length === 0 && state.failedStreak === 0 && state.blockedUntil <= now) {
      loginStateByIp.delete(ip);
    }
  }

  for (const [ip, events] of accessRequestsByIp.entries()) {
    const fresh = pruneRecent(events, ACCESS_REQUEST_LIMIT.windowMs, now);
    if (fresh.length > 0) accessRequestsByIp.set(ip, fresh);
    else accessRequestsByIp.delete(ip);
  }

  for (const [ip, events] of forgotPasswordEventsByIp.entries()) {
    const fresh = pruneRecent(events, FORGOT_PASSWORD_LIMIT.windowMs, now);
    if (fresh.length > 0) forgotPasswordEventsByIp.set(ip, fresh);
    else forgotPasswordEventsByIp.delete(ip);
  }

  for (const [ip, events] of downloadEventsByIp.entries()) {
    const fresh = pruneRecent(events, 60 * 60 * 1000, now);
    if (fresh.length > 0) downloadEventsByIp.set(ip, fresh);
    else downloadEventsByIp.delete(ip);
  }

  for (const [account, events] of downloadEventsByAccount.entries()) {
    const fresh = pruneRecent(events, 60 * 60 * 1000, now);
    if (fresh.length > 0) downloadEventsByAccount.set(account, fresh);
    else downloadEventsByAccount.delete(account);
  }

  for (const [id, record] of passwordResetById.entries()) {
    if (Number(record.expiresAt || 0) <= now) {
      passwordResetById.delete(id);
    }
  }

  let accessRequestsChanged = false;
  let accountsChanged = false;
  for (const [id, record] of accessRequestById.entries()) {
    const requestTime = Number(record.requestTime || 0);
    const tokenExpiresAt = Number(record.tokenExpiresAt || 0);
    const tooOld = now - requestTime > 30 * 24 * 60 * 60 * 1000;
    const pendingTooOld =
      record.status === "pending" &&
      tokenExpiresAt > 0 &&
      now - tokenExpiresAt > 7 * 24 * 60 * 60 * 1000;

    if (tooOld || pendingTooOld) {
      if (record.status === "pending" && record.pendingAccountId) {
        pendingAccountsById.delete(String(record.pendingAccountId));
        accountsChanged = true;
      }
      accessRequestById.delete(id);
      accessRequestsChanged = true;
    }
  }
  if (accessRequestsChanged) {
    saveAccessRequestsToDisk();
  }
  if (accountsChanged) {
    saveAccountsToDisk();
  }

  if (fs.existsSync(USERS_DOWNLOADS_DIR)) {
    const userKeys = fs.readdirSync(USERS_DOWNLOADS_DIR, { withFileTypes: true });
    for (const userDir of userKeys) {
      if (!userDir.isDirectory()) continue;
      let username = "";
      try {
        username = decodeURIComponent(userDir.name);
      } catch {
        continue;
      }
      if (!username) continue;
      pruneUserDownloads(username);
    }
  }
}

async function start() {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  fs.mkdirSync(USERS_DOWNLOADS_DIR, { recursive: true });
  loadAccountsFromDisk();
  loadAccessRequestsFromDisk();
  loadStatsFromDisk();
  if (DATA_ENCRYPTION_KEY) {
    // Normalize persisted state into encrypted-at-rest format on startup.
    saveAccountsToDisk();
    saveAccessRequestsToDisk();
  }
  const dev = process.env.NODE_ENV !== "production";
  const nextApp = next({ dev, dir: ROOT, turbopack: false });
  const nextHandler = nextApp.getRequestHandler();
  await nextApp.prepare();

  const app = express();
  app.set("trust proxy", true);
  app.use(applyCors);
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false, limit: "32kb" }));

  app.post(["/auth/login", "/api/auth/login"], (req, res) => {
    const ip = getClientIp(req);
    const rate = checkLoginRate(ip);

    if (!rate.allowed) {
      res.status(429).json({ ok: false, error: rate.error });
      return;
    }

    const loginId = String(req.body?.username || req.body?.email || "").trim();
    const password = String(req.body?.password || "");
    const normalizedUsername = normalizeUsername(loginId);
    const normalizedEmail = normalizeEmail(loginId);

    let sessionUsername = "";

    const activeAccount = findActiveAccountByUsername(normalizedUsername);
    const emailAccount = findActiveAccountByEmail(normalizedEmail);
    const candidates = [];
    if (activeAccount) candidates.push(activeAccount);
    if (emailAccount && (!activeAccount || emailAccount.username !== activeAccount.username)) {
      candidates.push(emailAccount);
    }

    const matching = candidates.filter(account => verifyPasswordHash(password, account.passwordHash));
    if (matching.length === 1) {
      sessionUsername = matching[0].username;
    } else if (matching.length > 1) {
      res.status(409).json({
        ok: false,
        error: "Login is ambiguous for this identifier. Use your username."
      });
      return;
    }

    if (
      !sessionUsername &&
      authConfigured() &&
      safeEqualString(loginId, AUTH_USERNAME) &&
      verifyEnvAdminPassword(password)
    ) {
      sessionUsername = AUTH_USERNAME;
    }

    if (!sessionUsername) {
      registerFailedLogin(rate.state);
      res.status(401).json({ ok: false, error: "Invalid username or password." });
      return;
    }

    registerSuccessfulLogin(rate.state);

    const sessionId = makeSession(sessionUsername);
    setSessionCookie(req, res, sessionId);
    res.json({ ok: true });
  });

  app.post(["/auth/logout", "/api/auth/logout"], (req, res) => {
    const cookies = parseCookies(req);
    const sessionId = cookies[SESSION_COOKIE];
    if (sessionId) sessions.delete(sessionId);
    clearSessionCookie(req, res);
    res.json({ ok: true });
  });

  app.post(["/auth/request-access", "/api/auth/request-access"], async (req, res) => {
    const ip = getClientIp(req);
    const allowed = consumeWindowLimit(
      accessRequestsByIp,
      ip,
      ACCESS_REQUEST_LIMIT.per15Minutes,
      ACCESS_REQUEST_LIMIT.windowMs
    );

    if (!allowed) {
      res.status(429).json({
        ok: false,
        error: "Too many access requests from this IP. Limit is 2 every 15 minutes."
      });
      return;
    }

    const username = String(req.body?.username || "").trim();
    const email = String(req.body?.email || "").trim();
    const requestedPassword = String(req.body?.password || "");

    if (!username || !email || !requestedPassword) {
      res
        .status(400)
        .json({ ok: false, error: "Username, email, and password are required." });
      return;
    }

    let record = null;
    let pendingAccount = null;

    try {
      const pendingResult = createPendingAccount({
        username,
        email,
        requestedPassword,
        requestId: ""
      });

      if (pendingResult.error) {
        res.status(409).json({ ok: false, error: pendingResult.error });
        return;
      }

      pendingAccount = pendingResult.account;

      record = createAccessRequestRecord({
        username,
        email,
        pendingAccountId: pendingAccount.id,
        ip: getEmailDisplayIp(req),
        userAgent: String(req.headers["user-agent"] || "")
      });

      pendingAccount.requestId = record.id;
      pendingAccountsById.set(pendingAccount.id, pendingAccount);
      saveAccountsToDisk();

      await sendAccessRequestEmail(record, {
        baseUrl: getRequestBaseUrl(req)
      });

      res.json({ ok: true, message: "Access request sent." });
    } catch (error) {
      if (record) {
        accessRequestById.delete(record.id);
        saveAccessRequestsToDisk();
      }
      if (pendingAccount) {
        deletePendingAccount(pendingAccount.id);
      }
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post(["/auth/forgot-password", "/api/auth/forgot-password"], async (req, res) => {
    const ip = getClientIp(req);
    const allowed = consumeWindowLimit(
      forgotPasswordEventsByIp,
      ip,
      FORGOT_PASSWORD_LIMIT.per15Minutes,
      FORGOT_PASSWORD_LIMIT.windowMs
    );

    if (!allowed) {
      res.status(429).json({
        ok: false,
        error: "Too many forgot-password requests from this IP. Limit is 2 every 15 minutes."
      });
      return;
    }

    const identifier = String(
      req.body?.identifier || req.body?.username || req.body?.email || ""
    ).trim();

    const account = findActiveAccountByIdentifier(identifier);
    if (account) {
      try {
        const record = createPasswordResetRecord(account);
        await sendPasswordResetEmail(record, { baseUrl: getRequestBaseUrl(req) });
      } catch {
        // Do not leak account existence or email delivery internals here.
      }
    }

    res.json({
      ok: true,
      message: "If an account matches that username/email, a reset link has been sent."
    });
  });

  app.get("/auth/reset-password/:id", (req, res) => {
    const id = String(req.params.id || "").trim();
    const token = String(req.query.token || "");
    const record = passwordResetById.get(id);
    const tokenError = validatePasswordResetToken(record, token);
    if (tokenError) {
      res.status(400).send(renderSimpleHtmlPage(escapeHtml(tokenError)));
      return;
    }

    res.send(renderPasswordResetFormPage({ token }));
  });

  app.post("/auth/reset-password/:id", (req, res) => {
    const id = String(req.params.id || "").trim();
    const token = String(req.body?.token || req.query.token || "");
    const password = String(req.body?.password || "");
    const record = passwordResetById.get(id);

    const tokenError = validatePasswordResetToken(record, token);
    if (tokenError) {
      res.status(400).send(renderSimpleHtmlPage(escapeHtml(tokenError)));
      return;
    }

    if (password.length < 8) {
      res.status(400).send(renderSimpleHtmlPage("Password must be at least 8 characters."));
      return;
    }

    const account = findActiveAccountByUsername(record.username);
    if (!account) {
      passwordResetById.delete(id);
      res.status(404).send(renderSimpleHtmlPage("Account not found."));
      return;
    }

    account.passwordHash = hashPasswordForStorage(password);
    saveAccountsToDisk();
    revokeSessionsForUsername(account.username);
    passwordResetById.delete(id);

    res.send(renderSimpleHtmlPage("Password updated. You can return to login."));
  });

  app.get("/auth/request-access/review/:id/allow", async (req, res) => {
    const id = String(req.params.id || "").trim();
    const token = String(req.query.token || "");
    const record = accessRequestById.get(id);

    const tokenError = validateAccessReviewToken(record, "allow", token);
    if (tokenError) {
      res.status(400).send(renderSimpleHtmlPage(escapeHtml(tokenError)));
      return;
    }

    const approveResult = approvePendingAccount(record.pendingAccountId);
    if (approveResult.error) {
      res.status(409).send(renderSimpleHtmlPage(escapeHtml(approveResult.error)));
      return;
    }

    let emailError = "";
    try {
      await sendDecisionEmailToRequester(record, "allow");
    } catch (error) {
      emailError = String(error.message || "Email delivery failed.");
    }

    finalizeAccessReview(record, "allow", emailError ? `Approval email failed: ${emailError}` : "");

    if (emailError) {
      res.status(500).send(renderSimpleHtmlPage(escapeHtml(emailError)));
      return;
    }

    const approvedUser = String(record.username || "user").trim() || "user";
    res.send(renderCenteredResultPage(`Allowed ${approvedUser}`, "Tab will close in 5 seconds"));
  });

  app.get("/auth/request-access/review/:id/deny", (req, res) => {
    const id = String(req.params.id || "").trim();
    const token = String(req.query.token || "");
    const record = accessRequestById.get(id);

    const tokenError = validateAccessReviewToken(record, "deny", token);
    if (tokenError) {
      res.status(400).send(renderSimpleHtmlPage(escapeHtml(tokenError)));
      return;
    }

    res.send(renderDenyFormPage(token));
  });

  app.post("/auth/request-access/review/:id/deny", async (req, res) => {
    const id = String(req.params.id || "").trim();
    const token = String(req.body?.token || req.query.token || "");
    const reason = String(req.body?.reason || "").trim().slice(0, 2000);
    const record = accessRequestById.get(id);

    const tokenError = validateAccessReviewToken(record, "deny", token);
    if (tokenError) {
      res.status(400).send(renderSimpleHtmlPage(escapeHtml(tokenError)));
      return;
    }

    deletePendingAccount(record.pendingAccountId);

    let emailError = "";
    try {
      await sendDecisionEmailToRequester(record, "deny", reason);
    } catch (error) {
      emailError = String(error.message || "Email delivery failed.");
    }

    finalizeAccessReview(
      record,
      "deny",
      emailError ? `${reason}\n\n(Notice email failed: ${emailError})` : reason
    );

    if (emailError) {
      res.status(500).send(renderSimpleHtmlPage(escapeHtml(emailError)));
      return;
    }

    res.send(renderSimpleHtmlPage("Sent"));
  });

  app.get("/", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const session = readValidSession(req);
    if (!session) {
      res.redirect("/login");
      return;
    }
    setSessionCookie(req, res, session.id);
    nextApp.render(req, res, "/index");
  });

  app.get("/history", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const session = readValidSession(req);
    if (!session) {
      res.redirect("/login");
      return;
    }
    setSessionCookie(req, res, session.id);
    nextApp.render(req, res, "/history");
  });

  app.get("/stats", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const session = readValidSession(req);
    if (!session) {
      res.redirect("/login");
      return;
    }
    setSessionCookie(req, res, session.id);
    nextApp.render(req, res, "/stats");
  });

  app.get("/login", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const session = readValidSession(req);
    if (session) {
      setSessionCookie(req, res, session.id);
      res.redirect("/");
      return;
    }
    nextApp.render(req, res, "/login");
  });

  app.get(["/auth/session", "/api/auth/session"], (req, res) => {
    const session = readValidSession(req);
    if (!session) {
      clearSessionCookie(req, res);
      res.status(401).json({ ok: false, error: "Authentication required." });
      return;
    }
    setSessionCookie(req, res, session.id);
    res.json({ ok: true, username: session.username });
  });

  app.get("/api/downloads/history", requireAuth, (req, res) => {
    const status = getUserStorageStatus(req.auth.username);

    res.json({
      ok: true,
      entries: status.entries.map(entry => ({
        id: entry.id,
        fileName: entry.fileName,
        title: entry.title || displayTitleFromFilename(entry.fileName),
        sourceUrl: entry.sourceUrl || "",
        mediaType: entry.mediaType || inferMediaTypeFromPath(entry.fileName),
        quality: normalizeQualityValue(entry.quality) || "hq",
        sizeBytes: entry.sizeBytes,
        createdAt: entry.createdAt,
        downloadUrl: `/api/downloads/file/${encodeURIComponent(entry.id)}`,
        thumbnailUrl: entry.externalThumbnailUrl || `/api/downloads/thumb/${encodeURIComponent(entry.id)}`
      })),
      usageBytes: status.usageBytes,
      capBytes: status.capBytes,
      exceedsCap: status.exceedsCap
    });
  });

  app.get("/api/stats", requireAuth, (_req, res) => {
    res.json({
      ok: true,
      stats: buildStatsSnapshot()
    });
  });

  app.post("/api/downloads/clear", requireAuth, (req, res) => {
    clearUserDownloads(req.auth.username);
    res.json({ ok: true, message: "All downloads cleared." });
  });

  app.delete("/api/downloads/item/:id", requireAuth, (req, res) => {
    const id = String(req.params.id || "").trim();
    if (!id) {
      res.status(400).json({ ok: false, error: "Missing file id." });
      return;
    }

    const removed = deleteUserDownloadById(req.auth.username, id);
    if (!removed) {
      res.status(404).json({ ok: false, error: "File not found." });
      return;
    }

    res.json({ ok: true });
  });

  app.get("/api/downloads/file/:id", requireAuth, (req, res) => {
    const id = String(req.params.id || "").trim();
    if (!id) {
      res.status(400).json({ ok: false, error: "Missing file id." });
      return;
    }

    const userRoot = getUserRoot(req.auth.username);
    const entries = pruneUserDownloads(req.auth.username);
    const entry = entries.find(item => item.id === id);

    if (!entry) {
      res.status(404).json({ ok: false, error: "File not found." });
      return;
    }

    const absPath = resolveSafePath(userRoot, entry.relativePath);
    if (!absPath || !fs.existsSync(absPath)) {
      res.status(404).json({ ok: false, error: "File not found." });
      return;
    }

    res.download(absPath, entry.fileName || path.basename(absPath));
  });

  app.get("/api/downloads/thumb/:id", requireAuth, (req, res) => {
    const id = String(req.params.id || "").trim();
    if (!id) {
      res.status(400).json({ ok: false, error: "Missing file id." });
      return;
    }

    const userRoot = getUserRoot(req.auth.username);
    const entries = pruneUserDownloads(req.auth.username);
    const entry = entries.find(item => item.id === id);

    if (!entry) {
      res.status(404).end();
      return;
    }

    let thumbnailPath = null;
    if (entry.thumbnailRelativePath) {
      thumbnailPath = resolveSafePath(userRoot, entry.thumbnailRelativePath);
    }

    if (!thumbnailPath || !fs.existsSync(thumbnailPath)) {
      const mediaPath = resolveSafePath(userRoot, entry.relativePath);
      if (!mediaPath || !fs.existsSync(mediaPath)) {
        res.status(404).end();
        return;
      }

      const regenerated = ensureThumbnailForFile(userRoot, mediaPath, entry.thumbnailRelativePath);
      if (!regenerated) {
        res.status(404).end();
        return;
      }

      entry.thumbnailRelativePath = regenerated;
      saveUserManifest(req.auth.username, entries);
      thumbnailPath = resolveSafePath(userRoot, regenerated);
    }

    if (!thumbnailPath || !fs.existsSync(thumbnailPath)) {
      res.status(404).end();
      return;
    }

    res.sendFile(thumbnailPath);
  });

  app.post(["/report-bug", "/api/report-bug"], requireAuth, async (req, res) => {
    const errorCodeRaw = String(req.body?.errorCode || "").trim();
    if (!errorCodeRaw) {
      res.status(400).json({ ok: false, error: "Missing error code." });
      return;
    }

    const actionsRaw = Array.isArray(req.body?.actions) ? req.body.actions : [];
    const actions = actionsRaw
      .slice(-10)
      .map(item => String(item || "").trim())
      .filter(Boolean)
      .map(item => item.slice(0, 240));

    const report = {
      username: req.auth.username,
      ip: getClientIp(req),
      userAgent: String(req.headers["user-agent"] || "").slice(0, 500),
      errorCode: errorCodeRaw.slice(0, 120),
      message: String(req.body?.message || "").slice(0, 500),
      jobId: String(req.body?.jobId || "").slice(0, 120),
      url: String(req.body?.url || "").slice(0, 500),
      type: String(req.body?.type || "").slice(0, 40),
      quality: String(req.body?.quality || "").slice(0, 40),
      codec: String(req.body?.codec || "").slice(0, 80),
      actions
    };

    try {
      await sendBugReportEmail(report);
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message || "Unable to send bug report." });
    }
  });

  app.post(["/download", "/api/download"], requireAuth, (req, res) => {
    const validationError = validatePayload(req.body);
    if (validationError) {
      res.status(400).json({ ok: false, error: validationError });
      return;
    }

    const storage = getUserStorageStatus(req.auth.username);
    if (storage.exceedsCap) {
      res.status(409).json({
        ok: false,
        code: "STORAGE_LIMIT_EXCEEDED",
        error: "Storage limit exceeded (10GB). Clear storage to continue.",
        usageBytes: storage.usageBytes,
        capBytes: storage.capBytes
      });
      return;
    }

    const ip = getClientIp(req);
    const limit = checkDownloadRateLimit({ username: req.auth.username, ip });
    if (!limit.allowed) {
      res.status(429).json({ ok: false, error: limit.error });
      return;
    }

    const jobId = startJob({
      ...req.body,
      ownerUsername: req.auth.username,
      ownerIp: ip
    });

    res.json({
      ok: true,
      jobId,
      eventsUrl: `/api/jobs/${jobId}/events`
    });
  });

  app.get(["/jobs", "/api/jobs"], requireAuth, (req, res) => {
    const list = Array.from(jobs.values())
      .filter(job => job.ownerUsername === req.auth.username)
      .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
      .map(job => ({
        id: job.id,
        status: job.status,
        message: job.message,
        progress: job.progress,
        speed: job.speed,
        eta: job.eta,
        totalSize: job.totalSize,
        error: job.error,
        thumbnailUrl: job.thumbnailUrl || "",
        downloadUrl: job.downloadUrl || "",
        title: job.title || sourceLabelFromUrl(job.url || ""),
        url: job.url || "",
        type: job.type || "a+v",
        quality: job.quality || "hq",
        codec: job.codec || "h265",
        createdAt: Number(job.createdAt || Date.now()),
        eventsUrl: `/api/jobs/${job.id}/events`
      }));

    res.json({ ok: true, jobs: list });
  });

  app.get(["/jobs/:id/events", "/api/jobs/:id/events"], requireAuth, (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) {
      res.status(404).json({ ok: false, error: "Job not found." });
      return;
    }

    if (job.ownerUsername !== req.auth.username) {
      res.status(403).json({ ok: false, error: "Not allowed to access this job." });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    sseWrite(res, job.lastUpdate);
    job.clients.add(res);

    req.on("close", () => {
      job.clients.delete(res);
    });
  });

  app.get(["/jobs/:id/file", "/api/jobs/:id/file"], requireAuth, (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job || job.status !== "completed" || !job.filePath) {
      res.status(404).json({ ok: false, error: "Download not ready." });
      return;
    }

    if (job.ownerUsername !== req.auth.username) {
      res.status(403).json({ ok: false, error: "Not allowed to access this file." });
      return;
    }

    const jobRoot = path.join(getUserRoot(job.ownerUsername), job.id);
    const resolvedJobRoot = path.resolve(jobRoot);
    const resolvedFile = path.resolve(job.filePath);
    if (!resolvedFile.startsWith(`${resolvedJobRoot}${path.sep}`) && resolvedFile !== resolvedJobRoot) {
      res.status(400).json({ ok: false, error: "Invalid file path." });
      return;
    }

    if (!fs.existsSync(job.filePath)) {
      res.status(404).json({ ok: false, error: "File no longer exists." });
      return;
    }

    const fileName = path.basename(job.filePath);
    res.download(job.filePath, fileName);
  });

  app.get(["/health", "/api/health"], (_req, res) => {
    res.json({ ok: true });
  });

  app.use((req, res) => nextHandler(req, res));

  setInterval(cleanupStaleState, 5 * 60 * 1000).unref();

  app.listen(PORT, () => {
    console.log(`multi-downloader listening on http://localhost:${PORT}`);
    console.log(`session TTL: ${SESSION_TTL_HOURS}h`);
    console.log(`smtp: ${SMTP_HOST}:${SMTP_PORT} secure=${SMTP_SECURE}`);
    console.log(
      `video accel: mode=${VIDEO_ACCEL_MODE} nvidia_transcode=${NVIDIA_TRANSCODE_AVAILABLE ? "available" : "unavailable"}`
    );
    console.log(
      `accounts: active=${activeAccountsByUsername.size} pending=${pendingAccountsById.size}`
    );
    if (!authConfigured() && activeAccountsByUsername.size === 0) {
      console.log("WARNING: auth is not configured. Set AUTH_USERNAME and AUTH_PASSWORD or AUTH_PASSWORD_HASH.");
    }
    if (!GMAIL_APP_PASSWORD) {
      console.log("WARNING: Gmail access request email is not configured. Set GMAIL_APP_PASSWORD.");
    }
    if (!DATA_ENCRYPTION_KEY) {
      console.log("WARNING: DATA_ENCRYPTION_KEY is not set. Username/email data at rest is not encrypted.");
    }
  });
}

start().catch(error => {
  console.error("Failed to start multi-downloader:", error);
  process.exit(1);
});
