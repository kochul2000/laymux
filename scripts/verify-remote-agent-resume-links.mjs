// dev 전용 Remote 페이지의 실제 클릭 → 호스트 PTY 검증.
// 실행: node scripts/verify-remote-agent-resume-links.mjs [--narrow]
import { chromium } from "../ui/node_modules/playwright-core/index.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const host = "http://127.0.0.1:19281";
const narrow = process.argv.includes("--narrow");
const touch = process.argv.includes("--touch");
const repo = fileURLToPath(new URL("../", import.meta.url));
const artifacts = path.join(
  repo,
  ".screenshots/remote-agent-resume-links",
  narrow ? "narrow" : "normal",
);
const uuid = "11111111-2222-4333-8444-555555555555";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function api(endpoint, body, method = body ? "POST" : "GET") {
  const response = await fetch(host + "/api/v1" + endpoint, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const value = await response.json();
  if (!response.ok || value.success === false)
    throw new Error(`${endpoint}: ${JSON.stringify(value)}`);
  return value;
}
const health = await api("/health");
if (
  health.instance.buildKind !== "dev" ||
  path.resolve(health.instance.worktreeRoot).toLowerCase() !==
    path.resolve(repo).toLowerCase()
)
  throw new Error("현재 워크트리의 dev 인스턴스가 아닙니다.");
await mkdir(artifacts, { recursive: true });
const desktop = await chromium.connectOverCDP(
  process.env.LAYMUX_RESUME_CDP ?? "http://127.0.0.1:9339",
);
const page = desktop
  .contexts()
  .flatMap((context) => context.pages())
  .find((candidate) =>
    /^http:\/\/(localhost|127\.0\.0\.1):\d+\/$/.test(candidate.url()),
  );
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
if (control.lease)
  throw new Error("기존 Remote 제어권이 있어 검증을 진행하지 않습니다.");
const savedSettings = await invoke("load_settings");
const originalWorkspace = (await api("/workspaces/active")).workspace.id;
const token = access.effectiveAuthToken || "resume-dev-verification";
let browser;
let workspace;
let ownedLease;
const results = [];
const remoteApi = async (endpoint, body) => {
  const response = await fetch(host + "/remote/v1" + endpoint, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const value = await response.json();
  if (!response.ok) throw new Error(`${endpoint}: ${JSON.stringify(value)}`);
  return value;
};
try {
  const configured = structuredClone(savedSettings);
  configured.claude.command = "claude --dangerously-skip-permissions";
  configured.codex.command = "codex --yolo --no-daemon";
  configured.grok.command = "grok --yolo";
  await invoke("save_settings", { settings: configured });
  await invoke("set_remote_runtime_access", {
    enabled: true,
    authToken: token,
  });
  browser = await chromium.launch({ channel: "msedge", headless: true });
  for (const profile of ["PowerShell", "WSL"]) {
    const windows = profile === "PowerShell";
    workspace = (
      await api("/workspaces", {
        name: "Remote 복원 링크 검증",
        layoutId: "default-layout",
      })
    ).workspace.id;
    await api("/workspaces/active", { id: workspace });
    await api(
      "/panes/0/view",
      { type: "TerminalView", profile, ...(windows ? {} : { cwd: "/tmp" }) },
      "PUT",
    );
    await pause(2500);
    const pane = (await api("/workspaces/active")).workspace.panes[0];
    const id = pane.terminalId;
    const shim = windows
      ? "function global:codex { Write-Host ('RESUME_ARGS:' + ($args -join '|')); Write-Host ('RESUME_CWD:' + (Get-Location).Path) }; function global:claude { codex @args }; function global:grok { codex @args }"
      : 'cd /tmp; codex(){ printf \'RESUME_ARGS:%s\\n\' "$*"; printf \'RESUME_CWD:%s\\n\' "$PWD"; }; claude(){ codex "$@"; }; grok(){ codex "$@"; }';
    await api(`/terminals/${id}/write`, { data: shim + "\r" });
    await pause(700);
    const context = await browser.newContext({
      viewport: { width: narrow ? 420 : 1280, height: 800 },
      hasTouch: touch,
    });
    await context.addInitScript(() => {
      let Constructor;
      Object.defineProperty(window, "Terminal", {
        configurable: true,
        get: () => Constructor,
        set: (value) => {
          Constructor = class extends value {
            constructor(...args) {
              super(...args);
              window.__resumeTerminal = this;
            }
          };
        },
      });
    });
    const remote = await context.newPage();
    const claimed = remote.waitForResponse(
      (response) =>
        response.url().endsWith("/remote/v1/session/claim") && response.ok(),
    );
    await remote.goto(
      host +
        "/remote/#" +
        new URLSearchParams({
          token,
          autoConnect: "1",
          clientName: "resume-dev-verification",
        }),
    );
    await remote.waitForFunction(
      () =>
        window.__resumeTerminal?.element &&
        document.getElementById("connect").disabled,
      { timeout: 30000 },
    );
    await pause(1800);
    const lease = (await (await claimed).json()).leaseId;
    ownedLease = lease;
    const readBuffer = () =>
      remote.evaluate(() => {
        const term = window.__resumeTerminal;
        const buffer = term.buffer.active;
        const lines = [];
        for (let index = 0; index < buffer.length; index++) {
          const line = buffer.getLine(index);
          lines.push({
            index,
            text: line.translateToString(true),
            isWrapped: line.isWrapped,
          });
        }
        return {
          cols: term.cols,
          rows: term.rows,
          viewportY: buffer.viewportY,
          lines,
        };
      });
    for (const provider of ["codex", "claude", "grok"]) {
      const hint = `${provider} ${provider === "codex" ? "resume" : "--resume"} ${uuid}`;
      const print = windows
        ? `Clear-Host; Write-Host 'Resume this session with:'; Write-Host '  ${hint}'`
        : `clear; printf 'Resume this session with:\\n  ${hint}\\n'`;
      await remoteApi(`/terminals/${id}/write`, {
        leaseId: lease,
        data: print + "\r",
      });
      await pause(1700);
      await page.waitForFunction(
        async (id) => {
          const { useTerminalStore } =
            await import("/src/stores/terminal-store.ts");
          const instance = useTerminalStore
            .getState()
            .instances.find((item) => item.id === id);
          return instance?.sessionReady && instance.activity?.type === "shell";
        },
        id,
        { timeout: 30000 },
      );
      let hostInfo;
      for (let attempt = 0; attempt < 40; attempt++) {
        const hostNavigation = await remoteApi("/navigation");
        hostInfo = hostNavigation.terminals.find((info) => info.id === id);
        if (hostInfo?.activity?.type === "shell" && !hostInfo.commandRunning)
          break;
        await pause(500);
      }
      if (hostInfo?.activity?.type !== "shell" || hostInfo.commandRunning)
        throw new Error(
          `${profile}: 호스트 셸 상태 미확정 ${JSON.stringify({ activity: hostInfo?.activity, commandRunning: hostInfo?.commandRunning })}`,
        );
      const [navigation] = await Promise.all([
        remote.waitForResponse(
          (response) =>
            response.url().endsWith("/remote/v1/navigation") && response.ok(),
        ),
        remote.evaluate(() => document.getElementById("refresh").click()),
      ]);
      const snapshot = await navigation.json();
      const info = snapshot.terminals.find((info) => info.id === id);
      if (info?.activity?.type !== "shell" || info.commandRunning)
        throw new Error(`${profile}: 호스트가 셸 대기 상태가 아닙니다.`);
      await pause(2500);
      const dump = await readBuffer();
      const line = dump.lines.findLast((line) =>
        line.text.trimStart().startsWith(provider + " "),
      );
      if (!line) throw new Error(`${profile} ${provider}: 안내 없음`);
      const screen = await remote
        .locator("#terminal .xterm-screen")
        .boundingBox();
      const x = screen.x + (3.5 * screen.width) / dump.cols;
      const y =
        screen.y +
        ((line.index - dump.viewportY + 0.5) * screen.height) / dump.rows;
      if (!touch) {
        await remote.mouse.move(0, 0);
        // xterm은 같은 buffer 셀로 돌아오면 hover를 재조회하지 않으므로 다른 행을 거친다.
        await remote.mouse.move(screen.x + 4, screen.y + 4);
        await remote.mouse.move(x, y);
      }
      await pause(250);
      await remote.screenshot({
        path: path.join(artifacts, `${profile}-${provider}.png`),
      });
      if (touch) await remote.touchscreen.tap(x, y);
      else await remote.mouse.click(x, y);
      const args =
        provider === "codex"
          ? ["--yolo", "--no-daemon", "resume", uuid]
          : provider === "claude"
            ? ["--dangerously-skip-permissions", "--resume", uuid]
            : ["--yolo", "--resume", uuid];
      const marker = "RESUME_ARGS:" + args.join(windows ? "|" : " ");
      let output = "";
      for (let attempt = 0; attempt < 24; attempt++) {
        await pause(500);
        output = (await readBuffer()).lines
          .map((line) => (line.isWrapped ? "" : "\n") + line.text)
          .join("");
        if (output.includes(marker) && output.includes("RESUME_CWD:")) break;
      }
      if (
        !output.includes(marker) ||
        output.split("RESUME_ARGS:").length - 1 !== 1
      )
        throw new Error(
          `${profile} ${provider}: 인자/횟수 실패\n${output}\n${await remote.locator("#statusText").innerText()}`,
        );
      const cwd = output
        .split("\n")
        .find((line) => line.startsWith("RESUME_CWD:"));
      if (!windows && cwd !== "RESUME_CWD:/tmp")
        throw new Error(`WSL CWD 변경: ${cwd}`);
      results.push({
        profile,
        provider,
        args,
        cwd,
        cols: dump.cols,
        status: "passed",
      });
      console.log(JSON.stringify(results.at(-1)));
    }
    await remoteApi("/session/release", { leaseId: lease });
    ownedLease = undefined;
    await context.close();
    await api(`/workspaces/${workspace}`, undefined, "DELETE");
    workspace = undefined;
  }
} finally {
  const cleanupErrors = [];
  const clean = async (label, operation) => {
    try {
      await operation();
    } catch (error) {
      cleanupErrors.push(new Error(`${label}: ${error.message}`));
    }
  };
  if (ownedLease)
    await clean("lease release", () =>
      remoteApi("/session/release", { leaseId: ownedLease }),
    );
  await clean("browser close", () => browser?.close());
  await clean("settings restore", () =>
    invoke("save_settings", { settings: savedSettings }),
  );
  await clean("runtime restore", () =>
    invoke("set_remote_runtime_access", {
      enabled: access.runtimeEnabled,
      authToken: access.effectiveAuthToken || null,
    }),
  );
  if (workspace)
    await clean("workspace remove", () =>
      api(`/workspaces/${workspace}`, undefined, "DELETE"),
    );
  await clean("workspace restore", () =>
    api("/workspaces/active", { id: originalWorkspace }),
  );
  await clean("results save", () =>
    writeFile(
      path.join(artifacts, "results.json"),
      JSON.stringify({ health, narrow, touch, results }, null, 2),
    ),
  );
  await clean("CDP close", () => desktop.close());
  if (cleanupErrors.length)
    throw new AggregateError(cleanupErrors, "dev 검증 환경 복구 실패");
}
