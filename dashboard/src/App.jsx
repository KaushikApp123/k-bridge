import { useState, useEffect, useRef, useCallback } from "react";

const WS_URL = "ws://192.168.4.1:81"; // K-Bridge ESP32 AP address
const MAX_FRAMES = 200;

// ─── OBD-II Metric Tracking ──────────────────────────────────────────────────
const TRACKED_METRICS = ["RPM", "Speed", "Coolant", "Engine Load", "Throttle"];

function parseMetric(decoded) {
  if (!decoded) return null;
  if (decoded.startsWith("RPM:"))          return { key: "RPM",          value: decoded.split(": ")[1] };
  if (decoded.startsWith("Speed:"))        return { key: "Speed",         value: decoded.split(": ")[1] };
  if (decoded.startsWith("Coolant:"))      return { key: "Coolant",       value: decoded.split(": ")[1] };
  if (decoded.startsWith("Engine Load:"))  return { key: "Engine Load",   value: decoded.split(": ")[1] };
  if (decoded.startsWith("Throttle:"))     return { key: "Throttle",      value: decoded.split(": ")[1] };
  if (decoded.startsWith("Cadence:"))      return { key: "Elliptical",    value: decoded };
  if (decoded.startsWith("ASCII:"))        return { key: "UART",          value: decoded.replace('ASCII: ', '') };
  return null;
}

// ─── Power + Calorie Derivation (elliptical) ─────────────────────────────────
function derivePower(cadenceRpm, resistanceLevel, weightKg = 70) {
  // Simplified power model: P ≈ resistance_factor × cadence
  const resistanceFactor = resistanceLevel * 2.5;
  const powerWatts = (cadenceRpm / 60) * resistanceFactor * 0.8;
  const calPerMin  = (powerWatts * 0.863) / 4.184;
  return { powerWatts: powerWatts.toFixed(1), calPerMin: calPerMin.toFixed(1) };
}

// ─── Components ──────────────────────────────────────────────────────────────
function StatusDot({ connected }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span style={{
        width: 10, height: 10, borderRadius: "50%",
        background: connected ? "#22c55e" : "#ef4444",
        boxShadow: connected ? "0 0 6px #22c55e" : "none",
        display: "inline-block"
      }} />
      <span style={{ fontSize: 13, color: connected ? "#22c55e" : "#ef4444" }}>
        {connected ? "Connected" : "Disconnected"}
      </span>
    </span>
  );
}

function MetricCard({ label, value }) {
  return (
    <div style={{
      background: "#1e293b", borderRadius: 10, padding: "14px 18px",
      minWidth: 140, border: "1px solid #334155"
    }}>
      <div style={{ fontSize: 11, color: "#64748b", textTransform: "uppercase", letterSpacing: 1 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: "#f1f5f9", marginTop: 4 }}>{value || "—"}</div>
    </div>
  );
}

