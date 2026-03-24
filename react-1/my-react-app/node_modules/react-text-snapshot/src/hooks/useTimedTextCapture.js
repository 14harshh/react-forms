import React, { useState, useRef } from "react";

const TimedTextCapture = ({ questionId, candidateId }) => {
  const [textValue, setTextValue] = useState("");
  const [snapshots, setSnapshots] = useState([]);

  const textRef = useRef("");
  const lastPrintedTextRef = useRef("");
  const intervalRef = useRef(null);
  const startTimeRef = useRef(null);
  const typingStartedRef = useRef(false);

  // 🟢 Start interval capture
  const startCapture = () => {
    startTimeRef.current = performance.now();

    intervalRef.current = setInterval(() => {
      const snapshotObject = {
        questionId,
        candidateId,
        timestamp: new Date().toISOString(),
        elapsedMs: Math.floor(performance.now() - startTimeRef.current),
        text: textRef.current,
        textLength: textRef.current.length,
      };

      setSnapshots(prev => [...prev, snapshotObject]);

      // ✅ Print only if text changed
      if (lastPrintedTextRef.current !== textRef.current) {
        console.log(`[${snapshotObject.timestamp}] ${snapshotObject.text}`);
        lastPrintedTextRef.current = textRef.current;
      }

    }, 3000);
  };

  // 🟢 Handle typing
  const handleChange = (e) => {
    const value = e.target.value;
    setTextValue(value);
    textRef.current = value;

    // Start only once
    if (!typingStartedRef.current && value.length > 0) {
      typingStartedRef.current = true;
      startCapture();
    }
  };

  // 🟢 Stop capture when cursor leaves textbox
  const handleBlur = () => {
    clearInterval(intervalRef.current);
  };

  return (
    <div>
      <textarea
        id="answerText"
        name="answerText"
        rows="6"
        cols="50"
        value={textValue}
        onChange={handleChange}
        onBlur={handleBlur}
        placeholder="Type here..."
      />
    </div>
  );
};

export default TimedTextCapture;