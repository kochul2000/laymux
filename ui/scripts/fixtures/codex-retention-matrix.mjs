// Mutates only a matrix-owned Codex database, never the user's shared store.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

const [directory, retention = "inspect"] = process.argv.slice(2);
const root = resolve(directory);
assert(root.includes("attribution-matrix"), "An isolated matrix directory is mandatory");
const file = readdirSync(root)
  .filter((p) => /^logs_\d+\.sqlite$/.test(p))
  .sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]))[0];
assert(file);
const db = new DatabaseSync(join(root, file));
db.exec("PRAGMA busy_timeout=2000");
const identity =
  process.argv[4] ??
  db
    .prepare(
      "SELECT process_uuid FROM logs WHERE process_uuid LIKE 'pid:%' ORDER BY id DESC LIMIT 1",
    )
    .get()?.process_uuid;
assert(identity);
assert(/^pid:\d+:[a-zA-Z0-9-]+$/.test(identity));
const backup = join(root, `threadless-${identity.replaceAll(":", "-")}.json`);
if (retention !== "inspect") {
  db.exec("BEGIN IMMEDIATE");
  try {
    const rows = db
      .prepare("SELECT * FROM logs WHERE process_uuid=? AND thread_id IS NULL ORDER BY id")
      .all(identity);
    if (!existsSync(backup)) writeFileSync(backup, JSON.stringify(rows));
    const original = JSON.parse(readFileSync(backup, "utf8"));
    assert(original.length);
    const keys = Object.keys(original[0]);
    const restore = db.prepare(
      `INSERT OR IGNORE INTO logs (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
    );
    for (const row of original) restore.run(...keys.map((k) => row[k]));
    const insertKeys = keys.filter((k) => k !== "id");
    const late = {
      ...original.at(-1),
      feedback_log_body: "retention matrix late threadless diagnostic",
    };
    const lateId = db
      .prepare(
        `INSERT INTO logs (${insertKeys.join(",")}) VALUES (${insertKeys.map(() => "?").join(",")})`,
      )
      .run(...insertKeys.map((k) => late[k])).lastInsertRowid;
    const predicate = {
      intact: "0",
      initial: `id=${original[0].id}`,
      partial: `id<=${original[Math.floor(original.length / 2)].id}`,
      all: "1",
      late_only: `id<${lateId}`,
    }[retention];
    assert(predicate !== undefined, "Unknown retention case");
    db.prepare(
      `DELETE FROM logs WHERE process_uuid=? AND thread_id IS NULL AND (${predicate})`,
    ).run(identity);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
const result = {
  identity,
  file: join(root, file),
  retention,
  counts: db
    .prepare(
      "SELECT COUNT(*) AS total, MIN(id) AS first, MIN(CASE WHEN thread_id IS NULL THEN id END) AS firstThreadless FROM logs WHERE process_uuid=?",
    )
    .get(identity),
  lifecycle: db
    .prepare(
      "SELECT id,thread_id,substr(feedback_log_body,1,2048) AS body FROM logs WHERE process_uuid=? AND (feedback_log_body LIKE 'app_server.request{%rpc.method=\"thread/%' OR feedback_log_body LIKE 'session_loop{%') ORDER BY id",
    )
    .all(identity),
};
console.log(JSON.stringify(result));
db.close();
