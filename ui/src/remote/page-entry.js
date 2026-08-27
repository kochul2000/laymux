// Bundles the Direct Remote Mode client sources into the committed minified
// artifacts served by the Rust remote server (ADR-0169). The app/CSS readable
// sources stay next to the artifacts; the Lucide DOM boundary lives beside
// this entry and is pulled in by remote-app.js (ADR-0210).
import "../../../src-tauri/src/remote_server/assets/remote-app.css";
import "../../../src-tauri/src/remote_server/assets/remote-app.js";
export {};
