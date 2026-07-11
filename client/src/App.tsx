import { useCallback, useEffect, useRef, useState } from "react";
import { ActionType, DogStatus, StatusResponse } from "./types";
import { getPushState, subscribeToPush, PushState } from "./push";

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
  const prevRemainingRef = useRef<number>(0);

  useEffect(() => {
    setPushState(getPushState());
  }, []);

  const enableNotifications = useCallback(async () => {
    try {
      const state = await subscribeToPush();
      setPushState(state);
      if (state === "denied") setError("ההתראות נחסמו בדפדפן");
      else setError(null);
    } catch (e) {
      setError("שגיאה בהפעלת התראות");
      console.error(e);
    }
  }, []);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/status");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: StatusResponse = await res.json();
      setStatus(data);
      setError(null);
    } catch (e) {
      setError("שגיאה בטעינת הסטטוס");
      console.error(e);
    }
  }, []);

  // Initial load + periodic re-sync with the server.
  useEffect(() => {
    fetchStatus();
    const id = setInterval(fetchStatus, 3000);
    return () => clearInterval(id);
  }, [fetchStatus]);

  // Local 1-second tick so the countdown stays smooth between polls.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Compute remaining seconds locally from the absolute timestamp.
  const remainingSeconds = status?.garden_available_until
    ? Math.max(0, Math.ceil((status.garden_available_until - now) / 1000))
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
        setStatus(data);
        setNow(Date.now());
        setError(null);
      } catch (e) {
        setError("שגיאה בשליחת הפעולה");
        console.error(e);
      } finally {
        setBusy(false);
      }
    },
    []
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

      <div style={{ marginTop: "26px", minHeight: "24px" }}>
        {pushState === "granted" ? (
          <span style={{ opacity: 0.9 }}>🔔 התראות פעילות</span>
        ) : pushState === "unsupported" ? (
          <span style={{ opacity: 0.7 }}>הדפדפן לא תומך בהתראות</span>
        ) : (
          <button
            onClick={enableNotifications}
            disabled={pushState === "denied"}
            style={{
              padding: "10px 18px",
              fontSize: "1rem",
              fontWeight: 600,
              color: "#fff",
              background: "rgba(0,0,0,0.25)",
              border: "1px solid rgba(255,255,255,0.5)",
              borderRadius: "10px",
              opacity: pushState === "denied" ? 0.6 : 1,
            }}
          >
            {pushState === "denied" ? "התראות חסומות 🔕" : "קבל התראות 🔔"}
          </button>
        )}
      </div>

      {error && (
        <div style={{ marginTop: "16px", color: "#fff", opacity: 0.9 }}>
          {error}
        </div>
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
