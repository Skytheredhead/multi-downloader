const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const readline = require("readline");
const nodemailer = require("nodemailer");
const esbuild = require("esbuild");
const net = require("net");

const PORT = 4928;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DOWNLOADS_DIR = path.join(ROOT, "downloads");
const USERS_DOWNLOADS_DIR = path.join(DOWNLOADS_DIR, "users");

const FRONTEND_ENTRY = path.join(ROOT, "frontend-entry.jsx");
const LOGIN_ENTRY = path.join(ROOT, "login-entry.jsx");
const HISTORY_ENTRY = path.join(ROOT, "history-entry.jsx");

const APP_HTML = path.join(PUBLIC_DIR, "app.html");
const LOGIN_HTML = path.join(PUBLIC_DIR, "login.html");
const HISTORY_HTML = path.join(PUBLIC_DIR, "history.html");

const SESSION_COOKIE = "md_session";
const SESSION_TTL_HOURS = Math.max(1, Number(process.env.SESSION_TTL_HOURS || 24 * 30));
const SESSION_TTL_MS = SESSION_TTL_HOURS * 60 * 60 * 1000;
const EMAIL_TIMEOUT_MS = 15000;
const ACCESS_REVIEW_TOKEN_TTL_MS = 48 * 60 * 60 * 1000;

const DOWNLOAD_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const USER_STORAGE_CAP_BYTES = 10 * 1024 * 1024 * 1024;

const LOGIN_RATE_LIMIT = { perMinute: 5, failBlockThreshold: 10, blockForMs: 60 * 60 * 1000 };
const ACCESS_REQUEST_LIMIT = { per15Minutes: 2, windowMs: 15 * 60 * 1000 };
const DOWNLOAD_LIMIT = { perMinute: 10, perHour: 25 };

const AUTH_USERNAME = process.env.AUTH_USERNAME || "";
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || "";
const AUTH_PASSWORD_HASH = process.env.AUTH_PASSWORD_HASH || "";

const GMAIL_USER = process.env.GMAIL_USER || "stemsplat@gmail.com";
const GMAIL_APP_PASSWORD = String(process.env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, "");
const ACCESS_ALERT_TO = process.env.ACCESS_ALERT_TO || "skytheredhead@gmail.com";
const SMTP_HOST = process.env.SMTP_HOST || "smtp.gmail.com";
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = String(process.env.SMTP_SECURE || "false").toLowerCase() === "true";
const ACCESS_REQUESTS_FILE = path.join(ROOT, "access-requests.json");
const USER_ACCOUNTS_FILE = path.join(ROOT, "user-accounts.json");

const VALID_TYPES = new Set(["a+v", "a", "v"]);
const VALID_QUALITIES = new Set(["hq", "mq", "lq"]);
const VIDEO_CODECS = new Set(["h264", "h265", "mov", "webm"]);
const AUDIO_CODECS = new Set(["wav", "mp3 (320)", "mp3 (128)"]);

const jobs = new Map();
const sessions = new Map();
const loginStateByIp = new Map();
const accessRequestsByIp = new Map();
const downloadEventsByIp = new Map();
const downloadEventsByAccount = new Map();
const accessRequestById = new Map();
const activeAccountsByUsername = new Map();
const pendingAccountsById = new Map();

let mailTransport = null;

function ensureBundle() {
  fs.mkdirSync(PUBLIC_DIR, { recursive: true });

  esbuild.buildSync({
    entryPoints: {
      app: FRONTEND_ENTRY,
      login: LOGIN_ENTRY,
      history: HISTORY_ENTRY
    },
    outdir: PUBLIC_DIR,
    bundle: true,
    minify: false,
    sourcemap: true,
    jsx: "automatic",
    loader: { ".js": "jsx", ".jsx": "jsx" }
  });
}

