import { describe, it, expect, beforeEach } from "vitest";
import { useSettingsStore, makeDefaultColorScheme } from "./settings-store";

describe("settings-store", () => {
  beforeEach(() => {
    useSettingsStore.setState(useSettingsStore.getInitialState());
  });

  it("has default font in profileDefaults", () => {
    const { profileDefaults } = useSettingsStore.getState();
    expect(profileDefaults.font.face).toBe("Cascadia Mono");
    expect(profileDefaults.font.size).toBe(14);
    expect(profileDefaults.font.weight).toBe("normal");
  });

  it("has default profiles", () => {
    const { profiles } = useSettingsStore.getState();
    expect(profiles).toHaveLength(2);
    expect(profiles[0].name).toBe("PowerShell");
    expect(profiles[1].name).toBe("WSL");
  });

  it("has default profile set", () => {
    const { defaultProfile } = useSettingsStore.getState();
    expect(defaultProfile).toBe("PowerShell");
  });

  it("updates font in profileDefaults", () => {
    useSettingsStore.getState().setProfileDefaults({ font: { face: "Fira Code", size: 16, weight: "normal" } });
    const { profileDefaults } = useSettingsStore.getState();
    expect(profileDefaults.font.face).toBe("Fira Code");
    expect(profileDefaults.font.size).toBe(16);
    expect(profileDefaults.font.weight).toBe("normal");
  });

  it("updates default profile", () => {
    useSettingsStore.getState().setDefaultProfile("WSL");
    expect(useSettingsStore.getState().defaultProfile).toBe("WSL");
  });

  it("adds a color scheme", () => {
    const cs = makeDefaultColorScheme();
    cs.name = "One Dark";
    cs.foreground = "#ABB2BF";
    cs.background = "#282C34";
    const before = useSettingsStore.getState().colorSchemes.length;
    useSettingsStore.getState().addColorScheme(cs);
    const { colorSchemes } = useSettingsStore.getState();
    expect(colorSchemes).toHaveLength(before + 1);
    expect(colorSchemes[colorSchemes.length - 1].name).toBe("One Dark");
    // All ANSI colors should be present in the added scheme
    const added = colorSchemes[colorSchemes.length - 1];
    expect(added.black).toBe("#0C0C0C");
    expect(added.brightWhite).toBe("#F2F2F2");
  });

  it("adds a keybinding", () => {
    useSettingsStore.getState().addKeybinding({ keys: "Ctrl+T", command: "new-terminal" });
    const { keybindings } = useSettingsStore.getState();
    expect(keybindings).toHaveLength(1);
    expect(keybindings[0].keys).toBe("Ctrl+T");
  });

  it("removes a keybinding", () => {
    useSettingsStore.getState().addKeybinding({ keys: "Ctrl+T", command: "new-terminal" });
    useSettingsStore.getState().addKeybinding({ keys: "Ctrl+W", command: "close-tab" });
    useSettingsStore.getState().removeKeybinding(0);
    const { keybindings } = useSettingsStore.getState();
    expect(keybindings).toHaveLength(1);
    expect(keybindings[0].keys).toBe("Ctrl+W");
  });

  it("adds a profile with all required fields", () => {
    useSettingsStore.getState().addProfile({
      name: "Git Bash",
      commandLine: "C:\\Program Files\\Git\\bin\\bash.exe",
      startupCommand: "",
      colorScheme: "",
      startingDirectory: "",
      hidden: false,
      cursorShape: "bar",
      padding: { top: 8, right: 8, bottom: 8, left: 8 },
      scrollbackLines: 9001,
      opacity: 100,
      tabTitle: "",
      bellStyle: "audible",
      closeOnExit: "automatic",
      antialiasingMode: "grayscale",
      suppressApplicationTitle: false,
      snapOnInput: true,
    });
    const { profiles } = useSettingsStore.getState();
    expect(profiles).toHaveLength(3);
    expect(profiles[2].name).toBe("Git Bash");
    expect(profiles[2].cursorShape).toBe("bar");
    expect(profiles[2].bellStyle).toBe("audible");
  });

  it("removes a profile", () => {
    useSettingsStore.getState().removeProfile(1); // Remove WSL
    const { profiles } = useSettingsStore.getState();
    expect(profiles).toHaveLength(1);
    expect(profiles.find((p) => p.name === "WSL")).toBeUndefined();
  });

  it("loads settings from external data", () => {
    useSettingsStore.getState().loadFromSettings({
      profileDefaults: { font: { face: "JetBrains Mono", size: 13, weight: "normal" } } as any,
      defaultProfile: "WSL",
      profiles: [{
        name: "WSL", commandLine: "wsl.exe", startupCommand: "", colorScheme: "", startingDirectory: "", hidden: false,
        cursorShape: "bar", padding: { top: 8, right: 8, bottom: 8, left: 8 },
        scrollbackLines: 9001, opacity: 100, tabTitle: "", bellStyle: "audible",
        closeOnExit: "automatic", antialiasingMode: "grayscale",
        suppressApplicationTitle: false, snapOnInput: true,
      }],
      colorSchemes: [],
      keybindings: [],
    });
    const state = useSettingsStore.getState();
    expect(state.profileDefaults.font.face).toBe("JetBrains Mono");
    expect(state.defaultProfile).toBe("WSL");
    expect(state.profiles).toHaveLength(1);
  });

  it("profile has default new fields", () => {
    const profile = useSettingsStore.getState().profiles[0];
    expect(profile.tabTitle).toBe("");
    expect(profile.bellStyle).toBe("audible");
    expect(profile.closeOnExit).toBe("automatic");
    expect(profile.antialiasingMode).toBe("grayscale");
    expect(profile.suppressApplicationTitle).toBe(false);
    expect(profile.snapOnInput).toBe(true);
  });

  it("loadFromSettings fills missing new fields with defaults", () => {
    // Simulate old-format data with only 5 profile fields
    useSettingsStore.getState().loadFromSettings({
      profiles: [{
        name: "Old",
        commandLine: "bash",
        colorScheme: "",
        startingDirectory: "",
        hidden: false,
      } as any],
    });
    const profile = useSettingsStore.getState().profiles[0];
    expect(profile.cursorShape).toBe("bar");
    expect(profile.padding).toEqual({ top: 8, right: 8, bottom: 8, left: 8 });
    expect(profile.scrollbackLines).toBe(9001);
    expect(profile.opacity).toBe(100);
    expect(profile.tabTitle).toBe("");
    expect(profile.bellStyle).toBe("audible");
    expect(profile.closeOnExit).toBe("automatic");
    expect(profile.antialiasingMode).toBe("grayscale");
    expect(profile.suppressApplicationTitle).toBe(false);
    expect(profile.snapOnInput).toBe(true);
  });

  it("updates profile new fields", () => {
    useSettingsStore.getState().updateProfile(0, {
      tabTitle: "Dev",
      bellStyle: "none",
      closeOnExit: "always",
      antialiasingMode: "cleartype",
      suppressApplicationTitle: true,
      snapOnInput: false,
    });
    const profile = useSettingsStore.getState().profiles[0];
    expect(profile.tabTitle).toBe("Dev");
    expect(profile.bellStyle).toBe("none");
    expect(profile.closeOnExit).toBe("always");
    expect(profile.antialiasingMode).toBe("cleartype");
    expect(profile.suppressApplicationTitle).toBe(true);
    expect(profile.snapOnInput).toBe(false);
  });

  it("updates font weight in profileDefaults", () => {
    useSettingsStore.getState().setProfileDefaults({ font: { face: "Cascadia Mono", size: 14, weight: "bold" } });
    expect(useSettingsStore.getState().profileDefaults.font.weight).toBe("bold");
  });

  it("loadFromSettings handles profileDefaults.font without weight (backwards compat)", () => {
    useSettingsStore.getState().loadFromSettings({
      profileDefaults: { font: { face: "Fira Code", size: 16 } } as any,
    });
    const { profileDefaults } = useSettingsStore.getState();
    expect(profileDefaults.font.face).toBe("Fira Code");
    expect(profileDefaults.font.size).toBe(16);
    expect(profileDefaults.font.weight).toBe("normal");
  });

  it("loadFromSettings handles profileDefaults.font with explicit undefined weight", () => {
    useSettingsStore.getState().loadFromSettings({
      profileDefaults: { font: { face: "Fira Code", size: 16, weight: undefined } } as any,
    });
    const { profileDefaults } = useSettingsStore.getState();
    expect(profileDefaults.font.weight).toBe("normal");
  });

  // -- resolveFont --

  it("resolveFont returns profileDefaults font when profile has no font override", () => {
    const font = useSettingsStore.getState().resolveFont("PowerShell");
    expect(font.face).toBe("Cascadia Mono");
    expect(font.size).toBe(14);
  });

  it("resolveFont returns profile font override when set", () => {
    useSettingsStore.getState().updateProfile(0, { font: { face: "Fira Code", size: 18, weight: "bold" } });
    const font = useSettingsStore.getState().resolveFont("PowerShell");
    expect(font.face).toBe("Fira Code");
    expect(font.size).toBe(18);
    expect(font.weight).toBe("bold");
  });

  it("resolveFont returns default font for unknown profile", () => {
    const font = useSettingsStore.getState().resolveFont("NonExistent");
    expect(font.face).toBe("Cascadia Mono");
    expect(font.size).toBe(14);
  });

  it("loadFromSettings migrates root-level font to profileDefaults when profileDefaults.font absent", () => {
    useSettingsStore.getState().loadFromSettings({
      font: { face: "Fira Code", size: 16, weight: "normal" },
      profileDefaults: { colorScheme: "Catppuccin Mocha" } as any,
    });
    const { profileDefaults } = useSettingsStore.getState();
    expect(profileDefaults.font.face).toBe("Fira Code");
    expect(profileDefaults.font.size).toBe(16);
    expect(profileDefaults.font.weight).toBe("normal");
  });

  it("loadFromSettings migrates root-level font when no profileDefaults provided", () => {
    useSettingsStore.getState().loadFromSettings({
      font: { face: "Fira Code", size: 16, weight: "normal" },
    });
    const { profileDefaults } = useSettingsStore.getState();
    expect(profileDefaults.font.face).toBe("Fira Code");
    expect(profileDefaults.font.size).toBe(16);
  });

  it("loadFromSettings prefers profileDefaults.font over root-level font", () => {
    useSettingsStore.getState().loadFromSettings({
      font: { face: "Fira Code", size: 16, weight: "normal" },
      profileDefaults: { font: { face: "JetBrains Mono", size: 13, weight: "normal" } } as any,
    });
    const { profileDefaults } = useSettingsStore.getState();
    expect(profileDefaults.font.face).toBe("JetBrains Mono");
    expect(profileDefaults.font.size).toBe(13);
  });

  it("loadFromSettings does not leak root-level font into store state", () => {
    useSettingsStore.getState().loadFromSettings({
      font: { face: "Fira Code", size: 16, weight: "normal" },
    });
    const state = useSettingsStore.getState() as Record<string, unknown>;
    expect(state.font).toBeUndefined();
  });

  it("profile font override is persisted through loadFromSettings", () => {
    useSettingsStore.getState().loadFromSettings({
      profiles: [{
        name: "Custom", commandLine: "bash", startupCommand: "", colorScheme: "", startingDirectory: "", hidden: false,
        cursorShape: "bar", padding: { top: 8, right: 8, bottom: 8, left: 8 },
        scrollbackLines: 9001, opacity: 100, tabTitle: "", bellStyle: "audible",
        closeOnExit: "automatic", antialiasingMode: "grayscale",
        suppressApplicationTitle: false, snapOnInput: true,
        font: { face: "JetBrains Mono", size: 16, weight: "bold" },
      }],
    });
    const font = useSettingsStore.getState().resolveFont("Custom");
    expect(font.face).toBe("JetBrains Mono");
    expect(font.size).toBe(16);
  });

  // -- Convenience settings --

  it("has default convenience settings", () => {
    const { convenience } = useSettingsStore.getState();
    expect(convenience.smartPaste).toBe(true);
    expect(convenience.pasteImageDir).toBe("");
  });

  it("setConvenience updates smart paste", () => {
    useSettingsStore.getState().setConvenience({ smartPaste: false });
    expect(useSettingsStore.getState().convenience.smartPaste).toBe(false);
    expect(useSettingsStore.getState().convenience.pasteImageDir).toBe("");
  });

  it("setConvenience updates paste image dir", () => {
    useSettingsStore.getState().setConvenience({ pasteImageDir: "C:\\temp\\images" });
    expect(useSettingsStore.getState().convenience.smartPaste).toBe(true);
    expect(useSettingsStore.getState().convenience.pasteImageDir).toBe("C:\\temp\\images");
  });

  it("loadFromSettings loads convenience settings", () => {
    useSettingsStore.getState().loadFromSettings({
      convenience: { smartPaste: false, pasteImageDir: "/tmp/images", hoverIdleSeconds: 2, notificationDismiss: "workspace" as const, copyOnSelect: false },
    });
    const { convenience } = useSettingsStore.getState();
    expect(convenience.smartPaste).toBe(false);
    expect(convenience.pasteImageDir).toBe("/tmp/images");
  });

  it("loadFromSettings fills missing convenience fields with defaults", () => {
    useSettingsStore.getState().loadFromSettings({
      convenience: { smartPaste: false } as any,
    });
    const { convenience } = useSettingsStore.getState();
    expect(convenience.smartPaste).toBe(false);
    expect(convenience.pasteImageDir).toBe("");
  });

  it("loadFromSettings without convenience preserves defaults", () => {
    useSettingsStore.getState().loadFromSettings({
      profileDefaults: { font: { face: "Fira Code", size: 16, weight: "normal" } } as any,
    });
    const { convenience } = useSettingsStore.getState();
    expect(convenience.smartPaste).toBe(true);
    expect(convenience.pasteImageDir).toBe("");
  });

  // -- Path ellipsis settings --

  it("has default pathEllipsis set to start", () => {
    const { convenience } = useSettingsStore.getState();
    expect(convenience.pathEllipsis).toBe("start");
  });

  it("setConvenience updates pathEllipsis", () => {
    useSettingsStore.getState().setConvenience({ pathEllipsis: "end" });
    expect(useSettingsStore.getState().convenience.pathEllipsis).toBe("end");
  });

  it("loadFromSettings fills missing pathEllipsis with default", () => {
    useSettingsStore.getState().loadFromSettings({
      convenience: { smartPaste: false } as any,
    });
    const { convenience } = useSettingsStore.getState();
    expect(convenience.pathEllipsis).toBe("start");
  });

  // -- Claude settings --

  it("has default claude settings", () => {
    const { claude } = useSettingsStore.getState();
    expect(claude.syncCwd).toBe("skip");
  });

  it("setClaude updates sync cwd mode", () => {
    useSettingsStore.getState().setClaude({ syncCwd: "command" });
    expect(useSettingsStore.getState().claude.syncCwd).toBe("command");
  });

  it("loadFromSettings loads claude settings", () => {
    useSettingsStore.getState().loadFromSettings({
      claude: { syncCwd: "command" },
    });
    const { claude } = useSettingsStore.getState();
    expect(claude.syncCwd).toBe("command");
  });

  it("loadFromSettings fills missing claude fields with defaults", () => {
    useSettingsStore.getState().loadFromSettings({
      claude: {} as any,
    });
    const { claude } = useSettingsStore.getState();
    expect(claude.syncCwd).toBe("skip");
  });

  it("loadFromSettings without claude preserves defaults", () => {
    useSettingsStore.getState().loadFromSettings({
      profileDefaults: { font: { face: "Fira Code", size: 16, weight: "normal" } } as any,
    });
    const { claude } = useSettingsStore.getState();
    expect(claude.syncCwd).toBe("skip");
  });

  // -- Scrollbar style settings --

  it("has default scrollbarStyle as overlay", () => {
    const { convenience } = useSettingsStore.getState();
    expect(convenience.scrollbarStyle).toBe("overlay");
  });

  it("setConvenience updates scrollbarStyle", () => {
    useSettingsStore.getState().setConvenience({ scrollbarStyle: "separate" });
    expect(useSettingsStore.getState().convenience.scrollbarStyle).toBe("separate");
  });

  it("setConvenience updates scrollbarStyle back to overlay", () => {
    useSettingsStore.getState().setConvenience({ scrollbarStyle: "separate" });
    useSettingsStore.getState().setConvenience({ scrollbarStyle: "overlay" });
    expect(useSettingsStore.getState().convenience.scrollbarStyle).toBe("overlay");
  });

  it("loadFromSettings loads scrollbarStyle", () => {
    useSettingsStore.getState().loadFromSettings({
      convenience: { smartPaste: true, pasteImageDir: "", hoverIdleSeconds: 2, notificationDismiss: "workspace" as const, copyOnSelect: true, scrollbarStyle: "separate" as const },
    });
    const { convenience } = useSettingsStore.getState();
    expect(convenience.scrollbarStyle).toBe("separate");
  });

  it("loadFromSettings fills missing scrollbarStyle with default overlay", () => {
    useSettingsStore.getState().loadFromSettings({
      convenience: { smartPaste: false } as any,
    });
    const { convenience } = useSettingsStore.getState();
    expect(convenience.scrollbarStyle).toBe("overlay");
  });

  it("setConvenience does not affect other convenience fields when setting scrollbarStyle", () => {
    useSettingsStore.getState().setConvenience({ scrollbarStyle: "separate" });
    const { convenience } = useSettingsStore.getState();
    expect(convenience.smartPaste).toBe(true);
    expect(convenience.copyOnSelect).toBe(true);
    expect(convenience.scrollbarStyle).toBe("separate");
  });

  // -- _externalRevision (Issue #51) --

  it("has initial _externalRevision of 0", () => {
    expect(useSettingsStore.getState()._externalRevision).toBe(0);
  });

  it("increments _externalRevision on each loadFromSettings call", () => {
    useSettingsStore.getState().loadFromSettings({ defaultProfile: "WSL" });
    expect(useSettingsStore.getState()._externalRevision).toBe(1);

    useSettingsStore.getState().loadFromSettings({ defaultProfile: "PowerShell" });
    expect(useSettingsStore.getState()._externalRevision).toBe(2);
  });

  it("does not increment _externalRevision on regular mutations", () => {
    useSettingsStore.getState().setDefaultProfile("WSL");
    expect(useSettingsStore.getState()._externalRevision).toBe(0);

    useSettingsStore.getState().setConvenience({ smartPaste: false });
    expect(useSettingsStore.getState()._externalRevision).toBe(0);

    useSettingsStore.getState().setClaude({ syncCwd: "command" });
    expect(useSettingsStore.getState()._externalRevision).toBe(0);
  });
});
