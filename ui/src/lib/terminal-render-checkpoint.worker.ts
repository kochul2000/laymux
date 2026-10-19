import { TerminalRenderCheckpointModel } from "./terminal-render-checkpoint-core";
import { Terminal } from "@xterm/headless";
import type {
  CheckpointWorkerRequest,
  CheckpointWorkerResponse,
} from "./terminal-render-checkpoint-worker";

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<CheckpointWorkerRequest>) => void) | null;
  postMessage: (message: CheckpointWorkerResponse) => void;
};
const model = new TerminalRenderCheckpointModel({
  terminal: new Terminal({
    allowProposedApi: true,
    cols: 80,
    rows: 24,
    scrollback: 10_000,
    windowsPty: { backend: "conpty", buildNumber: 21376 },
  }),
});
scope.onmessage = ({ data }) => {
  // capture must be able to wait for a future source target while subsequent
  // apply messages advance it. The model serializes writes itself.
  void (async () => {
    try {
      let result;
      if (data.op === "attach") await model.attach(data.attachment);
      else if (data.op === "apply") await model.apply(data.segment);
      else result = await model.capture(data.target, data.maxBytes);
      scope.postMessage({ id: data.id, ok: true, result });
    } catch (error) {
      scope.postMessage({
        id: data.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();
};