function normalizeIp(raw) {
  if (!raw || typeof raw !== "string") return "unknown";
  const value = raw.split(",")[0].trim();
  if (!value) return "unknown";
  if (value.startsWith("::ffff:")) return value.slice(7);
  return value;
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

function hasActiveAccountByEmail(email) {
  const normalized = normalizeEmail(email);
  for (const account of activeAccountsByUsername.values()) {
    if (account.email === normalized) return true;
  }
  return false;
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

function renderSimpleHtmlPage(bodyHtml) {
  return `<!doctype html><html><body>${bodyHtml}</body></html>`;
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
        background: #000;
        color: #fff;
        font-family: sans-serif;
      }
      body {
        display: flex;
        align-items: center;
        justify-content: center;
        text-align: center;
      }
      .wrap { padding: 24px; }
      .title { font-size: 28px; letter-spacing: 0.5px; margin-bottom: 10px; }
      .sub { font-size: 14px; opacity: 0.7; }
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

    kept.push({
      id,
      fileName: fileName || path.basename(absPath),
      relativePath,
      sizeBytes,
      createdAt
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

function appendUserDownloadRecord(username, { id, filePath, createdAt }) {
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
  entries.unshift({
    id,
    fileName: path.basename(filePath),
    relativePath,
    sizeBytes,
    createdAt
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

function postProcessArgs(type, codec) {
  const args = [];

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

  if (codec === "mov") {
    args.push("--recode-video", "mov");
    return args;
  }

  if (codec === "webm") {
    args.push("--recode-video", "webm");
    return args;
  }

  if (codec === "h264") {
    args.push("--recode-video", "mp4");
    args.push(
      "--postprocessor-args",
      type === "a+v" ? "ffmpeg:-c:v libx264 -c:a aac" : "ffmpeg:-c:v libx264"
    );
    return args;
  }

  if (codec === "h265") {
    args.push("--recode-video", "mp4");
    args.push(
      "--postprocessor-args",
      type === "a+v" ? "ffmpeg:-c:v libx265 -c:a aac" : "ffmpeg:-c:v libx265"
    );
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
    status: patch.status ?? job.status,
    message: patch.message ?? job.message,
    progress: patch.progress ?? job.progress,
    downloadUrl: patch.downloadUrl ?? job.downloadUrl,
    error: patch.error ?? job.error
  };

  job.status = next.status;
  job.message = next.message;
  job.progress = next.progress;
  job.downloadUrl = next.downloadUrl;
  job.error = next.error;

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
  const files = listFilesRecursive(dir);
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

function parseProgress(line) {
  const match = line.match(/\[download\]\s+([0-9]+(?:\.[0-9]+)?)%/i);
  if (!match) return null;
  const raw = Number(match[1]);
  if (!Number.isFinite(raw)) return null;
  return Math.max(0, Math.min(100, raw));
}

function handleYtDlpLine(job, line) {
  const text = line.trim();
  if (!text) return;

  const progress = parseProgress(text);
  if (progress !== null) {
    setJobState(job, {
      status: "running",
      message: `Downloading... ${progress.toFixed(1)}%`,
      progress
    });
    return;
  }

  if (text.includes("Destination:")) {
    setJobState(job, {
      status: "running",
      message: "Preparing output file..."
    });
    return;
  }

  if (
    text.includes("[Merger]") ||
    text.includes("[ExtractAudio]") ||
    text.includes("[VideoConvertor]") ||
    text.includes("[Fixup")
  ) {
    setJobState(job, {
      status: "processing",
      message: "Processing media..."
    });
    return;
  }

  if (text.includes("has already been downloaded")) {
    setJobState(job, {
      status: "processing",
      message: "Using existing downloaded media..."
    });
    return;
  }

  if (text.startsWith("ERROR:")) {
    setJobState(job, {
      status: "failed",
      message: "Download failed.",
      error: text.replace(/^ERROR:\s*/, "")
    });
  }
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
      error: null
    }
  };

  jobs.set(id, job);

  const format = formatSelector(type, quality, codec);
  const args = [
    "--no-playlist",
    "--newline",
    "-P",
    jobDir,
    "-o",
    "%(title).180B [%(id)s].%(ext)s",
    "-f",
    format,
    ...postProcessArgs(type, codec),
    url
  ];

  setJobState(job, {
    status: "running",
    message: "Starting yt-dlp...",
    progress: 0
  });

  const child = spawn("yt-dlp", args, {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"]
  });

  const stdoutReader = readline.createInterface({ input: child.stdout });
  const stderrReader = readline.createInterface({ input: child.stderr });

  stdoutReader.on("line", line => handleYtDlpLine(job, line));
  stderrReader.on("line", line => handleYtDlpLine(job, line));

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
    appendUserDownloadRecord(ownerUsername, {
      id,
      filePath,
      createdAt: job.createdAt
    });

    setJobState(job, {
      status: "completed",
      message: "Download ready.",
      progress: 100,
      downloadUrl: `/jobs/${id}/file`
    });

    setTimeout(() => {
      const existing = jobs.get(id);
      if (existing && existing.clients.size === 0 && Date.now() - existing.createdAt > 60 * 60 * 1000) {
        jobs.delete(id);
      }
    }, 60 * 60 * 1000);
  });

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

function pageForSession(req, res, pagePath) {
  const session = readValidSession(req);
  if (!session) {
    res.sendFile(LOGIN_HTML);
    return;
  }

  setSessionCookie(req, res, session.id);
  res.sendFile(pagePath);
}

function start() {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  fs.mkdirSync(USERS_DOWNLOADS_DIR, { recursive: true });
  loadAccountsFromDisk();
  loadAccessRequestsFromDisk();
  ensureBundle();

  const app = express();
  app.set("trust proxy", true);
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false, limit: "32kb" }));

  app.post("/auth/login", (req, res) => {
    const ip = getClientIp(req);
    const rate = checkLoginRate(ip);

    if (!rate.allowed) {
      res.status(429).json({ ok: false, error: rate.error });
      return;
    }

    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");
    const normalizedUsername = normalizeUsername(username);

    let sessionUsername = "";

    const activeAccount = findActiveAccountByUsername(normalizedUsername);
    if (activeAccount && verifyPasswordHash(password, activeAccount.passwordHash)) {
      sessionUsername = activeAccount.username;
    }

    if (
      !sessionUsername &&
      authConfigured() &&
      safeEqualString(username, AUTH_USERNAME) &&
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

  app.post("/auth/logout", (req, res) => {
    const cookies = parseCookies(req);
    const sessionId = cookies[SESSION_COOKIE];
    if (sessionId) sessions.delete(sessionId);
    clearSessionCookie(req, res);
    res.json({ ok: true });
  });

  app.post("/auth/request-access", async (req, res) => {
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

    res.send(renderCenteredResultPage("Allowed", "Tab will close in 5 seconds"));
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

    res.send(`<!doctype html><html><body><form method=\"POST\"><textarea name=\"reason\" rows=\"10\" cols=\"60\"></textarea><input type=\"hidden\" name=\"token\" value=\"${escapeHtml(token)}\" /><button type=\"submit\">Send</button></form></body></html>`);
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
    pageForSession(req, res, APP_HTML);
  });

  app.get("/history", (req, res) => {
    pageForSession(req, res, HISTORY_HTML);
  });

  app.get("/app.html", (req, res) => {
    pageForSession(req, res, APP_HTML);
  });

  app.get("/history.html", (req, res) => {
    pageForSession(req, res, HISTORY_HTML);
  });

  app.get("/login", (_req, res) => {
    res.sendFile(LOGIN_HTML);
  });

  app.use(express.static(PUBLIC_DIR, { index: false }));

  app.get("/api/downloads/history", requireAuth, (req, res) => {
    const status = getUserStorageStatus(req.auth.username);

    res.json({
      ok: true,
      entries: status.entries.map(entry => ({
        id: entry.id,
        fileName: entry.fileName,
        sizeBytes: entry.sizeBytes,
        createdAt: entry.createdAt,
        downloadUrl: `/api/downloads/file/${encodeURIComponent(entry.id)}`
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

  app.post("/download", requireAuth, (req, res) => {
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
      eventsUrl: `/jobs/${jobId}/events`
    });
  });

  app.get("/jobs/:id/events", requireAuth, (req, res) => {
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

  app.get("/jobs/:id/file", requireAuth, (req, res) => {
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

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  setInterval(cleanupStaleState, 5 * 60 * 1000).unref();

  app.listen(PORT, () => {
    console.log(`multi-downloader listening on http://localhost:${PORT}`);
    console.log(`session TTL: ${SESSION_TTL_HOURS}h`);
    console.log(`smtp: ${SMTP_HOST}:${SMTP_PORT} secure=${SMTP_SECURE}`);
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

start();
