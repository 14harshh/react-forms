import React, { useState } from "react";
import { useSnapshot } from "react-text-snapshot";
import "./App.css";

function App() {
  const [textValue,  setTextValue]  = useState("");
  const [submitting, setSubmitting] = useState(false);

  const { onTextChange, submitToBackend } = useSnapshot();

  const handleChange = (e) => {
    setTextValue(e.target.value);
    onTextChange(e.target.value);
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    await submitToBackend("message");
    setSubmitting(false);
  };

  return (
    <div className="container">
      <textarea
        id="message"
        value={textValue}
        placeholder="Type your message here..."
        rows={10}
        onChange={handleChange}
      />
      <button onClick={handleSubmit} disabled={!textValue || submitting}>
        {submitting ? "Analysing..." : "Submit"}
      </button>
    </div>
  );
}

export default App;