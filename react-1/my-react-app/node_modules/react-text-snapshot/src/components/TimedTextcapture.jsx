import React, { useState, useEffect, useRef, useCallback } from "react";

/* ─── SPEECH HOOK ─────────────────────────────────────────────── */
const useSpeechRecognition = ({ language = "en-US" } = {}) => {
  const [isListening, setIsListening] = useState(false);
  const recognitionRef = useRef(null);
  const onResultRef    = useRef(null);
  const isSupported    = !!(window.SpeechRecognition || window.webkitSpeechRecognition);

  const startListening = useCallback((onResult) => {
    if (!isSupported) { alert("Speech recognition not supported. Try Chrome."); return; }
    onResultRef.current = onResult;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    recognitionRef.current = new SR();
    recognitionRef.current.lang           = language;
    recognitionRef.current.continuous     = true;
    recognitionRef.current.interimResults = false;
    recognitionRef.current.onstart        = () => setIsListening(true);
    recognitionRef.current.onresult       = (event) => {
      let finalText = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) finalText += event.results[i][0].transcript;
      }
      if (finalText && onResultRef.current) onResultRef.current(finalText.trim());
    };
    recognitionRef.current.onend = () => setIsListening(false);
    recognitionRef.current.start();
  }, [language, isSupported]);

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop();
    setIsListening(false);
  }, []);

  useEffect(() => () => recognitionRef.current?.stop(), []);
  return { isListening, startListening, stopListening };
};

/* ─── WAV ENCODER ─────────────────────────────────────────────── */
const encodeWAV = (samples, sampleRate) => {
  const bitsPerSample = 16, numChannels = 1;
  const byteRate   = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataLength = samples.length * 2;
  const buffer     = new ArrayBuffer(44 + dataLength);
  const view       = new DataView(buffer);
  const writeStr   = (off, str) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); };
  writeStr(0, "RIFF"); view.setUint32(4, 36 + dataLength, true); writeStr(8, "WAVE");
  writeStr(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true); view.setUint16(32, blockAlign, true); view.setUint16(34, bitsPerSample, true);
  writeStr(36, "data"); view.setUint32(40, dataLength, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++, off += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
};

/* ─── AUDIO WORKLET PROCESSOR CODE ───────────────────────────── */
const WORKLET_CODE = `
class PCMProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      this.port.postMessage(new Float32Array(input[0]));
    }
    return true;
  }
}
registerProcessor('pcm-processor', PCMProcessor);
`;

