import { useEffect, useState } from "react";

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

export default function HistoryPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [entries, setEntries] = useState([]);
  const [usageBytes, setUsageBytes] = useState(0);
  const [capBytes, setCapBytes] = useState(10 * 1024 * 1024 * 1024);

  const loadHistory = async () => {
    setLoading(true);
    setError("");

    try {
      const resp = await fetch("/api/downloads/history");

      if (resp.status === 401) {
        window.location.assign("/");
        return;
      }

      const payload = await resp.json();
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
        window.location.assign("/");
        return;
      }

      const payload = await resp.json();
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
    <div
      style={{
        minHeight: "100vh",
        background: "#000",
        color: "#fff",
        fontFamily: "sans-serif",
        padding: "24px 16px",
        boxSizing: "border-box"
      }}
    >
      <div
        style={{
          width: "min(960px, 100%)",
          margin: "0 auto",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 20,
          gap: 12,
          flexWrap: "wrap"
        }}
      >
        <div>
          <div style={{ fontSize: 24, letterSpacing: 1 }}>Previous Downloads</div>
          <div style={{ opacity: 0.7, fontSize: 12, marginTop: 6 }}>
            Stored per user, auto-deleted after 7 days.
          </div>
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={() => window.location.assign("/")}
            style={{
              height: 36,
              padding: "0 12px",
              background: "#1f1f1f",
              border: "1px solid #333",
              color: "#fff",
              cursor: "pointer"
            }}
          >
            Back
          </button>
          <button
            onClick={logout}
            style={{
              height: 36,
              padding: "0 12px",
              background: "#1f1f1f",
              border: "1px solid #333",
              color: "#fff",
              cursor: "pointer"
            }}
          >
            Log Out
          </button>
        </div>
      </div>

      <div
        style={{
          width: "min(960px, 100%)",
          margin: "0 auto",
          border: "1px solid #222",
          background: "#0a0a0a",
          padding: 16,
          boxSizing: "border-box"
        }}
      >
        <div style={{ marginBottom: 14, fontSize: 13, opacity: 0.85 }}>
          Storage: {formatBytes(usageBytes)} / {formatBytes(capBytes)}
        </div>

        {error && (
          <div
            style={{
              marginBottom: 12,
              padding: "10px 12px",
              border: "1px solid #7f1d1d",
              background: "#1b0a0a",
              fontSize: 13
            }}
          >
            {error}
          </div>
        )}

        {loading ? (
          <div style={{ opacity: 0.8 }}>Loading...</div>
        ) : entries.length === 0 ? (
          <div style={{ opacity: 0.7 }}>No downloads in the past 7 days.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {entries.map(entry => (
              <div
                key={entry.id}
                style={{
                  border: "1px solid #222",
                  background: "#111",
                  padding: 10,
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 10,
                  flexWrap: "wrap"
                }}
              >
                <div style={{ minWidth: 240 }}>
                  <div style={{ fontSize: 13, wordBreak: "break-word" }}>{entry.fileName}</div>
                  <div style={{ marginTop: 4, opacity: 0.65, fontSize: 12 }}>
                    {formatDate(entry.createdAt)} • {formatBytes(entry.sizeBytes)}
                  </div>
                </div>

                <a
                  href={entry.downloadUrl}
                  style={{
                    height: 34,
                    minWidth: 96,
                    padding: "0 12px",
                    background: "#2563eb",
                    border: "1px solid #1e40af",
                    color: "#fff",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    textDecoration: "none",
                    fontSize: 13
                  }}
                >
                  Download
                </a>
              </div>
            ))}
          </div>
        )}

        <div style={{ marginTop: 18 }}>
          <button
            onClick={clearAll}
            style={{
              height: 38,
              minWidth: 120,
              padding: "0 14px",
              background: "#311",
              border: "1px solid #522",
              color: "#fff",
              cursor: "pointer"
            }}
          >
            Clear All
          </button>
        </div>
      </div>
    </div>
  );
}
