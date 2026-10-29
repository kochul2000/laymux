// Real dev UI/PTY/Compose close and update handoff (ADR-0364).
// Start test-owned dev: CDP 9344, VITE_LAYMUX_STRICT_MODE=0, isolated app data.
// pane | app-close | handoff | verify-handoff. Handoff phases share the context.
// LAYMUX_GRACEFUL_INPROCESS=1 verifies the local rollback backend.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  api,
  until,
  sleep,
  connectDev,
  closeDevPane,
} from "./fixtures/graceful-close-dev.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const phase = process.argv[2] ?? "pane";
const contextFile = path.join(root, ".tmp/graceful-close-context.json");
const artifacts = path.join(root, ".screenshots/terminal-graceful-close");
await mkdir(artifacts, { recursive: true });
await mkdir(path.dirname(contextFile), { recursive: true });
if (phase !== "pane")
  assert.equal(
    process.env.LAYMUX_GRACEFUL_ISOLATED,
    "1",
    "app exit requires a test-owned isolated dev",
  );
const { health, socket, evaluate } = await connectDev(root);
// Reload intentionally recreates PTYs. Adoption must observe the first mount.
if (phase !== "verify-handoff")
  await evaluate("setTimeout(()=>location.reload(),20);true");
await sleep(1000);
await until(
  () => evaluate(`!!document.querySelector('[data-testid="workspace-area"]')`),
  "settings loaded",
);
await evaluate(
  `(async()=>{window.gracefulCheck={s:(await import('/src/stores/settings-store.ts')).useSettingsStore,w:(await import('/src/stores/workspace-store.ts')).useWorkspaceStore};return true})()`,
);
const docker =
  process.env.LAYMUX_GRACEFUL_DOCKER ??
  "C:/Program Files/Docker/Docker/resources/bin/docker.exe";
