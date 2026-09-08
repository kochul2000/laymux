// Windows dev integration check. Real CLIs may consume their configured account usage.
/* global URL, fetch, AbortSignal, Buffer, setTimeout, clearTimeout, localStorage, getComputedStyle, document, structuredClone */
// LAYMUX_REPRO_ISOLATED=1 node scripts/check-settings-mcp-agents.mjs [claude|codex|grok]
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, createWriteStream, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { scenarios } from "./settings-mcp-scenarios.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const artifacts = path.join(root, ".tmp/settings-mcp-agent-check");
const base = "http://127.0.0.1:19281";
assert.equal(process.env.LAYMUX_REPRO_ISOLATED, "1", "임시 APPDATA의 dev만 사용하세요.");
const health = await (await fetch(`${base}/api/v1/health`)).json();
assert.equal(health.instance.buildKind, "dev");
assert.equal(health.port, 19281);
assert.equal(
  path.resolve(health.instance.worktreeRoot).toLowerCase(),
  path.resolve(root).toLowerCase(),
);
mkdirSync(artifacts, { recursive: true });
mkdirSync(path.join(artifacts, ".grok"), { recursive: true });
writeFileSync(
  path.join(artifacts, "mcp.json"),
  JSON.stringify({ mcpServers: { "laymux-dev": { type: "http", url: `${base}/mcp` } } }),
);
writeFileSync(
  path.join(artifacts, ".grok/config.toml"),
  `[mcp_servers.laymux-dev]\ntransport = "http"\nurl = "${base}/mcp"\n`,
);

let session;
let sequence = 0;
async function rpc(method, params, notification = false) {
  const id = ++sequence;
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(session ? { "Mcp-Session-Id": session } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id }), method, params }),
    signal: AbortSignal.timeout(35000),
  });
  session = response.headers.get("mcp-session-id") || session;
  const text = await response.text();
  assert(response.ok, `${method}: ${response.status} ${text.slice(0, 300)}`);
  if (!text || notification) return null;
  const message = text.startsWith("{")
    ? JSON.parse(text)
    : text
        .split("\n")
        .filter((line) => line.startsWith("data:") && line.slice(5).trim())
        .map((line) => JSON.parse(line.slice(5)))
        .find((value) => value.id === id);
  assert(message && !message.error, JSON.stringify(message));
  return message.result;
}
await rpc("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "settings-mcp-check", version: "1" },
});
await rpc("notifications/initialized", {}, true);
async function call(name, args = {}) {
  const result = await rpc("tools/call", { name, arguments: args });
  const text = result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  assert(!result.isError, `${name}: ${text}`);
  return JSON.parse(text);
}

const desktop = await chromium.connectOverCDP("http://127.0.0.1:9230");
const desktopPage = desktop
  .contexts()
  .flatMap((context) => context.pages())
  .find((page) => page.url().startsWith("http://localhost:1420"));
