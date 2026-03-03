import { useState, useRef, useEffect } from "react";

function Dropdown({ options, value, onChange, width = 120 }) {
  const [open, setOpen] = useState(false);
  const ref = useRef();

  useEffect(() => {
    const handler = e => {
      if (!ref.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div
      ref={ref}
      style={{
        position: "relative",
        width,
        background: "#111",
        border: "1px solid #333",
        cursor: "pointer",
        userSelect: "none"
      }}
    >
      <div
        onClick={() => setOpen(!open)}
        style={{
          padding: "12px 14px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          height: 46,
          boxSizing: "border-box"
        }}
      >
        <span>{value}</span>
        <span style={{ opacity: 0.6 }}>▾</span>
      </div>

      {open && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            right: 0,
            background: "#111",
            border: "1px solid #333",
            zIndex: 10
          }}
        >
          {options.map(opt => (
            <div
              key={opt}
              onClick={() => {
                onChange(opt);
                setOpen(false);
              }}
              style={{
                padding: "10px 14px",
                background: opt === value ? "#1a1a1a" : "#111"
              }}
            >
              {opt}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Toast({ kind, text, progress }) {
  const borderColor =
    kind === "error" ? "#7f1d1d" : kind === "success" ? "#14532d" : "#1e3a8a";
  const bg = kind === "error" ? "#1b0a0a" : kind === "success" ? "#09150d" : "#0a1120";

  return (
    <div
      style={{
        width: 340,
        background: bg,
        border: `1px solid ${borderColor}`,
        color: "#fff",
        borderRadius: 10,
        padding: "12px 14px",
        boxShadow: "0 8px 20px rgba(0,0,0,0.35)",
        display: "flex",
        flexDirection: "column",
        gap: 8
      }}
    >
      <div style={{ fontSize: 13, lineHeight: 1.35 }}>{text}</div>
      {typeof progress === "number" && (
        <div
          style={{
            width: "100%",
            height: 6,
            background: "rgba(255,255,255,0.1)",
            borderRadius: 999,
            overflow: "hidden"
          }}
        >
          <div
            style={{
              height: "100%",
              width: `${Math.max(0, Math.min(100, progress))}%`,
              background: kind === "error" ? "#ef4444" : "#3b82f6"
            }}
          />
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [type, setType] = useState("a+v");
  const [quality, setQuality] = useState("hq");
  const [codec, setCodec] = useState("h264");
  const [url, setUrl] = useState("");
  const [toasts, setToasts] = useState([]);

  const toastTimers = useRef(new Map());
  const activeStreams = useRef(new Map());

  const videoCodecs = ["h264", "h265", "mov", "webm"];
  const audioCodecs = ["wav", "mp3 (320)", "mp3 (128)"];

  const formatBytes = bytes => {
    if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = bytes;
    let index = 0;
    while (value >= 1024 && index < units.length - 1) {
      value /= 1024;
      index += 1;
    }
    return `${value.toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
  };

  const removeToast = id => {
    const timer = toastTimers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      toastTimers.current.delete(id);
    }
    setToasts(prev => prev.filter(t => t.id !== id));
  };

  const showToast = ({ id, kind = "info", text, progress, duration = 0 }) => {
    setToasts(prev => {
      const existing = prev.find(t => t.id === id);
      if (existing) {
        return prev.map(t => (t.id === id ? { ...t, kind, text, progress } : t));
      }
      return [...prev, { id, kind, text, progress }];
    });

    const old = toastTimers.current.get(id);
    if (old) {
      clearTimeout(old);
      toastTimers.current.delete(id);
    }

    if (duration > 0) {
      const timer = setTimeout(() => removeToast(id), duration);
      toastTimers.current.set(id, timer);
    }
  };

  const autoDownload = downloadUrl => {
    const a = document.createElement("a");
    a.href = downloadUrl;
    a.download = "";
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const handleLogout = async () => {
    try {
      await fetch("/auth/logout", { method: "POST" });
    } finally {
      window.location.assign("/");
    }
  };

  const clearStorage = async () => {
    const resp = await fetch("/api/downloads/clear", { method: "POST" });
    let payload = {};
    try {
      payload = await resp.json();
    } catch {
      payload = {};
    }

    if (!resp.ok || !payload.ok) {
      throw new Error(payload.error || "Failed to clear storage.");
    }
  };

  useEffect(() => {
    if (type === "a") {
      setCodec(audioCodecs[0]);
    } else {
      setCodec(videoCodecs[0]);
    }
  }, [type]);

  useEffect(() => {
    return () => {
      for (const timer of toastTimers.current.values()) {
        clearTimeout(timer);
      }
      for (const stream of activeStreams.current.values()) {
        stream.close();
      }
    };
  }, []);

  const triggerDownload = async () => {
    if (!url.trim()) {
      showToast({
        id: `validation-${Date.now()}`,
        kind: "error",
        text: "Paste a URL before downloading.",
        duration: 4000
      });
      return;
    }

    let createdJobId = null;

    try {
      const resp = await fetch("/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, type, quality, codec })
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
        const usage = formatBytes(Number(payload.usageBytes || 0));
        const cap = formatBytes(Number(payload.capBytes || 10 * 1024 * 1024 * 1024));
        const shouldClear = window.confirm(
          `Storage cap exceeded (${usage} / ${cap}). Clear storage now?`
        );

        if (shouldClear) {
          await clearStorage();
          showToast({
            id: `storage-cleared-${Date.now()}`,
            kind: "success",
            text: "Storage cleared. Start the download again.",
            duration: 5000
          });
          return;
        }
      }

      if (!resp.ok || !payload.ok) {
        throw new Error(payload.error || `Request failed (${resp.status})`);
      }

      createdJobId = payload.jobId;
      const toastId = `job-${createdJobId}`;

      showToast({ id: toastId, kind: "info", text: "Queued...", progress: 0 });

      const stream = new EventSource(payload.eventsUrl || `/jobs/${createdJobId}/events`);
      activeStreams.current.set(createdJobId, stream);

      stream.onmessage = event => {
        let update;
        try {
          update = JSON.parse(event.data);
        } catch {
          return;
        }

        if (update.status === "failed") {
          showToast({
            id: toastId,
            kind: "error",
            text: update.error ? `${update.message} ${update.error}` : update.message,
            progress: undefined,
            duration: 8000
          });
          stream.close();
          activeStreams.current.delete(createdJobId);
          return;
        }

        if (update.status === "completed") {
          showToast({
            id: toastId,
            kind: "success",
            text: "Download complete. Sending file...",
            progress: 100,
            duration: 5000
          });

          if (update.downloadUrl) {
            autoDownload(update.downloadUrl);
          }

          stream.close();
          activeStreams.current.delete(createdJobId);
          return;
        }

        showToast({
          id: toastId,
          kind: "info",
          text: update.message || "Working...",
          progress: typeof update.progress === "number" ? update.progress : undefined
        });
      };

      stream.onerror = () => {
        showToast({
          id: toastId,
          kind: "error",
          text: "Live status connection lost.",
          duration: 6000
        });
        stream.close();
        activeStreams.current.delete(createdJobId);
      };
    } catch (error) {
      showToast({
        id: `request-${Date.now()}`,
        kind: "error",
        text: error.message,
        duration: 7000
      });
      if (error.message.startsWith("Session expired")) {
        setTimeout(() => {
          window.location.assign("/");
        }, 1200);
      }
    }
  };

  return (
    <div
      style={{
        background: "#000",
        color: "#fff",
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
        fontFamily: "sans-serif",
        padding: "24px 16px",
        boxSizing: "border-box"
      }}
    >
      <div
        style={{
          position: "fixed",
          top: 16,
          left: 16,
          zIndex: 1000,
          display: "flex",
          gap: 8
        }}
      >
        <button
          onClick={() => window.location.assign("/history")}
          style={{
            height: 34,
            minWidth: 140,
            background: "#1f1f1f",
            border: "1px solid #333",
            color: "#fff",
            fontSize: 12,
            cursor: "pointer"
          }}
          onMouseEnter={e => (e.currentTarget.style.background = "#2a2a2a")}
          onMouseLeave={e => (e.currentTarget.style.background = "#1f1f1f")}
        >
          Previous Downloads
        </button>

        <button
          onClick={handleLogout}
          style={{
            height: 34,
            minWidth: 86,
            background: "#1f1f1f",
            border: "1px solid #333",
            color: "#fff",
            fontSize: 12,
            cursor: "pointer"
          }}
          onMouseEnter={e => (e.currentTarget.style.background = "#2a2a2a")}
          onMouseLeave={e => (e.currentTarget.style.background = "#1f1f1f")}
        >
          Log Out
        </button>
      </div>

      <div
        style={{
          position: "fixed",
          top: 16,
          right: 16,
          zIndex: 1000,
          display: "flex",
          flexDirection: "column",
          gap: 10
        }}
      >
        {toasts.map(toast => (
          <Toast
            key={toast.id}
            kind={toast.kind}
            text={toast.text}
            progress={toast.progress}
          />
        ))}
      </div>

      <div style={{ marginBottom: 40, fontSize: 24, letterSpacing: 1 }}>dl.67mc.org</div>

      <div
        style={{
          display: "flex",
          gap: 6,
          width: "min(800px, 100%)",
          flexWrap: "wrap"
        }}
      >
        <input
          value={url}
          onChange={e => setUrl(e.target.value)}
          onKeyDown={e => e.key === "Enter" && triggerDownload()}
          placeholder="Paste link..."
          style={{
            flex: "1 1 320px",
            padding: "12px",
            height: 46,
            background: "#111",
            border: "1px solid #333",
            color: "#fff",
            outline: "none",
            boxSizing: "border-box"
          }}
        />

        <Dropdown options={["a+v", "a", "v"]} value={type} onChange={setType} width={80} />

        <Dropdown
          options={["hq", "mq", "lq"]}
          value={quality}
          onChange={setQuality}
          width={80}
        />

        <Dropdown
          options={type === "a" ? audioCodecs : videoCodecs}
          value={codec}
          onChange={setCodec}
          width={130}
        />

        <button
          onClick={triggerDownload}
          style={{
            height: 46,
            minWidth: 46,
            background: "#2563eb",
            border: "1px solid #1e40af",
            color: "#ffffff",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 0,
            lineHeight: 1,
            fontSize: 16,
            transition: "background 0.15s ease"
          }}
          onMouseEnter={e => (e.currentTarget.style.background = "#1d4ed8")}
          onMouseLeave={e => (e.currentTarget.style.background = "#2563eb")}
        >
          <span style={{ transform: "translateY(-1px)" }}>↓</span>
        </button>
      </div>

      <div style={{ marginTop: 40, opacity: 0.5, fontSize: 12 }}>v0.2</div>
    </div>
  );
}
