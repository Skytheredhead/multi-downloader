const DEFAULT_BACKEND_API_PATH = "/api";
const DEFAULT_PRODUCTION_BACKEND_API_BASE = "https://dlapi.67mc.org/api";

function stripTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function parseOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

function runtimeApiBase() {
  if (process.env.NEXT_PUBLIC_BACKEND_API_BASE) {
    return process.env.NEXT_PUBLIC_BACKEND_API_BASE;
  }

  if (typeof window !== "undefined" && window.location?.hostname) {
    const host = window.location.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1") {
      return `${window.location.origin}${DEFAULT_BACKEND_API_PATH}`;
    }

    if (host === "dl.67mc.org" || host === "www.dl.67mc.org" || host.endsWith(".vercel.app")) {
      return DEFAULT_PRODUCTION_BACKEND_API_BASE;
    }
  }

  if (typeof window !== "undefined" && window.location?.origin) {
    return `${window.location.origin}${DEFAULT_BACKEND_API_PATH}`;
  }
  return DEFAULT_BACKEND_API_PATH;
}

export const BACKEND_API_BASE = stripTrailingSlash(runtimeApiBase());

export const BACKEND_ORIGIN = parseOrigin(BACKEND_API_BASE);

export function apiUrl(path) {
  const clean = String(path || "").replace(/^\/+/, "");
  return `${BACKEND_API_BASE}/${clean}`;
}

export function backendUrl(rawPath) {
  const value = String(rawPath || "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  if (!BACKEND_ORIGIN) return value;
  if (value.startsWith("/")) return `${BACKEND_ORIGIN}${value}`;
  return `${BACKEND_ORIGIN}/${value}`;
}

export function backendFetch(path, init = {}) {
  return fetch(apiUrl(path), {
    ...init,
    credentials: "include"
  });
}
