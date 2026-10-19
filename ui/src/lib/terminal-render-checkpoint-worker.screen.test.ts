import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker as NodeWorker } from "node:worker_threads";
import { Terminal } from "@xterm/xterm";
import { TerminalRenderCheckpointModel } from "./terminal-render-checkpoint";
import {
  TerminalRenderCheckpointWorker,
  type CheckpointWorkerPort,
} from "./terminal-render-checkpoint-worker";
import { activateTerminalUnicodeProvider } from "./terminal-unicode-width";
import type { TerminalOutputAttachment } from "./terminal-output-attach-coordinator";

const buildDir = mkdtempSync(path.join(tmpdir(), "laymux-checkpoint-worker-"));
let asset: string;
const workers: NodeWorker[] = [];
const encoder = new TextEncoder();
beforeAll(() => {
  // Build the actual browser Worker independently of the application's dist.
  execFileSync(process.execPath, ["node_modules/vite/bin/vite.js", "build", "--outDir", buildDir], {
    cwd: process.cwd(),
    windowsHide: true,
    stdio: "pipe",
  });
  const file = readdirSync(path.join(buildDir, "assets")).find(
    (name) => name.startsWith("terminal-render-checkpoint.worker-") && name.endsWith(".js"),
  );
  if (!file) throw new Error("built checkpoint Worker asset missing");
  asset = pathToFileURL(path.join(buildDir, "assets", file)).href;
}, 20_000);
afterAll(async () => {
  await Promise.all(workers.map((worker) => worker.terminate()));
  if (
    path.dirname(path.resolve(buildDir)) !== path.resolve(tmpdir()) ||
    !path.basename(buildDir).startsWith("laymux-checkpoint-worker-")
  ) {
    throw new Error("refusing to remove an unexpected Worker build directory");
  }
  rmSync(buildDir, { recursive: true, force: true });
});

function createWorker(): CheckpointWorkerPort {
  const native = new NodeWorker(
    `
    const {parentPort,workerData}=require('node:worker_threads');
    const events=new EventTarget();
    globalThis.addEventListener=events.addEventListener.bind(events);
    globalThis.removeEventListener=events.removeEventListener.bind(events);
    globalThis.postMessage=message=>parentPort.postMessage(message);
    const ready=import(workerData.url);
    parentPort.on('message',async data=>{await ready;globalThis.onmessage({data});});
  `,
    { eval: true, workerData: { url: asset } },
  );
  workers.push(native);
  const port: CheckpointWorkerPort = {
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage: (message, transfer) => native.postMessage(message, transfer as ArrayBuffer[]),
    terminate: () => {
      void native.terminate();
    },
  };
  native.on("message", (data) => port.onmessage?.({ data } as MessageEvent));
  native.on("error", (error) =>
    port.onerror?.({ message: error.message, preventDefault() {} } as ErrorEvent),
  );
  return port;
}

describe("built checkpoint Worker screen parity", () => {
  it("preserves Unicode cells, alt/main buffers and ordered resize snapshots", async () => {
    const worker = new TerminalRenderCheckpointWorker({ createWorker });
    const local = new TerminalRenderCheckpointModel();
    let geometry = { revision: 1, cols: 18, rows: 4 };
    const snapshot = encoder.encode("main 한글");
    let seq = snapshot.length;
    const attachment = {
      state: { generation: 11, snapshotStartSeq: 0, snapshotSeq: seq, geometry },
      snapshot,
    } as TerminalOutputAttachment;
    try {
      await Promise.all([worker.attach(attachment), local.attach(attachment)]);
      for (const text of ["\x1b[?1049h\x1b[31m한글 👩‍💻\x1b[0m", "\x1b[2;1Hnext", "\x1b[?1049l"]) {
        if (text.includes("next")) geometry = { revision: 2, cols: 12, rows: 3 };
        const data = encoder.encode(text);
        const segment = {
          generation: 11,
          seqStart: seq,
          seqEnd: seq + data.length,
          data,
          geometry,
        };
        seq += data.length;
        await Promise.all([worker.apply(segment), local.apply(segment)]);
        expect(data.byteLength).toBeGreaterThan(0);
        const target = { generation: 11, seq, geometry };
        const [actual, expected] = await Promise.all([
          worker.capture(target, 4096),
          local.capture(target, 4096),
        ]);
        expect(actual).toEqual(expected);
      }
      const terminal = new Terminal({
        allowProposedApi: true,
        cols: geometry.cols,
        rows: geometry.rows,
      });
      activateTerminalUnicodeProvider(terminal);
      const checkpoint = await worker.capture({ generation: 11, seq, geometry }, 4096);
      await new Promise<void>((resolve) => terminal.write(checkpoint.data, resolve));
      expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe("main 한글");
      terminal.dispose();
    } finally {
      worker.dispose();
      local.dispose();
    }
  }, 10_000);

  it("reaches a capture target supplied before its output arrives", async () => {
    const model = new TerminalRenderCheckpointWorker({ createWorker });
    const geometry = { revision: 1, cols: 18, rows: 4 };
    try {
      await model.attach({
        state: { generation: 11, snapshotStartSeq: 0, snapshotSeq: 0, geometry },
        snapshot: new Uint8Array(),
      } as TerminalOutputAttachment);
      const data = encoder.encode("later 한글");
      const capturing = model.capture({ generation: 11, seq: data.length, geometry }, 4096);
      await model.apply({ generation: 11, seqStart: 0, seqEnd: data.length, data, geometry });
      expect((await capturing).seq).toBe(data.length);
    } finally {
      model.dispose();
    }
  });
});
