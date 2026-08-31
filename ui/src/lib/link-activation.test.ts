import { describe, it, expect } from "vitest";
import {
  DEFAULT_LINK_ACTIVATION,
  LINK_ACTIVATION_MODES,
  decideLinkActivation,
  linkChipLabelKey,
  normalizeLinkActivation,
  type LinkActivationMode,
  type LinkSurface,
  type LinkTargetKind,
} from "./link-activation";

const NO_MODS = { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false };

describe("normalizeLinkActivation", () => {
  it("defaults to immediate so an existing install keeps opening on first click", () => {
    expect(DEFAULT_LINK_ACTIVATION).toBe("immediate");
    expect(LINK_ACTIVATION_MODES).toEqual(["immediate", "chip"]);
    for (const bogus of [undefined, null, "", "sheet", "double-click", 1, {}]) {
      expect(normalizeLinkActivation(bogus)).toBe("immediate");
    }
    expect(normalizeLinkActivation("chip")).toBe("chip");
    expect(normalizeLinkActivation("immediate")).toBe("immediate");
  });
});

describe("decideLinkActivation — immediate mode is the current behavior", () => {
  const cases: Array<{ surface: LinkSurface; target: LinkTargetKind; action: string }> = [
    { surface: "desktop", target: "url", action: "browser" },
    { surface: "desktop", target: "file", action: "viewer" },
    { surface: "desktop", target: "directory", action: "changeDir" },
    { surface: "remote", target: "url", action: "browser" },
    { surface: "remote", target: "file", action: "viewer" },
    // ADR-0045: Remote 는 cwd 를 전파하지 않는다 — 디렉터리는 탐색기 오버레이다.
    { surface: "remote", target: "directory", action: "explorer" },
  ];

  for (const { surface, target, action } of cases) {
    it(`${surface}/${target} opens ${action} directly`, () => {
      const result = decideLinkActivation({
        mode: "immediate",
        surface,
        target,
        modifiers: surface === "desktop" ? NO_MODS : undefined,
        osOpenEnabled: true,
      });
      expect(result).toEqual({ kind: "open-direct", action, bypass: false });
    });
  }
});

describe("decideLinkActivation — chip mode executes nothing", () => {
  it("desktop file offers viewer, OS open and copy", () => {
    const result = decideLinkActivation({
      mode: "chip",
      surface: "desktop",
      target: "file",
      modifiers: NO_MODS,
      osOpenEnabled: true,
    });
    expect(result).toEqual({ kind: "show-chip", actions: ["viewer", "osOpen", "copy"] });
  });

  it("desktop directory offers cwd change, the file manager and copy", () => {
    const result = decideLinkActivation({
      mode: "chip",
      surface: "desktop",
      target: "directory",
      modifiers: NO_MODS,
      osOpenEnabled: true,
    });
    expect(result).toEqual({ kind: "show-chip", actions: ["changeDir", "osOpen", "copy"] });
  });

  it("drops the OS action when the OS open feature is off", () => {
    for (const target of ["file", "directory"] as const) {
      const result = decideLinkActivation({
        mode: "chip",
        surface: "desktop",
        target,
        modifiers: NO_MODS,
        osOpenEnabled: false,
      });
      expect(result).toEqual({
        kind: "show-chip",
        actions: [target === "file" ? "viewer" : "changeDir", "copy"],
      });
    }
  });

  it("desktop url offers the browser and copy", () => {
    const result = decideLinkActivation({
      mode: "chip",
      surface: "desktop",
      target: "url",
      modifiers: NO_MODS,
      osOpenEnabled: true,
    });
    expect(result).toEqual({ kind: "show-chip", actions: ["browser", "copy"] });
  });

  it("Remote never offers an OS action or cwd propagation (ADR-0045)", () => {
    // osOpenEnabled 가 켜져 있어도 Remote 칩에는 OS 열기가 없다 — 칩은 기존
    // 액션의 표시 방식일 뿐 새 실행 표면이 아니다.
    expect(
      decideLinkActivation({
        mode: "chip",
        surface: "remote",
        target: "file",
        osOpenEnabled: true,
      }),
    ).toEqual({ kind: "show-chip", actions: ["viewer", "copy"] });
    expect(
      decideLinkActivation({
        mode: "chip",
        surface: "remote",
        target: "directory",
        osOpenEnabled: true,
      }),
    ).toEqual({ kind: "show-chip", actions: ["explorer", "copy"] });
    expect(
      decideLinkActivation({ mode: "chip", surface: "remote", target: "url", osOpenEnabled: true }),
    ).toEqual({ kind: "show-chip", actions: ["browser", "copy"] });
  });

  it("never returns an OS action to Remote in any mode or modifier combination", () => {
    for (const mode of LINK_ACTIVATION_MODES) {
      for (const target of ["url", "file", "directory"] as const) {
        const result = decideLinkActivation({
          mode,
          surface: "remote",
          target,
          // 터치에 수정자는 없지만, 있어도 Remote 권한 경계는 열리지 않는다.
          modifiers: { ctrlKey: true, shiftKey: true, altKey: false },
          osOpenEnabled: true,
        });
        const actions =
          result.kind === "show-chip"
            ? result.actions
            : result.kind === "open-direct"
              ? [result.action]
              : [];
        expect(actions).not.toContain("osOpen");
        expect(actions).not.toContain("osReveal");
        expect(actions).not.toContain("changeDir");
      }
    }
  });
});

