/* global fetch */
// Windows, isolated dev only. Arguments: baseline JSON, CODEX_SQLITE_HOME, result JSON.
// Baseline: { expected: { terminalId: { provider, sessionId } }, ledger: [{ id, provider, host }] }.
import assert from "node:assert/strict";
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { setTimeout, clearTimeout } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "@playwright/test";

assert.equal(process.platform, "win32");
assert.equal(process.env.LAYMUX_REPRO_ISOLATED, "1");
const [baselineFile, sqliteHome, outputFile] = process.argv.slice(2);
assert(baselineFile && sqliteHome && outputFile);
const baseline = JSON.parse(readFileSync(baselineFile, "utf8"));
const health = await (await fetch("http://127.0.0.1:19281/api/v1/health")).json();
assert.equal(health.instance.buildKind, "dev");
const worktree = realpathSync(path.resolve(".."));
assert.equal(realpathSync(health.instance.worktreeRoot), worktree);
const home = realpathSync(sqliteHome);
assert(home.toLowerCase().startsWith((path.join(worktree, ".tmp") + path.sep).toLowerCase()));
const native = baseline.ledger.filter((p) => p.provider === "codex" && p.host === "windows");
const guest = baseline.ledger.filter((p) => p.provider === "codex" && p.host === "wsl");
assert(native.length >= 2 && guest.length >= 2, "need two real Codex panes per host");
const numbers = readdirSync(home)
  .map((file) => /^logs_(\d+)\.sqlite$/.exec(file))
  .filter(Boolean)
  .map((match) => Number(match[1]));
assert(numbers.length);
const latest = Math.max(...numbers);
const fixture = path.join(home, `logs_${latest + 1}.sqlite`);
assert(!existsSync(fixture));
async function removeSnapshot() {
  // Activity reconciliation can briefly have this read-only snapshot open.
  for (let attempt = 0; ; attempt++) {
    try {
      unlinkSync(fixture);
      return;
    } catch (error) {
      if (attempt >= 49 || !["EBUSY", "EPERM"].includes(error.code)) throw error;
      await delay(100);
    }
  }
}
const browser = await chromium.connectOverCDP("http://127.0.0.1:9229");
const samples = [];
try {
  const page = browser
    .contexts()
    .flatMap((c) => c.pages())
    .find((p) => p.url().startsWith("http://localhost:1420"));
  assert(page);
  async function check(name, locked = false) {
    const sample = await page.evaluate(
      async ({ baseline, affected }) => {
        const api = await import("/src/lib/tauri-api.ts");
        const { flushSessionCheckpoint } = await import("/src/lib/persist-session.ts");
        const started = Date.now();
        const attributions = await api.getTerminalSessionAttributions();
        let error;
        try {
          await flushSessionCheckpoint({ reason: "update", requireConclusive: true });
        } catch (e) {
          error = String(e);
        }
        if (affected.length) await flushSessionCheckpoint({ reason: "watchdog" });
        const saved = await api.loadSettings();
        const failures = [];
        for (const [id, expected] of Object.entries(baseline.expected)) {
          const got = attributions[id];
          if (affected.includes(id)) {
            if (got?.state !== "unknown")
              failures.push(`${id}: expected unknown, got ${JSON.stringify(got)}`);
          } else if (
            got?.state !== "identified" ||
            got.provider !== expected.provider ||
            got.sessionId !== expected.sessionId
          ) {
            failures.push(`${id}: healthy peer changed to ${JSON.stringify(got)}`);
          }
          const view = saved.workspaces
            .flatMap((w) => w.panes)
            .find((p) => `terminal-${p.id}` === id)?.view;
          for (const [provider, field] of Object.entries({
            claude: "lastClaudeSession",
            codex: "lastCodexSession",
            grok: "lastGrokSession",
          })) {
            if (view?.[field] !== (provider === expected.provider ? expected.sessionId : undefined))
              failures.push(`${id}: saved ${field} changed`);
          }
          if (view?.lastAgentFresh !== undefined) failures.push(`${id}: unexpected fresh launch`);
        }
        if (Boolean(error) !== Boolean(affected.length))
          failures.push(`unexpected checkpoint outcome: ${error}`);
        return { attributions, error, failures, elapsedMs: Date.now() - started };
      },
      { baseline, affected: locked ? native.map((p) => p.id) : [] },
    );
    samples.push({ name, ...sample });
    writeFileSync(outputFile, JSON.stringify({ health, samples }, null, 2));
    console.log(JSON.stringify({ name, failures: sample.failures, elapsedMs: sample.elapsedMs }));
    return sample;
  }
  assert.deepEqual((await check("original-readable")).failures, []);
  const db = new DatabaseSync(path.join(home, `logs_${latest}.sqlite`), { readOnly: true });
  try {
    db.prepare("VACUUM INTO ?").run(fixture);
  } finally {
    db.close();
  }
  try {
    assert.deepEqual((await check("snapshot-readable")).failures, []);
    const script = `$ErrorActionPreference='Stop';for($i=0;$i -lt 50;$i++){try{$f=[IO.File]::Open('${fixture.replaceAll("'", "''")}','Open','Read','None');break}catch{if($i -eq 49){throw};Start-Sleep -Milliseconds 100}};[Console]::WriteLine('ready');[Console]::ReadLine() | Out-Null;$f.Dispose()`;
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-OutputFormat",
        "Text",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    const exited = new Promise((resolve) => child.once("exit", resolve));
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("file lock did not start")), 10000);
        const done = (error) => {
          clearTimeout(timer);
          if (error) reject(error);
          else resolve();
        };
        child.once("error", done);
        child.once("exit", (code) => done(new Error(`lock helper exited: ${code}`)));
        child.stdout.on("data", (data) => {
          if (data.toString().includes("ready")) done();
        });
        child.stderr.on("data", (data) => done(new Error(data.toString())));
      });
      for (let i = 0; i < 3; i++) await check(`native-locked-${i + 1}`, true);
    } finally {
      child.stdin.end("\n");
      await exited;
    }
    await check("snapshot-unlocked");
  } finally {
    await removeSnapshot();
  }
  await check("original-recovered");
  assert.deepEqual(
    samples.flatMap((sample) => sample.failures),
    [],
  );
} finally {
  await browser.close();
}
