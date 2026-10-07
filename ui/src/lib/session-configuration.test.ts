import { beforeEach, describe, expect, it } from "vitest";
import {
  configurationNeedsSave,
  resetSessionConfiguration,
  seedSessionConfiguration,
} from "./session-configuration";
import type { Settings } from "./tauri-api";
const settings = () =>
  ({ language: "ko", profiles: [], layouts: [], workspaces: [], docks: [] }) as unknown as Settings;
describe("configuration write boundary", () => {
  beforeEach(resetSessionConfiguration);
  it("ignores session and workspace mutations but saves changed templates and preferences", () => {
    const before = settings();
    seedSessionConfiguration(before);
    expect(
      configurationNeedsSave({
        ...before,
        workspaces: [{ id: "local", name: "local", panes: [] }],
      }),
    ).toBe(false);
    expect(configurationNeedsSave({ ...before, language: "en" })).toBe(true);
    expect(
      configurationNeedsSave({ ...before, layouts: [{ id: "new", name: "new", panes: [] }] }),
    ).toBe(true);
  });
});
