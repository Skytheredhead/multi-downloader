import { useEffect, useState } from "react";

const RETENTION_DAYS = 7;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
}

function formatDate(ts) {
  const value = Number(ts || 0);
  if (!value) return "Unknown";
  return new Date(value).toLocaleString();
}

function daysRemaining(ts) {
  const createdAt = Number(ts || 0);
  if (!createdAt) return 0;
  const remaining = RETENTION_MS - (Date.now() - createdAt);
  if (remaining <= 0) return 0;
  return Math.ceil(remaining / (24 * 60 * 60 * 1000));
}

export default function HistoryPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [entries, setEntries] = useState([]);
  const [usageBytes, setUsageBytes] = useState(0);
  const [capBytes, setCapBytes] = useState(10 * 1024 * 1024 * 1024);

  const storagePercent = capBytes > 0 ? Math.min(100, Math.round((usageBytes / capBytes) * 100)) : 0;

  const loadHistory = async () => {
    setLoading(true);
    setError("");

    try {
      const resp = await fetch("/api/downloads/history");

      if (resp.status === 401) {
        window.location.assign("/login");
        return;
      }

      const payload = await resp.json();
      if (String(payload?.error || "").toLowerCase().includes("authentication required")) {
        window.location.assign("/login");
        return;
      }
      if (!resp.ok || !payload.ok) {
        throw new Error(payload.error || "Failed to load history.");
      }

      setEntries(Array.isArray(payload.entries) ? payload.entries : []);
      setUsageBytes(Number(payload.usageBytes || 0));
      setCapBytes(Number(payload.capBytes || 10 * 1024 * 1024 * 1024));

      if (payload.exceedsCap) {
        const doClear = window.confirm(
          `Storage cap exceeded (${formatBytes(payload.usageBytes)} / ${formatBytes(payload.capBytes)}). Clear storage now?`
        );
        if (doClear) {
          await clearAll(true);
        }
      }
    } catch (err) {
      setError(err.message || "Failed to load history.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadHistory();
  }, []);

  const clearAll = async (skipConfirm = false) => {
    if (!skipConfirm) {
      const confirmed = window.confirm("Clear all downloads for this account?");
      if (!confirmed) return;
    }

    try {
      const resp = await fetch("/api/downloads/clear", { method: "POST" });

      if (resp.status === 401) {
        window.location.assign("/login");
        return;
      }

      const payload = await resp.json();
      if (String(payload?.error || "").toLowerCase().includes("authentication required")) {
        window.location.assign("/login");
        return;
      }
      if (!resp.ok || !payload.ok) {
        throw new Error(payload.error || "Failed to clear downloads.");
      }

      await loadHistory();
    } catch (err) {
      setError(err.message || "Failed to clear downloads.");
    }
  };

  const logout = async () => {
    try {
      await fetch("/auth/logout", { method: "POST" });
    } finally {
      window.location.assign("/");
    }
  };

  return (
    <div className="history-page">
      <button className="exit-btn" type="button" aria-label="Exit" title="Exit" onClick={logout}>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 3h9v18H3z" />
          <circle cx="8" cy="8" r="1.4" fill="currentColor" stroke="none" />
          <path d="M8 10.2v3.1l1.8 2" />
          <path d="M21 12h-8" />
          <path d="M18 9l3 3-3 3" />
        </svg>
      </button>

      <div className="history-main">
        <div className="history-shell">
          <div className="history-head">
            <button className="back-btn" type="button" onClick={() => window.location.assign("/")} aria-label="Back" title="Back">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </button>
            <div className="history-title">Previous</div>
          </div>

          {error && <div className="error-chip">{error}</div>}

          {loading ? (
            <div className="empty-state">Loading...</div>
          ) : entries.length === 0 ? (
            <div className="empty-state">No downloads in the past 7 days.</div>
          ) : (
            <div className="history-list">
              {entries.map(entry => (
                <div key={entry.id} className="history-item">
                  <div className="thumb-wrap">
                    <img
                      src={entry.thumbnailUrl}
                      alt="thumbnail"
                      className="thumb"
                      loading="lazy"
                      onError={event => {
                        event.currentTarget.style.display = "none";
                        const fallback = event.currentTarget.parentElement?.querySelector(".thumb-fallback");
                        if (fallback) fallback.style.display = "grid";
                      }}
                    />
                    <div className="thumb-fallback">No Thumbnail</div>
                  </div>

                  <div className="meta-col">
                    <div className="file-title">{entry.fileName || "Untitled"}</div>
                    <div className="meta-row">Size: {formatBytes(entry.sizeBytes)}</div>
                    <div className="meta-row">Downloaded: {formatDate(entry.createdAt)}</div>
                    <div className="meta-row">Days Remaining: {daysRemaining(entry.createdAt)}</div>
                  </div>

                  <div className="item-actions">
                    <a href={entry.downloadUrl} className="item-action">Download</a>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="bottom-controls">
            <button className="clear-btn" onClick={() => clearAll()}>Clear All</button>
            <div className="storage-chip">
              <div className="storage-text">Storage: {storagePercent}%</div>
              <div className="storage-bar">
                <div className="storage-fill" style={{ width: `${storagePercent}%` }} />
              </div>
            </div>
          </div>
        </div>
      </div>

      <style jsx global>{`
        .history-page {
          min-height: 100vh;
          position: relative;
          padding: 84px 16px 52px;
          box-sizing: border-box;
          background: linear-gradient(165deg, #090510 0%, #130a21 58%, #0b0713 100%);
          color: #e7ecef;
          font-family: var(--font-ui);
          overflow-x: hidden;
        }

        .history-main {
          min-height: calc(100vh - 136px);
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .back-btn,
        .exit-btn {
          border: 0;
          background: transparent;
          color: rgba(240, 234, 252, 0.82);
          transition: transform 0.16s ease, color 0.16s ease;
          cursor: pointer;
          width: 24px;
          height: 24px;
          display: grid;
          place-items: center;
        }

        .back-btn {
          flex-shrink: 0;
        }

        .exit-btn {
          position: fixed;
          top: 14px;
          right: 14px;
          z-index: 20;
        }

        .history-head {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 12px;
        }

        .back-btn:hover,
        .exit-btn:hover {
          transform: translateY(-1px);
          color: #ffffff;
        }

        .history-shell {
          width: min(980px, 100%);
          margin: 0;
          position: relative;
          z-index: 2;
        }

        .history-title {
          font-size: 30px;
          letter-spacing: 0.5px;
          color: #f2edff;
          text-shadow: 0 8px 40px rgba(0, 0, 0, 0.45);
          margin: 0;
          font-family: var(--font-display);
          font-weight: 600;
        }

        .error-chip {
          margin-bottom: 12px;
          padding: 8px 0;
          font-size: 13px;
          color: #ffd7e7;
        }

        .empty-state {
          margin-top: 10px;
          font-size: 13px;
          color: #d9ceef;
          opacity: 0.9;
        }

        .history-list {
          display: flex;
          flex-direction: column;
        }

        .history-item {
          display: grid;
          grid-template-columns: 230px 1fr auto;
          align-items: center;
          gap: 14px;
          padding: 12px 0;
          border-bottom: 1px solid rgba(255, 255, 255, 0.12);
          text-decoration: none;
          color: #e7ecef;
          transition: opacity 0.15s ease;
        }

        .history-item:hover {
          opacity: 0.88;
        }

        .thumb-wrap {
          position: relative;
          width: 100%;
          aspect-ratio: 16 / 9;
          border-radius: 8px;
          overflow: hidden;
          background: rgba(0, 0, 0, 0.28);
        }

        .thumb {
          width: 100%;
          height: 100%;
          object-fit: cover;
          display: block;
          filter: grayscale(1) sepia(0.32) hue-rotate(232deg) saturate(1.6) contrast(1.06) brightness(0.9);
        }

        .thumb-fallback {
          position: absolute;
          inset: 0;
          display: none;
          place-items: center;
          font-size: 12px;
          color: #d7c8f0;
        }

        .meta-row {
          font-size: 13px;
          color: #e9e0f6;
          line-height: 1.4;
        }

        .file-title {
          font-size: 14px;
          color: #f4efff;
          font-weight: 600;
          margin-bottom: 4px;
          white-space: nowrap;
          text-overflow: ellipsis;
          overflow: hidden;
        }

        .meta-col {
          display: flex;
          flex-direction: column;
          gap: 2px;
          min-width: 0;
        }

        .item-actions {
          display: flex;
          gap: 8px;
          justify-content: flex-end;
          align-items: center;
        }

        .item-action {
          height: 30px;
          min-width: 58px;
          border-radius: 8px;
          border: 1px solid rgba(255, 255, 255, 0.18);
          background: rgba(255, 255, 255, 0.08);
          color: #f3edff;
          cursor: pointer;
          font-size: 12px;
          text-decoration: none;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          padding: 0 10px;
          transition: background 0.15s ease;
        }

        .item-action:hover {
          background: rgba(255, 255, 255, 0.16);
        }

        .bottom-controls {
          margin-top: 18px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          flex-wrap: wrap;
        }

        .clear-btn {
          height: 36px;
          min-width: 120px;
          border-radius: 8px;
          border: 1px solid rgba(255, 255, 255, 0.16);
          background: rgba(255, 255, 255, 0.12);
          color: #fff;
          cursor: pointer;
          font-size: 13px;
          transition: transform 0.16s ease, background 0.16s ease;
        }

        .clear-btn:hover {
          background: rgba(255, 255, 255, 0.2);
        }

        .storage-chip {
          min-width: 220px;
          background: transparent;
          border: 1px solid rgba(255, 255, 255, 0.14);
          border-radius: 10px;
          padding: 7px 10px;
          display: flex;
          flex-direction: column;
          gap: 5px;
        }

        .storage-text {
          font-size: 12px;
          color: #efe7ff;
        }

        .storage-bar {
          height: 5px;
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.14);
          overflow: hidden;
        }

        .storage-fill {
          height: 100%;
          background: linear-gradient(90deg, #d9c6ff, #f0e8ff);
        }

        @media (max-width: 760px) {
          .history-main {
            align-items: flex-start;
          }

          .history-shell {
            margin-top: 8px;
          }

          .history-item {
            grid-template-columns: 1fr;
            gap: 8px;
          }

          .item-actions {
            justify-content: flex-start;
            margin-top: 6px;
          }
        }
      `}</style>
    </div>
  );
}