function FrameRow({ frame, index }) {
  const isCAn  = frame.proto === "CAN";
  const isUART = frame.proto === "UART";
  const bg = index % 2 === 0 ? "#0f172a" : "#111827";

  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "70px 90px 1fr 120px",
      gap: 8, padding: "7px 12px",
      background: bg, fontSize: 12,
      borderBottom: "1px solid #1e293b",
      fontFamily: "monospace"
    }}>
      <span style={{
        color: isCAn ? "#f59e0b" : "#38bdf8",
        fontWeight: 600
      }}>{frame.proto}</span>
      <span style={{ color: "#64748b" }}>{frame.ts}ms</span>
      <span style={{ color: "#e2e8f0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {frame.decoded}
      </span>
      <span style={{ color: "#475569", fontSize: 11 }}>{frame.hex}</span>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [connected, setConnected]   = useState(false);
  const [frames, setFrames]         = useState([]);
  const [metrics, setMetrics]       = useState({});
  const [filter, setFilter]         = useState("ALL");   // ALL | UART | CAN
  const [paused, setPaused]         = useState(false);
  const [baud, setBaud]             = useState(9600);
  const [weightKg, setWeightKg]     = useState(70);
  const [power, setPower]           = useState(null);
  const wsRef   = useRef(null);
  const frameRef = useRef([]);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;
    const sock = new WebSocket(WS_URL);

    sock.onopen = () => {
      setConnected(true);
      console.log("[WS] Connected to K-Bridge");
    };

    sock.onclose = () => {
      setConnected(false);
      console.log("[WS] Disconnected — retrying in 3s");
      setTimeout(connect, 3000);
    };

    sock.onerror = () => sock.close();

    sock.onmessage = (evt) => {
      if (paused) return;
      try {
        const frame = JSON.parse(evt.data);

        // Add to frame list
        frameRef.current = [frame, ...frameRef.current].slice(0, MAX_FRAMES);
        setFrames([...frameRef.current]);

        // Update live metrics
        const m = parseMetric(frame.decoded);
        if (m) {
          setMetrics(prev => ({ ...prev, [m.key]: m.value }));

          // Derive power from elliptical cadence frames
          if (frame.proto === "UART" && frame.decoded?.startsWith("Cadence:")) {
            const match = frame.decoded.match(/Cadence:\s*(\d+).*Resistance:\s*(\d+)/);
            if (match) {
              const p = derivePower(parseInt(match[1]), parseInt(match[2]), weightKg);
              setPower(p);
            }
          }
        }
      } catch (_) {}
    };

    wsRef.current = sock;
  }, [paused, weightKg]);

  useEffect(() => {
    connect();
    return () => wsRef.current?.close();
  }, []);

  const sendBaud = () => {
    if (wsRef.current?.readyState === WebSocket.OPEN)
      wsRef.current.send(JSON.stringify({ baud: parseInt(baud) }));
  };

  const clearFrames = () => {
    frameRef.current = [];
    setFrames([]);
    setMetrics({});
    setPower(null);
  };

  const filtered = filter === "ALL" ? frames : frames.filter(f => f.proto === filter);

  return (
    <div style={{
      minHeight: "100vh", background: "#0a0f1e", color: "#f1f5f9",
      fontFamily: "system-ui, sans-serif", padding: 20
    }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, letterSpacing: -0.5 }}>
            K-Bridge
          </h1>
          <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>
            Universal Embedded Device Interface
          </div>
        </div>
        <StatusDot connected={connected} />
      </div>

      {/* Live Metric Cards */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 20 }}>
        {["RPM", "Speed", "Coolant", "Engine Load", "Throttle"].map(k => (
          <MetricCard key={k} label={k} value={metrics[k]} />
        ))}
        {metrics["UART"] && (
          <MetricCard label="UART" value={metrics["UART"]} />
        )}
      </div>

      {/* Elliptical Power Box */}
      {(metrics["Elliptical"] || power) && (
        <div style={{
          background: "#1e293b", borderRadius: 10, padding: "14px 18px",
          marginBottom: 20, border: "1px solid #334155"
        }}>
          <div style={{ fontSize: 12, color: "#64748b", marginBottom: 8, textTransform: "uppercase", letterSpacing: 1 }}>
            Elliptical Machine
          </div>
          <div style={{ fontSize: 13, color: "#e2e8f0", marginBottom: 8 }}>
            {metrics["Elliptical"]}
          </div>
          {power && (
            <div style={{ display: "flex", gap: 20 }}>
              <div>
                <span style={{ color: "#64748b", fontSize: 11 }}>Estimated Power  </span>
                <span style={{ color: "#38bdf8", fontWeight: 700 }}>{power.powerWatts} W</span>
              </div>
              <div>
                <span style={{ color: "#64748b", fontSize: 11 }}>Calories/min  </span>
                <span style={{ color: "#22c55e", fontWeight: 700 }}>{power.calPerMin} kcal</span>
              </div>
            </div>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
            <label style={{ fontSize: 12, color: "#64748b" }}>Body weight (kg):</label>
            <input
              type="number" value={weightKg}
              onChange={e => setWeightKg(Number(e.target.value))}
              style={{
                width: 60, padding: "3px 6px", background: "#0f172a",
                border: "1px solid #334155", borderRadius: 6,
                color: "#f1f5f9", fontSize: 12
              }}
            />
          </div>
        </div>
      )}

      {/* Controls */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
        {/* Protocol filter */}
        {["ALL", "UART", "CAN"].map(f => (
          <button key={f} onClick={() => setFilter(f)} style={{
            padding: "5px 14px", borderRadius: 6, border: "none", cursor: "pointer",
            background: filter === f ? "#3b82f6" : "#1e293b",
            color: "#f1f5f9", fontSize: 13, fontWeight: 600
          }}>{f}</button>
        ))}

        <div style={{ width: 1, height: 24, background: "#334155" }} />

        {/* Pause / Clear */}
        <button onClick={() => setPaused(p => !p)} style={{
          padding: "5px 14px", borderRadius: 6, border: "none", cursor: "pointer",
          background: paused ? "#f59e0b" : "#1e293b", color: "#f1f5f9", fontSize: 13
        }}>{paused ? "Resume" : "Pause"}</button>

        <button onClick={clearFrames} style={{
          padding: "5px 14px", borderRadius: 6, border: "none", cursor: "pointer",
          background: "#1e293b", color: "#f1f5f9", fontSize: 13
        }}>Clear</button>

        <div style={{ width: 1, height: 24, background: "#334155" }} />

        {/* UART baud rate control */}
        <label style={{ fontSize: 12, color: "#64748b" }}>UART Baud:</label>
        <select
          value={baud}
          onChange={e => setBaud(e.target.value)}
          style={{
            padding: "4px 8px", background: "#1e293b", border: "1px solid #334155",
            borderRadius: 6, color: "#f1f5f9", fontSize: 12
          }}>
          {[1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200].map(b => (
            <option key={b} value={b}>{b}</option>
          ))}
        </select>
        <button onClick={sendBaud} style={{
          padding: "5px 12px", borderRadius: 6, border: "none", cursor: "pointer",
          background: "#3b82f6", color: "#fff", fontSize: 12
        }}>Set</button>

        <span style={{ marginLeft: "auto", fontSize: 12, color: "#475569" }}>
          {filtered.length} frames
        </span>
      </div>

      {/* Frame Table Header */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "70px 90px 1fr 120px",
        gap: 8, padding: "6px 12px",
        background: "#1e293b",
        fontSize: 11, color: "#64748b",
        textTransform: "uppercase", letterSpacing: 1,
        borderRadius: "8px 8px 0 0"
      }}>
        <span>Proto</span>
        <span>Time</span>
        <span>Decoded</span>
        <span>Hex</span>
      </div>

      {/* Frame List */}
      <div style={{
        height: 440, overflowY: "auto",
        border: "1px solid #1e293b",
        borderRadius: "0 0 8px 8px"
      }}>
        {filtered.length === 0 ? (
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            height: "100%", color: "#334155", fontSize: 14
          }}>
            {connected ? "Waiting for frames..." : "Connect K-Bridge to WiFi 'K-Bridge'"}
          </div>
        ) : (
          filtered.map((f, i) => <FrameRow key={i} frame={f} index={i} />)
        )}
      </div>

      {/* Footer */}
      <div style={{ marginTop: 12, fontSize: 11, color: "#334155", textAlign: "center" }}>
        K-Bridge · ESP32 @ {WS_URL} · Kaushik Appalanani
      </div>
    </div>
  );
}
