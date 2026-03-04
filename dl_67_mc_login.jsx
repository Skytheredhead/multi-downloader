import { useEffect, useRef, useState } from "react";
import { backendFetch } from "./frontend-api";

export default function Login() {
  const [mode, setMode] = useState("login");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [toast, setToast] = useState("");
  const toastTimerRef = useRef(null);

  const isLogin = mode === "login";
  const REQUEST_TIMEOUT_MS = 15000;

  const showToast = message => {
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
    setToast(String(message || ""));
    toastTimerRef.current = setTimeout(() => {
      setToast("");
      toastTimerRef.current = null;
    }, 2800);
  };

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  const postJson = async (url, body) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const resp = await backendFetch(url, {
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
      setNotice("Enter username/email and password.");
      return;
    }

    setPending(true);
    setNotice("");

    try {
      const { resp, payload } = await postJson("auth/login", {
        username: username.trim(),
        password
      });

      if (!resp.ok || !payload.ok) {
        const errorText = String(payload.error || "Login failed.").trim();
        if (errorText.toLowerCase() === "invalid username or password.") {
          setNotice("");
          showToast("Invalid username or password.");
        } else {
          setNotice(errorText);
        }
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
      const { payload } = await postJson("auth/request-access", {
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
    <div className="login-page">
      <div className="auth-shell">
        <div className="auth-core">
          <div className="auth-title">downloader</div>

          <div className="auth-card">
            <div className="field-group">
              <input
                value={username}
                onChange={event => setUsername(event.target.value)}
                placeholder={isLogin ? "Username or email" : "Username"}
                className="auth-input"
              />
            </div>

            {!isLogin && (
              <div className="field-group">
                <input
                  value={email}
                  onChange={event => setEmail(event.target.value)}
                  placeholder="Email"
                  className="auth-input"
                />
              </div>
            )}

            <div className="field-group">
              <div className="password-wrap">
                <input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={event => setPassword(event.target.value)}
                  placeholder="Password"
                  className="auth-input pass-input"
                  onKeyDown={event =>
                    event.key === "Enter" ? (isLogin ? handleLogin() : handleRequestAccess()) : null
                  }
                />
                <button
                  type="button"
                  className="toggle-pass"
                  onClick={() => setShowPassword(prev => !prev)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  title={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? (
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M3 3l18 18" />
                      <path d="M10.6 10.6A2 2 0 0 0 12 16a2 2 0 0 0 1.4-.6" />
                      <path d="M9.9 5.2A11.4 11.4 0 0 1 12 5c5.3 0 9.2 4.6 9.9 6-.3.6-1.4 2.3-3.2 3.9" />
                      <path d="M6.3 6.6C3.9 8.2 2.4 10.6 2 11c.4.8 3.6 6 10 6 1 0 1.9-.1 2.7-.4" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  )}
                </button>
              </div>
              {isLogin && (
                <button
                  type="button"
                  className="forgot-inline"
                  disabled={pending}
                  onClick={() => window.location.assign("/forgot-password")}
                >
                  Reset password
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="auth-actions">
          <button
            onClick={isLogin ? handleLogin : handleRequestAccess}
            disabled={pending}
            className="auth-btn"
          >
            {pending ? "Please wait..." : isLogin ? "Log In" : "Request Access"}
          </button>

          <button
            type="button"
            disabled={pending}
            className="switch-btn"
            onClick={() => {
              if (pending) return;
              setNotice("");
              setMode(isLogin ? "request" : "login");
            }}
          >
            {isLogin ? "Request access" : "Back to login"}
          </button>

          <div className={`notice ${notice ? "show" : ""}`}>{notice || "\u00A0"}</div>
        </div>
      </div>

      <style jsx global>{`
        .login-page {
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 18px 16px;
          box-sizing: border-box;
          background: transparent;
          color: #e7ecef;
          font-family: var(--font-ui);
        }

        .auth-shell {
          width: min(360px, 100%);
          position: relative;
          display: flex;
          flex-direction: column;
          transform: translateY(28px);
        }

        .auth-core {
          display: flex;
          flex-direction: column;
          align-items: stretch;
        }

        .auth-title {
          text-align: center;
          font-size: 46px;
          line-height: 1;
          letter-spacing: 0.4px;
          margin-bottom: 30px;
          color: #f4f0ff;
          font-family: var(--font-display);
          font-weight: 600;
        }

        .auth-card {
          display: flex;
          flex-direction: column;
          gap: 11px;
        }

        .field-group {
          display: flex;
          flex-direction: column;
          gap: 0;
        }

        .forgot-inline {
          margin-top: 6px;
          margin-left: auto;
          border: 0;
          background: transparent;
          color: rgba(202, 186, 229, 0.72);
          font-size: 12px;
          cursor: pointer;
          padding: 0;
          text-decoration: none;
          transition: color 0.15s ease, text-decoration-color 0.15s ease;
        }

        .forgot-inline:hover:not(:disabled) {
          color: rgba(221, 209, 243, 0.9);
          text-decoration: underline;
          text-underline-offset: 2px;
          text-decoration-thickness: 1px;
        }

        .forgot-inline:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }

        .auth-actions {
          display: flex;
          flex-direction: column;
          align-items: center;
          margin-top: 14px;
          gap: 6px;
        }

        .auth-input {
          height: 44px;
          border-radius: 9px;
          border: 1px solid rgba(255, 255, 255, 0.2);
          background: rgba(14, 9, 26, 0.92);
          color: #efe7ff;
          padding: 0 11px;
          font-size: 14px;
          outline: none;
          transition: border-color 0.15s ease, background 0.15s ease, box-shadow 0.15s ease;
        }

        .auth-input:focus {
          border-color: rgba(224, 206, 255, 0.72);
          background: rgba(17, 11, 30, 0.95);
          box-shadow: 0 0 0 2px rgba(214, 194, 245, 0.35);
        }

        .auth-input::placeholder {
          color: rgba(230, 218, 251, 0.7);
        }

        .password-wrap {
          position: relative;
        }

        .pass-input {
          width: 100%;
          padding-right: 42px;
        }

        .toggle-pass {
          position: absolute;
          right: 8px;
          top: 50%;
          transform: translateY(-50%);
          width: 28px;
          height: 28px;
          border-radius: 6px;
          border: 1px solid rgba(255, 255, 255, 0.18);
          background: rgba(255, 255, 255, 0.08);
          color: #efe7ff;
          font-size: 13px;
          cursor: pointer;
          display: grid;
          place-items: center;
        }

        .toggle-pass:hover {
          background: rgba(255, 255, 255, 0.16);
        }

        .auth-btn {
          height: 38px;
          width: min(220px, 82%);
          border-radius: 9px;
          border: 1px solid rgba(255, 255, 255, 0.16);
          background: rgba(225, 219, 240, 0.2);
          color: #fff;
          font-size: 14px;
          font-weight: 600;
          cursor: pointer;
          transition: transform 0.16s ease, background 0.16s ease, opacity 0.16s ease;
        }

        .auth-btn:hover:not(:disabled) {
          background: rgba(235, 228, 250, 0.28);
        }

        .auth-btn:disabled {
          opacity: 0.65;
          cursor: not-allowed;
        }

        .switch-btn {
          margin-top: 2px;
          border: 0;
          background: transparent;
          color: rgba(232, 220, 252, 0.8);
          font-size: 12px;
          cursor: pointer;
          padding: 3px 0;
          text-decoration: none;
          transition: color 0.15s ease, text-decoration-color 0.15s ease;
        }

        .switch-btn:hover:not(:disabled) {
          text-decoration: underline;
          text-underline-offset: 2px;
          text-decoration-thickness: 1px;
          text-decoration-color: rgba(232, 220, 252, 0.9);
          color: rgba(240, 230, 255, 0.95);
        }

        .switch-btn:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }

        .notice {
          margin-top: 4px;
          width: 100%;
          font-size: 12px;
          line-height: 1.35;
          color: #f1e8ff;
          border: 1px solid rgba(255, 255, 255, 0.12);
          background: rgba(31, 20, 50, 0.9);
          border-radius: 9px;
          padding: 8px 10px;
          min-height: 34px;
          visibility: hidden;
        }

        .notice.show {
          visibility: visible;
        }

        .toast {
          position: fixed;
          top: 14px;
          right: 14px;
          max-width: min(92vw, 360px);
          border-radius: 10px;
          border: 1px solid rgba(255, 255, 255, 0.16);
          background: rgba(26, 17, 43, 0.94);
          color: #f2e9ff;
          font-size: 12px;
          line-height: 1.35;
          padding: 9px 11px;
          z-index: 50;
          box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
        }

        @media (max-width: 520px) {
          .auth-shell {
            transform: translateY(20px);
          }

          .auth-title {
            font-size: 40px;
          }
        }
      `}</style>

      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  );
}
