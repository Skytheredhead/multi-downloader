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

let mailTransport = null;
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
    const email = String(item.email || "").trim();
    if (!id || !email) continue;

    accessRequestById.set(id, {
      id,
      username: String(item.username || "").trim(),
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
    .slice(0, 1000);
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
    const username = normalizeUsername(item.username);
    const email = normalizeEmail(item.email);
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
    const username = normalizeUsername(item.username);
    const email = normalizeEmail(item.email);
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
  const active = Array.from(activeAccountsByUsername.values());
  const pending = Array.from(pendingAccountsById.values());
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

  if (IMAGE_THUMBNAIL_EXTS.has(ext)) {
    return toUserRelativePath(userRoot, absPath);
  }

  if (!VIDEO_THUMBNAIL_EXTS.has(ext)) {
    return "";
  }

  const existing = preferredRelativePath
    ? resolveSafePath(userRoot, preferredRelativePath)
    : null;
  if (existing && fs.existsSync(existing)) {
    return preferredRelativePath;
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
      thumbnailRelativePath: finalThumbnailRelativePath
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

function appendUserDownloadRecord(username, { id, filePath, createdAt, thumbnailPath = "" }) {
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
    thumbnailRelativePath
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
      withFilter("bestvideo[height<=1080]", codecFilter),
      "bestvideo[height<=1080]",
      "best[height<=1080]"
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
        "--postprocessor-args",
        "ffmpeg:-b:a 320k"
      );
      return args;
    }

    args.push(
      "-x",
      "--audio-format",
      "mp3",
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
    thumbnailUrl: "thumbnailUrl" in patch ? patch.thumbnailUrl : job.thumbnailUrl
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

function findNewestFile(dir) {
  if (!fs.existsSync(dir)) return null;
  const files = listFilesRecursive(dir).filter(candidate => {
    const ext = path.extname(candidate).toLowerCase();
    if (!MEDIA_OUTPUT_EXTS.has(ext)) return false;
    const base = path.basename(candidate).toLowerCase();
    if (base.includes(".part")) return false;
    if (/\.(f\d+|frag\d+)\./i.test(base)) return false;
    return true;
  });
  if (files.length === 0) return null;

  let newest = files[0];
  let newestMtime = fs.statSync(newest).mtimeMs;

  for (let i = 1; i < files.length; i += 1) {
    const candidate = files[i];
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

function handleYtDlpLine(job, line) {
  const text = line.trim();
  if (!text) return;

  const progress = parseProgress(text);
  if (progress !== null) {
    const stats = parseDownloadStats(text);
    setJobState(job, {
      status: "running",
      message: `Downloading... ${progress.toFixed(1)}%`,
      progress,
      speed: stats.speed,
      eta: stats.eta,
      totalSize: stats.totalSize
    });
    return;
  }

  if (text.includes("Destination:")) {
    setJobState(job, {
      status: "running",
      message: "Preparing output file...",
      speed: null,
      eta: null
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
      speed: null,
      eta: null
    });
    return;
  }

  if (text.includes("has already been downloaded")) {
    setJobState(job, {
      status: "processing",
      message: "Reusing previously downloaded media...",
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

function buildYtDlpArgs({ url, type, quality, codec, jobDir, transcode, useNvidia }) {
  const format = formatSelector(type, quality, codec);
  return [
    "--no-playlist",
    "--no-overwrites",
    "--newline",
    "--write-thumbnail",
    "--convert-thumbnails",
    "jpg",
    "-P",
    jobDir,
    "-o",
    "%(title).180B [%(id)s].%(ext)s",
    "-f",
    format,
    ...postProcessArgs(type, codec, { transcode, useNvidia }),
    url
  ];
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
  const plan = [{ transcode: false, useNvidia: false, label: "fast-remux" }];
  if (type === "a") return plan;

  if (NVIDIA_TRANSCODE_AVAILABLE) {
    plan.push({ transcode: true, useNvidia: true, label: "gpu-transcode" });
  }
  plan.push({ transcode: true, useNvidia: false, label: "cpu-transcode" });
  return plan;
}

function startJob({ url, type, quality, codec, ownerUsername, ownerIp }) {
  const id = crypto.randomUUID();
  const userRoot = getUserRoot(ownerUsername);
  const jobDir = path.join(userRoot, id);

  fs.mkdirSync(jobDir, { recursive: true });

  const job = {
    id,
    ownerUsername,
    ownerIp,
    userRoot,
    status: "queued",
    message: "Queued...",
    progress: 0,
    error: null,
    speed: null,
    eta: null,
    totalSize: null,
    thumbnailUrl: null,
    downloadUrl: null,
    filePath: null,
    createdAt: Date.now(),
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
      thumbnailUrl: null
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
      useNvidia: attempt.useNvidia
    });
    const attemptLines = [];

    const startMessage =
      attempt.label === "fast-remux"
        ? "Starting yt-dlp..."
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

        if (hasNextAttempt && (canRetryFromRemux || canRetryFromNvidia)) {
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
      let completedSize = job.totalSize;
      try {
        const stat = fs.statSync(filePath);
        completedSize = formatBinaryBytes(stat.size) || completedSize;
      } catch {
        // ignore and keep prior size text
      }

      appendUserDownloadRecord(ownerUsername, {
        id,
        filePath,
        createdAt: job.createdAt,
        thumbnailPath: providerThumbPath
      });

      setJobState(job, {
        status: "completed",
        message: "Download ready.",
        progress: 100,
        speed: null,
        eta: null,
        totalSize: completedSize || "available",
        thumbnailUrl: `/api/downloads/thumb/${encodeURIComponent(id)}`,
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
        sizeBytes: entry.sizeBytes,
        createdAt: entry.createdAt,
        downloadUrl: `/api/downloads/file/${encodeURIComponent(entry.id)}`,
        thumbnailUrl: `/api/downloads/thumb/${encodeURIComponent(entry.id)}`
      })),
      usageBytes: status.usageBytes,
      capBytes: status.capBytes,
      exceedsCap: status.exceedsCap
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
  });
}

start().catch(error => {
  console.error("Failed to start multi-downloader:", error);
  process.exit(1);
});
