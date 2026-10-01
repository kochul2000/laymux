// Windows + WSL dev integration test. Never uses the release API or user CLI roots.
import { chromium } from "../../ui/node_modules/playwright-core/index.mjs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
const base = "http://127.0.0.1:19281/api/v1";
const distro = process.env.LAYMUX_WSL_DISTRO || "Ubuntu-22.04";
const devUrl = process.env.LAYMUX_DEV_URL || "http://localhost:1438";
const cdpUrl = process.env.LAYMUX_CDP_URL || "http://127.0.0.1:9341";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function api(route, body) {
  const response = await fetch(base + route, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json();
  if (!response.ok || result.success === false)
    throw new Error(JSON.stringify(result));
  return result;
}
const health = await api("/health");
assert.equal(
  health.instance.worktreeRoot.replaceAll("\\", "/").toLowerCase(),
  path.resolve(".").replaceAll("\\", "/").toLowerCase(),
);
assert.equal(
  health.instance.gitBranch,
  execFileSync("git", ["branch", "--show-current"], {
    windowsHide: true,
    encoding: "utf8",
  }).trim(),
);
const browser = await chromium.connectOverCDP(cdpUrl);
const page = browser
  .contexts()
  .flatMap((context) => context.pages())
  .find((page) => page.url().startsWith(devUrl));
assert.ok(page, "Expected dev WebView");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "laymux-hook-updates-"));
const linuxBase = "/tmp/laymux-hook-updates-" + randomUUID();
const foreign = { type: "command", command: "printf keep", timeout: 17 };
const original = {
  hooks: { Stop: [{ hooks: [foreign] }] },
  fixtureMarker: "preserve",
  disableAllHooks: true,
};
const targets = [
  { provider: "claude", distro: null, configDir: path.join(root, "claude") },
  { provider: "codex", distro: null, configDir: path.join(root, "codex") },
  { provider: "codex", distro, configDir: linuxBase + "/codex" },
];
const results = [];
const captures = [];
const linux = (...args) =>
  execFileSync("wsl.exe", ["-d", distro, "--exec", ...args], {
    windowsHide: true,
    encoding: "utf8",
  });
const manage = (target, operation) =>
  api("/agent-hooks/manage", { ...target, operation }).then(
    (result) => result.data,
  );
async function emit(target) {
  return api("/agent-hooks/events", {
    terminalId: "hook-update-fixture-" + randomUUID(),
    token: "fixture-token",
    provider: target.provider,
    sessionId: randomUUID(),
    event: "SessionStart",
    emittedAtMs: Date.now(),
    ancestors: [],
    distro: target.distro,
    configDir: target.configDir,
  });
}
const refresh = () =>
  page.evaluate(async () => {
    const { refreshAgentHookUpdates } =
      await import("/src/lib/agent-hook-updates.ts");
    await refreshAgentHookUpdates();
  });
try {
  for (const target of targets) {
    const file = target.provider === "claude" ? "settings.json" : "hooks.json";
    if (target.distro)
      linux(
        "sh",
        "-c",
        'mkdir -p "$1"; printf %s "$2" > "$1/hooks.json"',
        "sh",
        target.configDir,
        JSON.stringify(original),
      );
    else {
      await fs.mkdir(target.configDir, { recursive: true });
      await fs.writeFile(
        path.join(target.configDir, file),
        JSON.stringify(original),
      );
    }
    const installed = await manage(target, "install");
    assert.equal(installed.helperCurrent, true);
    assert.equal(installed.updateRequired, false);
    if (target.distro)
      linux(
        "sh",
        "-c",
        'printf tampered >> "$1/laymux-hooks/laymux-agent-hook"',
        "sh",
        target.configDir,
      );
    else
      await fs.appendFile(
        path.join(target.configDir, "laymux-hooks", "laymux-agent-hook.exe"),
        "tampered",
      );
    const stale = await manage(target, "status");
    assert.equal(stale.installed, true);
    assert.equal(stale.helperCurrent, false);
    assert.equal(stale.updateRequired, true);
    await emit(target);
    results.push({
      provider: target.provider,
      distro: target.distro,
      stale: true,
    });
  }
  const audit = (await api("/agent-hooks/updates")).data;
  for (const target of targets)
    assert.ok(
      audit.targets.some(
        (value) =>
          value.provider === target.provider &&
          value.distro === target.distro &&
          value.status.configDir.replaceAll("\\", "/") ===
            target.configDir.replaceAll("\\", "/") &&
          value.status.updateRequired,
      ),
    );
  await refresh();
  await page.getByTestId("agent-hook-update-notice").waitFor();
  await page.evaluate(async () => {
    const { default: i18n } = await import("/src/i18n/index.ts");
    await i18n.changeLanguage("ko");
  });
  await page.screenshot({
    path: path.resolve(".screenshots/hook-updates/notice-before.png"),
  });
  try {
    captures.push({
      stage: "before",
      screenshot: await api("/screenshot", {}),
    });
  } catch (error) {
    captures.push({ stage: "before", error: String(error) });
  }
  console.log(JSON.stringify({ stage: "before", captures }));
  for (const target of targets) {
    const row = page
      .locator(".agent-hook-update-notice__target")
      .filter({ has: page.getByText(target.configDir, { exact: true }) });
    await row.getByTestId("agent-hook-update-action").click();
    for (let tries = 0; tries < 30; tries++) {
      if (!(await manage(target, "status")).updateRequired) break;
      await pause(200);
    }
    const current = await manage(target, "status");
    assert.equal(current.helperCurrent, true);
    assert.equal(current.updateRequired, false);
    const raw = target.distro
      ? linux("cat", target.configDir + "/hooks.json")
      : await fs.readFile(
          path.join(
            target.configDir,
            target.provider === "claude" ? "settings.json" : "hooks.json",
          ),
          "utf8",
        );
    const config = JSON.parse(raw);
    assert.equal(config.fixtureMarker, "preserve");
    assert.equal(config.disableAllHooks, true);
    assert.deepEqual(config.hooks.Stop[0].hooks[0], foreign);
    results.find(
      (result) =>
        result.provider === target.provider && result.distro === target.distro,
    ).updated = true;
    await refresh();
    await row.waitFor({ state: "detached" });
  }
  // A stale UI action must not resurrect a removed integration.
  const target = targets[0];
  await manage(target, "remove");
  const removed = await manage(target, "update");
  assert.equal(removed.registered, 0);
  assert.equal(removed.helperPresent, false);
  await page.screenshot({
    path: path.resolve(".screenshots/hook-updates/notice-after.png"),
  });
  try {
    captures.push({ stage: "after", screenshot: await api("/screenshot", {}) });
  } catch (error) {
    captures.push({ stage: "after", error: String(error) });
  }
  await fs.writeFile(
    ".screenshots/hook-updates/results.json",
    JSON.stringify(
      { health, results, captures, staleRemovedUpdate: "no reinstall" },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ results, staleRemovedUpdate: "no reinstall" }));
} finally {
  for (const target of targets) {
    try {
      await manage(target, "remove");
    } catch {}
  }
  assert.ok(
    path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep),
  );
  assert.ok(path.basename(root).startsWith("laymux-hook-updates-"));
  await fs.rm(root, { recursive: true, force: true });
  linux(
    "sh",
    "-c",
    'case "$1" in /tmp/laymux-hook-updates-*) rm -rf -- "$1" ;; *) exit 1 ;; esac',
    "sh",
    linuxBase,
  );
  await refresh();
  await browser.close();
}