assert(desktopPage, "dev WebView가 필요합니다.");
const remoteAccess = await desktopPage.evaluate(async () => {
  const api = await import("/src/lib/tauri-api.ts");
  const { generateRemoteToken } = await import("/src/lib/remote-hosts.ts");
  const before = await api.getRemoteAccessStatus();
  const access = await api.setRemoteRuntimeAccess(
    true,
    before.effectiveAuthToken || generateRemoteToken(),
  );
  return { beforeEnabled: before.runtimeEnabled, token: access.effectiveAuthToken };
});
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 430, height: 900 } });
page.on("pageerror", (error) => console.error("Remote page:", error.message));
const providers = process.argv[2] ? [process.argv[2]] : ["claude", "codex", "grok"];
const names = [
  "get_settings_context",
  "describe_settings",
  "get_settings",
  "validate_settings",
  "update_settings",
  "describe_remote_settings",
  "get_remote_settings",
  "validate_remote_settings",
  "update_remote_settings",
];
const reports = [];
async function connectRemote() {
  const context = await call("get_settings_context");
  if (context.defaultScope !== "remoteDevice" || !context.targetReady) {
    await page.locator("#connect").evaluate((button) => button.click());
  }
  for (let i = 0; i < 80; i++) {
    const current = await call("get_settings_context");
    if (current.defaultScope === "remoteDevice" && current.targetReady) return;
    await page.waitForTimeout(200);
  }
  throw new Error("Remote 설정 snapshot 준비 시간 초과");
}
try {
  await page.goto(`${base}/remote/#token=${encodeURIComponent(remoteAccess.token)}`);
  await connectRemote();
  const originalPc = (await call("get_settings")).settings;
  const originalRemote = await call("get_remote_settings");
  const fontDescription = await call("describe_settings", { paths: ["/profileDefaults/font"] });
  console.log(
    JSON.stringify({
      phase: "준비",
      device: originalRemote.clientId,
      fontDescriptionBytes: Buffer.byteLength(JSON.stringify(fontDescription)),
    }),
  );
  for (const provider of providers)
    for (const scenario of scenarios.filter(
      (item) => !process.argv[3] || item.id === process.argv[3],
    )) {
      const runId = `${provider}-${scenario.id}`;
      if (scenario.scope === "pc") await page.locator("#exit").evaluate((button) => button.click());
      for (let i = 0; i < 50; i++) {
        if ((await call("get_settings_context")).defaultScope === scenario.scope) break;
        await page.waitForTimeout(200);
      }
      assert.equal((await call("get_settings_context")).defaultScope, scenario.scope);
      assert(["claude", "codex", "grok"].includes(provider));
      const prompt =
        "laymux-dev MCP 설정 기능을 사용해줘. 소스코드·파일·셸·웹 검색 대신 MCP 설명과 현재 값만 사용해. 시험용 dev이므로 변경을 지금 저장해도 돼. 사용자가 대상을 생략한 요청의 실행 맥락은 MCP로 직접 판단해. " +
        scenario.prompt +
        " 설명→현재값→검증→저장→재조회 순서로 수행하고 결과를 보고해. 지원하지 않는 요청은 다른 설정으로 대체하지 마. 복원은 외부 검증기가 하므로 네가 되돌리지 마.";
      writeFileSync(path.join(artifacts, "prompt.txt"), prompt);
      let executable = provider === "claude" ? "claude.exe" : "grok.exe";
      let args;
      if (provider === "claude") {
        args = [
          "-p",
          prompt,
          "--mcp-config",
          "mcp.json",
          "--strict-mcp-config",
          "--tools",
          "",
          "--allowedTools",
          names.map((name) => `mcp__laymux-dev__${name}`).join(","),
          "--output-format",
          "stream-json",
          "--verbose",
          "--disable-slash-commands",
          "--no-session-persistence",
        ];
      } else if (provider === "codex") {
        const cmdPath = execFileSync("where.exe", ["codex.cmd"], {
          encoding: "utf8",
          windowsHide: true,
        })
          .trim()
          .split(/\r?\n/)[0];
        executable = process.execPath;
        args = [
          path.join(path.dirname(cmdPath), "node_modules/@openai/codex/bin/codex.js"),
          "exec",
          "--ignore-user-config",
          "--skip-git-repo-check",
          "--ephemeral",
          "--sandbox",
          "read-only",
          "-c",
          `mcp_servers.laymux-dev.url="${base}/mcp"`,
          "-c",
          `mcp_servers.laymux-dev.enabled_tools=${JSON.stringify(names)}`,
          ...names.flatMap((name) => [
            "-c",
            `mcp_servers.laymux-dev.tools.${name}.approval_mode="approve"`,
          ]),
          "--json",
          prompt,
        ];
      } else {
        args = [
          "--prompt-file",
          "prompt.txt",
          "--tools",
          "",
          "--no-subagents",
          "--disable-web-search",
          ...names.flatMap((name) => ["--allow", `mcp__laymux-dev__${name}`]),
          "--output-format",
          "streaming-messages-json",
          "--max-turns",
          "30",
        ];
      }
      console.log(`${provider}: 실제 설정 변경 시작`);
      const log = createWriteStream(path.join(artifacts, `${runId}.jsonl`));
      let failure;
      try {
        await new Promise((resolve, reject) => {
          const child = spawn(executable, args, {
            cwd: artifacts,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
          });
          child.stdout.pipe(log);
          child.stderr.pipe(log);
          const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`${provider}: 5분 제한 초과`));
          }, 300000);
          child.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
          });
          child.once("exit", (code) => {
            clearTimeout(timer);
            if (code === 0) resolve();
            else reject(new Error(`${provider}: 종료 코드 ${code}`));
          });
        });
        const actualPc = (await call("get_settings")).settings;
        assert.equal((await call("get_settings_context")).defaultScope, scenario.scope);
        if (scenario.scope === "pc") {
          await connectRemote();
        }
        const actualRemote = await call("get_remote_settings");
        scenario.check(actualPc, actualRemote, originalPc, originalRemote);
        const deviceStorage = await page.evaluate(() => ({
          display: JSON.parse(localStorage.getItem("laymux.remote.displaySettings") || "{}"),
          keybar: JSON.parse(localStorage.getItem("laymux.remote.keybar") || "null"),
          menuSize: getComputedStyle(document.documentElement).getPropertyValue(
            "--remote-menu-font-size",
          ),
          floatingCount: document.querySelectorAll("#floatingControls > *").length,
        }));
        for (const [key, value] of Object.entries(deviceStorage.display))
          assert.equal(actualRemote.settings[key], value, key);
        assert.equal(deviceStorage.menuSize, actualRemote.settings.menuFontSize + "px");
        if (deviceStorage.keybar) {
          assert.deepEqual(
            deviceStorage.keybar.floating.buttons,
            actualRemote.settings.floatingButtons,
          );
          assert.deepEqual(deviceStorage.keybar.zones, actualRemote.settings.inputBarZones);
        }
        if (!actualRemote.settings.floatingEnabled) assert.equal(deviceStorage.floatingCount, 0);
        if (scenario.id === "remote") assert.equal(deviceStorage.floatingCount, 3);
        await page.screenshot({ path: path.join(artifacts, `${runId}-remote.png`) });
        const screenshot = await (
          await fetch(`${base}/api/v1/screenshot`, { method: "POST" })
        ).json();
        reports.push({
          provider,
          scenario: scenario.id,
          scope: scenario.scope,
          passed: true,
          pcScreenshot: screenshot.path ?? screenshot.data?.path,
        });
        console.log(`${provider}: PC·Remote 실제 값과 화면 검증 통과`);
      } catch (error) {
        failure = error;
        reports.push({ provider, scenario: scenario.id, passed: false, error: String(error) });
        console.error(String(error));
      } finally {
        await new Promise((resolve) => log.end(resolve));
        const transcript = readFileSync(path.join(artifacts, `${runId}.jsonl`), "utf8");
        const calls = transcript.split("\n").flatMap((line) => {
          try {
            const event = JSON.parse(line);
            if (event.type === "item.completed" && event.item?.type === "mcp_tool_call")
              return [event.item.tool];
            return (event.message?.content || [])
              .filter((item) => item.type === "tool_use")
              .map((item) =>
                (item.name === "use_tool" ? item.input.tool_name : item.name).split("__").at(-1),
              );
          } catch {
            return [];
          }
        });
        const firstWrite = calls.findIndex((name) =>
          ["update_settings", "update_remote_settings"].includes(name),
        );
        if (
          firstWrite < 0 ||
          calls.slice(0, firstWrite).filter((name) => name === "get_settings_context").length < 2
        ) {
          reports[reports.length - 1].passed = false;
          reports[reports.length - 1].error = "첫 저장 전 실행 맥락 조회·재확인이 필요합니다.";
          failure = new Error(reports[reports.length - 1].error);
        }
        const patch = Object.fromEntries(
          [
            "profileDefaults",
            "appearance",
            "power",
            "terminal",
            "paste",
            "keybindings",
            "profiles",
            "widgets",
            "remote",
          ].map((key) => [key, structuredClone(originalPc[key])]),
        );
        delete patch.terminal.composerStarredEntries;
        for (const key of ["cloudInstanceId", "cloudTunnelUrl", "cloudServerBaseUrl"])
          delete patch.remote[key];
        await call("update_settings", { patch });
        await connectRemote();
        const latest = await call("get_remote_settings");
        await call("update_remote_settings", {
          client_id: latest.clientId,
          expected_revision: latest.revision,
          patch: originalRemote.settings,
        });
        console.log(`${provider}: 시험 전 설정 복원 완료`);
      }
      if (failure) process.exitCode = 1;
    }
} finally {
  writeFileSync(
    path.join(artifacts, `report-${providers.join("-")}.json`),
    JSON.stringify(reports, null, 2),
  );
  try {
    await page.locator("#exit").evaluate((button) => button.click(), undefined, { timeout: 1000 });
  } catch {
    /* Closing the isolated context also ends its lease. */
  }
  await browser.close();
  await desktopPage.evaluate(async (beforeEnabled) => {
    const api = await import("/src/lib/tauri-api.ts");
    await api.setRemoteRuntimeAccess(beforeEnabled);
  }, remoteAccess.beforeEnabled);
  await desktop.close();
}
