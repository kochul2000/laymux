// Windows에서 dev WebView의 실제 포인터 클릭과 PTY 인자를 검증한다.
// 실행: node scripts/verify-agent-resume-links.mjs [--narrow]
// WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9339인 dev가 필요하다.
import { chromium } from "../ui/node_modules/playwright-core/index.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = "http://127.0.0.1:19281/api/v1";
const repo = fileURLToPath(new URL("../", import.meta.url));
const narrow = process.argv.includes("--narrow");
const artifacts = path.join(
  repo,
  ".screenshots",
  "agent-resume-links",
  narrow ? "narrow" : "normal",
);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const uuid = "11111111-2222-4333-8444-555555555555";

async function api(endpoint, body, method = body ? "POST" : "GET") {
  const response = await fetch(root + endpoint, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const raw = await response.text();
  const result = raw ? JSON.parse(raw) : {};
  if (!response.ok || result.success === false)
    throw new Error(`${endpoint}: ${JSON.stringify(result)}`);
  return result;
}

const health = await api("/health");
if (
  health.instance.buildKind !== "dev" ||
  path.resolve(health.instance.worktreeRoot).toLowerCase() !==
    path.resolve(repo).toLowerCase()
) {
  throw new Error("현재 워크트리의 dev 인스턴스가 아닙니다.");
}
await mkdir(artifacts, { recursive: true });
const browser = await chromium.connectOverCDP(
  process.env.LAYMUX_RESUME_CDP ?? "http://127.0.0.1:9339",
);
const page = browser
  .contexts()
  .flatMap((context) => context.pages())
  .find((candidate) =>
    /^http:\/\/(localhost|127\.0\.0\.1):\d+\/$/.test(candidate.url()),
  );
if (!page) throw new Error("dev WebView 문서를 찾을 수 없습니다.");
async function readBuffer(id) {
  return page.evaluate(async (id) => {
    const { getTerminalInspector } =
      await import("/src/lib/terminal-serialize-registry.ts");
    const inspect =
      getTerminalInspector(id) ??
      getTerminalInspector(id.replace(/^terminal-/, ""));
    if (!inspect) throw new Error(`${id}의 실제 xterm 버퍼가 없습니다.`);
    return inspect(0);
  }, id);
}
const originalWorkspace = (await api("/workspaces/active")).workspace.id;
const settings = await page.evaluate(async () => {
  const { useSettingsStore } = await import("/src/stores/settings-store.ts");
  const s = useSettingsStore.getState();
  return { claude: s.claude, codex: s.codex, grok: s.grok };
});
let workspace;
let originalSize;
const results = [];
try {
  await api("/ui/remote-access", { open: false });
  if (narrow) {
    originalSize = await page.evaluate(async () => {
      const { getCurrentWindow, LogicalSize } =
        await import("/node_modules/@tauri-apps/api/window.js");
      const win = getCurrentWindow();
      const size = await win.innerSize();
      await win.setSize(new LogicalSize(620, 800));
      return size;
    });
  }
  // 디스크를 저장하지 않고 검증 중의 런타임 설정만 교체한다.
  await page.evaluate(async () => {
    const { useSettingsStore } = await import("/src/stores/settings-store.ts");
    const s = useSettingsStore.getState();
    useSettingsStore.setState({
      claude: { ...s.claude, command: "claude --dangerously-skip-permissions" },
      codex: { ...s.codex, command: "codex --yolo --no-daemon" },
      grok: { ...s.grok, command: "grok --yolo" },
    });
  });
  workspace = (
    await api("/workspaces", {
      name: "복원 링크 dev 검증",
      layoutId: "default-layout",
    })
  ).workspace.id;
  await api("/workspaces/active", { id: workspace });
  await api(
    "/panes/0/view",
    { type: "TerminalView", profile: "PowerShell" },
    "PUT",
  );
  await api("/panes/split", {
    paneIndex: 0,
    direction: "horizontal",
    profile: "WSL",
    cwd: "/tmp",
  });
  await pause(2500);
  // 좁은 창의 기존 모바일 안내가 테스트 링크 위를 덮지 않게 닫는다.
  await api("/ui/remote-access", { open: false });
  for (const pane of (await api("/workspaces/active")).workspace.panes) {
    const id = pane.terminalId;
    const windows = pane.view.profile === "PowerShell";
    // 이 검증용 셸에서만 함수를 정의해 CLI 인자와 CWD를 기록한다.
    const shim = windows
      ? "function global:codex { Write-Host ('RESUME_ARGS:' + ($args -join '|')); Write-Host ('RESUME_CWD:' + (Get-Location).Path) }; function global:claude { codex @args }; function global:grok { codex @args }"
      : 'codex(){ printf \'RESUME_ARGS:%s\\n\' "$*"; printf \'RESUME_CWD:%s\\n\' "$PWD"; }; claude(){ codex "$@"; }; grok(){ codex "$@"; }';
    await api(`/terminals/${id}/write`, { data: shim + "\r" });
    await pause(700);
    for (const provider of ["codex", "claude", "grok"]) {
      const hint = `${provider} ${provider === "codex" ? "resume" : "--resume"} ${uuid}`;
      const print = windows
        ? `Clear-Host; Write-Host 'Resume this session with:'; Write-Host '  ${hint}'`
        : `clear; printf 'Resume this session with:\\n  ${hint}\\n'`;
      await api(`/terminals/${id}/write`, { data: print + "\r" });
      await pause(1000);
      let shell = false;
      for (let attempt = 0; attempt < 24; attempt++) {
        await pause(500);
        shell = await page.evaluate(async (id) => {
          const { useTerminalStore } =
            await import("/src/stores/terminal-store.ts");
          const t = useTerminalStore
            .getState()
            .instances.find((item) => item.id === id);
          return t?.sessionReady && t.activity?.type === "shell";
        }, id);
        if (shell) break;
      }
      if (!shell) throw new Error(`${id}가 셸 대기 상태가 아닙니다.`);
      const dump = await readBuffer(id);
      const line = dump.lines.find((line) =>
        line.text.trimStart().startsWith(provider + " "),
      );
      if (!line)
        throw new Error(
          `${pane.view.profile} ${provider}: 복원 안내를 찾지 못했습니다.`,
        );
      const screen = await page
        .locator(`[data-testid="terminal-view-${id}"] .xterm-screen`)
        .boundingBox();
      const x = screen.x + (3.5 * screen.width) / dump.cols;
      const y =
        screen.y +
        ((line.index - dump.baseY + 0.5) * screen.height) / dump.rows;
      await page.mouse.move(x, y);
      await pause(350);
      const screenshot = path.join(
        artifacts,
        `${pane.view.profile}-${provider}.png`,
      );
      await page.screenshot({ path: screenshot });
      await page.mouse.click(x, y);
      const args =
        provider === "codex"
          ? ["--yolo", "--no-daemon", "resume", uuid]
          : provider === "claude"
            ? ["--dangerously-skip-permissions", "--resume", uuid]
            : ["--yolo", "--resume", uuid];
      const marker = "RESUME_ARGS:" + args.join(windows ? "|" : " ");
      let output = "";
      for (let attempt = 0; attempt < 20; attempt++) {
        await pause(500);
        const after = await readBuffer(id);
        output = after.lines
          .map((line) => (line.isWrapped ? "" : "\n") + line.text)
          .join("");
        if (output.includes(marker)) break;
      }
      if (
        !output.includes(marker) ||
        output.split("RESUME_ARGS:").length - 1 !== 1
      ) {
        throw new Error(
          `${pane.view.profile} ${provider}: 제출 인자 또는 횟수가 다릅니다.\n${output}`,
        );
      }
      const cwd = output
        .split("\n")
        .find((line) => line.startsWith("RESUME_CWD:"));
      const expectedCwd = windows ? undefined : "RESUME_CWD:/tmp";
      if (expectedCwd && cwd !== expectedCwd)
        throw new Error(`WSL CWD가 바뀌었습니다: ${cwd}`);
      results.push({
        profile: pane.view.profile,
        provider,
        args,
        cwd,
        cols: dump.cols,
        screenshot,
        status: "passed",
      });
      console.log(JSON.stringify(results.at(-1)));
    }
  }
} finally {
  await writeFile(
    path.join(artifacts, "results.json"),
    JSON.stringify({ health, narrow, results }, null, 2),
  );
  await page.evaluate(async (settings) => {
    const { useSettingsStore } = await import("/src/stores/settings-store.ts");
    useSettingsStore.setState(settings);
  }, settings);
  if (workspace) await api(`/workspaces/${workspace}`, undefined, "DELETE");
  await api("/workspaces/active", { id: originalWorkspace });
  if (originalSize) {
    await page.evaluate(async (size) => {
      const { getCurrentWindow } =
        await import("/node_modules/@tauri-apps/api/window.js");
      const { PhysicalSize } =
        await import("/node_modules/@tauri-apps/api/dpi.js");
      await getCurrentWindow().setSize(
        new PhysicalSize(size.width, size.height),
      );
    }, originalSize);
  }
  await browser.close();
}
