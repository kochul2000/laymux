// Windows dev(19281)에서 WSL Git과 UNC 경로 계약을 실제로 확인한다.
// node scripts/verify-worktree-wsl.mjs [배포판 이름]
// 비기본 배포판을 우선 선택하고, 없으면 기본 배포판에서 검증한다. --git-only는 Git API만 검사한다.
// 실제 sourceTerminalId·symlink CWD 검증에는 CDP 9342의 dev WebView가 필요하다.
// 검증용 profile/workspace/fixture를 사용자가 확인할 수 있도록 남긴다.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium } from "../ui/node_modules/playwright-core/index.mjs";

const gitOnly = process.argv.includes("--git-only");
function wslListing(args) {
  const result = spawnSync("wsl.exe", args, {
    windowsHide: true,
    timeout: 30_000,
  });
  assert.equal(
    result.status,
    0,
    result.error?.message || result.stderr?.toString(),
  );
  const bytes = result.stdout;
  return bytes
    .toString(bytes[1] === 0 || bytes[0] === 0xff ? "utf16le" : "utf8")
    .replaceAll("\u0000", "")
    .replace(/^\uFEFF/, "");
}
const installedDistros = wslListing(["--list", "--quiet"])
  .split(/\r?\n/)
  .map((name) => name.trim())
  .filter(Boolean);
const defaultDistro = wslListing(["--list", "--verbose"]).match(
  /^\s*\*\s+(\S+)/m,
)?.[1];
assert.ok(defaultDistro, "WSL 기본 배포판 이름을 확인해야 한다");
const requestedDistro = process.argv
  .slice(2)
  .find((argument) => !argument.startsWith("--"));
const distro =
  requestedDistro ??
  installedDistros.find(
    (name) => name !== defaultDistro && !/^docker-/i.test(name),
  ) ??
  installedDistros.find((name) => !/^docker-/i.test(name));
assert.ok(distro, "Git과 대화형 셸을 지원하는 WSL 배포판이 필요하다");
assert.ok(installedDistros.includes(distro), `설치되지 않은 배포판: ${distro}`);
assert.match(distro, /^[A-Za-z0-9._-]+$/);
const nonDefaultDistroVerified = !gitOnly && distro !== defaultDistro;
const skipped = nonDefaultDistroVerified
  ? []
  : [
      gitOnly
        ? "--git-only: live 터미널 검증 생략"
        : "비기본 배포판 실기 미검증: 선택한 검증 배포판이 기본 배포판이므로 동일 배포판에서 live 검증 수행",
    ];
