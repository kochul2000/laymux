import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "../../../ui/node_modules/playwright-core/index.mjs";

export async function activityIpc(root, artifacts, expectedPid) {
  const dependencies = path.join(root, "target/debug/deps");
  const uds = readdirSync(dependencies)
    .filter((file) => /^libuds_windows-.*\.rlib$/.test(file))
    .map((file) => path.join(dependencies, file))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  assert.ok(uds, "dev 컴파일의 uds_windows 라이브러리가 필요합니다.");
  const ipc = path.join(artifacts, "activity-ipc.exe");
  execFileSync(
    "rustc",
    [
      "--edition",
      "2021",
      path.join(root, "scripts/tests/fixtures/activity-ipc.rs"),
      "-L",
      `dependency=${dependencies}`,
      "--extern",
      `uds_windows=${uds}`,
      "-o",
      ipc,
    ],
    { windowsHide: true },
  );
  const endpoint = JSON.parse(
    await readFile(
      path.join(process.env.LOCALAPPDATA, "laymux-dev/lx/endpoint.json"),
      "utf8",
    ),
  );
  assert.equal(
    endpoint.pid,
    expectedPid,
    "IPC도 같은 dev 인스턴스여야 합니다.",
  );
  const originalDistro =
    process.env.LAYMUX_TEST_WSL_DISTRO ||
    execFileSync("wsl.exe", ["--exec", "printenv", "WSL_DISTRO_NAME"], {
      windowsHide: true,
      encoding: "utf8",
    }).trim();
  assert.ok(
    originalDistro && !originalDistro.includes("/"),
    "실제 WSL 배포판 이름이 필요합니다.",
  );
  const setDistro = (target, distro) => {
    const result = JSON.parse(
      execFileSync(
        ipc,
        [
          endpoint.endpoint,
          JSON.stringify({
            action: "set-wsl-distro",
            terminal_id: target.id,
            path: `//wsl.localhost/${distro}/tmp`,
          }),
        ],
        { windowsHide: true, encoding: "utf8" },
      ),
    );
    assert.equal(result.success, true, JSON.stringify(result));
  };
  return { setDistro, originalDistro };
}

export async function verifyActivityRemote(invoke, targets, artifacts) {
  const access = await invoke("get_remote_access_status");
  assert.ok(
    !(await invoke("get_remote_control_status")).lease,
    "기존 Remote lease를 뺏지 않습니다.",
  );
  const token = access.effectiveAuthToken || "activity-dev-verification";
  let browser, lease;
  try {
    await invoke("set_remote_runtime_access", {
      enabled: true,
      authToken: token,
    });
    browser = await chromium.launch({ channel: "msedge", headless: true });
    const remote = await browser.newPage({
      viewport: { width: 430, height: 900 },
    });
    const claimed = remote.waitForResponse(
      (response) => response.url().endsWith("/session/claim") && response.ok(),
    );
    await remote.goto(
      "http://127.0.0.1:19281/remote/#" +
        new URLSearchParams({
          token,
          autoConnect: "1",
          clientName: "activity-dev-verification",
        }),
    );
    lease = (await (await claimed).json()).leaseId;
    await remote.locator("#navToggle").click();
    const rows = [];
    for (const target of targets) {
      const row = remote.locator(
        `[data-pane-row="${target.id.replace(/^terminal-/, "")}"]`,
      );
      await row.waitFor({ state: "visible" });
      const text = await row.innerText();
      assert.ok(
        text.includes(target.provider),
        `${target.environment} ${target.provider}: ${text}`,
      );
      rows.push({ id: target.id, provider: target.provider, text });
    }
    await remote.waitForTimeout(350);
    await remote.screenshot({ path: path.join(artifacts, "remote.png") });
    return rows;
  } finally {
    if (lease)
      await fetch("http://127.0.0.1:19281/remote/v1/session/release", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ leaseId: lease }),
      });
    await browser?.close();
    await invoke("set_remote_runtime_access", {
      enabled: access.runtimeEnabled,
      authToken: access.effectiveAuthToken || null,
    });
  }
}