describe("decideLinkActivation — modifier bypass is mode independent (ADR-0100 / #352)", () => {
  const modes: LinkActivationMode[] = ["immediate", "chip"];

  it("Ctrl on a path underline goes straight to the host OS", () => {
    for (const mode of modes) {
      expect(
        decideLinkActivation({
          mode,
          surface: "desktop",
          target: "file",
          modifiers: { ctrlKey: true, shiftKey: false, altKey: false },
          osOpenEnabled: true,
        }),
      ).toEqual({ kind: "open-direct", action: "osOpen", bypass: true });
      expect(
        decideLinkActivation({
          mode,
          surface: "desktop",
          target: "directory",
          modifiers: { ctrlKey: true, shiftKey: true, altKey: false },
          osOpenEnabled: true,
        }),
      ).toEqual({ kind: "open-direct", action: "osReveal", bypass: true });
    }
  });

  it("Ctrl+Alt / Ctrl+Meta are not owned, so chip mode still gates them", () => {
    for (const extra of [{ altKey: true }, { metaKey: true }]) {
      const result = decideLinkActivation({
        mode: "chip",
        surface: "desktop",
        target: "file",
        modifiers: { ctrlKey: true, shiftKey: false, altKey: false, ...extra },
        osOpenEnabled: true,
      });
      expect(result.kind).toBe("show-chip");
    }
  });

  it("Ctrl falls back to the mode's behavior when the OS open feature is off", () => {
    const mods = { ctrlKey: true, shiftKey: false, altKey: false };
    expect(
      decideLinkActivation({
        mode: "immediate",
        surface: "desktop",
        target: "file",
        modifiers: mods,
        osOpenEnabled: false,
      }),
    ).toEqual({ kind: "open-direct", action: "viewer", bypass: false });
    expect(
      decideLinkActivation({
        mode: "chip",
        surface: "desktop",
        target: "file",
        modifiers: mods,
        osOpenEnabled: false,
      }),
    ).toEqual({ kind: "show-chip", actions: ["viewer", "copy"] });
  });

  it("Shift/Alt on a URL keeps the #352 TUI bypass immediate", () => {
    for (const mode of modes) {
      for (const mods of [
        { ctrlKey: false, shiftKey: true, altKey: false },
        { ctrlKey: false, shiftKey: false, altKey: true },
      ]) {
        expect(
          decideLinkActivation({ mode, surface: "desktop", target: "url", modifiers: mods }),
        ).toEqual({ kind: "open-direct", action: "browser", bypass: true });
      }
    }
  });

  it("Ctrl+Shift on a URL is not a URL bypass — path-link owns Ctrl (ADR-0100)", () => {
    const result = decideLinkActivation({
      mode: "chip",
      surface: "desktop",
      target: "url",
      modifiers: { ctrlKey: true, shiftKey: true, altKey: false },
    });
    expect(result).toEqual({ kind: "show-chip", actions: ["browser", "copy"] });
  });

  it("touch surfaces without modifiers are gated by the mode alone", () => {
    expect(decideLinkActivation({ mode: "chip", surface: "remote", target: "url" })).toEqual({
      kind: "show-chip",
      actions: ["browser", "copy"],
    });
    expect(decideLinkActivation({ mode: "immediate", surface: "remote", target: "url" })).toEqual({
      kind: "open-direct",
      action: "browser",
      bypass: false,
    });
  });
});

describe("linkChipLabelKey", () => {
  it("labels the same action differently per target kind", () => {
    expect(linkChipLabelKey("copy", "url")).toBe("terminal.linkChipCopyUrl");
    expect(linkChipLabelKey("copy", "file")).toBe("terminal.linkChipCopyPath");
    expect(linkChipLabelKey("copy", "directory")).toBe("terminal.linkChipCopyPath");
    // 디렉터리의 OS 열기는 곧 파일 관리자에서 열기다.
    expect(linkChipLabelKey("osOpen", "directory")).toBe("terminal.linkChipOsReveal");
    expect(linkChipLabelKey("osOpen", "file")).toBe("terminal.linkChipOsOpen");
  });

  it("gives every chip action a label key", () => {
    for (const action of [
      "viewer",
      "changeDir",
      "explorer",
      "osOpen",
      "osReveal",
      "browser",
      "copy",
    ] as const) {
      for (const target of ["url", "file", "directory"] as const) {
        expect(linkChipLabelKey(action, target)).toMatch(/^terminal\.linkChip/);
      }
    }
  });
});
