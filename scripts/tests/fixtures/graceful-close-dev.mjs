import assert from "node:assert/strict";
import path from "node:path";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function api(route, body, method = body ? "POST" : "GET") {
  const response = await fetch("http://127.0.0.1:19281/api/v1" + route, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(route === "/health" ? 3000 : 45000),
  });
  const value = await response.json();
  assert.ok(
    response.ok && value.success !== false,
    `${route}: ${JSON.stringify(value)}`,
  );
  return value;
}
export async function until(read, label, timeout = 25000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`timeout: ${label}`);
}
export async function connectDev(root) {
  const health = await until(
    async () => {
      try {
        return await api("/health");
      } catch {
        return false;
      }
    },
    "dev health",
    120000,
  );
  assert.equal(health.instance.buildKind, "dev");
  assert.equal(
    path.resolve(health.instance.worktreeRoot).toLowerCase(),
    path.resolve(root).toLowerCase(),
  );
  const tabs = await (
    await fetch(process.env.LAYMUX_GRACEFUL_CDP ?? "http://127.0.0.1:9344/json")
  ).json();
  const tab = tabs.find((t) => t.url.includes("1420"));
  assert.ok(tab, "dev WebView");
  const socket = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let serial = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const response = JSON.parse(data);
    pending.get(response.id)?.resolve(response);
    pending.delete(response.id);
  };
  socket.onclose = () => {
    for (const waiter of pending.values())
      waiter.reject(new Error("dev WebView closed"));
    pending.clear();
  };
  async function evaluate(expression) {
    const id = ++serial;
    const result = await new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket.send(
        JSON.stringify({
          id,
          method: "Runtime.evaluate",
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
      );
    });
    assert.ok(
      !result.error && !result.result.exceptionDetails,
      JSON.stringify(result),
    );
    return result.result.result.value;
  }
  return { health, socket, evaluate };
}

export async function closeDevPane(evaluate, pane) {
  const source = `[data-layer-id="${pane.id}"]`;
  const direct = source + ' [data-testid="pane-control-delete"]';
  const floating =
    '[data-testid="pane-control-floating-menu"] [data-testid="pane-control-delete"]';
  if (
    !(await evaluate(`!!document.querySelector(${JSON.stringify(direct)})`))
  ) {
    await evaluate(
      `document.querySelector(${JSON.stringify(source + ' [data-testid="pane-control-menu-btn"]')}).click();true`,
    );
    await until(
      () => evaluate(`!!document.querySelector(${JSON.stringify(floating)})`),
      "pane close menu",
    );
  }
  const click = () =>
    evaluate(
      `(document.querySelector(${JSON.stringify(direct)})??document.querySelector(${JSON.stringify(floating)})).click();true`,
    );
  await click();
  await sleep(100);
  if (
    await evaluate(
      `!!(document.querySelector(${JSON.stringify(direct)})??document.querySelector(${JSON.stringify(floating)}))?.matches('[data-confirming="true"]')`,
    )
  )
    await click();
  await until(
    () =>
      evaluate(
        `!gracefulCheck.w.getState().getActiveWorkspace().panes.some(p=>p.layers.some(l=>l.id===${JSON.stringify(pane.id)}))`,
      ),
    "UI pane removed",
  );
  await until(
    async () =>
      !(await api("/terminals")).instances.some((t) => t.id === pane.terminal),
    "backend terminal removed",
  );
}
