import { describe, expect, it, vi } from "vitest";
import { MemoDocument } from "./memo-document";

describe("shared memo document", () => {
  it("uses the loaded content as the compare-and-save baseline", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const memo = new MemoDocument(() => Promise.resolve("PC note"), save);
    await memo.refresh();
    memo.edit("Phone edit");
    await memo.save();
    expect(save).toHaveBeenCalledWith("Phone edit", "PC note");
    expect(memo.getSnapshot().dirty).toBe(false);
  });

  it("preserves an edit made during a save and serializes the next save", async () => {
    let finish!: () => void;
    const save = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const memo = new MemoDocument(() => Promise.resolve("base"), save);
    await memo.refresh();
    memo.edit("first");
    const pending = memo.save();
    memo.edit("second");
    const queued = memo.save();
    finish();
    await Promise.all([pending, queued]);
    expect(save.mock.calls).toEqual([
      ["first", "base"],
      ["second", "first"],
    ]);
    expect(memo.getSnapshot().text).toBe("second");
    expect(memo.getSnapshot().dirty).toBe(false);
  });

  it("keeps the draft on conflict and does not silently accept a new baseline", async () => {
    const load = vi.fn().mockResolvedValue("original");
    const save = vi.fn().mockRejectedValue(new Error("Memo changed; reload"));
    const memo = new MemoDocument(load, save);
    await memo.refresh();
    memo.edit("draft");
    await memo.save();
    load.mockResolvedValue("PC edit");
    await memo.refresh();
    expect(memo.getSnapshot()).toMatchObject({
      text: "draft",
      dirty: true,
      error: "Memo changed; reload",
    });
    await memo.refresh(true);
    expect(memo.getSnapshot()).toMatchObject({ text: "PC edit", dirty: false, error: null });
  });

  it("does not overwrite typing with a late read", async () => {
    let finish!: (value: string) => void;
    const memo = new MemoDocument(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
      vi.fn(),
    );
    const pending = memo.refresh();
    memo.edit("typed");
    finish("old");
    await pending;
    expect(memo.getSnapshot().text).toBe("typed");
  });
});
