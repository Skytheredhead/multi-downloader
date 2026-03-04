import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { backendFetch, backendUrl } from "./frontend-api";

const CONTROL_HEIGHT = 48;
const MAX_TASKS = 50;
const URL_CACHE_KEY = "md_cached_url";
const RETURNING_FROM_HISTORY_KEY = "md_from_history";

function Dropdown({ options, value, onChange, width = 120 }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const onMouseDown = event => {
      if (!ref.current?.contains(event.target)) setOpen(false);
    };

    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, []);

  return (
    <div
      ref={ref}
      className="control select-control"
      style={{ width, height: CONTROL_HEIGHT }}
    >
      <div className="control-head" onClick={() => setOpen(prev => !prev)}>
        <span>{value}</span>
        <span style={{ opacity: 0.72 }}>▾</span>
      </div>

      {open && (
        <div className="control-menu select-menu">
          {options.map(option => (
            <div
              key={option}
              className={`control-opt ${option === value ? "active" : ""}`}
              onClick={() => {
                onChange(option);
                setOpen(false);
              }}
            >
              {option}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function makeLocalId() {
  return `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function sourceLabelFromUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.replace(/^www\./i, "");
    const shortPath = parsed.pathname && parsed.pathname !== "/" ? parsed.pathname : "";
    const combined = `${host}${shortPath}`;
    return combined.length > 72 ? `${combined.slice(0, 69)}...` : combined;
  } catch {
    const fallback = String(rawUrl || "").trim();
    return fallback.length > 72 ? `${fallback.slice(0, 69)}...` : fallback;
  }
}

function cleanDisplayTitle(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  return value.replace(/\s+\[[A-Za-z0-9_-]{6,}\]\s*$/u, "").trim() || value;
}

function resolveThumbUrl(raw) {
  if (!raw) return null;
  const resolved = backendUrl(raw);
  return `${resolved}${resolved.includes("?") ? "&" : "?"}t=${Date.now()}`;
}

function isTerminalStatus(status) {
  return status === "completed" || status === "failed";
}

function stageLabel(status) {
  if (status === "queued") return "queued";
  if (status === "running") return "downloading";
  if (status === "processing") return "processing";
  if (status === "completed") return "done";
  if (status === "failed") return "error";
  return "queued";
}

function chipStylesFor(status) {
  if (status === "completed") {
    return {
      color: "#f2ecff",
      background: "rgba(255, 255, 255, 0.12)",
      border: "1px solid rgba(255, 255, 255, 0.2)"
    };
  }

  if (status === "failed") {
    return {
      color: "#ffd9e8",
      background: "rgba(140, 47, 85, 0.35)",
      border: "1px solid rgba(228, 118, 161, 0.44)"
    };
  }

  return {
    color: "#ffffff",
    background: "rgba(255,255,255,.1)",
    border: "1px solid rgba(255,255,255,.18)"
  };
}

function fillFor(status) {
  if (status === "completed") return "linear-gradient(90deg, #e7e2f3, #cbc1e2)";
  if (status === "failed") return "linear-gradient(90deg, #f0a2c1, #d66595)";
  return "linear-gradient(90deg, #f0eef7, #d8d0ea)";
}

function speedToMbpsText(rawSpeed) {
  const value = String(rawSpeed || "").trim();
  if (!value) return "";
  const match = value.match(/^([0-9]+(?:\.[0-9]+)?)\s*([KMGTP]?i?B)\/s$/i);
  if (!match) return value;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return value;
  const unit = String(match[2] || "B").toUpperCase();
  const scale = {
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
  const bytesPerSecond = amount * (scale[unit] || 1);
  const mbPerSecond = bytesPerSecond / (1000 * 1000);
  const decimals = mbPerSecond >= 100 ? 0 : mbPerSecond >= 10 ? 1 : 2;
  return `${mbPerSecond.toFixed(decimals)} MB/s`;
}

function normalizeErrorCode(input, fallback = "unknown_error") {
  const value = String(input || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return value ? value.slice(0, 96) : fallback;
}

function createCodedError(code, message = "") {
  const err = new Error(message || String(code || "error"));
  err.code = normalizeErrorCode(code);
  return err;
}

function looksLikeNoDownloadableMediaError(code) {
  const normalized = normalizeErrorCode(code || "");
  return (
    normalized.includes("no_downloadable_file_was_found") ||
    normalized.includes("no_downloadable_media_was_found")
  );
}

function canSendBugReportForCode(code) {
  return !looksLikeNoDownloadableMediaError(code);
}

function humanizeGenericCode(code) {
  const cleaned = normalizeErrorCode(code || "");
  if (!cleaned) return "Unknown error.";
  const words = cleaned
    .split("_")
    .filter(Boolean)
    .map(item => (item.length <= 3 ? item.toUpperCase() : item))
    .join(" ");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}.`;
}

function friendlyErrorMessage(code, rawMessage = "") {
  const normalized = normalizeErrorCode(code || rawMessage || "unknown_error");
  const rawNormalized = normalizeErrorCode(rawMessage || "");

  if (looksLikeNoDownloadableMediaError(normalized)) {
    return "No downloadable media was found for this link.";
  }

  if (
    normalized.includes("ssl_certificate_verify_failed") ||
    normalized.includes("certificate_verify_failed") ||
    rawNormalized.includes("ssl_certificate_verify_failed") ||
    rawNormalized.includes("certificate_verify_failed")
  ) {
    return "Secure connection check failed (SSL). Server cert store or system time may be wrong.";
  }

  const map = {
    stream_connection_lost: "Connection to live status was lost.",
    session_expired: "Session expired. Please log in again.",
    clear_storage_failed: "Couldn't clear storage automatically.",
    storage_limit_exceeded: "Storage limit exceeded. Clear storage and retry.",
    download_failed: "Download failed.",
    request_failed: "Request failed.",
    unknown_error: "Unknown error."
  };

  if (map[normalized]) return map[normalized];
  if (normalized.startsWith("http_429")) return "Too many requests. Please wait and try again.";
  if (normalized.startsWith("http_401")) return "Authentication required. Please log in.";
  return humanizeGenericCode(normalized);
}

export default function App() {
  const [type, setType] = useState("a+v");
  const [quality, setQuality] = useState("hq");
  const [url, setUrl] = useState("");
  const [lastSubmittedUrl, setLastSubmittedUrl] = useState("");
  const [jobs, setJobs] = useState([]);
  const [popup, setPopup] = useState("");
  const [vig, setVig] = useState({ top: false, bottom: false });
  const [suppressReentryAnim, setSuppressReentryAnim] = useState(false);

  const jobsRef = useRef([]);
  const popupTimer = useRef(null);
  const activeStreams = useRef(new Map());
  const urlInputRef = useRef(null);
  const actionLogRef = useRef([]);
  const suppressUntilRestoreRef = useRef(false);

  const hasItems = jobs.length > 0;
  const topGapHeight =
    jobs.length === 0
      ? "max(120px, calc(50vh - 150px))"
      : jobs.length === 1
        ? "max(118px, calc(46vh - 150px))"
        : jobs.length === 2
          ? "max(114px, calc(42vh - 150px))"
          : "max(108px, calc(38vh - 150px))";

  const autoCodecFor = (downloadType, selectedQuality) => {
    if (downloadType === "a") {
      return selectedQuality === "lq" ? "mp3 (128)" : "mp3 (320)";
    }
    return "h265";
  };

  const showPopup = message => {
    if (popupTimer.current) {
      clearTimeout(popupTimer.current);
      popupTimer.current = null;
    }

    setPopup(String(message || ""));

    popupTimer.current = setTimeout(() => {
      setPopup("");
      popupTimer.current = null;
    }, 2800);
  };

  const pushAction = (action, detail = "") => {
    const stamp = new Date().toISOString();
    const line = detail ? `${stamp} ${action} | ${detail}` : `${stamp} ${action}`;
    actionLogRef.current = [...actionLogRef.current, line].slice(-50);
  };

  const autoDownload = downloadUrl => {
    const anchor = document.createElement("a");
    anchor.href = downloadUrl;
    anchor.download = "";
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  };

  const closeStreamFor = cardId => {
    const stream = activeStreams.current.get(cardId);
    if (!stream) return;
    stream.close();
    activeStreams.current.delete(cardId);
  };

  const insertCard = card => {
    setJobs(prev => [card, ...prev]);
    requestAnimationFrame(() => {
      setJobs(prev => prev.map(item => (item.id === card.id ? { ...item, entered: true } : item)));
    });
  };

  const updateCard = (cardId, updater) => {
    setJobs(prev => prev.map(item => (item.id === cardId ? updater(item) : item)));
  };

  const resetCardForRetry = cardId => {
    closeStreamFor(cardId);
    updateCard(cardId, card => ({
      ...card,
      status: "queued",
      stageText: "queued",
      message: "Queued...",
      progress: 0,
      speed: null,
      eta: null,
      totalSize: null,
      thumbnailUrl: null,
      downloadUrl: null,
      serverId: null,
      errorCode: null,
      rawError: null,
      reportState: "idle"
    }));
  };

  const applyServerUpdate = (localCardId, serverId, updateRaw) => {
    const update = updateRaw && typeof updateRaw === "object" ? updateRaw : {};

    updateCard(localCardId, card => {
      const nextThumb =
        "thumbnailUrl" in update
          ? resolveThumbUrl(update.thumbnailUrl)
          : update.status === "completed" && card.serverId
            ? backendUrl(`/api/downloads/thumb/${encodeURIComponent(card.serverId)}?t=${Date.now()}`)
            : card.thumbnailUrl;

      const failedCode =
        update.status === "failed"
          ? normalizeErrorCode(update.error || "download_failed")
          : card.errorCode;
      const failedMessage =
        update.status === "failed"
          ? friendlyErrorMessage(failedCode, update.error || update.message || "")
          : null;
      const nextLabel = String(update.title || "").trim();

      return {
        ...card,
        label: nextLabel ? cleanDisplayTitle(nextLabel) : card.label,
        request: {
          url: String(update.url || card.request?.url || ""),
          type: String(update.type || card.request?.type || "a+v"),
          quality: String(update.quality || card.request?.quality || "hq"),
          codec: String(update.codec || card.request?.codec || autoCodecFor(type, quality))
        },
        status: update.status || card.status,
        stageText: stageLabel(update.status || card.status),
        message: failedMessage || (update.message || card.message),
        progress: typeof update.progress === "number" ? update.progress : card.progress,
        speed: "speed" in update ? update.speed : card.speed,
        eta: "eta" in update ? update.eta : card.eta,
        totalSize: "totalSize" in update ? update.totalSize : card.totalSize,
        thumbnailUrl: nextThumb,
        downloadUrl: update.downloadUrl ? backendUrl(update.downloadUrl) : card.downloadUrl,
        errorCode: failedCode,
        rawError: update.status === "failed" ? String(update.error || "") : card.rawError,
        reportState: update.status === "failed" ? "idle" : card.reportState
      };
    });

    if (update.status === "completed") {
      pushAction("download_completed", serverId);
      if (update.downloadUrl) autoDownload(update.downloadUrl);
      closeStreamFor(localCardId);
    }

    if (update.status === "failed") {
      pushAction("download_failed", normalizeErrorCode(update.error || "download_failed"));
      closeStreamFor(localCardId);
    }
  };

  const attachJobStream = (localCardId, serverId, eventsPath = "") => {
    closeStreamFor(localCardId);

    const stream = new EventSource(
      backendUrl(eventsPath || `/api/jobs/${serverId}/events`),
      { withCredentials: true }
    );
    pushAction("stream_open", serverId);
    activeStreams.current.set(localCardId, stream);

    stream.onmessage = event => {
      let update;
      try {
        update = JSON.parse(event.data);
      } catch {
        return;
      }
      applyServerUpdate(localCardId, serverId, update);
    };

    stream.onerror = () => {
      const code = "stream_connection_lost";
      updateCard(localCardId, card => ({
        ...card,
        status: "failed",
        stageText: "error",
        message: friendlyErrorMessage(code, "Live status connection lost."),
        errorCode: code,
        rawError: "Live status connection lost.",
        reportState: "idle"
      }));
      pushAction("stream_error", code);
      closeStreamFor(localCardId);
    };
  };

  const mapApiJobToCard = apiJob => {
    const serverId = String(apiJob.id || "").trim();
    const requestType = String(apiJob.type || "a+v");
    const requestQuality = String(apiJob.quality || "hq");
    const requestCodec = String(apiJob.codec || autoCodecFor(requestType, requestQuality));
    const status = String(apiJob.status || "queued");
    const errorCode = status === "failed" ? normalizeErrorCode(apiJob.error || "download_failed") : null;
    const labelRaw = String(apiJob.title || "").trim() || sourceLabelFromUrl(apiJob.url || "");

    return {
      id: `restored-${serverId}`,
      entered: true,
      label: cleanDisplayTitle(labelRaw),
      request: {
        url: String(apiJob.url || ""),
        type: requestType,
        quality: requestQuality,
        codec: requestCodec
      },
      serverId,
      status,
      stageText: stageLabel(status),
      message: status === "failed" ? friendlyErrorMessage(errorCode, apiJob.error || apiJob.message || "") : String(apiJob.message || ""),
      progress: Number(apiJob.progress || 0),
      speed: apiJob.speed || null,
      eta: apiJob.eta || null,
      totalSize: apiJob.totalSize || null,
      thumbnailUrl: resolveThumbUrl(apiJob.thumbnailUrl || ""),
      downloadUrl: apiJob.downloadUrl ? backendUrl(apiJob.downloadUrl) : null,
      errorCode,
      rawError: status === "failed" ? String(apiJob.error || "") : null,
      reportState: "idle",
      createdAt: Number(apiJob.createdAt || Date.now())
    };
  };

  const startDownloadFlow = async ({ request, reuseCardId = null }) => {
    const localCardId = reuseCardId || makeLocalId();
    const label = sourceLabelFromUrl(request.url);
    pushAction("download_submit", label);

    if (!reuseCardId && jobsRef.current.length >= MAX_TASKS) {
      showPopup(`you already have ${MAX_TASKS} downloads queued`);
      pushAction("download_rejected", "max_tasks_reached");
      return;
    }

    if (reuseCardId) {
      resetCardForRetry(reuseCardId);
    } else {
      insertCard({
        id: localCardId,
        entered: false,
        label,
        request,
        serverId: null,
        status: "queued",
        stageText: "queued",
        message: "Queued...",
        progress: 0,
        speed: null,
        eta: null,
        totalSize: null,
        thumbnailUrl: null,
        downloadUrl: null,
        errorCode: null,
        rawError: null,
        reportState: "idle",
        createdAt: Date.now()
      });
    }

    try {
      const resp = await backendFetch("download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request)
      });

      let payload = {};
      try {
        payload = await resp.json();
      } catch {
        payload = {};
      }

      if (resp.status === 401) {
        throw createCodedError("session_expired", "Session expired. Redirecting to login...");
      }

      if (payload.code === "STORAGE_LIMIT_EXCEEDED") {
        const shouldClear = window.confirm(
          "Storage cap exceeded (10GB). Clear storage now?"
        );

        if (shouldClear) {
          const clearResp = await backendFetch("downloads/clear", { method: "POST" });
          if (!clearResp.ok) {
            throw createCodedError("clear_storage_failed", "Failed to clear storage.");
          }
          showPopup("storage cleared; start download again");
          updateCard(localCardId, card => ({
            ...card,
            status: "failed",
            stageText: "error",
            message: "Storage was full. Retry started after clear.",
            progress: 0
          }));
          return;
        }
      }

      if (!resp.ok || !payload.ok || !payload.jobId) {
        throw createCodedError(
          payload.code || `http_${resp.status}`,
          payload.error || `Request failed (${resp.status})`
        );
      }

      const serverId = String(payload.jobId);
      pushAction("download_accepted", serverId);

      updateCard(localCardId, card => ({
        ...card,
        serverId,
        status: "queued",
        stageText: "queued",
        message: "Queued...",
        progress: 0
      }));

      attachJobStream(localCardId, serverId, payload.eventsUrl || `/api/jobs/${serverId}/events`);
    } catch (error) {
      const code = normalizeErrorCode(error?.code || error?.message || "request_failed");
      pushAction("request_failed", code);
      updateCard(localCardId, card => ({
        ...card,
        status: "failed",
        stageText: "error",
        message: friendlyErrorMessage(code, error?.message || ""),
        progress: 0,
        errorCode: code,
        rawError: String(error?.message || ""),
        reportState: "idle"
      }));
      if (code === "session_expired") {
        setTimeout(() => window.location.assign("/login"), 1200);
      }
    }
  };

  const triggerDownload = () => {
    const trimmedUrl = url.trim();
    const effectiveUrl = trimmedUrl || lastSubmittedUrl;
    if (!effectiveUrl) {
      showPopup("paste a link first");
      pushAction("download_rejected", "missing_url");
      return;
    }

    setLastSubmittedUrl(effectiveUrl);
    setUrl("");

    startDownloadFlow({
      request: {
        url: effectiveUrl,
        type,
        quality,
        codec: autoCodecFor(type, quality)
      }
    });
  };

  const retryCard = card => {
    if (!card?.request) return;
    pushAction("retry_clicked", card.errorCode || card.id);
    startDownloadFlow({ request: card.request, reuseCardId: card.id });
  };

  const downloadCardFile = card => {
    if (!card?.downloadUrl) return;
    pushAction("download_file_clicked", card.serverId || card.id);
    autoDownload(card.downloadUrl);
  };

  const sendBugReport = async card => {
    if (!card?.errorCode || card.reportState === "sending" || !canSendBugReportForCode(card.errorCode)) return;

    updateCard(card.id, current => ({
      ...current,
      reportState: "sending"
    }));

    pushAction("bug_report_send", card.errorCode);

    try {
      const resp = await backendFetch("report-bug", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          errorCode: card.errorCode,
          message: card.rawError || card.message || "",
          jobId: card.serverId || "",
          url: card.request?.url || "",
          type: card.request?.type || "",
          quality: card.request?.quality || "",
          codec: card.request?.codec || "",
          actions: actionLogRef.current.slice(-10)
        })
      });

      let payload = {};
      try {
        payload = await resp.json();
      } catch {
        payload = {};
      }

      if (!resp.ok || !payload.ok) {
        throw new Error(payload.error || `http_${resp.status}`);
      }

      updateCard(card.id, current => ({
        ...current,
        reportState: "sent"
      }));
      showPopup("bug report sent");
      pushAction("bug_report_sent", card.errorCode);
    } catch (error) {
      updateCard(card.id, current => ({
        ...current,
        reportState: "error"
      }));
      showPopup("bug report failed");
      pushAction("bug_report_failed", normalizeErrorCode(error?.message || "bug_report_failed"));
    }
  };

  const clearAllCards = () => {
    for (const stream of activeStreams.current.values()) {
      stream.close();
    }
    activeStreams.current.clear();
    setJobs([]);
    pushAction("cards_cleared");
  };

  const handleLogout = async () => {
    try {
      pushAction("logout_clicked");
      await backendFetch("auth/logout", { method: "POST" });
    } finally {
      window.location.assign("/");
    }
  };

  useEffect(() => {
    jobsRef.current = jobs;
  }, [jobs]);

  useEffect(() => {
    try {
      const cachedUrl = window.sessionStorage.getItem(URL_CACHE_KEY);
      if (cachedUrl) setUrl(cachedUrl);
      const fromHistory = window.sessionStorage.getItem(RETURNING_FROM_HISTORY_KEY) === "1";
      if (fromHistory) {
        setSuppressReentryAnim(true);
        suppressUntilRestoreRef.current = true;
        window.sessionStorage.removeItem(RETURNING_FROM_HISTORY_KEY);
      }
    } catch {
      // ignore storage errors
    }
    urlInputRef.current?.focus();
  }, []);

  useEffect(() => {
    try {
      window.sessionStorage.setItem(URL_CACHE_KEY, url);
    } catch {
      // ignore storage errors
    }
  }, [url]);

  useEffect(() => {
    const onPaste = event => {
      const targetTag = event.target?.tagName;
      if (targetTag === "INPUT" || targetTag === "TEXTAREA") return;
      const text = String(event.clipboardData?.getData("text") || "").trim();
      if (!/^https?:\/\//i.test(text)) return;
      event.preventDefault();
      setUrl(text);
      urlInputRef.current?.focus();
      pushAction("paste_url", sourceLabelFromUrl(text));
    };

    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const checkSession = async () => {
      try {
        const resp = await backendFetch("auth/session", { cache: "no-store" });
        if (!cancelled && resp.status === 401) {
          window.location.assign("/login");
        }
      } catch {
        // ignore transient network errors
      }
    };

    checkSession();
    const timer = setInterval(checkSession, 60 * 1000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const restoreJobs = async () => {
      try {
        const resp = await backendFetch("jobs", { cache: "no-store" });
        if (resp.status === 401) {
          window.location.assign("/login");
          return;
        }

        let payload = {};
        try {
          payload = await resp.json();
        } catch {
          payload = {};
        }

        if (!resp.ok || !payload.ok || !Array.isArray(payload.jobs)) {
          return;
        }

        if (cancelled) return;

        const restoredCards = payload.jobs
          .map(mapApiJobToCard)
          .filter(card => card.serverId);

        if (restoredCards.length === 0) return;

        setJobs(prev => {
          if (!prev.length) return restoredCards;

          const byServerId = new Map();
          for (const item of prev) {
            if (item.serverId) byServerId.set(item.serverId, item);
          }

          for (const card of restoredCards) {
            if (!byServerId.has(card.serverId)) {
              byServerId.set(card.serverId, card);
            }
          }

          const merged = Array.from(byServerId.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
          const locals = prev.filter(item => !item.serverId);
          return [...locals, ...merged];
        });

        requestAnimationFrame(() => {
          for (const card of restoredCards) {
            if (!isTerminalStatus(card.status)) {
              attachJobStream(card.id, card.serverId, `/api/jobs/${card.serverId}/events`);
            }
          }
        });
      } catch {
        // ignore hydration failures; live flows still work
      } finally {
        if (suppressUntilRestoreRef.current) {
          suppressUntilRestoreRef.current = false;
          requestAnimationFrame(() => setSuppressReentryAnim(false));
        }
      }
    };

    restoreJobs();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const updateVigs = () => {
      const doc = document.documentElement;
      const hasOverflow = doc.scrollHeight > window.innerHeight + 6;
      setVig({
        top: window.scrollY > 4,
        bottom: hasOverflow && window.scrollY + window.innerHeight < doc.scrollHeight - 4
      });
    };

    updateVigs();
    window.addEventListener("scroll", updateVigs, { passive: true });
    window.addEventListener("resize", updateVigs);

    return () => {
      window.removeEventListener("scroll", updateVigs);
      window.removeEventListener("resize", updateVigs);
    };
  }, [jobs.length]);

  useEffect(() => {
    return () => {
      if (popupTimer.current) clearTimeout(popupTimer.current);
      for (const stream of activeStreams.current.values()) {
        stream.close();
      }
      activeStreams.current.clear();
    };
  }, []);

  return (
    <>
      <div className={`md-page ${suppressReentryAnim ? "no-reentry-anim" : ""}`}>
        <button className="exit-icon" type="button" aria-label="Exit" title="Exit" onClick={handleLogout}>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 3h9v18H3z" />
            <circle cx="8" cy="8" r="1.4" fill="currentColor" stroke="none" />
            <path d="M8 10.2v3.1l1.8 2" />
            <path d="M21 12h-8" />
            <path d="M18 9l3 3-3 3" />
          </svg>
        </button>

        <div className="layout-shell">
          <div
            id="page-top-gap"
            style={{ height: topGapHeight }}
          />

          <div className={`main-controls ${jobs.length > 2 ? "up" : ""}`}>
            <div className="title-row">
              <div id="title">downloader</div>
            </div>

            <div className="controls-row">
              <Link
                href="/history"
                className="history-icon-btn"
                aria-label="Previous Downloads"
                title="Previous Downloads"
                onClick={() => {
                  try {
                    window.sessionStorage.setItem(URL_CACHE_KEY, url);
                    window.sessionStorage.setItem(RETURNING_FROM_HISTORY_KEY, "1");
                  } catch {
                    // ignore storage errors
                  }
                }}
              >
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 6h7l2 2h9v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z" />
                  <path d="M3 9h18" />
                </svg>
              </Link>

              <input
                ref={urlInputRef}
                value={url}
                onChange={event => setUrl(event.target.value)}
                onKeyDown={event => event.key === "Enter" && triggerDownload()}
                placeholder="Paste link..."
                className="control glass input-url"
                style={{ height: CONTROL_HEIGHT }}
              />

              <div className="stacked-control">
                <span className="control-label">Format</span>
                <Dropdown options={["a+v", "a", "v"]} value={type} onChange={setType} width={72} />
              </div>
              <div className="stacked-control">
                <span className="control-label">Quality</span>
                <Dropdown options={["hq", "mq", "lq"]} value={quality} onChange={setQuality} width={72} />
              </div>

              <button className="start-btn" type="button" onClick={triggerDownload}>
                <span style={{ fontSize: 16 }}>↓</span>
                <span>Download</span>
              </button>
            </div>
          </div>

          <div id="queue" className={`queue ${hasItems ? "show" : ""}`}>
            {jobs.map(job => {
              const chipStyle = chipStylesFor(job.status);
              const isRunning = job.status === "running";
              const etaChipText = job.eta ? `${job.eta} remaining` : "estimating...";
              const chipText = isRunning ? etaChipText : job.stageText;
              const speedText = isRunning ? speedToMbpsText(job.speed) : "";
              const showChip = job.status !== "completed";
              const showAction = job.status === "completed" || job.status === "failed";
              const actionTitle = job.status === "completed" ? "download" : "retry";
              const iconType =
                job.request?.type === "a" ? "audio" : job.request?.type === "v" ? "video" : "";
              const shouldOverlayTypeIcon = Boolean(iconType) && Boolean(job.thumbnailUrl);
              const sizeText =
                job.totalSize ||
                (job.status === "completed"
                  ? "available"
                  : job.status === "failed"
                    ? "-"
                    : "estimating...");

              return (
                <div
                  key={job.id}
                  className={`item-row ${job.entered ? "enter-active" : "enter-pre"}`}
                >
                  <div className={`glass card ${job.status === "completed" || job.status === "failed" ? "done" : ""}`}>
                    <div className="thumb-wrap-inline">
                      {job.thumbnailUrl ? (
                        <img
                          src={job.thumbnailUrl}
                          alt="thumbnail"
                          className={`thumb-inline ${shouldOverlayTypeIcon ? "thumb-inline-dimmed" : ""}`}
                          loading="lazy"
                          onError={event => {
                            event.currentTarget.style.display = "none";
                            const fallback = event.currentTarget.parentElement?.querySelector(".thumb-inline-fallback");
                            if (fallback) fallback.style.display = "grid";
                          }}
                        />
                      ) : null}
                      {shouldOverlayTypeIcon ? (
                        <div className="audio-note-badge" aria-hidden="true">
                          {iconType === "audio" ? (
                            <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M9 17a2 2 0 1 1-2-2 2 2 0 0 1 2 2z" />
                              <path d="M17 15a2 2 0 1 1-2-2 2 2 0 0 1 2 2z" />
                              <path d="M9 17V7l8-2v10" />
                            </svg>
                          ) : (
                            <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                              <rect x="3" y="5" width="18" height="14" rx="2.4" />
                              <path d="M8 3v4" />
                              <path d="M16 3v4" />
                              <path d="M3 10h18" />
                            </svg>
                          )}
                        </div>
                      ) : null}
                      <div className="thumb-inline-fallback" style={{ display: job.thumbnailUrl ? "none" : "grid" }}>
                        {job.status === "completed" ? "No thumbnail" : "Preview pending"}
                      </div>
                    </div>

                    <div className="card-main">
                      <div className="item-head">
                        <div className="filename" title={cleanDisplayTitle(job.label)}>{cleanDisplayTitle(job.label)}</div>
                        {showChip && <span className="chip" style={chipStyle}>{chipText}</span>}
                      </div>

                      <div className="subline">
                        <span className="subline-main">{job.message || " "}</span>
                        {speedText ? <span className="subline-speed">{speedText}</span> : null}
                      </div>
                      {job.status === "failed" && job.errorCode && canSendBugReportForCode(job.errorCode) ? (
                        <div className="error-tools">
                          <button
                            type="button"
                            className="bug-report-btn"
                            disabled={job.reportState === "sending" || job.reportState === "sent"}
                            onClick={() => sendBugReport(job)}
                          >
                            {job.reportState === "sending"
                              ? "sending..."
                              : job.reportState === "sent"
                                ? "report sent"
                                : "send bug report"}
                          </button>
                        </div>
                      ) : null}

                      <div className="stats">
                        <span>Size: {sizeText}</span>
                      </div>

                      <div className="bar">
                        <div
                          className="bar-fill"
                          style={{
                            width: `${Math.max(0, Math.min(100, Number(job.progress) || 0))}%`,
                            background: fillFor(job.status)
                          }}
                        />
                      </div>
                    </div>
                  </div>

                  <button
                    className={`dl-pad ${showAction ? "show" : ""}`}
                    type="button"
                    title={actionTitle}
                    onClick={() => (job.status === "completed" ? downloadCardFile(job) : retryCard(job))}
                  >
                    {job.status === "completed" ? (
                      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M12 3v11" />
                        <path d="M8 10l4 4 4-4" />
                        <path d="M4 19h16" />
                      </svg>
                    ) : (
                      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M3 12a9 9 0 1 0 3-6.7" />
                        <path d="M3 4v5h5" />
                      </svg>
                    )}
                  </button>
                </div>
              );
            })}
          </div>

          <button id="clear-btn" className={hasItems ? "show" : ""} type="button" onClick={clearAllCards}>
            clear all
          </button>

          <div id="queue-bottom-pad" />
        </div>

        <div id="top-vig" style={{ opacity: vig.top ? 1 : 0 }} />
        <div id="bot-vig" style={{ opacity: vig.bottom ? 1 : 0 }} />

        <div className="version-pill">v0.1</div>

        {popup && (
          <div className="popup-card glass">
            {popup}
          </div>
        )}
      </div>

      <style jsx global>{`
        .md-page {
          min-height: 100vh;
          position: relative;
          overflow-x: hidden;
          background: transparent;
          color: #e7ecef;
          font-family: var(--font-ui);
        }

        .glass {
          background: rgba(18, 11, 31, 0.58);
          backdrop-filter: blur(12px) saturate(110%);
          -webkit-backdrop-filter: blur(12px) saturate(110%);
          border: 1px solid rgba(255, 255, 255, 0.07);
          box-shadow: 0 8px 26px rgba(0, 0, 0, 0.28);
        }

        .layout-shell {
          width: min(92vw, 760px);
          margin: 0 auto;
          display: flex;
          flex-direction: column;
          align-items: stretch;
          position: relative;
          overflow: visible;
          z-index: 2;
        }

        #page-top-gap,
        #queue-bottom-pad {
          flex-shrink: 0;
          transition: height 0.4s ease;
        }

        #queue-bottom-pad {
          height: 70px;
        }

        .main-controls {
          position: relative;
          z-index: 14;
          transition: transform 0.35s ease;
        }

        .main-controls.up {
          transform: translateY(-10px);
        }

        .title-row {
          min-height: 34px;
          margin-bottom: 16px;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        #title {
          font-size: 34px;
          line-height: 1;
          letter-spacing: 0.9px;
          margin: 0;
          text-shadow: 0 8px 40px rgba(0, 0, 0, 0.45);
          color: #f2edff;
          font-family: var(--font-display);
          font-weight: 600;
          text-transform: lowercase;
        }

        .history-icon-btn {
          width: 48px;
          height: 48px;
          border-radius: 10px;
          text-decoration: none;
          color: #efe7ff;
          background: rgba(255, 255, 255, 0.12);
          border: 1px solid rgba(255, 255, 255, 0.16);
          display: inline-grid;
          place-items: center;
          align-items: center;
          transition: transform 0.16s ease, background 0.16s ease;
        }

        .history-icon-btn:hover {
          transform: translateY(-1px);
          background: rgba(255, 255, 255, 0.2);
        }

        .controls-row {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
          overflow: visible;
          width: 100%;
          align-items: flex-end;
        }

        .control {
          position: relative;
          border-radius: 10px;
          color: #efe7ff;
        }

        .input-url {
          flex: 1 1 320px;
          min-width: 220px;
          padding: 0 13px;
          font-size: 14px;
          outline: none;
        }

        .stacked-control {
          display: flex;
          flex-direction: column;
          gap: 4px;
          align-items: flex-start;
        }

        .control-label {
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.55px;
          color: rgba(233, 224, 248, 0.8);
          padding-left: 2px;
        }

        .control-head {
          height: 100%;
          padding: 0 12px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          font-size: 14px;
          cursor: pointer;
        }

        .control.select-control {
          background: rgba(20, 13, 34, 0.96);
          border: 1px solid rgba(255, 255, 255, 0.16);
          backdrop-filter: none;
          -webkit-backdrop-filter: none;
        }

        .control-menu {
          position: absolute;
          top: calc(100% + 4px);
          left: 0;
          right: 0;
          border-radius: 10px;
          overflow: hidden;
          z-index: 120;
        }

        .control-menu.select-menu {
          background: rgba(20, 13, 34, 0.98);
          border: 1px solid rgba(255, 255, 255, 0.16);
          backdrop-filter: none;
          -webkit-backdrop-filter: none;
        }

        .control-opt {
          padding: 10px 12px;
          font-size: 14px;
          background: transparent;
        }

        .control-opt:hover {
          background: rgba(255, 255, 255, 0.08);
        }

        .control-opt.active {
          background: rgba(120, 89, 180, 0.32);
        }

        .start-btn {
          min-width: 114px;
          height: 48px;
          border-radius: 10px;
          background: rgba(233, 224, 250, 0.28);
          border: 1px solid rgba(255, 255, 255, 0.2);
          color: #fff;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          cursor: pointer;
          font-size: 13px;
          font-weight: 600;
          transition: transform 0.16s ease, background 0.16s ease, box-shadow 0.16s ease;
        }

        .start-btn:hover {
          transform: translateY(-1px);
          background: rgba(242, 235, 255, 0.38);
          box-shadow: 0 10px 24px rgba(0, 0, 0, 0.22);
        }

        .exit-icon {
          position: fixed;
          top: 14px;
          right: 14px;
          border: 0;
          background: transparent;
          color: rgba(245, 239, 255, 0.84);
          padding: 0;
          width: 24px;
          height: 24px;
          cursor: pointer;
          transition: color 0.15s ease, transform 0.15s ease;
          z-index: 20;
        }

        .exit-icon:hover {
          color: #ffffff;
          transform: translateY(-1px);
        }

        .queue {
          position: relative;
          z-index: 4;
          width: 100%;
          display: flex;
          flex-direction: column;
          margin-top: 34px;
          gap: 14px;
          opacity: 0;
          transform: translateY(8px);
          transition: opacity 0.25s ease, transform 0.25s ease;
        }

        .queue.show {
          opacity: 1;
          transform: translateY(0);
        }

        .item-row {
          position: relative;
          padding-right: 84px;
        }

        .enter-pre {
          opacity: 0;
          transform: translateY(8px);
        }

        .enter-active {
          opacity: 1;
          transform: translateY(0);
          transition: transform 0.35s ease-in-out, opacity 0.35s ease-in-out;
        }

        .card {
          position: relative;
          border-radius: 12px;
          padding: 12px 14px;
          background: rgba(15, 10, 26, 0.76);
          display: grid;
          grid-template-columns: 154px 1fr;
          gap: 10px;
          align-items: center;
          transition: background 0.2s ease;
        }

        .card.done {
          background: rgba(18, 12, 32, 0.8);
        }

        .thumb-wrap-inline {
          position: relative;
          width: 154px;
          aspect-ratio: 16 / 9;
          border-radius: 9px;
          overflow: hidden;
          background: rgba(0, 0, 0, 0.3);
          border: 1px solid rgba(255, 255, 255, 0.12);
        }

        .thumb-inline {
          width: 100%;
          height: 100%;
          object-fit: cover;
          display: block;
          filter: none;
        }

        .thumb-inline-dimmed {
          filter: brightness(0.56);
        }

        .audio-note-badge {
          position: absolute;
          left: 50%;
          top: 50%;
          transform: translate(-50%, -50%);
          width: 40px;
          height: 40px;
          color: rgba(242, 242, 247, 0.95);
          display: grid;
          place-items: center;
          filter: drop-shadow(0 2px 1px rgba(0, 0, 0, 0.78))
            drop-shadow(0 0 8px rgba(0, 0, 0, 0.48));
          pointer-events: none;
        }

        .thumb-inline-fallback {
          position: absolute;
          inset: 0;
          place-items: center;
          text-align: center;
          font-size: 11px;
          padding: 6px;
          color: #d9cceb;
          background: linear-gradient(145deg, rgba(24, 15, 40, 0.76), rgba(16, 11, 30, 0.82));
        }

        .card-main {
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 7px;
        }

        .item-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
        }

        .filename {
          font-size: 13px;
          color: var(--txt-main, #e7ecef);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          min-width: 0;
        }

        .chip {
          font-size: 11px;
          padding: 3px 8px;
          border-radius: 999px;
          white-space: nowrap;
        }

        .subline {
          min-height: 16px;
          font-size: 12px;
          color: #ddd2ee;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
        }

        .subline-main {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .subline-speed {
          flex-shrink: 0;
          color: #efe7ff;
          opacity: 0.92;
        }

        .error-tools {
          margin-top: 2px;
          display: flex;
          justify-content: flex-start;
        }

        .bug-report-btn {
          border: 1px solid rgba(255, 255, 255, 0.2);
          background: rgba(255, 255, 255, 0.08);
          color: #efe7ff;
          font-size: 11px;
          height: 24px;
          border-radius: 7px;
          padding: 0 9px;
          cursor: pointer;
          transition: background 0.15s ease, opacity 0.15s ease;
        }

        .bug-report-btn:hover:not(:disabled) {
          background: rgba(255, 255, 255, 0.15);
        }

        .bug-report-btn:disabled {
          opacity: 0.7;
          cursor: not-allowed;
        }

        .stats {
          display: flex;
          gap: 8px;
          font-size: 11px;
          color: #d9cceb;
        }

        .bar {
          height: 10px;
          background: rgba(255, 255, 255, 0.08);
          border-radius: 999px;
          overflow: hidden;
        }

        .bar-fill {
          height: 100%;
          width: 0%;
          will-change: width;
          transition: width 0.2s ease;
        }

        .dl-pad {
          position: absolute;
          right: 12px;
          top: 50%;
          width: 56px;
          height: 56px;
          border-radius: 14px;
          background: rgba(255, 255, 255, 0.95);
          border: 1px solid rgba(255, 255, 255, 0.28);
          color: #17141f;
          display: flex;
          align-items: center;
          justify-content: center;
          box-shadow: 0 8px 20px rgba(0, 0, 0, 0.28);
          opacity: 0;
          transform: translateX(-10px) translateY(-50%);
          transition: opacity 0.42s ease, transform 0.42s ease, box-shadow 0.2s ease;
          pointer-events: none;
        }

        .dl-pad.show {
          opacity: 1;
          transform: translateX(0) translateY(-50%);
          pointer-events: auto;
          cursor: pointer;
        }

        .dl-pad.show:hover {
          box-shadow: 0 12px 30px rgba(0, 0, 0, 0.35);
        }

        #clear-btn {
          margin-top: 34px;
          align-self: center;
          background: transparent;
          border: 0;
          color: #ffffff;
          text-decoration: underline;
          cursor: pointer;
          opacity: 0;
          transition: opacity 0.25s ease;
          pointer-events: none;
        }

        #clear-btn.show {
          opacity: 1;
          pointer-events: auto;
        }

        #top-vig,
        #bot-vig {
          pointer-events: none;
          position: fixed;
          left: 0;
          right: 0;
          height: 120px;
          background: linear-gradient(
            to bottom,
            rgba(0, 0, 0, 0.42) 0%,
            rgba(0, 0, 0, 0.28) 28%,
            rgba(0, 0, 0, 0.14) 58%,
            rgba(0, 0, 0, 0) 100%
          );
          opacity: 0;
          transition: opacity 0.32s ease;
          z-index: 8;
        }

        #top-vig {
          top: 0;
        }

        #bot-vig {
          bottom: 0;
          transform: rotate(180deg);
        }

        .version-pill {
          position: fixed;
          right: 12px;
          bottom: 10px;
          opacity: 0.55;
          font-size: 12px;
          letter-spacing: 0.2px;
          color: #f3edff;
          z-index: 20;
        }

        .popup-card {
          position: fixed;
          top: 14px;
          right: 62px;
          padding: 8px 12px;
          border-radius: 10px;
          font-size: 12px;
          color: #efe7ff;
          z-index: 25;
        }

        .md-page.no-reentry-anim .queue,
        .md-page.no-reentry-anim .queue.show,
        .md-page.no-reentry-anim .main-controls,
        .md-page.no-reentry-anim .main-controls.up,
        .md-page.no-reentry-anim .enter-pre,
        .md-page.no-reentry-anim .enter-active {
          transition: none !important;
          animation: none !important;
          transform: none !important;
          opacity: 1 !important;
        }

        .control:focus-within,
        .start-btn:focus-visible,
        .history-icon-btn:focus-visible,
        .exit-icon:focus-visible,
        .dl-pad:focus-visible,
        #clear-btn:focus-visible {
          outline: 2px solid rgba(223, 205, 255, 0.75);
          outline-offset: 2px;
        }

        @media (max-width: 700px) {
          #title {
            font-size: 29px;
          }

          .title-row {
            min-height: 0;
            margin-bottom: 12px;
          }

          .card {
            grid-template-columns: 1fr;
            gap: 9px;
          }

          .stacked-control {
            min-width: 72px;
          }

          .thumb-wrap-inline {
            width: 100%;
          }

          .item-row {
            padding-right: 0;
          }

          .dl-pad {
            position: relative;
            inset: auto;
            transform: none;
            margin-top: 8px;
            width: 100%;
            height: 44px;
            border-radius: 10px;
          }

          .dl-pad.show {
            transform: none;
          }
        }
      `}</style>
    </>
  );
}