function dc(args) {
  const r = spawnSync(docker, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15000,
  });
  assert.equal(r.status, 0, r.stderr || r.error?.message);
  return r.stdout.trim();
}
async function events(file) {
  try {
    return (await readFile(file, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse);
  } catch {
    return [];
  }
}
async function alive(actor) {
  try {
    const stat = await readFile(
      `//wsl.localhost/${process.env.LAYMUX_GRACEFUL_DISTRO ?? "Ubuntu-22.04"}/proc/${actor.pid}/stat`,
      "utf8",
    );
    return stat.split(") ").at(-1).split(/\s+/)[19] === actor.birth;
  } catch {
    return false;
  }
}
let context;
let keepForHandoff = false;
let appExited = false;
const checks = [];
const save = () => writeFile(contextFile, JSON.stringify(context, null, 2));
async function newPane(native = false) {
  const result = await api("/panes/split", {
    paneIndex: 0,
    direction: "vertical",
    profile: native ? context.nativeProfile : context.profile,
    cwd: native ? context.directory : "/tmp",
  });
  const pane = {
    id: result.newPane.id,
    terminal: "terminal-" + result.newPane.id,
    native,
  };
  context.panes.push(pane);
  await save();
  await until(
    async () =>
      (await api("/terminals")).instances.some(
        (t) => t.id === pane.terminal && t.sessionReady && t.cwd,
      ),
    "PTY ready",
  );
  const list = (await api("/pty-sessions")).data;
  assert.equal(
    list.sessions.some(
      (s) => s.terminalId === pane.terminal && s.state === "pane",
    ),
    process.env.LAYMUX_GRACEFUL_INPROCESS !== "1",
    "PTY backend",
  );
  await evaluate(
    `(async()=>{(await import('/src/stores/overrides-store.ts')).useOverridesStore.getState().setPaneOverride(${JSON.stringify(pane.id)},{controlBarMode:'pinned'});return true})()`,
  );
  return pane;
}
const send = (pane, data) => api(`/terminals/${pane.terminal}/write`, { data });
const closePane = (pane) => closeDevPane(evaluate, pane);

async function actor(ignore = false, flood = false) {
  const pane = await newPane();
  const name = `actor-${context.panes.length}`;
  const log = path.join(context.directory, name + ".jsonl");
  await send(
    pane,
    `python3 '${context.guest}/exit_actor.py' '${context.guest}/${name}.jsonl' ${ignore ? "ignore" : flood ? "flood" : "normal"}\r`,
  );
  const ready = await until(
    async () => (await events(log)).find((e) => e.kind === "ready"),
    "actor ready",
  );
  assert.equal(ready.hasProof, true, "actual guest generation proof");
  return { pane, log, ...ready };
}
async function compose(native = false) {
  const pane = await newPane(native);
  const project = `lx-gclose-${context.token}-${context.projects.length}`;
  context.projects.push(project);
  await save();
  await send(
    pane,
    `docker compose -p '${project}' -f '${native ? context.directory.replaceAll("\\", "/") : context.guest}/compose.yml' up --no-build --pull never\r`,
  );
  const id = await until(
    () =>
      dc([
        "ps",
        "-q",
        "--filter",
        `label=com.docker.compose.project=${project}`,
      ]),
    "Compose running",
  );
  await until(
    async () =>
      JSON.stringify(
        await api(`/terminals/${pane.terminal}/output?lines=20`),
      ).includes("LAYMUX_GRACEFUL_READY"),
    "attached Compose",
  );
  return { pane, project, id };
}
const state = (service) =>
  JSON.parse(dc(["inspect", "--format", "{{json .State}}", service.id]));
async function verifyActorEnded(target, timeout = 18000) {
  await until(
    async () =>
      (await events(target.log)).some((e) => e.kind === "cleanup-complete") &&
      !(await alive(target)),
    "SIGTERM cleanup completed",
    timeout,
  );
  const values = await events(target.log);
  assert.equal(
    values.some((e) => e.kind === "SIGTERM"),
    true,
    JSON.stringify(values),
  );
  return values;
}
async function quitOrHandoff(handoff) {
  await evaluate(
    `(async()=>{await(await import('/src/lib/persist-session.ts')).persistSession();return true})()`,
  );
  if (handoff) await api("/dev/update-handoff", { mode: "installer" });
  else
    await evaluate(
      `(async()=>{const{getCurrentWindow}=await import('/node_modules/@tauri-apps/api/window.js');void getCurrentWindow().close();return true})()`,
    );
  await until(
    async () => {
      try {
        await api("/health");
        return false;
      } catch {
        return true;
      }
    },
    "dev GUI exit",
    40000,
  );
  appExited = true;
}
try {
  if (phase === "verify-handoff") {
    context = JSON.parse(await readFile(contextFile, "utf8"));
    assert.equal(
      await evaluate("gracefulCheck.w.getState().activeWorkspaceId"),
      context.workspace,
      "restored active workspace",
    );
    await until(
      async () =>
        (await api("/terminals")).instances.some(
          (t) => t.id === context.actor.pane.terminal && t.sessionReady,
        ),
      "PTY reattached",
    );
    await until(async () => {
      const inventory = (await api("/pty-sessions")).data;
      return context.savedSessions.every((saved) =>
        inventory.sessions.some(
          (s) =>
            s.sessionId === saved.sessionId &&
            s.childPid === saved.childPid &&
            s.state === "pane",
        ),
      );
    }, "same daemon sessions and children reattached");
    assert.ok(await alive(context.actor));
    assert.deepEqual(
      (await events(context.actor.log)).map((e) => e.kind),
      ["ready"],
    );
    assert.equal(state(context.compose).Running, true);
    await closePane(context.actor.pane);
    const actorEvents = await verifyActorEnded(context.actor);
    await closePane(context.compose.pane);
    await until(
      () => !state(context.compose).Running,
      "adopted Compose stopped",
    );
    checks.push({
      kind: "handoff-adoption",
      oldPid: context.originalPid,
      newPid: health.instance.pid,
      actorEvents,
      sameSessions: true,
      composeStopped: true,
    });
  } else {
    const directory = await mkdtemp(
      path.join(
        process.env.LAYMUX_GRACEFUL_FIXTURE_PARENT ?? tmpdir(),
        "laymux-gclose-",
      ),
    );
    const guest = directory
      .replaceAll("\\", "/")
      .replace(/^([A-Za-z]):/, (_, drive) => "/mnt/" + drive.toLowerCase());
    assert.ok(guest.startsWith("/mnt/"));
    const token = crypto.randomUUID().slice(0, 8);
    const original = await evaluate(
      `({profiles:gracefulCheck.s.getState().profiles,exit:gracefulCheck.s.getState().exit,codex:gracefulCheck.s.getState().codex,workspace:gracefulCheck.w.getState().activeWorkspaceId})`,
    );
    // Exercise backend SIGTERM independently of optional frontend Ctrl+C.
    await evaluate(
      `gracefulCheck.s.setState({exit:{...gracefulCheck.s.getState().exit,interruptTerminals:false},codex:{...gracefulCheck.s.getState().codex,verifySessionOnExit:false}});true`,
    );
    context = {
      directory,
      guest,
      token,
      original,
      profile: `graceful-wsl-${token}`,
      nativeProfile: `graceful-native-${token}`,
      projects: [],
      panes: [],
      originalPid: health.instance.pid,
    };
    await evaluate(
      `(()=>{const s=gracefulCheck.s.getState();for(const[name,commandLine,startingDirectory]of ${JSON.stringify(
        [
          [
            context.profile,
            `wsl.exe -d ${process.env.LAYMUX_GRACEFUL_DISTRO ?? "Ubuntu-22.04"}`,
            "/tmp",
          ],
          [
            context.nativeProfile,
            "powershell.exe -NoLogo -NoProfile",
            directory,
          ],
        ],
      )})s.addProfile({...s.profiles[0],name,commandLine,startingDirectory,startupCommand:'',restoreCwd:false,restoreOutput:false,hidden:false});return true})()`,
    );
    await evaluate(
      `(async()=>{await(await import('/src/lib/persist-session.ts')).persistSession();return true})()`,
    );
    context.workspace = (
      await api("/workspaces", {
        name: `정상 종료 dev 검증 ${token}`,
        layoutId: "default-layout",
      })
    ).workspace.id;
    await api("/workspaces/active", { id: context.workspace });
    await api("/panes/0/view", { type: "EmptyView" }, "PUT");
    await save();
    const image = process.env.LAYMUX_GRACEFUL_IMAGE ?? "redis:6.2.24";
    dc(["image", "inspect", image]);
    await writeFile(
      path.join(directory, "compose.yml"),
      `services:\n  sleeper:\n    image: ${image}\n    command: ["sh", "-c", "trap 'exit 0' TERM INT; echo LAYMUX_GRACEFUL_READY; while :; do sleep 0.1; done"]\n    network_mode: none\n    mem_limit: 32m\n    cpus: 0.10\n    pids_limit: 16\n    stop_grace_period: 3s\n    labels:\n      laymux.test.owner: graceful-close-e2e\n`,
    );
    await writeFile(
      path.join(directory, "exit_actor.py"),
      String.raw`import os,sys,json,signal,time
from pathlib import Path
file=Path(sys.argv[1]); ignore=sys.argv[2]=='ignore'; flood=sys.argv[2]=='flood'
birth=Path('/proc/self/stat').read_text().rsplit(') ',1)[1].split()[19]
def log(kind):
 with file.open('a') as f: f.write(json.dumps({'kind':kind,'pid':os.getpid(),'birth':birth,'at':time.time(),'hasProof':bool(os.environ.get('LX_AGENT_HOOK_TOKEN'))})+'\n')
def handler(sig,frame):
 log(signal.Signals(sig).name)
 if ignore and sig==signal.SIGTERM: return
 if flood:
  for i in range(64): os.write(1,b'X'*65536)
 time.sleep(1); log('cleanup-complete'); sys.exit(0)
for sig in (signal.SIGHUP,signal.SIGINT,signal.SIGTERM): signal.signal(sig,handler)
log('ready'); print('GRACEFUL_ACTOR_READY',flush=True)
while True:
 file.with_suffix('.tick').write_text(str(time.time()));time.sleep(.2)
`,
    );
    if (phase === "pane") {
      const peer = await actor();
      const closing = await actor();
      await closePane(closing.pane);
      checks.push({ kind: "SIGTERM", events: await verifyActorEnded(closing) });
      const noisy = await actor(false, true);
      await closePane(noisy.pane);
      checks.push({
        kind: "cleanup-output-drain",
        events: await verifyActorEnded(noisy),
      });
      assert.ok(await alive(peer));
      assert.deepEqual(
        (await events(peer.log)).map((e) => e.kind),
        ["ready"],
      );
      const stubborn = await actor(true);
      const started = Date.now();
      await closePane(stubborn.pane);
      await verifyActorEnded(stubborn, 20000);
      assert.ok(
        Date.now() - started >= 11000,
        "timeout fallback must allow the grace period",
      );
      checks.push({
        kind: "timeout",
        elapsedMs: Date.now() - started,
        events: await events(stubborn.log),
      });
      // Native console event delivery is covered by graceful_console_close.rs.
      // Optional native Compose probe: CLI versions may ignore console events.
      for (const native of process.env.LAYMUX_GRACEFUL_NATIVE_COMPOSE === "1"
        ? [false, true]
        : [false]) {
        const service = await compose(native);
        const screenshot = (await api("/screenshot", {})).path;
        await closePane(service.pane);
        await until(
          () => !state(service).Running,
          "foreground Compose stopped",
        );
        checks.push({
          kind: "compose",
          native,
          state: state(service),
          screenshot,
        });
      }
      assert.ok(await alive(peer));
      assert.deepEqual(
        (await events(peer.log)).map((e) => e.kind),
        ["ready"],
      );
      await closePane(peer.pane);
      await verifyActorEnded(peer);
      checks.push({ kind: "peer-isolation", passed: true });
    } else {
      context.actor = await actor(false, true);
      context.compose = await compose();
      context.savedSessions = (await api("/pty-sessions")).data.sessions.filter(
        (s) =>
          [context.actor.pane.terminal, context.compose.pane.terminal].includes(
            s.terminalId,
          ),
      );
      await save();
      if (phase === "handoff") {
        assert.notEqual(process.env.LAYMUX_GRACEFUL_INPROCESS, "1");
        await api("/dev/update-handoff", { mode: "prepare" });
        assert.deepEqual(
          (await events(context.actor.log)).map((e) => e.kind),
          ["ready"],
        );
        assert.ok(await alive(context.actor));
        assert.equal(state(context.compose).Running, true);
        await quitOrHandoff(true);
        await sleep(1500);
        assert.ok(await alive(context.actor));
        assert.equal(state(context.compose).Running, true);
        assert.deepEqual(
          (await events(context.actor.log)).map((e) => e.kind),
          ["ready"],
        );
        keepForHandoff = true;
        checks.push({ kind: "handoff", prepareAndInstallerPassed: true });
      } else {
        assert.equal(phase, "app-close");
        await quitOrHandoff(false);
        const values = await verifyActorEnded(context.actor);
        await until(
          () => !state(context.compose).Running,
          "app-close Compose stopped",
        );
        checks.push({
          kind: "app-close",
          events: values,
          composeStopped: true,
        });
      }
    }
  }
  await writeFile(
    path.join(artifacts, `${phase}-${context.token}.json`),
    JSON.stringify({ health, checks, context }, null, 2),
  );
  console.log(JSON.stringify({ phase, token: context.token, checks }, null, 2));
} finally {
  if (context && !keepForHandoff) {
    for (const project of context.projects) {
      assert.ok(project.startsWith(`lx-gclose-${context.token}-`));
      dc([
        "compose",
        "-p",
        project,
        "-f",
        path.join(context.directory, "compose.yml"),
        "down",
      ]);
      assert.equal(
        dc([
          "ps",
          "-q",
          "--filter",
          `label=com.docker.compose.project=${project}`,
        ]),
        "",
      );
    }
    if (!appExited) {
      await api("/workspaces/active", { id: context.original.workspace });
      await api(`/workspaces/${context.workspace}`, undefined, "DELETE");
      await evaluate(
        `gracefulCheck.s.setState(${JSON.stringify({ profiles: context.original.profiles, exit: context.original.exit, codex: context.original.codex })});true`,
      );
      await evaluate(
        `(async()=>{await(await import('/src/lib/persist-session.ts')).persistSession();return true})()`,
      );
    }
  }
  socket.close();
}
