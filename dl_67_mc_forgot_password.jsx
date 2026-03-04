import { useEffect, useRef, useState } from "react";
import { backendFetch } from "./frontend-api";

export default function ForgotPasswordPage() {
  const [identifier, setIdentifier] = useState("");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const [toast, setToast] = useState("");
  const toastTimerRef = useRef(null);
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
    }, 3200);
  };

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  const handleSubmit = async () => {
    const value = identifier.trim();
    if (!value) {
      setNotice("Enter your username or email.");
      return;
    }

    setPending(true);
    setNotice("");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const resp = await backendFetch("auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: value }),
        signal: controller.signal
      });

      let payload = {};
      try {
        payload = await resp.json();
      } catch {
        payload = {};
      }

      if (!resp.ok) {
        setNotice(payload?.error || `Request failed (${resp.status})`);
        return;
      }

      setNotice("");
      showToast(
        "If an account matches that username/email, a reset link has been sent."
      );
    } catch (error) {
      if (error.name === "AbortError") {
        setNotice("Request timed out. Please try again.");
      } else {
        setNotice("Unable to reach server.");
      }
    } finally {
      clearTimeout(timer);
      setPending(false);
    }
  };

  return (
    <div className="login-page">
      <div className="auth-shell">
        <div className="auth-core">
          <div className="auth-title">dl.67mc.org</div>

          <div className="auth-card">
            <div className="field-group">
              <input
                value={identifier}
                onChange={event => setIdentifier(event.target.value)}
                placeholder="Username or email"
                className="auth-input"
                onKeyDown={event => (event.key === "Enter" ? handleSubmit() : null)}
              />
            </div>
          </div>
        </div>

        <div className="auth-actions">
          <button
            onClick={handleSubmit}
            disabled={pending}
            className="auth-btn"
          >
            {pending ? "Please wait..." : "Send reset link"}
          </button>

          <button
            type="button"
            disabled={pending}
            className="switch-btn"
            onClick={() => window.location.assign("/login")}
          >
            Back to login
          </button>

          <div className={`notice ${notice ? "show" : ""}`}>{notice || "\u00A0"}</div>
        </div>
      </div>

      {toast ? <div className="toast">{toast}</div> : null}

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
    </div>
  );
}
