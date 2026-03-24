import React from "react";
import TimedTextCapture from "react-text-snapshot";
import "./App.css";

function App() {
  const handleCapture = (snapshot) => {
    console.log("Captured snapshot:", snapshot);
  };

  return (
    <div className="container">
      <TimedTextCapture onCapture={handleCapture} />
      <div style={{ marginTop: "20px" }}>
      </div>
    </div>
  );
}

export default App;

