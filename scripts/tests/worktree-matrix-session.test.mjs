import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { assertSetupMayStart } from "../verify-worktree-matrix-session.mjs";

async function fixture(t) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "laymux-matrix-session-test-"),
  );
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(
      path.basename(directory).startsWith("laymux-matrix-session-test-"),
    );
    await rm(directory, { recursive: true, force: true });
  });
  return path.join(directory, "session.json");
}

test("상태 파일이 없으면 첫 검증을 시작할 수 있다", async (t) => {
  await assert.doesNotReject(assertSetupMayStart(await fixture(t)));
});

test("미복원 검증과 중간 실패 기록을 덮어쓰지 않고 복원을 안내한다", async (t) => {
  const file = await fixture(t);
  for (const restored of [undefined, false]) {
    const original = JSON.stringify({
      originalRemote: { authToken: "fixture-secret" },
      restored,
    });
    await writeFile(file, original);
    await assert.rejects(assertSetupMayStart(file), /--restore/);
    assert.equal(await readFile(file, "utf8"), original);
  }
});

test("복원이 완료된 기록은 그대로 둔 채 다음 검증을 허용한다", async (t) => {
  const file = await fixture(t);
  const original = JSON.stringify({ restored: true });
  await writeFile(file, original);
  await assert.doesNotReject(assertSetupMayStart(file));
  assert.equal(await readFile(file, "utf8"), original);
});

test("손상된 기록은 보존하고 토큰을 오류에 노출하지 않는다", async (t) => {
  const file = await fixture(t);
  const original = '{"token":"fixture-secret",';
  await writeFile(file, original);
  await assert.rejects(assertSetupMayStart(file), (error) => {
    assert.match(error.message, /복원/);
    assert.ok(!error.message.includes("fixture-secret"));
    return true;
  });
  assert.equal(await readFile(file, "utf8"), original);
});
