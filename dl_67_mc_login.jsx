import { useState } from "react";

export default function Login() {
  const [mode, setMode] = useState("login");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");

  const isLogin = mode === "login";
  const REQUEST_TIMEOUT_MS = 15000;

  const postJson = async (url, body) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      let payload = {};
      try {
        payload = await resp.json();
      } catch {
        payload = {};
      }

      return { resp, payload };
    } finally {
      clearTimeout(timer);
    }
  };

  const handleLogin = async () => {
    if (!username.trim() || !password) {
      setNotice("Enter username and password.");
      return;
    }

    setPending(true);
    setNotice("");

    try {
      const { resp, payload } = await postJson("/auth/login", {
        username: username.trim(),
        password
      });

      if (!resp.ok || !payload.ok) {
        setNotice(payload.error || "Login failed.");
        return;
      }

      window.location.assign("/");
    } catch (error) {
      if (error.name === "AbortError") {
        setNotice("Request timed out. Please try again.");
      } else {
        setNotice("Unable to reach server.");
      }
    } finally {
      setPending(false);
    }
  };

  const handleRequestAccess = async () => {
    if (!username.trim() || !email.trim() || !password) {
      setNotice("Enter username, email, and password.");
      return;
    }

    setPending(true);
    setNotice("");

    try {
      const { payload } = await postJson("/auth/request-access", {
        username: username.trim(),
        email: email.trim(),
        password
      });
      setNotice(payload.message || payload.error || "Request submitted.");
    } catch (error) {
      if (error.name === "AbortError") {
        setNotice("Email request timed out. Check server email settings and try again.");
      } else {
        setNotice("Unable to reach server.");
      }
    } finally {
      setPending(false);
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
      <div style={{ marginBottom: 40, fontSize: 24, letterSpacing: 1 }}>dl.67mc.org</div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 12,
          width: "min(360px, 100%)"
        }}
      >
        <input
          value={username}
          onChange={e => setUsername(e.target.value)}
          placeholder="Username"
          style={{
            padding: "12px",
            height: 46,
            background: "#111",
            border: "1px solid #333",
            color: "#fff",
            outline: "none",
            boxSizing: "border-box"
          }}
        />

        {!isLogin && (
          <input
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="Email"
            style={{
              padding: "12px",
              height: 46,
              background: "#111",
              border: "1px solid #333",
              color: "#fff",
              outline: "none",
              boxSizing: "border-box"
            }}
          />
        )}

        <input
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          placeholder="Password"
          onKeyDown={e =>
            e.key === "Enter" ? (isLogin ? handleLogin() : handleRequestAccess()) : null
          }
          style={{
            padding: "12px",
            height: 46,
            background: "#111",
            border: "1px solid #333",
            color: "#fff",
            outline: "none",
            boxSizing: "border-box"
          }}
        />

        <button
          onClick={isLogin ? handleLogin : handleRequestAccess}
          disabled={pending}
          style={{
            height: 46,
            background: pending ? "#171717" : "#1f1f1f",
            border: "1px solid #333",
            color: "#ffffff",
            cursor: pending ? "not-allowed" : "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 14,
            transition: "background 0.15s ease",
            opacity: pending ? 0.7 : 1
          }}
        >
          {pending ? "Please wait..." : isLogin ? "Log In" : "Request Access"}
        </button>

        <div
          onClick={() => {
            if (pending) return;
            setNotice("");
            setMode(isLogin ? "request" : "login");
          }}
          style={{
            marginTop: 10,
            fontSize: 13,
            opacity: 0.7,
            cursor: pending ? "default" : "pointer",
            textAlign: "center",
            textDecoration: "none"
          }}
          onMouseEnter={e => {
            if (!pending) e.currentTarget.style.textDecoration = "underline";
          }}
          onMouseLeave={e => {
            e.currentTarget.style.textDecoration = "none";
          }}
        >
          {isLogin ? "Request access" : "Back to login"}
        </div>

        {notice && (
          <div
            style={{
              marginTop: 2,
              fontSize: 12,
              lineHeight: 1.35,
              opacity: 0.85,
              textAlign: "center"
            }}
          >
            {notice}
          </div>
        )}
      </div>
    </div>
  );
}
