import { describe, expect, it } from "vitest";
import { shouldStabilizeInitialExecutionHost } from "./terminal-execution-host";

describe("shouldStabilizeInitialExecutionHost", () => {
  it("enables only native Windows sessions", () => {
    expect(shouldStabilizeInitialExecutionHost("nativeWindows")).toBe(true);
    expect(shouldStabilizeInitialExecutionHost("wsl")).toBe(false);
    expect(shouldStabilizeInitialExecutionHost("directSsh")).toBe(false);
    expect(shouldStabilizeInitialExecutionHost("nonWindows")).toBe(false);
    expect(shouldStabilizeInitialExecutionHost("unknown")).toBe(false);
  });
});
