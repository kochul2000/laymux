import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";
import "./i18n";

// Dev builds mount under StrictMode, which re-runs effects and therefore
// closes and reopens every TerminalView PTY once. `VITE_LAYMUX_STRICT_MODE=0`
// mounts like a release build, for verifying PTY lifetime on a dev instance
// (e.g. PTY daemon session adoption, docs/dev-repro-methodology.md).
const strictMode = import.meta.env.VITE_LAYMUX_STRICT_MODE !== "0";

createRoot(document.getElementById("root")!).render(
  strictMode ? (
    <StrictMode>
      <App />
    </StrictMode>
  ) : (
    <App />
  ),
);
