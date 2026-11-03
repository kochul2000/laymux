// 실행 중인 현재 워크트리의 dev 전용. HTTP가 죽은 동안 CDP/native IPC로 검증한다.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createConnection } from "node:net";
import { connectDevPage } from "./dev-cdp.mjs";

const base = "http://127.0.0.1:19281";
const health = await (await fetch(`${base}/api/v1/health`)).json();
assert.equal(health.instance.buildKind, "dev");
assert.equal(
  health.instance.worktreeRoot.replaceAll("\\", "/").toLowerCase(),
  path.resolve(".").replaceAll("\\", "/").toLowerCase(),
);
const page = await connectDevPage(
  process.env.LAYMUX_CDP_URL || "http://127.0.0.1:9348",
  process.env.LAYMUX_DEV_URL || "http://localhost:1420",
);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function screenshot(name) {
  // The same screenshot implementation as the Automation API, reached through
  // CDP while its HTTP listener is intentionally down.
  const data = await page.evaluate(async () => {
    const { captureScreenshot } =
      await import("/src/hooks/useAutomationBridge.ts");
    return captureScreenshot();
  });
  await mkdir(".screenshots", { recursive: true });
  const destination = `.screenshots/mcp-server-${name}.png`;
  await writeFile(destination, Buffer.from(data.split(",")[1], "base64"));
  return destination;
}

let interrupted = false;
const terminalId = `terminal-mcp-recovery-${Date.now()}`;
let terminalCreated = false;
try {
  const before = await page.evaluate(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    return {
      status: await invoke("get_automation_server_status"),
      sessions: await invoke("get_terminal_session_attributions"),
      retry: await invoke("retry_automation_server"),
    };
  });
  assert.equal(before.status.phase, "running");
  assert.equal(
    before.retry.revision,
    before.status.revision,
    "정상 서버 재시도는 멱등",
  );
  const response = await fetch(
    `${base}/api/v1/dev/automation-server/fail-stop`,
    { method: "POST" },
  );
  assert.equal(response.status, 200);
  interrupted = true;
  for (let attempt = 0; attempt < 40; attempt++) {
    if (
      await page.evaluate(
        () =>
          document.querySelector('[data-testid="mcp-server-retry"]') !== null,
      )
    )
      break;
    await pause(250);
  }
  const failure = await page.evaluate(async () => ({
    status: await window.__TAURI_INTERNALS__.invoke(
      "get_automation_server_status",
    ),
    notice: document.querySelector('[data-testid="mcp-server-notice"]')
      ?.textContent,
    role: document
      .querySelector('[data-testid="mcp-server-notice"]')
      ?.getAttribute("role"),
  }));
  assert.equal(failure.status.phase, "failed");
  assert.equal(failure.role, "alert");
  assert.ok(failure.notice.includes(failure.status.error));
  await page.evaluate(async (id) => {
    const { useSettingsStore } = await import("/src/stores/settings-store.ts");
    const profile = useSettingsStore
      .getState()
      .profiles.find((profile) => /powershell|pwsh/i.test(profile.commandLine));
    if (!profile) throw new Error("네이티브 PowerShell 프로필이 필요합니다");
    await window.__TAURI_INTERNALS__.invoke("create_terminal_session", {
      id,
      profile: profile.name,
      cols: 80,
      rows: 24,
      syncGroup: "mcp-recovery-test",
      cwdSend: false,
      cwdReceive: false,
    });
  }, terminalId);
  terminalCreated = true;
  // A fresh connection must be refused; HTTP is not serving the failure notice.
  await assert.rejects(
    new Promise((resolve, reject) => {
      const socket = createConnection({ host: "127.0.0.1", port: 19281 });
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", reject);
    }),
  );
  const failedImage = await screenshot("failed");
  await page.evaluate(() =>
    document.querySelector('[data-testid="mcp-server-retry"]').click(),
  );
  let recovered;
  for (let attempt = 0; attempt < 40; attempt++) {
    recovered = await page.evaluate(async () =>
      window.__TAURI_INTERNALS__.invoke("get_automation_server_status"),
    );
    if (recovered.phase === "running") break;
    await pause(250);
  }
  assert.equal(recovered.phase, "running");
  interrupted = false;
  const after = await (await fetch(`${base}/api/v1/health`)).json();
  assert.equal(
    after.instance.pid,
    health.instance.pid,
    "GUI 프로세스를 재시작하지 않는다",
  );
  const sessions = await page.evaluate(async () =>
    window.__TAURI_INTERNALS__.invoke("get_terminal_session_attributions"),
  );
  assert.deepEqual(
    Object.keys(sessions)
      .filter((id) => id !== terminalId)
      .sort(),
    Object.keys(before.sessions).sort(),
  );
  for (const [terminalId, session] of Object.entries(sessions)) {
    if (!before.sessions[terminalId]) continue;
    assert.equal(
      session.generation,
      before.sessions[terminalId].generation,
      "PTY 세대를 유지한다",
    );
  }
  await page.evaluate(
    async (id) =>
      window.__TAURI_INTERNALS__.invoke("write_to_terminal", {
        id,
        data: "$h=Invoke-RestMethod ('http://127.0.0.1:'+$env:LX_AUTOMATION_PORT+'/api/v1/health'); Write-Output ('__MCP_CHILD__'+$env:LX_AUTOMATION_PORT+'|'+$h.instance.pid+'__')\r",
      }),
    terminalId,
  );
  const marker = `__MCP_CHILD__19281|${health.instance.pid}__`;
  let output = "";
  for (let attempt = 0; attempt < 80; attempt++) {
    output = (
      await (
        await fetch(`${base}/api/v1/terminals/${terminalId}/output?lines=100`)
      ).json()
    ).output;
    if (output?.includes(marker)) break;
    await pause(250);
  }
  assert.ok(
    output?.includes(marker),
    `중단 중 생성된 동일 셸의 복구 후 통신 실패: ${output}`,
  );
  const mcp = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "recovery-test", version: "1" },
      },
    }),
  });
  assert.equal(mcp.status, 200, await mcp.clone().text());
  const initialized = await mcp.text();
  assert.ok(initialized.includes('"serverInfo"'), initialized);
  assert.equal(
    await page.evaluate(() =>
      document
        .querySelector('[data-testid="mcp-server-notice"]')
        ?.getAttribute("role"),
    ),
    "status",
  );
  const recoveredImage = await screenshot("recovered");
  await page.evaluate(() =>
    document.querySelector('[data-testid="mcp-server-dismiss"]').click(),
  );
  console.log(
    JSON.stringify({
      pid: health.instance.pid,
      phase: recovered.phase,
      failedImage,
      recoveredImage,
      mcpInitialize: mcp.status,
    }),
  );
} finally {
  // Keep dev usable even if a screenshot/assertion fails after interruption.
  if (interrupted)
    await page.evaluate(async () =>
      window.__TAURI_INTERNALS__.invoke("retry_automation_server"),
    );
  if (terminalCreated)
    await page.evaluate(
      async (id) =>
        window.__TAURI_INTERNALS__.invoke("close_terminal_session", { id }),
      terminalId,
    );
  page.close();
}