/* ─── AUDIO CAPTURE HOOK ──────────────────────────────────────── */
const useAudioCapture = () => {
  const audioCtxRef  = useRef(null); const analyserRef  = useRef(null);
  const workletRef   = useRef(null); const sourceRef    = useRef(null);
  const streamRef    = useRef(null); const pcmRef       = useRef([]);
  const ampRef       = useRef([]);   const timerRef     = useRef(null);
  const dataArrRef   = useRef(null); const srRef        = useRef(44100);
  const blobUrlRef   = useRef(null);

  const startAudioCapture = useCallback(async () => {
    try {
      pcmRef.current = []; ampRef.current = [];
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      streamRef.current = stream;
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      audioCtxRef.current = ctx;
      srRef.current = ctx.sampleRate;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.3;
      analyserRef.current = analyser;
      dataArrRef.current = new Uint8Array(analyser.frequencyBinCount);
      const blob    = new Blob([WORKLET_CODE], { type: "application/javascript" });
      const blobUrl = URL.createObjectURL(blob);
      blobUrlRef.current = blobUrl;
      await ctx.audioWorklet.addModule(blobUrl);
      const workletNode = new AudioWorkletNode(ctx, "pcm-processor");
      workletNode.port.onmessage = (e) => {
        pcmRef.current.push(new Float32Array(e.data));
      };
      workletRef.current = workletNode;
      const source = ctx.createMediaStreamSource(stream);
      source.connect(analyser);
      source.connect(workletNode);
      workletNode.connect(ctx.destination);
      sourceRef.current = source;
      const tick = () => {
        analyser.getByteTimeDomainData(dataArrRef.current);
        let sum = 0;
        for (let i = 0; i < dataArrRef.current.length; i++) {
          const v = (dataArrRef.current[i] - 128) / 128;
          sum += v * v;
        }
        ampRef.current.push(Math.round(Math.sqrt(sum / dataArrRef.current.length) * 1000) / 1000);
        timerRef.current = setTimeout(tick, 50);
      };
      tick();
    } catch (err) { console.warn("[AudioCapture] mic failed:", err.message); }
  }, []);

  const stopAudioCapture = useCallback(() => {
    clearTimeout(timerRef.current);
    workletRef.current?.disconnect();
    sourceRef.current?.disconnect();
    audioCtxRef.current?.close();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    if (blobUrlRef.current) { URL.revokeObjectURL(blobUrlRef.current); blobUrlRef.current = null; }
    workletRef.current = sourceRef.current = audioCtxRef.current = analyserRef.current = streamRef.current = null;
  }, []);

  const getWavBlob = useCallback(() => {
    const chunks = pcmRef.current;
    if (!chunks.length) return null;
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const merged = new Float32Array(total);
    let off = 0; for (const c of chunks) { merged.set(c, off); off += c.length; }
    return new Blob([encodeWAV(merged, srRef.current)], { type: "audio/wav" });
  }, []);

  const getAudioWaveMeta = useCallback(() => {
    const s = ampRef.current;
    if (!s.length) return {};
    const n = s.length, avg = s.reduce((a, b) => a + b, 0) / n, max = Math.max(...s);
    const silentSamples = s.filter((v) => v < 0.01).length;
    const stdDev = Math.sqrt(s.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / n);
    const epBand = s.filter((v) => v > 0.005 && v < 0.03);
    const epAvg  = epBand.length ? epBand.reduce((a, b) => a + b, 0) / epBand.length : 0;
    const r = (v) => Math.round(v * 1000) / 1000;
    return { sampleCount: n, avgAmplitude: r(avg), maxAmplitude: r(max), silentSamples,
      amplitudeStdDev: r(stdDev), earpieceEnergyAvg: r(epAvg),
      earpieceFlag: epBand.length / n > 0.4, isTooSmoothForSpeech: stdDev < 0.02 && avg > 0.005 };
  }, []);

  useEffect(() => () => stopAudioCapture(), []);
  return { startAudioCapture, stopAudioCapture, getWavBlob, getAudioWaveMeta };
};

/* ─── RESULT SCREEN ───────────────────────────────────────────── */
const RISK_CONFIG = {
  Low:      { color: "#22c55e", bg: "#052e16", label: "Low Risk" },
  Medium:   { color: "#f59e0b", bg: "#1c1400", label: "Medium Risk" },
  High:     { color: "#f97316", bg: "#1c0a00", label: "High Risk" },
  Critical: { color: "#ef4444", bg: "#1c0000", label: "Critical Risk" },
};
const VERDICT_COLOR = {
  "Human Written":      "#22c55e",
  "AI Assisted":        "#f59e0b",
  "AI Generated":       "#ef4444",
  "Likely Plagiarized": "#f97316",
};

const ScoreRing = ({ score }) => {
  const r = 44, circ = 2 * Math.PI * r, dash = circ * (score / 100);
  const color = score < 30 ? "#22c55e" : score < 60 ? "#f59e0b" : score < 80 ? "#f97316" : "#ef4444";
  return (
    <svg width="120" height="120" viewBox="0 0 120 120">
      <circle cx="60" cy="60" r={r} fill="none" stroke="#1e1e1e" strokeWidth="10"/>
      <circle cx="60" cy="60" r={r} fill="none" stroke={color} strokeWidth="10"
        strokeDasharray={`${dash} ${circ}`} strokeLinecap="round"
        transform="rotate(-90 60 60)" style={{ transition: "stroke-dasharray 1s ease" }}/>
      <text x="60" y="55" textAnchor="middle" fill={color} fontSize="22" fontWeight="700" fontFamily="'Segoe UI',sans-serif">{score}</text>
      <text x="60" y="72" textAnchor="middle" fill="#555" fontSize="11" fontFamily="'Segoe UI',sans-serif">/ 100</text>
    </svg>
  );
};

const MiniBar = ({ label, value, color }) => (
  <div style={{ marginBottom: 10 }}>
    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
      <span style={{ fontSize: 12, color: "#888" }}>{label}</span>
      <span style={{ fontSize: 12, color, fontWeight: 600 }}>{value}%</span>
    </div>
    <div style={{ height: 4, background: "#1e1e1e", borderRadius: 2 }}>
      <div style={{ height: "100%", width: `${value}%`, background: color, borderRadius: 2, transition: "width 1s ease" }}/>
    </div>
  </div>
);