const repo = fileURLToPath(new URL("../", import.meta.url));
const artifacts = path.join(repo, ".screenshots", "worktree-view");
const url = "http://127.0.0.1:19281/api/v1";
function guest(args, input) {
  const result = spawnSync("wsl.exe", ["-d", distro, "--exec", ...args], {
    encoding: "utf8",
    input,
    windowsHide: true,
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
}
function git(cwd, ...args) {
  return guest(["git", "-C", cwd, ...args]);
}
async function api(route, body, status = 200, method = body ? "POST" : "GET") {
  const response = await fetch(url + route, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json();
  assert.equal(response.status, status, JSON.stringify(result));
  if (status >= 200 && status < 300)
    assert.notEqual(result.success, false, JSON.stringify(result));
  return result;
}
async function until(read, accept, label) {
  const deadline = Date.now() + 90_000;
  let result;
  do {
    result = await read();
    if (accept(result)) return result;
    await new Promise((resolve) => setTimeout(resolve, 500));
  } while (Date.now() < deadline);
  assert.fail(`${label}: ${JSON.stringify(result)}`);
}
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const health = await api("/health");
assert.equal(health.instance.buildKind, "dev");
assert.equal(
  path.resolve(health.instance.worktreeRoot).toLowerCase(),
  path.resolve(repo).toLowerCase(),
);
const base = guest(["mktemp", "-d", "/tmp/laymux-worktrees-XXXXXX"]);
assert.match(base, /^\/tmp\/laymux-worktrees-[a-zA-Z0-9]+$/);
const main = `${base}/main`;
guest(["mkdir", "--", main]);
git(main, "init", "-b", "main");
git(main, "config", "user.name", "Laymux dev verification");
git(main, "config", "user.email", "laymux-dev@example.invalid");
git(main, "config", "commit.gpgsign", "false");
guest(["tee", `${main}/README.md`], "WSL 실기 검증\n");
git(main, "add", ".");
git(main, "commit", "-m", "fixture");
for (const name of ["clean", "dirty", "ignored"])
  git(main, "worktree", "add", "-b", name, `${base}/${name}`);
guest(["tee", `${base}/dirty/README.md`], "보존할 수정\n");
guest(["tee", `${base}/ignored/.gitignore`], "secret.txt\n");
git(`${base}/ignored`, "add", ".gitignore");
git(`${base}/ignored`, "commit", "-m", "ignore local files");
guest(["tee", `${base}/ignored/secret.txt`], "보존할 ignored 파일\n");
const host = (guestPath) => `//wsl.localhost/${distro}${guestPath}`;
const workingDir = host(main);
const listing = (
  await api(`/worktrees?workingDir=${encodeURIComponent(workingDir)}`)
).data;
assert.equal(listing.worktrees.length, 4);
assert.ok(
  listing.worktrees.every((entry) =>
    entry.path.startsWith(`//wsl.localhost/${distro}/`),
  ),
);
const results = ["WSL Git 목록과 배포판을 포함한 UNC 경로 반환"];
for (const [name, blocker] of [
  ["dirty", "tracked_changes"],
  ["ignored", "ignored_files"],
]) {
  const detail = (
    await api("/worktrees/inspect", {
      workingDir,
      path: host(`${base}/${name}`),
    })
  ).data;
  assert.ok(detail.blockers.includes(blocker), JSON.stringify(detail));
  await api(
    "/worktrees/remove",
    {
      workingDir,
      path: detail.worktree.path,
      expectedHead: detail.worktree.head,
    },
    409,
  );
  guest(["test", "-d", `${base}/${name}`]);
  results.push(`WSL ${name} 제거 거부·폴더 보존`);
}
const clean = (
  await api("/worktrees/inspect", { workingDir, path: host(`${base}/clean`) })
).data;
assert.equal(clean.canRemove, true, JSON.stringify(clean));
await api("/worktrees/remove", {
  workingDir,
  path: clean.worktree.path,
  expectedHead: clean.worktree.head,
});
assert.equal(git(main, "rev-parse", "refs/heads/clean"), clean.worktree.head);
assert.equal(
  (await api(`/worktrees?workingDir=${encodeURIComponent(workingDir)}`)).data
    .worktrees.length,
  3,
);
results.push("WSL clean 제거·브랜치 보존");

async function verifyLiveGuestUsage() {
  const activeTree = `${base}/in-use`;
  const alias = `${base}/active-alias`;
  const aliasCwd = `${alias}/src`;
  git(main, "worktree", "add", "-b", "in-use", activeTree);
  guest(["mkdir", "--", `${activeTree}/src`]);
  guest(["ln", "-s", "--", activeTree, alias]);

  // Git 목록이 symlink를 거쳐 등록한 경로를 실제 경로로 반환하는지도 확인한다.
  const physicalParent = `${base}/physical-parent`;
  const parentAlias = `${base}/parent-alias`;
  guest(["mkdir", "--", physicalParent]);
  guest(["ln", "-s", "--", physicalParent, parentAlias]);
  git(
    main,
    "worktree",
    "add",
    "-b",
    "registered-via-alias",
    `${parentAlias}/tree`,
  );
  const registered = (
    await api(`/worktrees?workingDir=${encodeURIComponent(workingDir)}`)
  ).data;
  const registeredTree = registered.worktrees.find(
    (entry) => entry.branch === "registered-via-alias",
  );
  assert.equal(
    registeredTree?.path,
    host(`${physicalParent}/tree`),
    JSON.stringify(registeredTree),
  );
  results.push(
    "WSL symlink 부모를 경유한 worktree 등록도 Git 목록은 실제 경로 반환",
  );

  const browser = await chromium.connectOverCDP(
    process.env.LAYMUX_CDP_URL || "http://127.0.0.1:9342",
  );
  try {
    const page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) =>
        /^http:\/\/(localhost|127\.0\.0\.1):1420\/$/.test(candidate.url()),
      );
    assert.ok(page, "현재 dev WebView 페이지");
    const postponeHooks = page
      .getByRole("button", { name: "나중에", exact: true })
      .first();
    if (await postponeHooks.isVisible()) await postponeHooks.click();
    const profileName = `Worktree WSL ${distro} ${base.split("-").at(-1)}`;
    await page.evaluate(
      async ({ profileName, distro, main }) => {
        const { useSettingsStore, makeProfileFromDefaults } =
          await import("/src/stores/settings-store.ts");
        const { persistSession } = await import("/src/lib/persist-session.ts");
        const state = useSettingsStore.getState();
        state.addProfile({
          ...makeProfileFromDefaults(
            profileName,
            `wsl.exe -d ${distro}`,
            state.profileDefaults,
          ),
          startingDirectory: main,
          restoreCwd: true,
        });
        await persistSession();
      },
      { profileName, distro, main },
    );
    const workspace = (
      await api(
        "/workspaces",
        {
          name: `WSL 워크트리 검증 · ${distro}`,
          layoutId: "default-layout",
        },
        201,
      )
    ).workspace;
    await api("/workspaces/active", { id: workspace.id });
    await api(
      "/panes/0/view",
      {
        type: "TerminalView",
        profile: profileName,
        lastCwd: main,
        syncGroup: "none",
        cwdSend: false,
        cwdReceive: false,
      },
      200,
      "PUT",
    );
    const active = (await api("/workspaces/active")).workspace;
    const terminalId = active.panes[0].terminalId;
    assert.ok(terminalId?.startsWith("terminal-"), JSON.stringify(active));
    const terminal = () =>
      page.evaluate(async (terminalId) => {
        const { invoke } =
          await import("/node_modules/@tauri-apps/api/core.js");
        return (
          await invoke("get_terminal_summaries", { terminalIds: [terminalId] })
        )[0];
      }, terminalId);
    await until(
      terminal,
      (current) => current?.activity?.type === "shell",
      "WSL 셸 초기화",
    );

    // 사용자 prompt의 OSC 9;9가 physical CWD를 보낼 수 있으므로 마지막 prompt hook에서
    // 실제 Bash PWD를 보고한다. 이 fixture 셸에만 추가하며 사용자 설정 파일은 수정하지 않는다.
    await api(`/terminals/${terminalId}/write`, {
      data: '__laymux_worktree_probe_cwd() { printf \'\\033]7;file://localhost%s\\007\' "$PWD"; }; PROMPT_COMMAND="${PROMPT_COMMAND//__laymux_prompt_post/__laymux_worktree_probe_cwd;__laymux_prompt_post}"\r',
    });

    // 실제 Bash의 논리 CWD를 OSC로 보고한다. 임의 backend 상태를 주입하지 않는다.
    const changeDirectory = async (directory) => {
      await api(`/terminals/${terminalId}/write`, {
        data: `cd -L -- ${shellQuote(directory)}; printf '\\033]7;file://localhost%s\\007' "$PWD"\r`,
      });
      return until(
        terminal,
        (current) =>
          current?.cwd === directory && current?.activity?.type === "shell",
        `WSL 실제 CWD ${directory}`,
      );
    };
    const source = await changeDirectory(main);
    await api(
      `/worktrees?workingDir=${encodeURIComponent(source.cwd)}`,
      undefined,
      409,
    );
    const followed = (
      await api(
        `/worktrees?workingDir=${encodeURIComponent(source.cwd)}&sourceTerminalId=${encodeURIComponent(terminalId)}`,
      )
    ).data;
    assert.equal(followed.workingDir, host(main));
    assert.equal(followed.repositoryPath, host(main));
    assert.ok(
      followed.worktrees.every((entry) =>
        entry.path.startsWith(`//wsl.localhost/${distro}/`),
      ),
    );
    await api(
      `/worktrees?workingDir=${encodeURIComponent(`${main}/wrong`)}&sourceTerminalId=${encodeURIComponent(terminalId)}`,
      undefined,
      409,
    );
    results.push(
      `${distro === defaultDistro ? "기본" : "비기본"} ${distro}: sourceTerminalId로 raw POSIX CWD 배포판 식별·source 없는 조회/오래된 CWD 거부`,
    );

    const logical = await changeDirectory(aliasCwd);
    assert.equal(logical.cwd, aliasCwd);
    const inspectActive = async () =>
      (await api("/worktrees/inspect", { workingDir, path: host(activeTree) }))
        .data;
    const used = await until(
      inspectActive,
      (detail) =>
        detail.usage.some(
          (usage) => usage.terminalId === terminalId && usage.kind === "live",
        ),
      "symlink CWD 실제 worktree 연결",
    );
    const liveUsage = used.usage.find(
      (usage) => usage.terminalId === terminalId,
    );
    assert.equal(liveUsage.cwd, host(`${activeTree}/src`));
    assert.equal(used.canRemove, false);
    assert.ok(used.blockers.includes("in_use"));
    assert.deepEqual(used.usageWarnings, [], JSON.stringify(used));
    results.push(
      "실제 WSL shell의 symlink CWD가 물리 worktree 하위 경로로 연결·사용 중 보호",
    );

    // raw target을 넘겨도 guard는 Git에서 검증한 UNC target을 사용해야 한다.
    const refused = await api(
      "/worktrees/remove",
      { workingDir, path: activeTree, expectedHead: used.worktree.head },
      409,
    );
    assert.match(String(refused.error), /laymux.*사용 중/);
    guest(["test", "-d", activeTree]);
    results.push(
      "raw POSIX target 제거 요청도 검증된 canonical target의 live 사용 정보로 거부·폴더 보존",
    );
    await api("/screenshot", undefined, 200, "POST");
    await page.screenshot({
      path: path.join(artifacts, "wsl-symlink-terminal.png"),
    });

    // 같은 터미널이 떠난 뒤에는 오래된 saved CWD가 제거를 계속 막지 않는다.
    await changeDirectory(main);
    const released = await until(
      inspectActive,
      (detail) => detail.canRemove,
      "이동 후 worktree 사용 해제",
    );
    await api("/worktrees/remove", {
      workingDir,
      path: activeTree,
      expectedHead: released.worktree.head,
    });
    guest(["test", "!", "-e", activeTree]);
    assert.equal(
      git(main, "rev-parse", "refs/heads/in-use"),
      released.worktree.head,
    );
    results.push(
      "실제 터미널 이동 후 보호 해제·raw POSIX 제거 성공·브랜치 보존",
    );

    // 실제 WSL WorktreeView에서 새 터미널을 열어 UNC 경로가 guest CWD로 변환되는지 확인한다.
    await api(
      "/panes/0/view",
      { type: "WorktreeView", repositoryPath: workingDir },
      200,
      "PUT",
    );
    const viewWorkspace = (await api("/workspaces/active")).workspace;
    const paneId = viewWorkspace.panes.find((pane) => pane.activeLayer).id;
    const view = page.locator(
      `[data-testid="view-worktree"][data-pane-id="${paneId}"]`,
    );
    await view
      .locator("[data-worktree-path]")
      .first()
      .waitFor({ timeout: 90_000 });
    await api("/ui/worktrees", {
      paneId,
      action: "select",
      path: registeredTree.path,
    });
    await view.getByRole("button", { name: "새 터미널", exact: true }).click();
    const layeredWorkspace = (await api("/workspaces/active")).workspace;
    const openedTerminalId = layeredWorkspace.panes.find(
      (pane) => pane.activeLayer && pane.terminalId,
    )?.terminalId;
    assert.ok(
      openedTerminalId && openedTerminalId !== terminalId,
      JSON.stringify(layeredWorkspace),
    );
    const openedTerminal = await until(
      () =>
        page.evaluate(async (terminalId) => {
          const { invoke } =
            await import("/node_modules/@tauri-apps/api/core.js");
          return (
            await invoke("get_terminal_summaries", {
              terminalIds: [terminalId],
            })
          )[0];
        }, openedTerminalId),
      (current) =>
        current?.cwd === `${physicalParent}/tree` &&
        current?.activity?.type === "shell",
      "WSL WorktreeView 새 터미널의 실제 guest CWD",
    );
    const openedProfile = await page.evaluate(async (name) => {
      const { useSettingsStore } =
        await import("/src/stores/settings-store.ts");
      return useSettingsStore
        .getState()
        .profiles.find((profile) => profile.name === name);
    }, openedTerminal.profile);
    assert.equal(openedProfile?.commandLine, `wsl.exe -d ${distro}`);
    const openedUsage = (
      await api("/worktrees/inspect", { workingDir, path: registeredTree.path })
    ).data;
    assert.ok(
      openedUsage.usage.some(
        (usage) =>
          usage.terminalId === openedTerminalId && usage.kind === "live",
      ),
    );
    assert.ok(openedUsage.blockers.includes("in_use"));
    const openedRefused = await api(
      "/worktrees/remove",
      {
        workingDir,
        path: registeredTree.path,
        expectedHead: openedUsage.worktree.head,
      },
      409,
    );
    assert.match(String(openedRefused.error), /laymux.*사용 중/);
    results.push(
      "WSL WorktreeView 새 터미널 버튼에서 guest CWD·일치하는 프로필·live 제거 보호 확인",
    );
    await api("/panes/layers/activate", { layerId: paneId });
    await api("/ui/worktrees", { paneId, action: "refresh" });
    await view
      .locator("[data-worktree-path]")
      .first()
      .waitFor({ timeout: 90_000 });
    await api("/ui/worktrees", {
      paneId,
      action: "select",
      path: registeredTree.path,
    });
    await view.getByTestId("worktree-detail-summary").waitFor();
    await api("/screenshot", undefined, 200, "POST");
    await page.screenshot({
      path: path.join(artifacts, "wsl-worktree-view.png"),
    });
    return {
      workspaceId: workspace.id,
      terminalId,
      openedTerminalId,
      paneId,
      profileName,
      logicalCwd: aliasCwd,
      canonicalCwd: liveUsage.cwd,
      registeredTree: registeredTree.path,
    };
  } finally {
    await browser.close();
  }
}
await mkdir(artifacts, { recursive: true });
const live = gitOnly ? undefined : await verifyLiveGuestUsage();
const report = {
  distro,
  defaultDistro,
  base,
  workingDir,
  gitOnly,
  nonDefaultDistroVerified,
  skipped,
  live,
  results,
};
await writeFile(
  path.join(artifacts, "wsl-report.json"),
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
