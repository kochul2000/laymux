// native: node scripts/tests/pane-worktree-cwd.e2e.mjs
// WSL: LAYMUX_WORKTREE_GUEST=Ubuntu-22.04 (PowerShell: $env:LAYMUX_WORKTREE_GUEST=...)
// dev: WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9344
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, copyFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const artifacts = path.join(root, ".screenshots/pane-worktree-cwd");
await mkdir(artifacts, { recursive: true });
await mkdir(path.join(root, ".tmp"), { recursive: true });
const guest = process.env.LAYMUX_WORKTREE_GUEST;
let main;
let linked;
if (guest) {
  const script = `set -eu
base=$(mktemp -d /tmp/laymux-cwd-XXXXXX)
main="$base/main repo"
linked="$base/linked checkout"
mkdir -p "$main"
git -C "$main" init -b main >/dev/null
git -C "$main" config user.name 'CWD test'
git -C "$main" config user.email 'cwd@example.invalid'
printf 'initial\n' > "$main/tracked.txt"
git -C "$main" add tracked.txt
git -C "$main" -c core.hooksPath= -c commit.gpgSign=false commit -m initial >/dev/null
git -C "$main" worktree add -b linked "$linked" >/dev/null
mkdir -p "$main/ui" "$linked/ui" "$linked/linked-only"
printf '%s\n' "$base"
`;
  const result = spawnSync("wsl.exe", ["-d", guest, "--exec", "bash", "-s"], {
    input: script,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  const base = result.stdout.trim();
  assert.ok(base.startsWith("/tmp/laymux-cwd-"));
  main = `${base}/main repo`;
  linked = `${base}/linked checkout`;
} else {
  const fixture = await mkdtemp(path.join(root, ".tmp/cwd-"));
  main = path.join(fixture, "원본 repo");
  linked = path.join(fixture, "linked checkout");
  await mkdir(main);
  const git = (...args) =>
    execFileSync(
      "git",
      [
        "-c",
        "core.hooksPath=",
        "-c",
        "commit.gpgSign=false",
        "-C",
        main,
        ...args,
      ],
      { encoding: "utf8", windowsHide: true, stdio: "pipe" },
    );
  git("init", "-b", "main");
  git("config", "user.name", "CWD test");
  git("config", "user.email", "cwd@example.invalid");
  await writeFile(path.join(main, "tracked.txt"), "initial\n");
  git("add", "tracked.txt");
  git("commit", "-m", "initial");
  git("worktree", "add", "-b", "linked", linked);
  await mkdir(path.join(main, "ui"));
  await mkdir(path.join(linked, "ui"));
  await mkdir(path.join(linked, "linked-only"));
}
const join = (base, sub) => (guest ? `${base}/${sub}` : path.join(base, sub));
for (const [name, enabled, source, expected] of [
  ["same-subdirectory", true, join(linked, "ui"), join(main, "ui")],
  ["keep-worktree", false, join(linked, "ui"), join(linked, "ui")],
  ["missing-subdirectory", true, join(linked, "linked-only"), main],
]) {
  const result = spawnSync(
    process.execPath,
    [path.join(root, "scripts/tests/pane-profile-inheritance.e2e.mjs")],
    {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      env: {
        ...process.env,
        LAYMUX_PROFILE_CDP:
          process.env.LAYMUX_PROFILE_CDP ?? "http://127.0.0.1:9344/json",
        LAYMUX_MAIN_WORKTREE_CWD: enabled ? "1" : "0",
        LAYMUX_PROFILE_START_DIR: source,
        LAYMUX_PROFILE_EXPECT_CWD: expected,
        ...(guest ? { LAYMUX_PROFILE_COMMAND: `wsl.exe -d ${guest}` } : {}),
      },
    },
  );
  await writeFile(
    path.join(artifacts, `${guest ? "wsl" : "native"}-${name}.log`),
    result.stdout + result.stderr,
  );
  assert.equal(result.status, 0, `${name}: ${result.stderr}`);
  await copyFile(
    path.join(root, ".screenshots/pane-profile/results.json"),
    path.join(artifacts, `${guest ? "wsl" : "native"}-${name}.json`),
  );
  console.log(`${guest ?? "Windows"}: ${name} 통과`);
}
