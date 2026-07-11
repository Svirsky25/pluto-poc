import { useCallback, useEffect, useRef, useState } from "react";
import { ActionType, DogStatus, StatusResponse } from "./types";
import {
  getPushState,
  subscribeToPush,
  unsubscribeFromPush,
  isSubscribed,
  PushState,
  errStr,
  pushDiagnostics,
} from "./push";

// Visual + textual config per status.
const STATUS_CONFIG: Record<
  DogStatus,
  { label: string; emoji: string; background: string; accent: string }
> = {
  READY_FOR_GARDEN: {
    label: "מוכן לגינה",
    emoji: "🌳",
    background: "linear-gradient(160deg, #16a34a 0%, #15803d 100%)",
    accent: "#166534",
  },
  PEE_ONLY: {
    label: "רק פיפי",
    emoji: "💛",
    background: "linear-gradient(160deg, #facc15 0%, #eab308 100%)",
    accent: "#a16207",
  },
  NEEDS_WALK: {
    label: "צריך טיול!",
    emoji: "🚨",
    background: "linear-gradient(160deg, #ef4444 0%, #b91c1c 100%)",
    accent: "#991b1b",
  },
};

function formatCountdown(totalSeconds: number): string {
  const s = Math.max(0, totalSeconds);
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

export default function App() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [pushState, setPushState] = useState<PushState>("default");
  const [notifOn, setNotifOn] = useState<boolean>(false);
  const [notifBusy, setNotifBusy] = useState<boolean>(false);
  // Absolute local deadline (ms) for the garden window, derived from the
  // server's remaining_seconds — avoids depending on the device's wall clock.
  const [deadline, setDeadline] = useState<number | null>(null);
  const prevRemainingRef = useRef<number>(0);

  useEffect(() => {
    setPushState(getPushState());
    isSubscribed().then(setNotifOn);
  }, []);

  // Apply a server status payload. Converts the authoritative remaining_seconds
  // into a local deadline so the countdown is immune to client/server clock skew.
  const applyStatus = useCallback((data: StatusResponse) => {
    setStatus(data);
    setDeadline(
      data.remaining_seconds > 0
        ? Date.now() + data.remaining_seconds * 1000
        : null,
    );
  }, []);

  // Toggle push notifications on/off. On => subscribe, Off => unsubscribe.
  const toggleNotifications = useCallback(async () => {
    setNotifBusy(true);
    try {
      if (notifOn) {
        await unsubscribeFromPush();
        setNotifOn(false);
        setError(null);
      } else {
        const state = await subscribeToPush();
        setPushState(state);
        if (state === "granted") {
          setNotifOn(true);
          setError(null);
        } else {
          // Permission not granted (denied / dismissed) — leave the toggle off.
          setNotifOn(false);
        }
      }
    } catch (e) {
      // Surface the exact error + environment so iOS failures are debuggable
      // right on the device (no remote console needed).
      setNotifOn(false);
      const detail = `${errStr(e)}\n\n${pushDiagnostics()}`;
      setError(detail);
      // eslint-disable-next-line no-alert
      alert("Push error:\n\n" + detail);
      console.error(e);
    } finally {
      setNotifBusy(false);
    }
  }, [notifOn]);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/status");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: StatusResponse = await res.json();
      applyStatus(data);
      setError(null);
    } catch (e) {
      setError("שגיאה בטעינת הסטטוס");
      console.error(e);
    }
  }, [applyStatus]);

  // Initial load, then subscribe to realtime status updates via SSE so the
  // UI flips the instant the server changes state (no polling lag).
  useEffect(() => {
    fetchStatus();
    const es = new EventSource("/api/events");
    es.onmessage = (event) => {
      try {
        const data: StatusResponse = JSON.parse(event.data);
        applyStatus(data);
        setNow(Date.now());
        setError(null);
      } catch (e) {
        console.error(e);
      }
    };
    // EventSource reconnects automatically on transient errors.
    return () => es.close();
  }, [fetchStatus]);

  // Local 1-second tick so the countdown stays smooth between polls.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Countdown derived from the local deadline (see applyStatus) — independent
  // of the device's absolute clock, so it works even for short windows.
  const remainingSeconds = deadline
    ? Math.max(0, Math.ceil((deadline - now) / 1000))
    : 0;

  // When the window hits zero locally, re-sync immediately to catch the
  // server-side transition to NEEDS_WALK.
  useEffect(() => {
    if (prevRemainingRef.current > 0 && remainingSeconds === 0) {
      fetchStatus();
    }
    prevRemainingRef.current = remainingSeconds;
  }, [remainingSeconds, fetchStatus]);

  const sendAction = useCallback(
    async (actionType: ActionType) => {
      setBusy(true);
      try {
        const res = await fetch("/api/action", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action_type: actionType }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: StatusResponse = await res.json();
        applyStatus(data);
        setNow(Date.now());
        setError(null);
      } catch (e) {
        setError("שגיאה בשליחת הפעולה");
        console.error(e);
      } finally {
        setBusy(false);
      }
    },
    [applyStatus]
  );

  const currentStatus: DogStatus = status?.current_status ?? "NEEDS_WALK";
  const config = STATUS_CONFIG[currentStatus];
  const showTimer = currentStatus === "READY_FOR_GARDEN" && remainingSeconds > 0;

  return (
    <div
      style={{
        minHeight: "100vh",
        background: config.background,
        transition: "background 0.6s ease",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        color: "#fff",
        padding: "24px",
        textAlign: "center",
      }}
    >
      <h1 style={{ fontSize: "2.4rem", marginBottom: "4px" }}>פלוטו 🐶</h1>
      <p style={{ opacity: 0.85, marginBottom: "28px" }}>
        סטטוס הכלב של המשפחה
      </p>

      <div
        style={{
          fontSize: "5rem",
          lineHeight: 1,
          marginBottom: "8px",
        }}
      >
        {config.emoji}
      </div>
      <div
        style={{
          fontSize: "2rem",
          fontWeight: 700,
          marginBottom: "18px",
          textShadow: "0 1px 3px rgba(0,0,0,0.25)",
        }}
      >
        {config.label}
      </div>

      {showTimer ? (
        <div
          style={{
            background: "rgba(0,0,0,0.2)",
            borderRadius: "16px",
            padding: "16px 28px",
            marginBottom: "32px",
            minWidth: "240px",
          }}
        >
          <div style={{ fontSize: "0.95rem", opacity: 0.85, marginBottom: "6px" }}>
            הגינה זמינה עוד
          </div>
          <div
            style={{
              fontSize: "2.6rem",
              fontWeight: 700,
              fontVariantNumeric: "tabular-nums",
              letterSpacing: "2px",
            }}
          >
            {formatCountdown(remainingSeconds)}
          </div>
        </div>
      ) : (
        <div style={{ marginBottom: "32px", minHeight: "24px", opacity: 0.85 }}>
          {currentStatus === "NEEDS_WALK"
            ? "פלוטו צריך לצאת לטיול 🚶"
            : currentStatus === "PEE_ONLY"
            ? "פלוטו עשה רק פיפי"
            : ""}
        </div>
      )}

      <div
        style={{
          display: "flex",
          gap: "16px",
          flexWrap: "wrap",
          justifyContent: "center",
          width: "100%",
          maxWidth: "420px",
        }}
      >
        <button
          onClick={() => sendAction("PEE_ONLY")}
          disabled={busy}
          style={buttonStyle("#eab308", config.accent, busy)}
        >
          רק פיפי 💛
        </button>
        <button
          onClick={() => sendAction("PEE_AND_POOP")}
          disabled={busy}
          style={buttonStyle("#16a34a", config.accent, busy)}
        >
          פיפי + קקי 💩
        </button>
      </div>

      <div
        style={{
          marginTop: "26px",
          minHeight: "24px",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: "6px",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "12px",
            opacity: notifBusy ? 0.6 : 1,
          }}
        >
          <span style={{ fontSize: "1rem", fontWeight: 600 }}>
            {notifOn ? "התראות פעילות 🔔" : "קבלת התראות"}
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={notifOn}
            aria-label="קבלת התראות"
            onClick={toggleNotifications}
            disabled={notifBusy}
            style={{
              position: "relative",
              width: "58px",
              height: "32px",
              padding: 0,
              border: "none",
              borderRadius: "16px",
              background: notifOn ? "#16a34a" : "rgba(0,0,0,0.35)",
              boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.4)",
              transition: "background 0.2s ease",
              cursor: notifBusy ? "default" : "pointer",
            }}
          >
            <span
              style={{
                position: "absolute",
                top: "3px",
                left: notifOn ? "29px" : "3px",
                width: "26px",
                height: "26px",
                borderRadius: "50%",
                background: "#fff",
                boxShadow: "0 1px 3px rgba(0,0,0,0.35)",
                transition: "left 0.2s ease",
              }}
            />
          </button>
        </div>
        {pushState === "denied" && (
          <span style={{ fontSize: "0.8rem", opacity: 0.85 }}>
            ההתראות חסומות — יש לאשר בהגדרות הדפדפן/המכשיר
          </span>
        )}
        {pushState === "unsupported" && (
          <span style={{ fontSize: "0.8rem", opacity: 0.85 }}>
            להתראות ב-iPhone יש להתקין את האפליקציה (הוסף למסך הבית)
          </span>
        )}
      </div>

      {error && (
        <pre
          dir="ltr"
          style={{
            marginTop: "16px",
            padding: "12px 14px",
            maxWidth: "min(92vw, 520px)",
            color: "#fff",
            background: "rgba(0,0,0,0.35)",
            border: "1px solid rgba(255,255,255,0.35)",
            borderRadius: "10px",
            fontSize: "0.8rem",
            lineHeight: 1.4,
            textAlign: "left",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            overflowWrap: "anywhere",
          }}
        >
          {error}
        </pre>
      )}
    </div>
  );
}

function buttonStyle(
  bg: string,
  border: string,
  disabled: boolean
): React.CSSProperties {
  return {
    flex: "1 1 160px",
    padding: "18px 20px",
    fontSize: "1.25rem",
    fontWeight: 700,
    color: "#fff",
    background: bg,
    border: `2px solid ${border}`,
    borderRadius: "14px",
    boxShadow: "0 4px 10px rgba(0,0,0,0.2)",
    opacity: disabled ? 0.6 : 1,
    transition: "transform 0.1s ease, opacity 0.2s ease",
  };
}
