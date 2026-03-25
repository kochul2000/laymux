import { describe, it, expect, beforeEach } from "vitest";
import { useSettingsStore, makeDefaultColorScheme } from "./settings-store";

describe("settings-store", () => {
  beforeEach(() => {
    useSettingsStore.setState(useSettingsStore.getInitialState());
  });

  it("has default font settings", () => {
    const { font } = useSettingsStore.getState();
    expect(font.face).toBe("Cascadia Mono");
    expect(font.size).toBe(14);
    expect(font.weight).toBe("normal");
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

  it("updates font settings", () => {
    useSettingsStore.getState().setFont({ face: "Fira Code", size: 16, weight: "normal" });
    const { font } = useSettingsStore.getState();
    expect(font.face).toBe("Fira Code");
    expect(font.size).toBe(16);
    expect(font.weight).toBe("normal");
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
      font: { face: "JetBrains Mono", size: 13, weight: "normal" },
      defaultProfile: "WSL",
      profiles: [{
        name: "WSL", commandLine: "wsl.exe", colorScheme: "", startingDirectory: "", hidden: false,
        cursorShape: "bar", padding: { top: 8, right: 8, bottom: 8, left: 8 },
        scrollbackLines: 9001, opacity: 100, tabTitle: "", bellStyle: "audible",
        closeOnExit: "automatic", antialiasingMode: "grayscale",
        suppressApplicationTitle: false, snapOnInput: true,
      }],
      colorSchemes: [],
      keybindings: [],
    });
    const state = useSettingsStore.getState();
    expect(state.font.face).toBe("JetBrains Mono");
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

  it("updates font weight", () => {
    useSettingsStore.getState().setFont({ face: "Cascadia Mono", size: 14, weight: "bold" });
    expect(useSettingsStore.getState().font.weight).toBe("bold");
  });

  it("loadFromSettings handles font without weight (backwards compat)", () => {
    useSettingsStore.getState().loadFromSettings({
      font: { face: "Fira Code", size: 16 } as any,
    });
    const { font } = useSettingsStore.getState();
    expect(font.face).toBe("Fira Code");
    expect(font.size).toBe(16);
    expect(font.weight).toBe("normal");
  });

  it("loadFromSettings handles font with explicit undefined weight", () => {
    useSettingsStore.getState().loadFromSettings({
      font: { face: "Fira Code", size: 16, weight: undefined } as any,
    });
    const { font } = useSettingsStore.getState();
    expect(font.weight).toBe("normal");
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
      font: { face: "Fira Code", size: 16, weight: "normal" },
    });
    const { convenience } = useSettingsStore.getState();
    expect(convenience.smartPaste).toBe(true);
    expect(convenience.pasteImageDir).toBe("");
  });

  it("loadFromSettings migrates claude key to convenience", () => {
    useSettingsStore.getState().loadFromSettings({
      claude: { smartPaste: false, pasteImageDir: "/old/path" },
    } as any);
    const { convenience } = useSettingsStore.getState();
    expect(convenience.smartPaste).toBe(false);
    expect(convenience.pasteImageDir).toBe("/old/path");
  });
});
