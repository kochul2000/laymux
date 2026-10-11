// 실제 dev 백엔드의 인증·lease·대형 자원 읽기를 브라우저 프리뷰와 함께 검증한다.
// dev: 전용 APPDATA/UDF, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9339
// 실행: node scripts/verify-localhost-preview.mjs (기본 http://localhost:8765/)
import { chromium } from "../ui/node_modules/playwright-core/index.mjs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const root = fileURLToPath(new URL("../", import.meta.url));
const host = "http://127.0.0.1:19281";
const health = await fetch(host + "/api/v1/health").then((r) => r.json());
if (
  health.instance?.buildKind !== "dev" ||
  path.resolve(health.instance.worktreeRoot).toLowerCase() !==
    path.resolve(root).toLowerCase()
) {
  throw new Error("현재 워크트리의 dev 인스턴스만 검증할 수 있습니다.");
}
const desktop = await chromium.connectOverCDP("http://127.0.0.1:9339");
const page = desktop
  .contexts()
  .flatMap((c) => c.pages())
  .find((p) => p.url() === "http://localhost:1420/");
if (!page) throw new Error("dev WebView를 찾지 못했습니다.");
const invoke = (command, args) =>
  page.evaluate(
    async ({ command, args }) => {
      const { invoke } = await import("/node_modules/@tauri-apps/api/core.js");
      return invoke(command, args);
    },
    { command, args },
  );
const access = await invoke("get_remote_access_status");
const control = await invoke("get_remote_control_status");
if (control.lease) {
  await desktop.close();
  throw new Error("기존 Remote 제어권이 있어 검증하지 않습니다.");
}
const token = access.effectiveAuthToken || randomUUID();
let ownedLease;
async function remote(endpoint, body) {
  const response = await fetch(host + "/remote/v1" + endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer " + token,
    },
    body: JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok)
    throw new Error(`${endpoint}: ${value.error || response.status}`);
  return value;
}
try {
  if (!access.effectiveEnabled)
    await invoke("set_remote_runtime_access", {
      enabled: true,
      authToken: token,
    });
  const claim = await remote("/session/claim", {
    clientName: "localhost-preview-validation",
  });
  ownedLease = claim.leaseId;
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        path.join(root, "ui/node_modules/@playwright/test/cli.js"),
        "test",
        "localhost-preview.spec.ts",
        "--workers=1",
      ],
      {
        cwd: path.join(root, "ui"),
        windowsHide: true,
        stdio: "inherit",
        env: {
          ...process.env,
          LAYMUX_PREVIEW_REPRO_URL:
            process.env.LAYMUX_PREVIEW_REPRO_URL || "http://localhost:8765/",
          LAYMUX_PREVIEW_BACKEND_TOKEN: token,
          LAYMUX_PREVIEW_BACKEND_LEASE: ownedLease,
        },
      },
    );
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (exitCode !== 0) throw new Error("실제 백엔드 웹 프리뷰 검증 실패");
  const screenshot = await fetch(host + "/api/v1/screenshot", {
    method: "POST",
  }).then((r) => r.json());
  if (screenshot.error) throw new Error(screenshot.error);
  console.log("실제 dev 백엔드 + Godot 프리뷰 검증 통과", {
    screenshot: screenshot.path,
  });
} finally {
  if (ownedLease) await remote("/session/release", { leaseId: ownedLease });
  if (!access.effectiveEnabled)
    await invoke("set_remote_runtime_access", {
      enabled: false,
      authToken: null,
    });
  await desktop.close();
}
