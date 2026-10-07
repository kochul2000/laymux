// WebView2의 page target만 연결한다. 브라우저의 shared worker를 attach하지 않는다.
import assert from "node:assert/strict";

export async function connectDevPage(cdpUrl, pageUrl) {
  const targets = await (await fetch(`${cdpUrl}/json/list`)).json();
  const target = targets.find(
    (t) => t.type === "page" && t.url.startsWith(pageUrl),
  );
  assert.ok(target?.webSocketDebuggerUrl, "지정한 dev WebView가 필요하다");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  socket.addEventListener("close", () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("dev CDP connection closed"));
    }
    pending.clear();
  });
  return {
    async evaluate(fn, arg) {
      const id = ++nextId;
      const response = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("dev evaluation timed out"));
        }, 60_000);
        pending.set(id, { resolve, reject, timer });
      });
      socket.send(
        JSON.stringify({
          id,
          method: "Runtime.evaluate",
          params: {
            expression: `(${fn.toString()})(${JSON.stringify(arg) ?? "undefined"})`,
            awaitPromise: true,
            returnByValue: true,
          },
        }),
      );
      const result = await response;
      if (result.exceptionDetails) {
        throw new Error(
          result.exceptionDetails.exception?.description ??
            result.exceptionDetails.exception?.value ??
            result.exceptionDetails.text,
        );
      }
      return result.result.value;
    },
    close() {
      socket.close();
    },
  };
}
