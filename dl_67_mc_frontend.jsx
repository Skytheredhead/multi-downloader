import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { backendFetch, backendUrl } from "./frontend-api";

const CONTROL_HEIGHT = 48;
const MAX_TASKS = 50;

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
      className="control glass"
      style={{ width, height: CONTROL_HEIGHT }}
    >
      <div className="control-head" onClick={() => setOpen(prev => !prev)}>
        <span>{value}</span>
        <span style={{ opacity: 0.72 }}>▾</span>
      </div>

      {open && (
        <div className="control-menu glass">
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

export default function App() {
  const [type, setType] = useState("a+v");
  const [quality, setQuality] = useState("hq");
  const [url, setUrl] = useState("");
  const [jobs, setJobs] = useState([]);
  const [popup, setPopup] = useState("");
  const [statusLine, setStatusLine] = useState("");
  const [vig, setVig] = useState({ top: false, bottom: false });

  const jobsRef = useRef([]);
  const popupTimer = useRef(null);
  const activeStreams = useRef(new Map());
  const urlInputRef = useRef(null);

  const hasItems = jobs.length > 0;
  const topGapHeight =
    jobs.length === 0
      ? "max(110px, calc(48vh - 130px))"
      : jobs.length === 1
        ? "max(110px, calc(43vh - 130px))"
        : jobs.length === 2
          ? "max(98px, calc(34vh - 130px))"
          : "120px";

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
      serverId: null
    }));
  };

  const startDownloadFlow = async ({ request, reuseCardId = null }) => {
    const localCardId = reuseCardId || makeLocalId();
    const label = sourceLabelFromUrl(request.url);

    if (!reuseCardId && jobsRef.current.length >= MAX_TASKS) {
      showPopup(`you already have ${MAX_TASKS} downloads queued`);
      return;
    }

    if (reuseCardId) {
      resetCardForRetry(reuseCardId);
    } else {
      setStatusLine("Queued...");
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
        throw new Error("Session expired. Redirecting to login...");
      }

      if (payload.code === "STORAGE_LIMIT_EXCEEDED") {
        const shouldClear = window.confirm(
          "Storage cap exceeded (10GB). Clear storage now?"
        );

        if (shouldClear) {
          const clearResp = await backendFetch("downloads/clear", { method: "POST" });
          if (!clearResp.ok) {
            throw new Error("Failed to clear storage.");
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
        throw new Error(payload.error || `Request failed (${resp.status})`);
      }

      const serverId = String(payload.jobId);

      updateCard(localCardId, card => ({
        ...card,
        serverId,
        status: "queued",
        stageText: "queued",
        message: "Queued...",
        progress: 0
      }));

      closeStreamFor(localCardId);

      const stream = new EventSource(
        backendUrl(payload.eventsUrl || `/api/jobs/${serverId}/events`),
        { withCredentials: true }
      );
      activeStreams.current.set(localCardId, stream);

      stream.onmessage = event => {
        let update;
        try {
          update = JSON.parse(event.data);
        } catch {
          return;
        }

        updateCard(localCardId, card => {
          const nextThumb =
            "thumbnailUrl" in update
              ? update.thumbnailUrl
                ? (() => {
                  const resolved = backendUrl(update.thumbnailUrl);
                  return `${resolved}${resolved.includes("?") ? "&" : "?"}t=${Date.now()}`;
                })()
                : null
              : update.status === "completed" && card.serverId
                ? backendUrl(`/api/downloads/thumb/${encodeURIComponent(card.serverId)}?t=${Date.now()}`)
                : card.thumbnailUrl;

          return {
            ...card,
            status: update.status || card.status,
            stageText: stageLabel(update.status || card.status),
            message: update.error
              ? `${update.message || "Download failed."} ${update.error}`.trim()
              : update.message || card.message,
            progress: typeof update.progress === "number" ? update.progress : card.progress,
            speed: "speed" in update ? update.speed : card.speed,
            eta: "eta" in update ? update.eta : card.eta,
            totalSize: "totalSize" in update ? update.totalSize : card.totalSize,
            thumbnailUrl: nextThumb,
            downloadUrl: update.downloadUrl ? backendUrl(update.downloadUrl) : card.downloadUrl
          };
        });

        if (update.status === "queued") setStatusLine("Queued...");
        if (update.status === "running") setStatusLine("Downloading...");
        if (update.status === "processing") setStatusLine("Processing...");
        if (update.status === "completed") setStatusLine("Done");
        if (update.status === "failed") setStatusLine("Failed");

        if (update.status === "completed") {
          if (update.downloadUrl) autoDownload(update.downloadUrl);
          closeStreamFor(localCardId);
        }

        if (update.status === "failed") {
          closeStreamFor(localCardId);
        }
      };

      stream.onerror = () => {
        updateCard(localCardId, card => ({
          ...card,
          status: "failed",
          stageText: "error",
          message: "Live status connection lost."
        }));
        setStatusLine("Connection lost");
        closeStreamFor(localCardId);
      };
    } catch (error) {
      updateCard(localCardId, card => ({
        ...card,
        status: "failed",
        stageText: "error",
        message: String(error?.message || "Download request failed."),
        progress: 0
      }));
      setStatusLine("Request failed");

      if (String(error?.message || "").startsWith("Session expired")) {
        setTimeout(() => window.location.assign("/login"), 1200);
      }
    }
  };

  const triggerDownload = () => {
    const trimmedUrl = url.trim();
    if (!trimmedUrl) {
      showPopup("paste a link first");
      return;
    }

    startDownloadFlow({
      request: {
        url: trimmedUrl,
        type,
        quality,
        codec: autoCodecFor(type, quality)
      }
    });
  };

  const retryCard = card => {
    if (!card?.request) return;
    startDownloadFlow({ request: card.request, reuseCardId: card.id });
  };

  const downloadCardFile = card => {
    if (!card?.downloadUrl) return;
    autoDownload(card.downloadUrl);
  };

  const clearAllCards = () => {
    for (const stream of activeStreams.current.values()) {
      stream.close();
    }
    activeStreams.current.clear();
    setJobs([]);
  };

  const handleLogout = async () => {
    try {
      await backendFetch("auth/logout", { method: "POST" });
    } finally {
      window.location.assign("/");
    }
  };

  useEffect(() => {
    jobsRef.current = jobs;
  }, [jobs]);

  useEffect(() => {
    urlInputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onPaste = event => {
      const targetTag = event.target?.tagName;
      if (targetTag === "INPUT" || targetTag === "TEXTAREA") return;
      const text = String(event.clipboardData?.getData("text") || "").trim();
      if (!/^https?:\/\//i.test(text)) return;
      event.preventDefault();
      setUrl(text);
      urlInputRef.current?.focus();
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
      <div className="md-page">
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
              <Link href="/history" className="history-icon-btn" aria-label="Previous Downloads" title="Previous Downloads">
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
            {statusLine ? <div className="row-status">{statusLine}</div> : null}
          </div>

          <div id="queue" className={`queue ${hasItems ? "show" : ""}`}>
            {jobs.map(job => {
              const chipStyle = chipStylesFor(job.status);
              const showChip = job.status !== "completed";
              const showAction = job.status === "completed" || job.status === "failed";
              const actionTitle = job.status === "completed" ? "download" : "retry";
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
                          className="thumb-inline"
                          loading="lazy"
                          onError={event => {
                            event.currentTarget.style.display = "none";
                            const fallback = event.currentTarget.parentElement?.querySelector(".thumb-inline-fallback");
                            if (fallback) fallback.style.display = "grid";
                          }}
                        />
                      ) : null}
                      <div className="thumb-inline-fallback" style={{ display: job.thumbnailUrl ? "none" : "grid" }}>
                        {job.status === "completed" ? "No thumbnail" : "Preview pending"}
                      </div>
                    </div>

                    <div className="card-main">
                      <div className="item-head">
                        <div className="filename" title={job.label}>{job.label}</div>
                        {showChip && <span className="chip" style={chipStyle}>{job.stageText}</span>}
                      </div>

                      <div className="subline">{job.message || " "}</div>

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
          background: rgba(25, 15, 41, 0.62);
          backdrop-filter: blur(12px) saturate(110%);
          -webkit-backdrop-filter: blur(12px) saturate(110%);
          border: 1px solid rgba(255, 255, 255, 0.08);
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

        .control-menu {
          position: absolute;
          top: calc(100% + 4px);
          left: 0;
          right: 0;
          border-radius: 10px;
          overflow: hidden;
          z-index: 30;
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
          width: 100%;
          display: flex;
          flex-direction: column;
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
          display: grid;
          grid-template-columns: 154px 1fr;
          gap: 10px;
          align-items: center;
          transition: background 0.2s ease;
        }

        .card.done {
          background: rgba(58, 40, 83, 0.72);
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
          filter: grayscale(1) sepia(0.32) hue-rotate(232deg) saturate(1.6) contrast(1.06) brightness(0.9);
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
          margin-top: 14px;
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

        .row-status {
          margin-top: 8px;
          min-height: 16px;
          font-size: 12px;
          color: rgba(228, 216, 248, 0.86);
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
