import { useEffect, useMemo, useState } from "react";
import { backendFetch } from "./frontend-api";

const REQUEST_TIMEOUT_MS = 12000;

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = value;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  return `${amount.toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
}

function formatSpeed(value) {
  const speed = Number(value || 0);
  if (!Number.isFinite(speed) || speed <= 0) return "0.00 MB/s";
  const decimals = speed >= 100 ? 0 : speed >= 10 ? 1 : 2;
  return `${speed.toFixed(decimals)} MB/s`;
}

function formatDateCompact(ts) {
  const value = Number(ts || 0);
  if (!value) return "Unknown";
  const date = new Date(value);
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  }).replace(/\s*([AP])M$/i, (_all, meridiem) => `${String(meridiem).toLowerCase()}`);
}

function buildPieGradient(counts, order, palette) {
  const total = order.reduce((sum, key) => sum + (Number(counts?.[key] || 0) || 0), 0);
  if (total <= 0) return "rgba(255,255,255,0.08)";

  let start = 0;
  const segments = [];
  for (const key of order) {
    const value = Number(counts?.[key] || 0) || 0;
    if (value <= 0) continue;
    const end = start + (value / total) * 360;
    segments.push(`${palette[key]} ${start.toFixed(3)}deg ${end.toFixed(3)}deg`);
    start = end;
  }

  if (segments.length === 0) return "rgba(255,255,255,0.08)";
  return `conic-gradient(${segments.join(", ")})`;
}

export default function StatsPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [stats, setStats] = useState(null);

  const fetchWithTimeout = async path => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await backendFetch(path, {
        cache: "no-store",
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
  };

  const loadStats = async () => {
    setLoading(true);
    setError("");

    try {
      const resp = await fetchWithTimeout("stats");
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

      if (!resp.ok || !payload.ok || typeof payload.stats !== "object") {
        throw new Error(payload.error || "Failed to load stats.");
      }

      setStats(payload.stats);
    } catch (err) {
      if (err?.name === "AbortError") {
        setError("Stats request timed out. Check backend connection.");
      } else {
        setError(err?.message || "Failed to load stats.");
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadStats();
  }, []);

  const typeOrder = ["a+v", "a", "v"];
  const typePalette = {
    "a+v": "#bfa4ff",
    a: "#6f53a9",
    v: "#3f2a66"
  };

  const qualityOrder = ["hq", "mq", "lq"];
  const qualityPalette = {
    hq: "#f5e8ff",
    mq: "#b08cea",
    lq: "#6c4ca0"
  };

  const typePie = useMemo(
    () => buildPieGradient(stats?.mediaTypeCounts || {}, typeOrder, typePalette),
    [stats]
  );

  const qualityPie = useMemo(
    () => buildPieGradient(stats?.qualityCounts || {}, qualityOrder, qualityPalette),
    [stats]
  );

  const logout = async () => {
    try {
      await backendFetch("auth/logout", { method: "POST" });
    } finally {
      window.location.assign("/");
    }
  };

  return (
    <div className="stats-page">
      <button className="exit-btn" type="button" aria-label="Exit" title="Exit" onClick={logout}>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 3h9v18H3z" />
          <circle cx="8" cy="8" r="1.4" fill="currentColor" stroke="none" />
          <path d="M8 10.2v3.1l1.8 2" />
          <path d="M21 12h-8" />
          <path d="M18 9l3 3-3 3" />
        </svg>
      </button>

      <div className="stats-main">
        <div className="stats-shell">
          <div className="stats-head">
            <button
              className="back-btn"
              type="button"
              onClick={() => {
                try {
                  window.sessionStorage.setItem("md_from_history", "1");
                } catch {
                  // ignore storage errors
                }
                window.location.assign("/");
              }}
              aria-label="Back"
              title="Back"
            >
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </button>
            <div className="stats-title">Stats</div>
          </div>

          {loading ? <div className="muted">Loading...</div> : null}
          {error ? <div className="error-chip">{error}</div> : null}

          {!loading && !error && stats ? (
            <>
              <div className="summary-row">
                <div className="metric">
                  <div className="metric-label">Average video length</div>
                  <div className="metric-value">{stats.averageVideoLengthLabel || "0:00"}</div>
                </div>
                <div className="metric">
                  <div className="metric-label">Total downloads</div>
                  <div className="metric-value">{Number(stats.totalDownloads || 0)}</div>
                </div>
                <div className="metric">
                  <div className="metric-label">Unique users</div>
                  <div className="metric-value">{Number(stats.uniqueUsers || 0)}</div>
                </div>
                <div className="metric">
                  <div className="metric-label">Total downloaded size</div>
                  <div className="metric-value small">{formatBytes(stats.totalSizeBytes || 0)}</div>
                </div>
                <div className="metric">
                  <div className="metric-label">Average download size</div>
                  <div className="metric-value small">{formatBytes(stats.averageDownloadSizeBytes || 0)}</div>
                </div>
                <div className="metric">
                  <div className="metric-label">Activity (24h | 7d | 30d)</div>
                  <div className="metric-value small">
                    {Number(stats.last24hDownloads || 0)} | {Number(stats.last7dDownloads || 0)} | {Number(stats.last30dDownloads || 0)}
                  </div>
                </div>
                <div className="metric">
                  <div className="metric-label">Average download speed</div>
                  <div className="metric-value small">{formatSpeed(stats.averageDownloadSpeedMBps || 0)}</div>
                </div>
                <div className="metric">
                  <div className="metric-label">Top download speed</div>
                  <div className="metric-value small">{formatSpeed(stats.topDownloadSpeedMBps || 0)}</div>
                </div>
                <div className="metric">
                  <div className="metric-label">Lowest download speed</div>
                  <div className="metric-value small">{formatSpeed(stats.lowestDownloadSpeedMBps || 0)}</div>
                </div>
              </div>

              <div className="charts-row">
                <div className="chart-block">
                  <div className="chart-title">Media types</div>
                  <div className="pie" style={{ background: typePie }} />
                  <div className="legend">
                    {typeOrder.map(key => (
                      <div key={key} className="legend-item">
                        <span className="dot" style={{ background: typePalette[key] }} />
                        <span>{key}: {Number(stats.mediaTypeCounts?.[key] || 0)}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="chart-block">
                  <div className="chart-title">Quality</div>
                  <div className="pie" style={{ background: qualityPie }} />
                  <div className="legend">
                    {qualityOrder.map(key => (
                      <div key={key} className="legend-item">
                        <span className="dot" style={{ background: qualityPalette[key] }} />
                        <span>{key}: {Number(stats.qualityCounts?.[key] || 0)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <div className="columns">
                <div className="col-block">
                  <div className="block-title">Last 10 videos downloaded</div>
                  <div className="list">
                    {(stats.last10Downloads || []).map((item, idx) => (
                      <a key={`${item.sourceUrl}-${idx}`} className="list-row" href={item.sourceUrl} target="_blank" rel="noopener noreferrer">
                        <div className="row-title">{item.title || item.sourceUrl}</div>
                        <div className="row-meta">{item.username} | {item.quality} | {formatDateCompact(item.createdAt)}</div>
                      </a>
                    ))}
                    {(!stats.last10Downloads || stats.last10Downloads.length === 0) ? (
                      <div className="muted">No downloads yet.</div>
                    ) : null}
                  </div>
                </div>

                <div className="col-block">
                  <div className="block-title">Top 10 user leaderboard</div>
                  <div className="list">
                    {(stats.topUsers || []).map(item => (
                      <div key={item.username} className="list-row compact">
                        <div className="row-title">{item.username}</div>
                        <div className="row-meta">{item.count} downloads</div>
                      </div>
                    ))}
                    {(!stats.topUsers || stats.topUsers.length === 0) ? (
                      <div className="muted">No users yet.</div>
                    ) : null}
                  </div>

                  <div className="block-title" style={{ marginTop: 14 }}>Most recently used users</div>
                  <div className="list">
                    {(stats.mostRecentlyUsedUsers || []).map(item => (
                      <div key={item.username} className="list-row compact">
                        <div className="row-title">{item.username}</div>
                        <div className="row-meta">{formatDateCompact(item.lastAt)}</div>
                      </div>
                    ))}
                    {(!stats.mostRecentlyUsedUsers || stats.mostRecentlyUsedUsers.length === 0) ? (
                      <div className="muted">No user activity yet.</div>
                    ) : null}
                  </div>

                  <div className="block-title" style={{ marginTop: 14 }}>Top source domains</div>
                  <div className="list">
                    {(stats.topDomains || []).map(item => (
                      <div key={item.domain} className="list-row compact">
                        <div className="row-title">{item.domain}</div>
                        <div className="row-meta">{item.count} downloads</div>
                      </div>
                    ))}
                    {(!stats.topDomains || stats.topDomains.length === 0) ? (
                      <div className="muted">No domain data yet.</div>
                    ) : null}
                  </div>
                </div>
              </div>
            </>
          ) : null}
        </div>
      </div>

      <style jsx global>{`
        .stats-page {
          min-height: 100vh;
          position: relative;
          padding: 84px 16px 52px;
          box-sizing: border-box;
          background: transparent;
          color: #e7ecef;
          font-family: var(--font-ui);
          overflow-x: hidden;
        }

        .stats-main {
          min-height: calc(100vh - 136px);
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .stats-shell {
          width: min(1000px, 100%);
          position: relative;
          z-index: 2;
        }

        .stats-head {
          display: flex;
          align-items: center;
          gap: 14px;
          margin-bottom: 14px;
        }

        .stats-title {
          font-size: 30px;
          letter-spacing: 0.5px;
          color: #f2edff;
          text-shadow: 0 8px 40px rgba(0, 0, 0, 0.45);
          margin: 0;
          font-family: var(--font-display);
          font-weight: 600;
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

        .exit-btn {
          position: fixed;
          top: 14px;
          right: 14px;
          z-index: 20;
        }

        .back-btn:hover,
        .exit-btn:hover {
          transform: translateY(-1px);
          color: #ffffff;
        }

        .error-chip {
          margin-bottom: 12px;
          padding: 8px 0;
          font-size: 13px;
          color: #ffd7e7;
        }

        .muted {
          font-size: 13px;
          color: #d9ceef;
          opacity: 0.9;
        }

        .summary-row {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 12px;
          margin-bottom: 14px;
        }

        .metric {
          border: 1px solid rgba(255, 255, 255, 0.14);
          border-radius: 10px;
          padding: 10px 12px;
          background: rgba(255, 255, 255, 0.03);
        }

        .metric-label {
          font-size: 12px;
          color: #d7c8f0;
        }

        .metric-value {
          margin-top: 3px;
          font-size: 20px;
          color: #f4efff;
          font-weight: 700;
          font-family: var(--font-display);
        }

        .metric-value.small {
          font-size: 18px;
          letter-spacing: 0.2px;
        }

        .charts-row {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 12px;
          margin-bottom: 14px;
        }

        .chart-block {
          border: 1px solid rgba(255, 255, 255, 0.14);
          border-radius: 10px;
          padding: 12px;
          background: rgba(255, 255, 255, 0.03);
        }

        .chart-title {
          font-size: 13px;
          color: #efe7ff;
          margin-bottom: 9px;
        }

        .pie {
          width: 132px;
          height: 132px;
          border-radius: 999px;
          border: 1px solid rgba(255, 255, 255, 0.16);
          margin-bottom: 10px;
        }

        .legend {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }

        .legend-item {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 12px;
          color: #e7ddf8;
        }

        .dot {
          width: 10px;
          height: 10px;
          border-radius: 999px;
          display: inline-block;
        }

        .columns {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 12px;
        }

        .col-block {
          border: 1px solid rgba(255, 255, 255, 0.14);
          border-radius: 10px;
          padding: 10px 12px;
          background: rgba(255, 255, 255, 0.03);
        }

        .block-title {
          font-size: 13px;
          color: #efe7ff;
          margin-bottom: 8px;
        }

        .list {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }

        .list-row {
          display: flex;
          flex-direction: column;
          gap: 2px;
          text-decoration: none;
          color: inherit;
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 8px;
          padding: 7px 8px;
          background: rgba(255, 255, 255, 0.02);
        }

        .list-row.compact {
          flex-direction: row;
          align-items: baseline;
          justify-content: space-between;
          gap: 10px;
        }

        .row-title {
          font-size: 12px;
          color: #f2edff;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .row-meta {
          font-size: 11px;
          color: #cfc1e5;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        @media (max-width: 800px) {
          .summary-row,
          .charts-row,
          .columns {
            grid-template-columns: 1fr;
          }

          .stats-main {
            align-items: flex-start;
          }

          .stats-shell {
            margin-top: 8px;
          }
        }
      `}</style>
    </div>
  );
}
