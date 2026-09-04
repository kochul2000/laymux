import { describe, expect, it } from "vitest";
import { fileKindIconName } from "./file-kind-icon";

describe("fileKindIconName", () => {
  it("uses FolderUp for the parent row", () => {
    expect(fileKindIconName({ isDirectory: true }, true)).toBe("FolderUp");
  });

  it("classifies a directory ahead of a symlink", () => {
    expect(fileKindIconName({ isDirectory: true, isSymlink: true })).toBe("Folder");
    expect(fileKindIconName({ isDirectory: true, isSymlink: false })).toBe("Folder");
  });

  it("classifies a non-directory symlink as Link", () => {
    expect(fileKindIconName({ isDirectory: false, isSymlink: true })).toBe("Link");
  });

  it("classifies a regular file as File", () => {
    expect(fileKindIconName({ isDirectory: false, isSymlink: false })).toBe("File");
    expect(fileKindIconName({ isDirectory: false })).toBe("File");
  });
});
