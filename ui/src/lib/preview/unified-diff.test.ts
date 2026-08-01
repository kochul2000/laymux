import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "./unified-diff";

function lines(...parts: string[]): string {
  return parts.join("\n");
}

describe("parseUnifiedDiff", () => {
  it("returns an empty result for empty input", () => {
    expect(parseUnifiedDiff("")).toEqual({ files: [], truncated: false, totalLines: 0 });
  });

  it("parses a git header with an index line as a modification", () => {
    const result = parseUnifiedDiff(
      lines(
        "diff --git a/src/app.ts b/src/app.ts",
        "index 83db48f..bf269f4 100644",
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -1,2 +1,2 @@",
        "-const a = 1;",
        "+const a = 2;",
        " export {};",
      ),
    );

    expect(result.files).toHaveLength(1);
    expect(result.files[0].oldPath).toBe("src/app.ts");
    expect(result.files[0].newPath).toBe("src/app.ts");
    expect(result.files[0].status).toBe("modified");
    expect(result.files[0].binary).toBe(false);
    expect(result.files[0].additions).toBe(1);
    expect(result.files[0].deletions).toBe(1);
    expect(result.totalLines).toBe(3);
    expect(result.truncated).toBe(false);
  });

  it("derives added status from a new file mode header", () => {
    const result = parseUnifiedDiff(
      lines(
        "diff --git a/new.txt b/new.txt",
        "new file mode 100644",
        "index 0000000..d95f3ad",
        "--- /dev/null",
        "+++ b/new.txt",
        "@@ -0,0 +1,2 @@",
        "+one",
        "+two",
      ),
    );

    expect(result.files[0].status).toBe("added");
    expect(result.files[0].newPath).toBe("new.txt");
    expect(result.files[0].additions).toBe(2);
    expect(result.files[0].deletions).toBe(0);
  });

  it("derives deleted status from a deleted file mode header", () => {
    const result = parseUnifiedDiff(
      lines(
        "diff --git a/gone.txt b/gone.txt",
        "deleted file mode 100644",
        "index d95f3ad..0000000",
        "--- a/gone.txt",
        "+++ /dev/null",
        "@@ -1,2 +0,0 @@",
        "-one",
        "-two",
      ),
    );

    expect(result.files[0].status).toBe("deleted");
    expect(result.files[0].oldPath).toBe("gone.txt");
    expect(result.files[0].deletions).toBe(2);
    expect(result.files[0].additions).toBe(0);
  });

  it("derives renamed status and both paths from rename headers", () => {
    const result = parseUnifiedDiff(
      lines(
        "diff --git a/old/name.txt b/new/name.txt",
        "similarity index 87%",
        "rename from old/name.txt",
        "rename to new/name.txt",
        "index 1111111..2222222 100644",
        "--- a/old/name.txt",
        "+++ b/new/name.txt",
        "@@ -1 +1 @@",
        "-a",
        "+b",
      ),
    );

    expect(result.files[0].status).toBe("renamed");
    expect(result.files[0].oldPath).toBe("old/name.txt");
    expect(result.files[0].newPath).toBe("new/name.txt");
  });

  it("keeps a pure rename with no hunks", () => {
    const result = parseUnifiedDiff(
      lines(
        "diff --git a/a.txt b/b.txt",
        "similarity index 100%",
        "rename from a.txt",
        "rename to b.txt",
      ),
    );

    expect(result.files[0].status).toBe("renamed");
    expect(result.files[0].hunks).toEqual([]);
    expect(result.totalLines).toBe(0);
  });

  it("treats a mode-only change as a modification with no hunks", () => {
    const result = parseUnifiedDiff(
      lines("diff --git a/run.sh b/run.sh", "old mode 100644", "new mode 100755"),
    );

    expect(result.files).toHaveLength(1);
    expect(result.files[0].status).toBe("modified");
    expect(result.files[0].binary).toBe(false);
    expect(result.files[0].hunks).toEqual([]);
  });

  it("parses a plain unified diff without a git header and strips timestamps", () => {
    const result = parseUnifiedDiff(
      lines(
        "--- a/plain.txt\t2024-01-01 10:00:00.000000000 +0900",
        "+++ b/plain.txt\t2024-01-02 10:00:00.000000000 +0900",
        "@@ -1,2 +1,2 @@",
        " keep",
        "-drop",
        "+add",
      ),
    );

    expect(result.files).toHaveLength(1);
    expect(result.files[0].oldPath).toBe("plain.txt");
    expect(result.files[0].newPath).toBe("plain.txt");
    expect(result.files[0].status).toBe("modified");
    expect(result.files[0].hunks[0].lines.map((l) => l.type)).toEqual(["context", "del", "add"]);
  });

  it("treats /dev/null markers as added and deleted without a git header", () => {
    const added = parseUnifiedDiff(
      lines("--- /dev/null", "+++ b/fresh.txt", "@@ -0,0 +1 @@", "+hello"),
    );
    const deleted = parseUnifiedDiff(
      lines("--- a/stale.txt", "+++ /dev/null", "@@ -1 +0,0 @@", "-bye"),
    );

    expect(added.files[0].status).toBe("added");
    expect(added.files[0].oldPath).toBe("/dev/null");
    expect(deleted.files[0].status).toBe("deleted");
    expect(deleted.files[0].newPath).toBe("/dev/null");
  });

  it("keeps the section heading in the hunk header", () => {
    const result = parseUnifiedDiff(
      lines(
        "--- a/x.ts",
        "+++ b/x.ts",
        "@@ -5,1 +5,1 @@ function greet() {",
        '-  return "hi";',
        '+  return "hello";',
      ),
    );

    expect(result.files[0].hunks[0].header).toBe("@@ -5,1 +5,1 @@ function greet() {");
  });

  it("assigns line numbers from the hunk header and advances them per line type", () => {
    const result = parseUnifiedDiff(
      lines(
        "--- a/f.txt",
        "+++ b/f.txt",
        "@@ -10,3 +11,4 @@",
        " ctx",
        "-old",
        "+new1",
        "+new2",
        " tail",
      ),
    );

    expect(result.files[0].hunks[0].lines).toEqual([
      { type: "context", oldNumber: 10, newNumber: 11, text: "ctx" },
      { type: "del", oldNumber: 11, text: "old" },
      { type: "add", newNumber: 12, text: "new1" },
      { type: "add", newNumber: 13, text: "new2" },
      { type: "context", oldNumber: 12, newNumber: 14, text: "tail" },
    ]);
  });

  it("treats an omitted hunk count as one line", () => {
    const result = parseUnifiedDiff(lines("--- a/f.txt", "+++ b/f.txt", "@@ -7 +9 @@", "-a", "+b"));

    expect(result.files[0].hunks[0].lines).toEqual([
      { type: "del", oldNumber: 7, text: "a" },
      { type: "add", newNumber: 9, text: "b" },
    ]);
  });

  it("records a no-newline marker as a meta line that consumes no line number", () => {
    const result = parseUnifiedDiff(
      lines(
        "--- a/f.txt",
        "+++ b/f.txt",
        "@@ -1 +1 @@",
        "-a",
        "\\ No newline at end of file",
        "+b",
        "\\ No newline at end of file",
      ),
    );

    expect(result.files[0].hunks[0].lines).toEqual([
      { type: "del", oldNumber: 1, text: "a" },
      { type: "meta", text: "\\ No newline at end of file" },
      { type: "add", newNumber: 1, text: "b" },
      { type: "meta", text: "\\ No newline at end of file" },
    ]);
    expect(result.totalLines).toBe(4);
  });

  it("marks a Binary files line as binary with no hunks", () => {
    const withHeader = parseUnifiedDiff(
      lines(
        "diff --git a/img.png b/img.png",
        "index 1111111..2222222 100644",
        "Binary files a/img.png and b/img.png differ",
      ),
    );
    const bare = parseUnifiedDiff("Binary files a/x.bin and b/x.bin differ");

    expect(withHeader.files[0].binary).toBe(true);
    expect(withHeader.files[0].hunks).toEqual([]);
    expect(bare.files).toHaveLength(1);
    expect(bare.files[0].binary).toBe(true);
    expect(bare.files[0].oldPath).toBe("x.bin");
    expect(bare.files[0].newPath).toBe("x.bin");
  });

  it("marks a GIT binary patch as binary and resumes at the next file", () => {
    const result = parseUnifiedDiff(
      lines(
        "diff --git a/img.png b/img.png",
        "new file mode 100644",
        "index 0000000..1111111",
        "GIT binary patch",
        "literal 12",
        "TcmZQzU|?_)00mMr7yv0(0RR91",
        "",
        "literal 0",
        "HcmV?d00001",
        "",
        "diff --git a/after.txt b/after.txt",
        "--- a/after.txt",
        "+++ b/after.txt",
        "@@ -1 +1 @@",
        "-a",
        "+b",
      ),
    );

    expect(result.files).toHaveLength(2);
    expect(result.files[0].binary).toBe(true);
    expect(result.files[0].status).toBe("added");
    expect(result.files[0].hunks).toEqual([]);
    expect(result.files[1].binary).toBe(false);
    expect(result.files[1].newPath).toBe("after.txt");
    expect(result.totalLines).toBe(2);
  });

  it("keeps header-looking content inside a hunk and still finds the next file", () => {
    const result = parseUnifiedDiff(
      lines(
        "diff --git a/patch.md b/patch.md",
        "index 1111111..2222222 100644",
        "--- a/patch.md",
        "+++ b/patch.md",
        "@@ -1,4 +1,4 @@",
        " Example diff snippet:",
        "-diff --git a/old b/old",
        "---- a/fake",
        "++++ b/fake",
        "+@@ -1 +1 @@",
        " done",
        "diff --git a/next.txt b/next.txt",
        "--- a/next.txt",
        "+++ b/next.txt",
        "@@ -1 +1 @@",
        "-x",
        "+y",
      ),
    );

    expect(result.files).toHaveLength(2);
    expect(result.files[0].hunks[0].lines.map((l) => l.text)).toEqual([
      "Example diff snippet:",
      "diff --git a/old b/old",
      "--- a/fake",
      "+++ b/fake",
      "@@ -1 +1 @@",
      "done",
    ]);
    expect(result.files[0].additions).toBe(2);
    expect(result.files[0].deletions).toBe(2);
    expect(result.files[1].newPath).toBe("next.txt");
    expect(result.files[1].hunks[0].lines).toHaveLength(2);
  });

  it("parses a multi-file diff", () => {
    const result = parseUnifiedDiff(
      lines(
        "diff --git a/one.txt b/one.txt",
        "--- a/one.txt",
        "+++ b/one.txt",
        "@@ -1 +1 @@",
        "-1",
        "+11",
        "diff --git a/two.txt b/two.txt",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/two.txt",
        "@@ -0,0 +1,2 @@",
        "+2",
        "+22",
      ),
    );

    expect(result.files.map((f) => f.newPath)).toEqual(["one.txt", "two.txt"]);
    expect(result.files.map((f) => f.status)).toEqual(["modified", "added"]);
    expect(result.totalLines).toBe(4);
  });

  it("ignores the commit message that precedes the first file header", () => {
    const result = parseUnifiedDiff(
      lines(
        "From 1234567890abcdef Mon Sep 17 00:00:00 2001",
        "From: Dev <dev@example.com>",
        "Subject: [PATCH] add greeting",
        "",
        "The body mentions --- and +++ and @@ markers.",
        "",
        "---",
        " hello.txt | 1 +",
        " 1 file changed, 1 insertion(+)",
        "",
        "diff --git a/hello.txt b/hello.txt",
        "new file mode 100644",
        "index 0000000..ce01362",
        "--- /dev/null",
        "+++ b/hello.txt",
        "@@ -0,0 +1 @@",
        "+hello",
      ),
    );

    expect(result.files).toHaveLength(1);
    expect(result.files[0].newPath).toBe("hello.txt");
    expect(result.files[0].status).toBe("added");
    expect(result.files[0].hunks[0].lines).toEqual([{ type: "add", newNumber: 1, text: "hello" }]);
    expect(result.totalLines).toBe(1);
  });

  it("caps emitted lines at maxLines while still reporting the source total", () => {
    const result = parseUnifiedDiff(
      lines(
        "diff --git a/one.txt b/one.txt",
        "--- a/one.txt",
        "+++ b/one.txt",
        "@@ -1,2 +1,2 @@",
        "-1",
        "-2",
        "+1a",
        "+2a",
        "diff --git a/two.txt b/two.txt",
        "--- a/two.txt",
        "+++ b/two.txt",
        "@@ -1 +1 @@",
        "-3",
        "+3a",
      ),
    );
    const capped = parseUnifiedDiff(
      lines(
        "diff --git a/one.txt b/one.txt",
        "--- a/one.txt",
        "+++ b/one.txt",
        "@@ -1,2 +1,2 @@",
        "-1",
        "-2",
        "+1a",
        "+2a",
        "diff --git a/two.txt b/two.txt",
        "--- a/two.txt",
        "+++ b/two.txt",
        "@@ -1 +1 @@",
        "-3",
        "+3a",
      ),
      { maxLines: 3 },
    );

    expect(result.truncated).toBe(false);
    expect(result.totalLines).toBe(6);
    expect(capped.truncated).toBe(true);
    expect(capped.totalLines).toBe(6);
    expect(capped.files.flatMap((f) => f.hunks).flatMap((h) => h.lines)).toHaveLength(3);
    // Stats describe the source, so the cap must not distort them.
    expect(capped.files[1].deletions).toBe(1);
    expect(capped.files[1].additions).toBe(1);
  });
});
