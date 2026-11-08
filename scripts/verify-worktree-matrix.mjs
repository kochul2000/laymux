// dev(19281) 전용. --setup → --stage normal → GUI 재시작 → --stage adopt
// → kill-dev.sh --with-daemon 후 재시작 → --stage disk → --restore.
// Windows/기본 WSL/명시적 WSL × 원본/워크트리 루트·하위 폴더를 PC·Remote로 확인한다.
// 각 재시작 직전 --watch-restart adopt|disk를 별도 프로세스에서 실행한다.
// watch-*-ready.json 이후 GUI를 재기동하고, watch-*-connected.json 이후
// --warm으로 검증 PTY를 연결한다. watcher 완료 뒤 해당 --stage를 실행한다.
// 실패 시에도 마지막 --restore로 임시 Remote 설정·활성 workspace를 복원한다.
// PTY 보존을 비교하는 재기동은 VITE_LAYMUX_STRICT_MODE=0으로 실행한다.
// 기본 dev의 StrictMode는 의도적으로 PTY를 닫고 다시 연다(재현 방법론 §4.7).
// 이미 기본 dev에서 normal을 완료했다면 --restart-baseline으로 재시작 직전
// 셸 표식을 다시 기록하고, 재기동할 dev에서 StrictMode를 해제한다.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { chromium } from "../ui/node_modules/playwright-core/index.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const artifacts = path.join(root, ".screenshots/worktree-matrix");
const stateFile = path.join(artifacts, "session.json");
const host = "http://127.0.0.1:19281";
await mkdir(artifacts, { recursive: true });
const normalize = (value) =>
  value
    .replaceAll("\\", "/")
    .replace(/^\/mnt\/([a-z])\//, (_, drive) => `${drive.toUpperCase()}:/`);
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
async function until(read, accept, label, timeout = 60_000) {
  let last;
  const end = Date.now() + timeout;
  do {
    last = await read();
    if (accept(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 300));
  } while (Date.now() < end);
  assert.fail(`${label}: ${JSON.stringify(last)}`);
}
async function api(route, body, method = body === undefined ? "GET" : "POST") {
  const response = await fetch(host + "/api/v1" + route, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  assert.ok(
    response.ok && value.success !== false,
    `${route}: ${JSON.stringify(value)}`,
  );
  return value;
}
const health = await api("/health");
assert.equal(health.instance.buildKind, "dev");
assert.equal(
  path.resolve(health.instance.worktreeRoot).toLowerCase(),
  path.resolve(root).toLowerCase(),
);
let desktopBrowser = await chromium.connectOverCDP("http://127.0.0.1:9342");
let desktop = desktopBrowser
  .contexts()
  .flatMap((context) => context.pages())
  .find((page) =>
    /^http:\/\/(localhost|127\.0\.0\.1):1420\/$/.test(page.url()),
  );
assert.ok(desktop, "dev WebView");
const invoke = (command, args = {}) =>
  desktop.evaluate(
    async ({ command, args }) => {
      const { invoke } = await import("/node_modules/@tauri-apps/api/core.js");
      return invoke(command, args);
    },
    { command, args },
  );
const persist = () =>
  desktop.evaluate(async () => {
    const { persistSession } = await import("/src/lib/persist-session.ts");
    await persistSession();
  });
const save = (state) =>
  writeFile(stateFile, JSON.stringify(state, null, 2) + "\n");
function run(command, args, input, encoding = "utf8") {
  const result = spawnSync(command, args, {
    input,
    encoding,
    windowsHide: true,
    timeout: 30_000,
  });
  assert.equal(
    result.status,
    0,
    result.error?.message || result.stderr?.toString(),
  );
  return result.stdout;
}
function git(env, cwd, ...args) {
  const argv = [
    "-C",
    env.wsl ? guest(env, cwd) : cwd,
    "-c",
    "core.hooksPath=",
    "-c",
    "commit.gpgsign=false",
    ...args.map((argument) =>
      env.wsl &&
      normalize(argument).startsWith(`//wsl.localhost/${env.distro}/`)
        ? guest(env, argument)
        : argument,
    ),
  ];
  return run(
    env.wsl ? "wsl.exe" : "git",
    env.wsl ? ["-d", env.distro, "--exec", "git", ...argv] : argv,
  ).trim();
}
function guest(env, value) {
  return env.wsl
    ? normalize(value).replace(`//wsl.localhost/${env.distro}`, "")
    : value;
}
async function createFixture(env) {
  const base = env.wsl
    ? `//wsl.localhost/${env.distro}${run("wsl.exe", ["-d", env.distro, "--exec", "mktemp", "-d", "/tmp/laymux-matrix-XXXXXX"]).trim()}`
    : normalize(await mkdtemp(path.join(os.tmpdir(), "laymux-matrix-")));
  const main = `${base}/main`;
  await mkdir(`${main}/sub`, { recursive: true });
  git(env, main, "init", "-b", "main");
  git(env, main, "config", "user.name", "Laymux matrix verification");
  git(env, main, "config", "user.email", "laymux-dev@example.invalid");
  await writeFile(`${main}/README.md`, `matrix ${env.name}\n`);
  await writeFile(`${main}/sub/keep.txt`, "subdirectory fixture\n");
  await writeFile(`${main}/.gitignore`, "secret.txt\n");
  git(env, main, "add", ".");
  git(env, main, "commit", "-m", "fixture");
  const trees = {};
  for (const name of [
    "linked",
    "clean",
    "dirty",
    "untracked",
    "ignored",
    "locked",
  ]) {
    trees[name] = `${base}/${name}`;
    git(env, main, "worktree", "add", "-b", name, trees[name]);
  }
  trees.detached = `${base}/detached`;
  git(env, main, "worktree", "add", "--detach", trees.detached);
  await writeFile(`${trees.dirty}/README.md`, `changed matrix ${env.name}\n`);
  await writeFile(`${trees.untracked}/notes.txt`, "matrix untracked\n");
  await writeFile(`${trees.ignored}/secret.txt`, "matrix ignored\n");
  git(env, main, "worktree", "lock", trees.locked);
  return { base, main, trees };
}
async function configureRemote(state, restore = false) {
  await desktop.evaluate(
    async ({ remote }) => {
      const { useSettingsStore } =
        await import("/src/stores/settings-store.ts");
      useSettingsStore.getState().setRemote(remote);
    },
    {
      remote: restore
        ? state.originalRemote
        : {
            ...state.originalRemote,
            enabled: true,
            authToken: state.token,
            allowedIps: ["127.0.0.1/32", "::1/128"],
            tailscaleOnly: false,
          },
    },
  );
  await persist();
}
async function setup() {
  assert.ok(
    !(await invoke("get_remote_control_status")).lease,
    "기존 Remote 제어권을 침범하지 않는다",
  );
  const metadata = await desktop.evaluate(async () => {
    const { useSettingsStore } = await import("/src/stores/settings-store.ts");
    const state = useSettingsStore.getState();
    return {
      remote: state.remote,
      native: state.profiles.find((profile) => profile.name === "PowerShell")
        ?.commandLine,
    };
  });
  const bytes = run("wsl.exe", ["--list", "--verbose"], undefined, null);
  const distro = bytes
    .toString(bytes[1] === 0 ? "utf16le" : "utf8")
    .replaceAll("\0", "")
    .match(/^\s*\*\s+(\S+)/m)?.[1];
  assert.ok(distro && !/^docker-/i.test(distro), "기본 일반 WSL 배포판");
  const state = {
    token: crypto.randomUUID(),
    originalRemote: metadata.remote,
    originalAccess: await invoke("get_remote_access_status"),
    originalWorkspace: (await api("/workspaces/active")).workspace.id,
    environments: [],
    stages: {},
  };
  await save(state);
  for (const [name, commandLine, wsl] of [
    ["windows", metadata.native || "powershell.exe", false],
    ["wsl-default", "wsl.exe", true],
    ["wsl-explicit", `wsl.exe -d ${distro}`, true],
  ]) {
    const env = {
      name,
      commandLine,
      wsl,
      distro,
      profile: `Matrix ${name} ${state.token.slice(0, 6)}`,
    };
    env.fixture = await createFixture(env);
    await desktop.evaluate(
      async ({ env }) => {
        const { useSettingsStore, makeProfileFromDefaults } =
          await import("/src/stores/settings-store.ts");
        const state = useSettingsStore.getState();
        state.addProfile({
          ...makeProfileFromDefaults(
            env.profile,
            env.commandLine,
            state.profileDefaults,
          ),
          startingDirectory: env.wsl
            ? env.fixture.main.replace(`//wsl.localhost/${env.distro}`, "")
            : env.fixture.main,
          restoreCwd: true,
        });
      },
      { env },
    );
    await persist();
    const workspace = (
      await api("/workspaces", {
        name: `Matrix ${name}`,
        layoutId: "default-layout",
      })
    ).workspace;
    env.workspaceId = workspace.id;
    state.environments.push(env);
    await save(state);
    await api("/workspaces/active", { id: workspace.id });
    await api(
      "/panes/0/view",
      {
        type: "TerminalView",
        profile: env.profile,
        lastCwd: guest(env, env.fixture.main),
        syncGroup: workspace.id,
        cwdSend: true,
        cwdReceive: false,
      },
      "PUT",
    );
    env.sourceId = (
      await api("/workspaces/active")
    ).workspace.panes[0].terminalId;
    env.paneId = await desktop.evaluate(
      async ({ workspaceId }) => {
        const { useWorkspaceStore } =
          await import("/src/stores/workspace-store.ts");
        const store = useWorkspaceStore.getState();
        store.splitPane(0, "vertical", workspaceId, {
          type: "WorktreeView",
          syncGroup: workspaceId,
          cwdReceive: true,
        });
        return useWorkspaceStore
          .getState()
          .workspaces.find((workspace) => workspace.id === workspaceId).panes[1]
          .layers[0].id;
      },
      { workspaceId: workspace.id },
    );
    await until(
      () => api("/terminals"),
      (result) =>
        result.instances.some(
          (terminal) => terminal.id === env.sourceId && terminal.sessionReady,
        ),
      `${name} 세션 준비`,
    );
    await save(state);
    console.log(`검증 환경 생성: ${name}`);
  }
  await configureRemote(state);
  console.log("행렬 준비 완료: 환경 3 × CWD 4 × 생명주기 3");
}
async function changeCwd(env, cwd) {
  const directory = guest(env, cwd);
  await api(`/terminals/${env.sourceId}/write`, {
    data: env.wsl
      ? `cd -- ${shellQuote(directory)}\r`
      : `Set-Location -LiteralPath '${directory.replaceAll("'", "''")}'\r`,
  });
  return until(
    async () =>
      (await api("/terminals")).instances.find(
        (item) => item.id === env.sourceId,
      ),
    (terminal) => {
      return (
        terminal?.activity?.type === "shell" &&
        normalize(terminal.cwd || "") ===
          (env.wsl ? directory : normalize(directory))
      );
    },
    `${env.name} CWD ${directory}`,
  );
}
async function pcSettled(view) {
  return until(
    () =>
      view.evaluate((root) => ({
        busy: root.getAttribute("aria-busy") === "true",
        warnings: [
          ...root.querySelectorAll(
            '[data-testid="worktree-list"] > .worktree-warning',
          ),
        ].map((item) => item.textContent),
        errors: [...root.querySelectorAll('[role="alert"]')].map(
          (item) => item.textContent,
        ),
        rows: [...root.querySelectorAll("[data-worktree-path]")].map(
          (item) => ({
            path: item.dataset.worktreePath,
            text: item.textContent,
          }),
        ),
      })),
    (state) =>
      !state.busy &&
      !state.errors.length &&
      !state.warnings.length &&
      state.rows.length === 8,
    "PC 목록·검사 완료",
  );
}
async function shellIdentity(env, initialize) {
  const tag = `MATRIX${crypto.randomUUID().replaceAll("-", "")}`;
  const marker = initialize ? crypto.randomUUID() : null;
  const data = env.wsl
    ? `${marker ? `__LAYMUX_MATRIX_INCARNATION=${shellQuote(marker)}; ` : ""}printf '${tag}=%s|%s\\n' "$$" "$__LAYMUX_MATRIX_INCARNATION"\r`
    : `${marker ? `$global:__LAYMUX_MATRIX_INCARNATION='${marker}'; ` : ""}Write-Output ('${tag}=' + $PID + '|' + $global:__LAYMUX_MATRIX_INCARNATION)\r`;
  await api(`/terminals/${env.sourceId}/write`, { data });
  return until(
    async () => {
      const output = (await api(`/terminals/${env.sourceId}/output?lines=20`))
        .output;
      const match = output.match(new RegExp(`${tag}=(\\d+)\\|([a-z0-9-]*)`));
      return match ? { pid: Number(match[1]), incarnation: match[2] } : null;
    },
    Boolean,
    `${env.name} 실제 셸 incarnation`,
  );
}
async function warm(state) {
  for (const env of state.environments) {
    await api("/workspaces/active", { id: env.workspaceId });
    await until(
      async () =>
        (await api("/terminals")).instances.find(
          (item) => item.id === env.sourceId,
        ),
      (terminal) =>
        terminal?.sessionReady && terminal.activity?.type === "shell",
      `${env.name} 초기 재연결`,
    );
  }
}
async function stage(state, label) {
  if (label !== "normal") {
    const mainSource = await desktop.evaluate(async () =>
      (await fetch("/src/main.tsx")).text(),
    );
    const env = JSON.parse(
      mainSource.match(/import\.meta\.env = (\{[^\n]+?\});/)[1],
    );
    assert.equal(
      env.VITE_LAYMUX_STRICT_MODE,
      "0",
      "PTY 복원 검증은 VITE_LAYMUX_STRICT_MODE=0이 필요하다",
    );
  }
  const priorPid = state.stages.normal?.pid;
  if (label !== "normal")
    assert.notEqual(
      health.instance.pid,
      priorPid,
      "새 GUI 프로세스에서 재검증한다",
    );
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const result = {
    pid: health.instance.pid,
    cases: [],
    checks: [],
    shells: {},
  };
  let activeLease;
  const cleaned = new Set();
  try {
    // 숨은 workspace의 PTY는 실제로 연결되기 전에는 Unknown이다. 먼저 이
    // 검증에서 소유한 세 세션을 모두 재연결하고, 어느 것도 CWD를 바꾸지 않는다.
    await warm(state);
    for (const env of state.environments) {
      const listing = (
        await api(
          `/worktrees?workingDir=${encodeURIComponent(env.fixture.main)}`,
        )
      ).data;
      for (const entry of listing.worktrees.filter((tree) =>
        normalize(tree.path).startsWith(
          `${normalize(env.fixture.base)}/remove-`,
        ),
      )) {
        const detail = (
          await api("/worktrees/inspect", {
            workingDir: env.fixture.main,
            path: entry.path,
          })
        ).data;
        assert.ok(detail.canRemove, "중단된 검증의 clean 임시 대상만 정리한다");
        await api("/worktrees/remove", {
          workingDir: env.fixture.main,
          path: entry.path,
          expectedHead: entry.head,
        });
        cleaned.add(env.name);
      }
    }
    for (const env of state.environments) {
      await api("/workspaces/active", { id: env.workspaceId });
      await api("/grid/focus", { paneIndex: 0 });
      await until(
        () => api("/terminals"),
        (value) =>
          value.instances.some(
            (item) => item.id === env.sourceId && item.sessionReady,
          ),
        `${label} ${env.name} 복원`,
      );
      const restored = (await api("/terminals")).instances.find(
        (item) => item.id === env.sourceId,
      );
      if (label !== "normal") {
        assert.equal(
          normalize(restored.cwd),
          normalize(env.savedCwd),
          "복원 직후 실제 CWD를 보존해야 한다",
        );
      }
      const identity = await shellIdentity(env, label === "normal");
      if (label === "adopt")
        assert.deepEqual(
          identity,
          (state.restartBaseline ?? state.stages.normal).shells[env.name],
          "GUI 재시작은 기존 셸을 재결합해야 한다",
        );
      if (label === "disk") {
        assert.equal(
          identity.incarnation,
          "",
          "데몬 없는 재시작은 이전 셸의 메모리를 상속하면 안 된다",
        );
        assert.notEqual(identity.pid, state.stages.adopt.shells[env.name].pid);
      }
      result.shells[env.name] = identity;
      const view = desktop.locator(
        `[data-testid="view-worktree"][data-pane-id="${env.paneId}"]`,
      );
      await view.waitFor();
      if (cleaned.has(env.name))
        await api("/ui/worktrees", { paneId: env.paneId, action: "refresh" });
      await pcSettled(view);
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const claimed = page.waitForResponse(
        (response) =>
          response.url().endsWith("/remote/v1/session/claim") && response.ok(),
      );
      await page.goto(
        host +
          "/remote/#" +
          new URLSearchParams({
            token: state.token,
            autoConnect: "1",
            clientName: `matrix-${label}-${env.name}`,
          }),
      );
      const leaseId = (await (await claimed).json()).leaseId;
      activeLease = leaseId;
      const remote = async (suffix, body, expected = 200) => {
        const response = await fetch(
          host + `/remote/v1/terminals/${env.sourceId}/worktrees${suffix}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${state.token}`,
            },
            body: JSON.stringify({ leaseId, ...body }),
          },
        );
        const data = await response.json();
        assert.equal(response.status, expected, JSON.stringify(data));
        return data;
      };
      let remoteCwd;
      page.on("response", async (response) => {
        if (
          response.url().endsWith(`/terminals/${env.sourceId}/worktrees`) &&
          response.ok()
        )
          remoteCwd = (await response.json()).cwd;
      });
      const row = (tree) =>
        page.locator(
          `button[data-worktree-path=${JSON.stringify(normalize(tree))}]`,
        );
      if (state.lastLeaseId)
        await remote("", { leaseId: state.lastLeaseId }, 409);
      const open = async () => {
        if (!(await page.locator("#worktreesOverlay").isVisible()))
          await page.locator("#worktreesHeader").click();
      };
      const settle = () =>
        until(
          () => page.locator("#worktreesStatus").textContent(),
          (text) => !text.trim(),
          "Remote 목록·검사 완료",
        );
      let previousCwd;
      const positions = [
        ["main", env.fixture.main, env.fixture.main, false],
        ["main-sub", `${env.fixture.main}/sub`, env.fixture.main, false],
        ["linked", env.fixture.trees.linked, env.fixture.trees.linked, true],
        [
          "linked-sub",
          `${env.fixture.trees.linked}/sub`,
          env.fixture.trees.linked,
          true,
        ],
      ];
      for (const [position, cwd, currentTree, linked] of positions) {
        const terminal = await changeCwd(env, cwd);
        const snapshot = (
          await api(
            `/worktrees?workingDir=${encodeURIComponent(terminal.cwd)}&sourceTerminalId=${env.sourceId}`,
          )
        ).data;
        assert.equal(
          normalize(snapshot.repositoryPath),
          normalize(env.fixture.main),
        );
        assert.equal(snapshot.worktrees.length, 8);
        assert.deepEqual(snapshot.usageWarnings, []);
        const pc = await pcSettled(view);
        const linkedRow = pc.rows.find(
          (item) =>
            normalize(item.path) === normalize(env.fixture.trees.linked),
        );
        assert.equal(
          linkedRow.text.includes("현재 조회 경로"),
          linked,
          "PC CWD 수신은 현재 조회 경로 보호에 반영된다",
        );
        const inspection = (
          await remote("/inspect", { cwd: terminal.cwd, path: currentTree })
        ).data;
        assert.ok(
          inspection.usage.some(
            (item) => item.terminalId === env.sourceId && item.kind === "live",
          ),
        );
        assert.ok(inspection.blockers.includes("in_use"));
        assert.equal(inspection.canRemove, false);
        assert.deepEqual(inspection.usageWarnings, []);
        const list = await remote("", {});
        assert.equal(list.cwd, terminal.cwd);
        assert.deepEqual(list.data.usageWarnings, []);
        if (previousCwd) {
          await remote(
            "/inspect",
            { cwd: previousCwd, path: currentTree },
            409,
          );
          await until(
            () =>
              page
                .getByRole("button", { name: "제거 확인", exact: true })
                .count(),
            (count) => count === 0,
            "CWD 변경은 이전 제거 확인을 폐기한다",
          );
        }
        await open();
        await until(
          () => remoteCwd,
          (value) => value === terminal.cwd,
          "Remote 실제 CWD 동기화",
        );
        await settle();
        assert.equal(
          await page.locator("#worktreesRepo").getAttribute("title"),
          normalize(env.fixture.main),
        );
        for (const width of [390, 1280]) {
          await page.setViewportSize({ width, height: 844 });
          await row(currentTree).click();
          const remove = page.getByRole("button", {
            name: "워크트리 제거",
            exact: true,
          });
          await remove.waitFor();
          assert.ok(await remove.isDisabled());
          const bounds = await page.evaluate(() => ({
            width: innerWidth,
            scroll: document.documentElement.scrollWidth,
          }));
          assert.ok(bounds.scroll <= bounds.width + 1, JSON.stringify(bounds));
          await page.screenshot({
            path: path.join(
              artifacts,
              `${label}-${env.name}-${position}-${width}.png`,
            ),
          });
          await page
            .getByRole("button", { name: "상세 닫기", exact: true })
            .click();
        }
        await row(env.fixture.trees.clean).click();
        const remove = page.getByRole("button", {
          name: "워크트리 제거",
          exact: true,
        });
        await until(
          () => remove.isEnabled(),
          Boolean,
          "미사용 clean 제거 확인 가능",
        );
        await remove.click();
        await page
          .getByRole("button", { name: "제거 확인", exact: true })
          .waitFor();
        previousCwd = terminal.cwd;
        result.cases.push({
          environment: env.name,
          cwd: position,
          surfaces: ["PC", "Remote 390", "Remote 1280"],
          warnings: 0,
          liveUsage: true,
        });
        await writeFile(
          path.join(artifacts, `${label}-report.json`),
          JSON.stringify(result, null, 2),
        );
        console.log(
          `통과: ${label} / ${env.name} / ${position} / PC·Remote(390·1280)`,
        );
      }
      await page.getByRole("button", { name: "취소", exact: true }).click();
      await page
        .getByRole("button", { name: "상세 닫기", exact: true })
        .click();
      for (const [name, blocker] of [
        ["dirty", "tracked_changes"],
        ["untracked", "untracked_files"],
        ["ignored", "ignored_files"],
        ["locked", "locked"],
        ["detached", "detached"],
      ]) {
        const current = (await api("/terminals")).instances.find(
          (item) => item.id === env.sourceId,
        );
        const detail = (
          await remote("/inspect", {
            cwd: current.cwd,
            path: env.fixture.trees[name],
          })
        ).data;
        assert.ok(detail.blockers.includes(blocker));
        await remote(
          "/remove",
          {
            cwd: current.cwd,
            path: env.fixture.trees[name],
            expectedHead: detail.worktree.head,
          },
          409,
        );
        await access(env.fixture.trees[name]);
      }
      result.checks.push(
        `${env.name}: 변경·미추적·ignored·잠금·분리 HEAD 제거 거부`,
      );
      await row(env.fixture.trees.dirty).click();
      await page.locator("#worktreesDetail summary").click();
      await page
        .getByRole("button", { name: "변경 · README.md", exact: true })
        .click();
      await page.locator("#fileViewerOverlay").waitFor();
      await until(
        async () => {
          const texts = await Promise.all(
            page.frames().map((frame) =>
              frame
                .locator("body")
                .innerText()
                .catch(() => ""),
            ),
          );
          return texts.join("\n");
        },
        (text) => text.includes(`changed matrix ${env.name}`),
        "Remote 파일 내용 확인",
      );
      await page.locator("#fileViewerClose").click();
      await page
        .getByRole("button", { name: "상세 닫기", exact: true })
        .click();
      result.checks.push(`${env.name}: Remote 파일 열기·검토 복귀`);
      for (const surface of ["remote", "pc"]) {
        const name = `remove-${label}-${surface}-${Date.now().toString(36)}`;
        const tree = `${env.fixture.base}/${name}`;
        git(env, env.fixture.main, "worktree", "add", "-b", name, tree);
        const head = git(env, tree, "rev-parse", "HEAD");
        if (surface === "remote") {
          await page.locator("#worktreesRefresh").click();
          await row(tree).waitFor();
          await row(tree).click();
          const remove = page.getByRole("button", {
            name: "워크트리 제거",
            exact: true,
          });
          await until(
            () => remove.isEnabled(),
            Boolean,
            "Remote 새 clean 제거 가능",
          );
          await remove.click();
          await page
            .getByRole("button", { name: "제거 확인", exact: true })
            .click();
          await until(
            async () => {
              try {
                await access(tree);
                return false;
              } catch {
                return true;
              }
            },
            Boolean,
            "Remote UI 실제 제거",
          );
        } else {
          // PC 입력은 Remote 제어권 동안 차단되는 것이 정상이다. 우회 클릭하지 않는다.
          assert.ok(
            await desktop.getByTestId("remote-control-overlay").isVisible(),
          );
          await fetch(host + "/remote/v1/session/release", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${state.token}`,
            },
            body: JSON.stringify({ leaseId }),
          });
          activeLease = null;
          await context.close();
          await desktop
            .getByTestId("remote-control-overlay")
            .waitFor({ state: "hidden" });
          await api("/ui/worktrees", { paneId: env.paneId, action: "refresh" });
          await until(
            () => view.getAttribute("aria-busy"),
            (value) => value === "false",
            "PC 갱신",
          );
          await view
            .locator(`[data-worktree-path=${JSON.stringify(tree)}]`)
            .waitFor();
          await api("/ui/worktrees", {
            paneId: env.paneId,
            action: "select",
            path: tree,
          });
          const remove = view.getByTestId("worktree-remove");
          await until(
            () => remove.isEnabled(),
            Boolean,
            "PC 새 clean 제거 가능",
          );
          await remove.click();
          await view.getByTestId("worktree-confirm-remove").click();
          await until(
            async () => {
              try {
                await access(tree);
                return false;
              } catch {
                return true;
              }
            },
            Boolean,
            "PC UI 실제 제거",
          );
        }
        assert.equal(
          git(env, env.fixture.main, "rev-parse", `refs/heads/${name}`),
          head,
        );
        result.checks.push(`${env.name}: ${surface} UI 확인 제거·브랜치 보존`);
      }
      assert.deepEqual(errors, []);
      await changeCwd(env, env.fixture.main);
      await until(
        async () =>
          (await pcSettled(view)).rows.find(
            (item) =>
              normalize(item.path) === normalize(env.fixture.trees.linked),
          ),
        (row) => !row.text.includes("현재 조회 경로"),
        "워크트리에서 원본으로 CWD 수신",
      );
      const released = (
        await api("/worktrees/inspect", {
          workingDir: env.fixture.main,
          path: env.fixture.trees.linked,
        })
      ).data;
      assert.equal(
        released.canRemove,
        true,
        "실제 터미널이 원본으로 이동하면 이전 워크트리의 사용 보호를 해제한다",
      );
      assert.deepEqual(released.usage, []);
      await changeCwd(env, `${env.fixture.trees.linked}/sub`);
      await pcSettled(view);
      result.checks.push(
        `${env.name}: 워크트리→원본 이동 후 사용 보호 해제·하위 CWD 복귀`,
      );
      await fetch(host + "/remote/v1/session/release", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${state.token}`,
        },
        body: JSON.stringify({ leaseId }),
      });
      state.lastLeaseId = leaseId;
      activeLease = null;
      env.savedCwd = (await api("/terminals")).instances.find(
        (item) => item.id === env.sourceId,
      ).cwd;
      await context.close();
    }
    state.stages[label] = result;
    await persist();
    await save(state);
    await writeFile(
      path.join(artifacts, `${label}-report.json`),
      JSON.stringify(result, null, 2) + "\n",
    );
    console.log(
      `${label} 단계 완료: 조합 ${result.cases.length}개, 추가 확인 ${result.checks.length}개`,
    );
  } finally {
    if (activeLease)
      await fetch(host + "/remote/v1/session/release", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${state.token}`,
        },
        body: JSON.stringify({ leaseId: activeLease }),
      }).catch(() => {});
    await browser.close();
  }
}
async function restore(state) {
  await configureRemote(state, true);
  await invoke("set_remote_runtime_access", {
    enabled: state.originalAccess.runtimeEnabled,
    authToken: state.originalAccess.effectiveAuthToken || null,
  });
  await api("/workspaces/active", { id: state.originalWorkspace });
  await persist();
  await until(
    async () =>
      isDeepStrictEqual(
        (await invoke("load_settings")).remote,
        state.originalRemote,
      ),
    Boolean,
    "영속 Remote 설정 복원",
  );
  const access = await invoke("get_remote_access_status");
  assert.equal(access.runtimeEnabled, state.originalAccess.runtimeEnabled);
  assert.ok(
    access.effectiveAuthToken === state.originalAccess.effectiveAuthToken,
    "원래 접근 토큰 복원",
  );
  state.restored = true;
  await save(state);
  console.log("원래 Remote 설정·런타임 접근·활성 workspace 복원 완료");
}
async function pcFiles(state) {
  assert.ok(!(await invoke("get_remote_control_status")).lease);
  const checks = [];
  for (const env of state.environments) {
    await api("/workspaces/active", { id: env.workspaceId });
    const view = desktop.locator(
      `[data-testid="view-worktree"][data-pane-id="${env.paneId}"]`,
    );
    await pcSettled(view);
    await api("/ui/worktrees", {
      paneId: env.paneId,
      action: "select",
      path: env.fixture.trees.dirty,
    });
    await view
      .getByRole("button", { name: "변경 · README.md", exact: true })
      .click();
    await desktop.getByTestId("file-viewer-overlay").waitFor();
    await desktop.getByTestId("file-viewer-source-mode").click();
    await until(
      () => desktop.getByTestId("file-viewer-text").textContent(),
      (text) => text.includes(`changed matrix ${env.name}`),
      `${env.name} PC 파일 내용`,
    );
    await desktop.getByTestId("file-viewer-overlay-close").click();
    checks.push(`${env.name}: PC 변경 파일 실제 열기`);
  }
  await writeFile(
    path.join(artifacts, "pc-files.json"),
    JSON.stringify({ checks }, null, 2),
  );
  console.log(`PC 파일 열기 통과: ${checks.length}개 환경`);
}
async function watchRestart(state, label) {
  const env = state.environments.at(-1);
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  let lease;
  let manualConnect = false;
  page.on("response", async (response) => {
    if (response.url().endsWith("/remote/v1/session/claim") && response.ok())
      lease = (await response.json()).leaseId;
  });
  const request = async (route, body) => {
    const response = await fetch(host + "/remote/v1" + route, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${state.token}`,
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    await page.goto(
      host +
        "/remote/#" +
        new URLSearchParams({
          token: state.token,
          autoConnect: "1",
          clientName: `matrix-restart-${label}`,
        }),
    );
    await until(() => lease, Boolean, "재시작 전 Remote 제어권");
    await page.locator("#worktreesHeader").click();
    const row = page.locator(
      `button[data-worktree-path=${JSON.stringify(env.fixture.trees.clean)}]`,
    );
    await row.waitFor();
    await row.click();
    const remove = page.getByRole("button", {
      name: "워크트리 제거",
      exact: true,
    });
    await until(() => remove.isEnabled(), Boolean, "재시작 전 clean 검사");
    await remove.click();
    await page
      .getByRole("button", { name: "제거 확인", exact: true })
      .waitFor();
    const previousLease = lease;
    await writeFile(
      path.join(artifacts, `watch-${label}-ready.json`),
      JSON.stringify({ pid: health.instance.pid, confirmation: true }),
    );
    console.log(`Remote 재시작 감시 준비: ${label}`);
    const next = await until(
      async () => {
        try {
          return await api("/health");
        } catch {
          return null;
        }
      },
      (value) =>
        value?.instance?.pid !== undefined &&
        value.instance.pid !== health.instance.pid,
      "새 GUI 기동",
      180_000,
    );
    await until(
      () =>
        page.getByRole("button", { name: "제거 확인", exact: true }).count(),
      (count) => count === 0,
      "재시작은 이전 제거 확인을 폐기한다",
    );
    await until(
      async () => {
        if (lease !== previousLease) return true;
        const connect = page.locator("#connect");
        if (!(await connect.isVisible())) {
          const toggle = page.locator("#navToggle");
          if ((await toggle.getAttribute("aria-expanded")) === "false")
            await toggle.click();
          const connection = page.locator("#drawerConnectionButton");
          if (await connection.isVisible()) await connection.click();
        }
        if ((await connect.isVisible()) && (await connect.isEnabled())) {
          manualConnect = true;
          await connect.click();
        }
        return false;
      },
      Boolean,
      "Remote 안전한 재접속",
    );
    const stale = await request(`/terminals/${env.sourceId}/worktrees`, {
      leaseId: previousLease,
    });
    assert.equal(stale.status, 409, "이전 GUI의 lease는 다시 사용할 수 없다");
    if (!(await page.locator("#worktreesOverlay").isVisible()))
      await page.locator("#worktreesHeader").click();
    await writeFile(
      path.join(artifacts, `watch-${label}-connected.json`),
      JSON.stringify({ pid: next.instance.pid, remoteOpen: true }),
    );
    console.log(
      `Remote 재접속·뷰 열기 완료: ${label}, 호스트 전체 재연결 대기`,
    );
    // 호스트 검증 프로세스가 세 검증 PTY를 모두 연결한 뒤 경고를 대조한다.
    await until(
      async () =>
        (
          await request(`/terminals/${env.sourceId}/worktrees`, {
            leaseId: lease,
          })
        ).body,
      (value) => value.success && value.data?.usageWarnings?.length === 0,
      "재연결된 호스트 사용 관측",
      90_000,
    );
    await until(
      () => page.locator("#worktreesStatus").textContent(),
      (text) => !text.trim(),
      "재접속 후 Remote 경고 해소",
    );
    assert.equal(
      await page
        .getByRole("button", { name: "제거 확인", exact: true })
        .count(),
      0,
    );
    await page.screenshot({
      path: path.join(artifacts, `remote-reconnect-${label}.png`),
    });
    await writeFile(
      path.join(artifacts, `remote-reconnect-${label}.json`),
      JSON.stringify(
        {
          previousPid: health.instance.pid,
          nextPid: next.instance.pid,
          manualConnect,
          staleLeaseRejected: true,
          staleConfirmationDiscarded: true,
          warnings: [],
        },
        null,
        2,
      ),
    );
    console.log(`Remote 재접속 통과: ${label}, 이전 제어권·제거 확인 폐기`);
  } finally {
    if (lease)
      await request("/session/release", { leaseId: lease }).catch(() => {});
    await browser.close();
  }
}
try {
  if (process.argv.includes("--setup")) await setup();
  else {
    const state = JSON.parse(await readFile(stateFile, "utf8"));
    if (process.argv.includes("--restore")) await restore(state);
    else if (process.argv.includes("--pc-files")) await pcFiles(state);
    else if (process.argv.includes("--warm")) {
      await warm(state);
      await persist();
      console.log("세 검증 PTY 재연결 완료");
    } else if (process.argv.includes("--restart-baseline")) {
      await warm(state);
      const baseline = { pid: health.instance.pid, shells: {} };
      for (const env of state.environments) {
        await api("/workspaces/active", { id: env.workspaceId });
        baseline.shells[env.name] = await shellIdentity(env, true);
      }
      state.restartBaseline = baseline;
      await persist();
      await save(state);
      await writeFile(
        path.join(artifacts, "restart-baseline.json"),
        JSON.stringify(baseline, null, 2),
      );
      console.log("재시작 직전 셸 PID·메모리 표식 기록 완료");
    } else if (process.argv.includes("--watch-restart"))
      await watchRestart(
        state,
        process.argv[process.argv.indexOf("--watch-restart") + 1],
      );
    else {
      const label = process.argv[process.argv.indexOf("--stage") + 1];
      assert.ok(["normal", "adopt", "disk"].includes(label));
      await stage(state, label);
    }
  }
} finally {
  await desktopBrowser.close();
}
