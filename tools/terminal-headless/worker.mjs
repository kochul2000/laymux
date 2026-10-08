// Private stdio worker: only the Rust daemon owns this process and its pipes.
import readline from "node:readline";
import { once } from "node:events";
import { HeadlessScreen } from "./state.ts";
import { colorSchemeToXtermTheme } from "../../ui/src/lib/color-scheme.ts";
import { builtinColorSchemes } from "../../ui/src/lib/builtin-color-schemes.ts";

const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_SESSIONS = 4096;
const MAX_SCREEN_CELLS = 4 * 1024 * 1024;
const screens = new Map();
let chain = Promise.resolve();

function admitGeometry(id, cols, rows) {
  const requested = cols * rows * 2;
  let existing = 0;
  for (const [other, { screen }] of screens) if (other !== id) existing += screen.terminal.cols * screen.terminal.rows * 2;
  if (requested + existing > MAX_SCREEN_CELLS) throw new Error("daemon screen memory capacity exceeded");
}

function rebalanceScrollback() {
  let allocated = 0;
  for (const { screen } of screens.values()) allocated += screen.terminal.cols * screen.terminal.rows * 2;
  const historyPerScreen = Math.floor((MAX_SCREEN_CELLS - allocated) / Math.max(1, screens.size));
  for (const { screen } of screens.values()) screen.terminal.options.scrollback = Math.min(10000, Math.floor(historyPerScreen / screen.terminal.cols));
}

async function execute(request) {
  if (!request || !Number.isSafeInteger(request.requestId)) throw new Error("invalid request identity");
  if (typeof request.terminalId !== "string" || request.terminalId.length > 512) throw new Error("invalid terminal identity");
  if (!Number.isSafeInteger(request.generation) || request.generation < 1) throw new Error("invalid terminal generation");
  const id = request.terminalId;
  if (request.operation === "create") {
    if (screens.has(id)) throw new Error("terminal already exists");
    if (screens.size >= MAX_SESSIONS) throw new Error("terminal capacity exceeded");
    if (!Number.isInteger(request.cols) || !Number.isInteger(request.rows) || request.cols < 1 || request.rows < 1 || request.cols > 4096 || request.rows > 4096) throw new Error("invalid terminal geometry");
    admitGeometry(id, request.cols, request.rows);
    const replies = [];
    const scheme = request.scheme?.builtin ? builtinColorSchemes.find((scheme) => scheme.name === request.scheme.builtin) : request.scheme;
    const theme = scheme ? colorSchemeToXtermTheme(scheme) : {};
    const screen = new HeadlessScreen(request.cols, request.rows, (data) => replies.push(data), theme);
    screens.set(id, { screen, replies, generation: request.generation });
    rebalanceScrollback();
    return { created: true };
  }
  const entry = screens.get(id);
  if (!entry || request.generation !== entry.generation) throw new Error("stale terminal generation");
  switch (request.operation) {
    case "write": {
      if (typeof request.data !== "string") throw new Error("missing terminal bytes");
      const bytes = Buffer.from(request.data, "base64");
      if (bytes.byteLength > MAX_FRAME_BYTES / 2) throw new Error("terminal delta too large");
      await entry.screen.write(new Uint8Array(bytes));
      return { replies: entry.replies.splice(0) };
    }
    case "resize":
      if (!Number.isInteger(request.cols) || !Number.isInteger(request.rows) || request.cols < 1 || request.rows < 1 || request.cols > 4096 || request.rows > 4096) throw new Error("invalid terminal geometry");
      admitGeometry(id, request.cols, request.rows);
      entry.screen.terminal.resize(request.cols, request.rows);
      rebalanceScrollback();
      return { resized: true };
    case "checkpoint":
      return entry.screen.checkpoint();
    case "dispose":
      entry.screen.dispose();
      screens.delete(id);
      rebalanceScrollback();
      return { disposed: true };
    default:
      throw new Error("unknown operation");
  }
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  input.pause();
  chain = chain.then(async () => {
    let response;
    let request;
    try {
      if (Buffer.byteLength(line) > MAX_FRAME_BYTES) throw new Error("worker frame too large");
      request = JSON.parse(line);
      response = { requestId: request.requestId, result: await execute(request) };
    } catch (error) {
      response = { requestId: request?.requestId, error: String(error.message || error) };
    }
    const encoded = JSON.stringify(response);
    if (Buffer.byteLength(encoded) > MAX_FRAME_BYTES) {
      response = { requestId: request?.requestId, error: "worker response too large" };
    }
    if (!process.stdout.write(JSON.stringify(response) + "\n")) await once(process.stdout, "drain");
    input.resume();
  }).catch(() => process.exit(1));
});
input.on("close", () => {
  void chain.finally(() => { for (const { screen } of screens.values()) screen.dispose(); });
});