/* ─── SNAPSHOT PANEL ──────────────────────────────────────────── */
const SnapshotPanel = ({ snapshots }) => {
  const [expanded, setExpanded] = useState(null);
  if (!snapshots || snapshots.length === 0) return null;
  return (
    <div style={{ background: "#0f0f0f", border: "1px solid #2a2a2a", borderRadius: 20, padding: "24px 28px", marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <div style={{ fontSize: 11, color: "#555", letterSpacing: "0.08em", textTransform: "uppercase" }}>
          Typing snapshots
          <span style={{ marginLeft: 8, fontSize: 11, color: "#3b82f6", background: "#0d1f3c", padding: "1px 7px", borderRadius: 10 }}>{snapshots.length}</span>
        </div>
        <div style={{ fontSize: 11, color: "#444" }}>Click a snapshot to expand</div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {snapshots.map((snap, i) => {
          const isOpen = expanded === i;
          const timeStr = snap.timestamp
            ? new Date(snap.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
            : `Snapshot ${i + 1}`;
          const preview = (snap.text || "").slice(0, 60).replace(/\n/g, " ");
          return (
            <div key={i} onClick={() => setExpanded(isOpen ? null : i)}
              style={{ background: isOpen ? "#141414" : "#111", border: `1px solid ${isOpen ? "#3b82f640" : "#1e1e1e"}`, borderRadius: 10, padding: "10px 14px", cursor: "pointer", transition: "all 0.2s" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 22, height: 22, borderRadius: 6, background: "#1a2a3a", color: "#3b82f6", fontSize: 10, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{i + 1}</div>
                <div style={{ fontSize: 11, color: "#3b82f6", fontFamily: "monospace", flexShrink: 0 }}>{timeStr}</div>
                <div style={{ fontSize: 12, color: "#555", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", flex: 1 }}>
                  {preview || <span style={{ color: "#333", fontStyle: "italic" }}>empty</span>}
                </div>
                <div style={{ fontSize: 11, color: "#444", flexShrink: 0 }}>{(snap.text || "").length} chars</div>
                <div style={{ color: "#444", fontSize: 12, flexShrink: 0 }}>{isOpen ? "▲" : "▼"}</div>
              </div>
              {isOpen && (
                <div style={{ marginTop: 10, padding: "12px 14px", background: "#0a0a0a", borderRadius: 8, fontSize: 13, color: "#aaa", lineHeight: 1.7, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "'Segoe UI', sans-serif", borderLeft: "2px solid #3b82f640" }}>
                  {snap.text || <span style={{ color: "#333", fontStyle: "italic" }}>No text at this point</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

/* ─── RESULT SCREEN ───────────────────────────────────────────── */
const ResultScreen = ({ result, snapshots, onRetry }) => {
  const risk   = RISK_CONFIG[result.riskLevel] || RISK_CONFIG.Low;
  const vColor = VERDICT_COLOR[result.finalVerdict] || "#888";
  return (
    <>
      <style>{`
        @keyframes fadeUp { from{opacity:0;transform:translateY(16px)} to{opacity:1;transform:translateY(0)} }
        .res-card { animation:fadeUp 0.4s ease both; }
        .res-card:nth-child(2){animation-delay:.08s} .res-card:nth-child(3){animation-delay:.16s} .res-card:nth-child(4){animation-delay:.24s}
        .signal-tag { display:inline-block; padding:4px 10px; border-radius:6px; font-size:11px; color:#f97316; background:#1c0a00; border:1px solid #f9731630; margin:3px 4px 3px 0; }
      `}</style>
      <div style={{ minHeight: "100vh", background: "#0a0a0a", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "40px 48px", boxSizing: "border-box" }}>
        <div style={{ width: "100%", maxWidth: 900 }}>

          {/* ── Score header ── */}
          <div className="res-card" style={{ display: "flex", alignItems: "center", gap: 32, background: "#141414", border: "1px solid #2a2a2a", borderRadius: 20, padding: "28px 36px", marginBottom: 16 }}>
            <ScoreRing score={result.overallScore}/>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 11, color: "#555", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8 }}>Overall suspicion score</div>
              <div style={{ fontSize: 28, fontWeight: 700, color: vColor, fontFamily: "'Segoe UI',sans-serif", marginBottom: 10 }}>{result.finalVerdict}</div>
              <div style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "6px 14px", borderRadius: 8, background: risk.bg, border: `1px solid ${risk.color}40` }}>
                <div style={{ width: 7, height: 7, borderRadius: "50%", background: risk.color }}/>
                <span style={{ fontSize: 12, color: risk.color, fontWeight: 600 }}>{risk.label}</span>
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 11, color: "#555", marginBottom: 4 }}>Writing pattern</div>
              <div style={{ fontSize: 13, color: "#ccc", fontWeight: 500 }}>{result.writingPattern}</div>
            </div>
          </div>

          {/* ── Signal bars ── */}
          <div className="res-card" style={{ background: "#141414", border: "1px solid #2a2a2a", borderRadius: 20, padding: "24px 36px", marginBottom: 16 }}>
            <div style={{ fontSize: 11, color: "#555", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 16 }}>Signal breakdown</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 40px" }}>
              <MiniBar label="AI probability"         value={result.aiProbability}        color="#ef4444"/>
              <MiniBar label="Plagiarism probability" value={result.plagiarismProbability} color="#f97316"/>
              <MiniBar label="Human likelihood"       value={result.humanLikelihood}       color="#22c55e"/>
              <MiniBar label="Speech naturalness"     value={result.speechNaturalness}     color="#3b82f6"/>
            </div>
          </div>

          {/* ── Analysis + signals ── */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
            <div className="res-card" style={{ background: "#141414", border: "1px solid #2a2a2a", borderRadius: 20, padding: "24px 28px" }}>
              <div style={{ fontSize: 11, color: "#555", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 12 }}>Analysis</div>
              <p style={{ fontSize: 13, color: "#aaa", lineHeight: 1.7, margin: 0 }}>{result.explanation}</p>
            </div>
            <div className="res-card" style={{ background: "#141414", border: "1px solid #2a2a2a", borderRadius: 20, padding: "24px 28px" }}>
              <div style={{ fontSize: 11, color: "#555", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 12 }}>
                Signals detected
                <span style={{ marginLeft: 8, fontSize: 11, color: "#f97316", background: "#1c0a00", padding: "1px 7px", borderRadius: 10 }}>{result.signalsDetected.length}</span>
              </div>
              {result.signalsDetected.length > 0
                ? result.signalsDetected.map((s, i) => <span key={i} className="signal-tag">{s}</span>)
                : <span style={{ fontSize: 13, color: "#555" }}>No suspicious signals.</span>}
            </div>
          </div>

          {/* ── SNAPSHOT PANEL ── */}
          <SnapshotPanel snapshots={snapshots} />

          <div style={{ textAlign: "center", marginTop: 8 }}>
            <button onClick={onRetry} style={{ padding: "11px 32px", fontSize: 14, fontWeight: 600, borderRadius: 10, fontFamily: "'Segoe UI',sans-serif", border: "1px solid #3a3a3a", background: "#1e1e1e", color: "#ccc", cursor: "pointer" }}>
              New attempt
            </button>
          </div>
        </div>
      </div>
    </>
  );
};

/* ─── MAIN COMPONENT ──────────────────────────────────────────── */
const TimedTextCapture = () => {
  const [textValue,  setTextValue]  = useState("");
  const [warningMsg, setWarningMsg] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result,     setResult]     = useState(null);
  const [submittedSnapshots, setSubmittedSnapshots] = useState([]);

  const snapshotsRef       = useRef([]);
  const textRef            = useRef("");
  const captureIntervalRef = useRef(null);
  const typingStartedRef   = useRef(false);
  const speechTextRef      = useRef("");

  const { isListening, startListening, stopListening } = useSpeechRecognition();
  const { startAudioCapture, stopAudioCapture, getWavBlob, getAudioWaveMeta } = useAudioCapture();

  const wordCount = textValue.trim().split(/\s+/).filter(Boolean).length;

  const startCapture = () => {
    if (captureIntervalRef.current) return;
    captureIntervalRef.current = setInterval(() => {
      snapshotsRef.current.push({ timestamp: new Date().toISOString(), text: textRef.current });
    }, 3000);
  };

  const handleSpeechResult = useCallback((spokenText) => {
    speechTextRef.current = speechTextRef.current ? `${speechTextRef.current} ${spokenText}` : spokenText;
    setTextValue((prev) => {
      const updated = prev ? `${prev} ${spokenText}` : spokenText;
      textRef.current = updated;
      if (!typingStartedRef.current) { typingStartedRef.current = true; startCapture(); }
      return updated;
    });
  }, []);

  const toggleMic = () => {
    if (isListening) { stopListening(); stopAudioCapture(); }
    else             { startListening(handleSpeechResult); startAudioCapture(); }
  };

  const handleChange = (e) => {
    const value = e.target.value;
    setTextValue(value);
    textRef.current = value;
    if (!typingStartedRef.current && value.length > 0) {
      typingStartedRef.current = true;
      startCapture();
    }
  };

  const handleBlockedAction = (e) => {
    e.preventDefault();
    setWarningMsg("Copy, paste, and cut are disabled.");
    setTimeout(() => setWarningMsg(""), 2500);
  };

  const handleSubmit = async () => {
    clearInterval(captureIntervalRef.current);
    captureIntervalRef.current = null;
    stopListening();
    stopAudioCapture();

    snapshotsRef.current.push({ timestamp: new Date().toISOString(), text: textRef.current });
    const snapshotsCopy = snapshotsRef.current.map((s) => ({ ...s }));
    setSubmittedSnapshots(snapshotsCopy);

    const audioWaveMeta = getAudioWaveMeta();
    const wavBlob       = getWavBlob();

    setSubmitting(true);
    try {
      const formData = new FormData();
      if (wavBlob) formData.append("audioFile", wavBlob, `audio_${Date.now()}.wav`);
      formData.append("payload", JSON.stringify({
        snapshots:     snapshotsCopy,
        audioWaveMeta: audioWaveMeta || {},
        sessionMeta:   { speechText: speechTextRef.current || "" },
      }));

      const res  = await fetch("http://localhost:3000/api/verify", { method: "POST", body: formData });
      const data = await res.json();
      console.log("Backend Response:", JSON.stringify(data, null, 2));

      if (data.success && data.aiResult) {
        setResult(data.aiResult);
      } else {
        console.error("Backend error:", data.error);
      }
    } catch (err) {
      console.error("Backend error:", err);
    } finally {
      setSubmitting(false);
    }
  };

  const handleRetry = () => {
    setResult(null);
    setTextValue("");
    setWarningMsg("");
    setSubmitting(false);
    setSubmittedSnapshots([]);
    snapshotsRef.current      = [];
    textRef.current           = "";
    speechTextRef.current     = "";
    typingStartedRef.current  = false;
    clearInterval(captureIntervalRef.current);
    captureIntervalRef.current = null;
  };

  useEffect(() => () => {
    clearInterval(captureIntervalRef.current);
    stopListening();
    stopAudioCapture();
  }, []);

  if (result) {
    return <ResultScreen result={result} snapshots={submittedSnapshots} onRetry={handleRetry} />;
  }

  const isDisabled = textValue.length === 0 || submitting;

  return (
    <>
      <style>{`
        @keyframes wave1 { 0%,100%{height:4px} 50%{height:22px} }
        @keyframes wave2 { 0%,100%{height:4px} 50%{height:32px} }
        @keyframes wave3 { 0%,100%{height:4px} 50%{height:18px} }
        @keyframes wave4 { 0%,100%{height:4px} 50%{height:28px} }
        @keyframes wave5 { 0%,100%{height:4px} 50%{height:14px} }

        body { background:#0a0a0a !important; min-height:100vh; margin:0; padding:0; user-select:none; }
        .ttc-page { min-height:100vh; background:#0a0a0a; display:flex; align-items:center; justify-content:center; padding:40px 48px; box-sizing:border-box; }
        .ttc-container { width:100%; max-width:1100px; }
        .ttc-wrap { width:100%; background:#141414; border:1px solid #2a2a2a; border-radius:20px; overflow:hidden; font-family:'Segoe UI',sans-serif; }
        .ttc-header { padding:24px 32px; border-bottom:1px solid #1e1e1e; display:flex; justify-content:space-between; align-items:center; }
        .ttc-title { font-size:18px; font-weight:700; color:#ffffff; letter-spacing:0.01em; }
        .ttc-mic { display:flex; align-items:center; gap:8px; padding:10px 20px; font-size:14px; font-weight:500; font-family:'Segoe UI',sans-serif; border:1px solid #3a3a3a; border-radius:10px; background:#1e1e1e; color:#ccc; cursor:pointer; transition:all 0.2s; min-width:110px; justify-content:center; }
        .ttc-mic:hover { border-color:#555; color:#fff; }
        .ttc-mic.on    { border-color:#ff4d4f; background:#1a0808; color:#ff6b6b; }
        .ttc-dot { width:8px; height:8px; border-radius:50%; background:#555; flex-shrink:0; }
        .ttc-wave { display:none; align-items:center; gap:3px; height:32px; }
        .ttc-mic.on .ttc-dot   { display:none; }
        .ttc-mic.on .ttc-label { display:none; }
        .ttc-mic.on .ttc-wave  { display:flex; }
        .ttc-bar { width:3px; background:#ff6b6b; border-radius:2px; height:4px; }
        .ttc-mic.on .ttc-bar:nth-child(1){animation:wave1 0.9s ease-in-out infinite 0.00s}
        .ttc-mic.on .ttc-bar:nth-child(2){animation:wave2 0.9s ease-in-out infinite 0.15s}
        .ttc-mic.on .ttc-bar:nth-child(3){animation:wave3 0.9s ease-in-out infinite 0.05s}
        .ttc-mic.on .ttc-bar:nth-child(4){animation:wave4 0.9s ease-in-out infinite 0.25s}
        .ttc-mic.on .ttc-bar:nth-child(5){animation:wave1 0.9s ease-in-out infinite 0.10s}
        .ttc-mic.on .ttc-bar:nth-child(6){animation:wave3 0.9s ease-in-out infinite 0.20s}
        .ttc-mic.on .ttc-bar:nth-child(7){animation:wave2 0.9s ease-in-out infinite 0.05s}
        .ttc-mic.on .ttc-bar:nth-child(8){animation:wave5 0.9s ease-in-out infinite 0.30s}
        .ttc-mic.on .ttc-bar:nth-child(9){animation:wave4 0.9s ease-in-out infinite 0.12s}
        .ttc-body { padding:24px 32px; border-bottom:1px solid #1e1e1e; }
        .ttc-ta { width:100%; min-height:320px; padding:18px; font-size:15px; font-family:'Segoe UI',sans-serif; border:1px solid #2a2a2a; border-radius:12px; resize:vertical; outline:none; line-height:1.8; color:#cccccc; background:#0f0f0f; caret-color:#4f8ef7; display:block; box-sizing:border-box; transition:border-color 0.2s,box-shadow 0.2s; user-select:text; }
        .ttc-ta::placeholder { color:#3a3a3a; }
        .ttc-ta:focus { border-color:#333; box-shadow:0 0 0 3px rgba(79,142,247,0.07); }
        .ttc-footer { padding:18px 32px; display:flex; justify-content:space-between; align-items:center; }
        .ttc-warn { font-size:12px; color:#ff6b6b; min-height:16px; }
        .ttc-wc   { font-size:13px; color:#444; margin-top:4px; }
        .ttc-btn { padding:12px 32px; font-size:15px; font-weight:700; border-radius:10px; font-family:'Segoe UI',sans-serif; border:1px solid #3a3a3a; background:#1e1e1e; color:#555; cursor:default; transition:all 0.2s; }
        .ttc-btn.on { color:#ffffff; border-color:#555; cursor:pointer; }
        .ttc-btn.on:hover { background:#2a2a2a; border-color:#777; }
      `}</style>

      <div className="ttc-page">
        <div className="ttc-container">
          <div className="ttc-wrap">
            <div className="ttc-header">
              <span className="ttc-title"></span>
              <button className={`ttc-mic${isListening ? " on" : ""}`} onClick={toggleMic}>
                <span className="ttc-dot"/>
                <span className="ttc-label">Speak</span>
                <div className="ttc-wave">
                  {[...Array(9)].map((_, i) => <div key={i} className="ttc-bar"/>)}
                </div>
              </button>
            </div>

            <div className="ttc-body">
              <textarea
                className="ttc-ta"
                rows={10}
                value={textValue}
                placeholder="Type or speak your answer here..."
                onChange={handleChange}
                onCopy={handleBlockedAction}
                onPaste={handleBlockedAction}
                onCut={handleBlockedAction}
                onDrop={(e) => e.preventDefault()}
                onDragOver={(e) => e.preventDefault()}
              />
            </div>

            <div className="ttc-footer">
              <div>
                <div className="ttc-warn">{warningMsg}</div>
                <div className="ttc-wc">{wordCount > 0 ? `${wordCount} word${wordCount !== 1 ? "s" : ""}` : ""}</div>
              </div>
              <button
                className={`ttc-btn${isDisabled ? "" : " on"}`}
                onClick={handleSubmit}
                disabled={isDisabled}
              >
                {submitting ? "Analysing..." : "Submit"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
};

export default TimedTextCapture;