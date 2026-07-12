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
    expect(profileDefaults.stabilizeInteractiveCursor).toBe(true);
  });

  it("defaults language to system", () => {
    expect(useSettingsStore.getState().language).toBe("system");
  });

  it("setLanguage updates the language setting", () => {
    useSettingsStore.getState().setLanguage("en");
    expect(useSettingsStore.getState().language).toBe("en");
    useSettingsStore.getState().setLanguage("ko");
    expect(useSettingsStore.getState().language).toBe("ko");
  });

  it("loadFromSettings applies a valid language", () => {
    useSettingsStore.getState().loadFromSettings({ language: "en" });
    expect(useSettingsStore.getState().language).toBe("en");
  });

  it("loadFromSettings falls back to system for an invalid language", () => {
    useSettingsStore.getState().loadFromSettings({ language: "fr" as unknown as "system" });
    expect(useSettingsStore.getState().language).toBe("system");
  });

  it("loadFromSettings leaves language untouched when absent", () => {
    useSettingsStore.getState().setLanguage("ko");
    useSettingsStore.getState().loadFromSettings({ defaultProfile: "WSL" });
    expect(useSettingsStore.getState().language).toBe("ko");
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
    useSettingsStore
      .getState()
      .setProfileDefaults({ font: { face: "Fira Code", size: 16, weight: "normal" } });
    const { profileDefaults } = useSettingsStore.getState();
    expect(profileDefaults.font.face).toBe("Fira Code");
    expect(profileDefaults.font.size).toBe(16);
    expect(profileDefaults.font.weight).toBe("normal");
  });

  it("propagates updated profileDefaults to profiles still using previous defaults", () => {
    useSettingsStore.getState().setProfileDefaults({
      cursorBlink: false,
      cursorShape: "filledBox",
      stabilizeInteractiveCursor: false,
    });

    const profile = useSettingsStore.getState().profiles[0];
    expect(profile.cursorBlink).toBe(false);
    expect(profile.cursorShape).toBe("filledBox");
    expect(profile.stabilizeInteractiveCursor).toBe(false);
  });

  it("does not overwrite profile values that differ from previous defaults", () => {
    useSettingsStore.getState().updateProfile(0, { cursorBlink: false });
    useSettingsStore.getState().setProfileDefaults({ cursorBlink: true });

    const profile = useSettingsStore.getState().profiles[0];
    expect(profile.cursorBlink).toBe(false);
  });

  it("propagates inherited object defaults even when key order differs", () => {
    useSettingsStore.getState().updateProfile(0, {
      padding: { left: 8, bottom: 8, right: 8, top: 8 },
    });

    useSettingsStore.getState().setProfileDefaults({
      padding: { top: 10, right: 12, bottom: 14, left: 16 },
    });

    const profile = useSettingsStore.getState().profiles[0];
    expect(profile.padding).toEqual({ top: 10, right: 12, bottom: 14, left: 16 });
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
      cursorBlink: true,
      stabilizeInteractiveCursor: true,
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
      profiles: [
        {
          name: "WSL",
          commandLine: "wsl.exe",
          startupCommand: "",
          colorScheme: "",
          startingDirectory: "",
          hidden: false,
          cursorShape: "bar",
          cursorBlink: true,
          stabilizeInteractiveCursor: true,
          padding: { top: 8, right: 8, bottom: 8, left: 8 },
          scrollbackLines: 9001,
          opacity: 100,
          tabTitle: "",
          bellStyle: "audible",
          closeOnExit: "automatic",
          antialiasingMode: "grayscale",
          suppressApplicationTitle: false,
          snapOnInput: true,
        },
      ],
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
      profiles: [
        {
          name: "Old",
          commandLine: "bash",
          colorScheme: "",
          startingDirectory: "",
          hidden: false,
        } as any,
      ],
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
    useSettingsStore
      .getState()
      .setProfileDefaults({ font: { face: "Cascadia Mono", size: 14, weight: "bold" } });
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
    useSettingsStore
      .getState()
      .updateProfile(0, { font: { face: "Fira Code", size: 18, weight: "bold" } });
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

  it("resolveFont applies viewOverrides.fontSize when provided", () => {
    const font = useSettingsStore.getState().resolveFont("PowerShell", { fontSize: 22 });
    expect(font.size).toBe(22);
    expect(font.face).toBe("Cascadia Mono");
  });

  it("resolveFont ignores viewOverrides when fontSize is undefined", () => {
    const font = useSettingsStore.getState().resolveFont("PowerShell", {});
    expect(font.size).toBe(14);
  });

  it("resolveFont viewOverrides.fontSize takes precedence over profile.font.size", () => {
    useSettingsStore
      .getState()
      .updateProfile(0, { font: { face: "Fira Code", size: 18, weight: "bold" } });
    const font = useSettingsStore.getState().resolveFont("PowerShell", { fontSize: 26 });
    expect(font.size).toBe(26);
    expect(font.face).toBe("Fira Code");
    expect(font.weight).toBe("bold");
  });

  it("loadFromSettings loads profileDefaults.font", () => {
    useSettingsStore.getState().loadFromSettings({
      profileDefaults: { font: { face: "JetBrains Mono", size: 13, weight: "normal" } } as any,
    });
    const { profileDefaults } = useSettingsStore.getState();
    expect(profileDefaults.font.face).toBe("JetBrains Mono");
    expect(profileDefaults.font.size).toBe(13);
  });

  it("profile font override is persisted through loadFromSettings", () => {
    useSettingsStore.getState().loadFromSettings({
      profiles: [
        {
          name: "Custom",
          commandLine: "bash",
          startupCommand: "",
          colorScheme: "",
          startingDirectory: "",
          hidden: false,
          cursorShape: "bar",
          cursorBlink: true,
          stabilizeInteractiveCursor: true,
          padding: { top: 8, right: 8, bottom: 8, left: 8 },
          scrollbackLines: 9001,
          opacity: 100,
          tabTitle: "",
          bellStyle: "audible",
          closeOnExit: "automatic",
          antialiasingMode: "grayscale",
          suppressApplicationTitle: false,
          snapOnInput: true,
          font: { face: "JetBrains Mono", size: 16, weight: "bold" },
        },
      ],
    });
    const font = useSettingsStore.getState().resolveFont("Custom");
    expect(font.face).toBe("JetBrains Mono");
    expect(font.size).toBe(16);
  });

  // -- Paste settings --

  it("has default paste settings", () => {
    const { paste } = useSettingsStore.getState();
    expect(paste.smart).toBe(true);
    expect(paste.imageDir).toBe("");
  });

  it("workspaceSelector.hiddenAutoCloseSeconds defaults to 0 (disabled)", () => {
    expect(useSettingsStore.getState().workspaceSelector.hiddenAutoCloseSeconds).toBe(0);
  });

  it("setWorkspaceSelector updates hiddenAutoCloseSeconds", () => {
    useSettingsStore.getState().setWorkspaceSelector({ hiddenAutoCloseSeconds: 600 });
    expect(useSettingsStore.getState().workspaceSelector.hiddenAutoCloseSeconds).toBe(600);
  });

  it("loadFromSettings fills missing hiddenAutoCloseSeconds with default 0", () => {
    useSettingsStore.getState().loadFromSettings({
      workspaceSelector: { sortOrder: "manual" } as any,
    });
    expect(useSettingsStore.getState().workspaceSelector.hiddenAutoCloseSeconds).toBe(0);
  });

  it("loadFromSettings preserves explicit hiddenAutoCloseSeconds", () => {
    useSettingsStore.getState().loadFromSettings({
      workspaceSelector: { hiddenAutoCloseSeconds: 1200 } as any,
    });
    expect(useSettingsStore.getState().workspaceSelector.hiddenAutoCloseSeconds).toBe(1200);
  });

  it("has default multi-file paste settings (#325)", () => {
    const { paste } = useSettingsStore.getState();
    expect(paste.pathSeparator).toBe("space");
    expect(paste.pathQuote).toBe(false);
  });

  it("setPaste updates multi-file paste settings (#325)", () => {
    useSettingsStore.getState().setPaste({ pathSeparator: "comma", pathQuote: true });
    expect(useSettingsStore.getState().paste.pathSeparator).toBe("comma");
    expect(useSettingsStore.getState().paste.pathQuote).toBe(true);
  });

  it("loadFromSettings fills missing multi-file paste fields with defaults (#325)", () => {
    useSettingsStore.getState().loadFromSettings({
      paste: { smart: false } as any,
    });
    const { paste } = useSettingsStore.getState();
    expect(paste.pathSeparator).toBe("space");
    expect(paste.pathQuote).toBe(false);
  });

  it("setPaste updates smart paste", () => {
    useSettingsStore.getState().setPaste({ smart: false });
    expect(useSettingsStore.getState().paste.smart).toBe(false);
    expect(useSettingsStore.getState().paste.imageDir).toBe("");
  });

  it("setPaste updates paste image dir", () => {
    useSettingsStore.getState().setPaste({ imageDir: "C:\\temp\\images" });
    expect(useSettingsStore.getState().paste.smart).toBe(true);
    expect(useSettingsStore.getState().paste.imageDir).toBe("C:\\temp\\images");
  });

  it("loadFromSettings loads paste settings", () => {
    useSettingsStore.getState().loadFromSettings({
      paste: {
        smart: false,
        imageDir: "/tmp/images",
      } as any,
    });
    const { paste } = useSettingsStore.getState();
    expect(paste.smart).toBe(false);
    expect(paste.imageDir).toBe("/tmp/images");
  });

  it("loadFromSettings fills missing paste fields with defaults", () => {
    useSettingsStore.getState().loadFromSettings({
      paste: { smart: false } as any,
    });
    const { paste } = useSettingsStore.getState();
    expect(paste.smart).toBe(false);
    expect(paste.imageDir).toBe("");
  });

  it("loadFromSettings without paste preserves defaults", () => {
    useSettingsStore.getState().loadFromSettings({
      profileDefaults: { font: { face: "Fira Code", size: 16, weight: "normal" } } as any,
    });
    const { paste } = useSettingsStore.getState();
    expect(paste.smart).toBe(true);
    expect(paste.imageDir).toBe("");
  });

  // -- Path ellipsis settings --

  it("has default pathEllipsis set to start", () => {
    expect(useSettingsStore.getState().workspaceSelector.pathEllipsis).toBe("start");
  });

  it("setWorkspaceSelector updates pathEllipsis", () => {
    useSettingsStore.getState().setWorkspaceSelector({ pathEllipsis: "end" });
    expect(useSettingsStore.getState().workspaceSelector.pathEllipsis).toBe("end");
  });

  it("loadFromSettings fills missing pathEllipsis with default", () => {
    useSettingsStore.getState().loadFromSettings({
      workspaceSelector: { sortOrder: "manual" } as any,
    });
    expect(useSettingsStore.getState().workspaceSelector.pathEllipsis).toBe("start");
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
    expect(claude.sessionLimitAutoResume).toBe(true);
    expect(claude.sessionLimitResumeDelaySeconds).toBe(60);
    expect(claude.sessionLimitResumeMessage).toBe("go on");
  });

  it("loadFromSettings loads claude session-limit resume settings", () => {
    useSettingsStore.getState().loadFromSettings({
      claude: {
        sessionLimitAutoResume: false,
        sessionLimitResumeDelaySeconds: 120,
        sessionLimitResumeMessage: "continue",
      } as any,
    });
    const { claude } = useSettingsStore.getState();
    expect(claude.sessionLimitAutoResume).toBe(false);
    expect(claude.sessionLimitResumeDelaySeconds).toBe(120);
    expect(claude.sessionLimitResumeMessage).toBe("continue");
  });

  it("loadFromSettings without claude preserves defaults", () => {
    useSettingsStore.getState().loadFromSettings({
      profileDefaults: { font: { face: "Fira Code", size: 16, weight: "normal" } } as any,
    });
    const { claude } = useSettingsStore.getState();
    expect(claude.syncCwd).toBe("skip");
  });

  it("has default codex settings", () => {
    const { codex } = useSettingsStore.getState();
    expect(codex.statusMessageMode).toBe("bullet-title");
    expect(codex.statusMessageDelimiter).toBe(" · ");
  });

  it("setCodex updates status message mode", () => {
    useSettingsStore.getState().setCodex({ statusMessageMode: "bullet-title" });
    expect(useSettingsStore.getState().codex.statusMessageMode).toBe("bullet-title");
  });

  it("loadFromSettings loads codex settings", () => {
    useSettingsStore.getState().loadFromSettings({
      codex: { statusMessageMode: "bullet", statusMessageDelimiter: " | " },
    });
    const { codex } = useSettingsStore.getState();
    expect(codex.statusMessageMode).toBe("bullet");
    expect(codex.statusMessageDelimiter).toBe(" | ");
  });

  it("loadFromSettings fills missing codex fields with defaults", () => {
    useSettingsStore.getState().loadFromSettings({
      codex: {} as any,
    });
    const { codex } = useSettingsStore.getState();
    expect(codex.statusMessageMode).toBe("bullet-title");
    expect(codex.statusMessageDelimiter).toBe(" · ");
  });

  // -- Scrollbar style settings --

  it("has default scrollbarStyle as overlay", () => {
    expect(useSettingsStore.getState().terminal.scrollbarStyle).toBe("overlay");
  });

  it("setTerminal updates scrollbarStyle", () => {
    useSettingsStore.getState().setTerminal({ scrollbarStyle: "separate" });
    expect(useSettingsStore.getState().terminal.scrollbarStyle).toBe("separate");
  });

  it("setTerminal updates scrollbarStyle back to overlay", () => {
    useSettingsStore.getState().setTerminal({ scrollbarStyle: "separate" });
    useSettingsStore.getState().setTerminal({ scrollbarStyle: "overlay" });
    expect(useSettingsStore.getState().terminal.scrollbarStyle).toBe("overlay");
  });

  it("loadFromSettings loads scrollbarStyle", () => {
    useSettingsStore.getState().loadFromSettings({
      terminal: {
        copyOnSelect: true,
        scrollbarStyle: "separate" as const,
      },
    });
    expect(useSettingsStore.getState().terminal.scrollbarStyle).toBe("separate");
  });

  it("loadFromSettings fills missing scrollbarStyle with default overlay", () => {
    useSettingsStore.getState().loadFromSettings({
      terminal: { copyOnSelect: false } as any,
    });
    expect(useSettingsStore.getState().terminal.scrollbarStyle).toBe("overlay");
  });

  it("setTerminal does not affect other terminal fields when setting scrollbarStyle", () => {
    useSettingsStore.getState().setTerminal({ scrollbarStyle: "separate" });
    const { terminal } = useSettingsStore.getState();
    expect(terminal.copyOnSelect).toBe(true);
    expect(terminal.scrollbarStyle).toBe("separate");
  });

  // -- Jump-to-bottom button setting (issue #361) --

  it("has default showScrollToBottomButton as true", () => {
    expect(useSettingsStore.getState().terminal.showScrollToBottomButton).toBe(true);
  });

  it("setTerminal toggles showScrollToBottomButton", () => {
    useSettingsStore.getState().setTerminal({ showScrollToBottomButton: false });
    expect(useSettingsStore.getState().terminal.showScrollToBottomButton).toBe(false);
  });

  it("loadFromSettings fills missing showScrollToBottomButton with default true", () => {
    useSettingsStore.getState().loadFromSettings({
      terminal: { copyOnSelect: false } as any,
    });
    expect(useSettingsStore.getState().terminal.showScrollToBottomButton).toBe(true);
  });

  // -- Workspace display settings --

  it("has default workspaceSelector.display with all items enabled", () => {
    const { display } = useSettingsStore.getState().workspaceSelector;
    expect(display.minimap).toBe(true);
    expect(display.environment).toBe(true);
    expect(display.activity).toBe(true);
    expect(display.path).toBe(true);
    expect(display.result).toBe(true);
  });

  it("setWorkspaceSelector partial display update", () => {
    const prev = useSettingsStore.getState().workspaceSelector.display;
    useSettingsStore
      .getState()
      .setWorkspaceSelector({ display: { ...prev, minimap: false, activity: false } });
    const { display } = useSettingsStore.getState().workspaceSelector;
    expect(display.minimap).toBe(false);
    expect(display.environment).toBe(true);
    expect(display.activity).toBe(false);
    expect(display.path).toBe(true);
    expect(display.result).toBe(true);
  });

  it("loadFromSettings loads workspaceSelector.display", () => {
    useSettingsStore.getState().loadFromSettings({
      workspaceSelector: {
        display: {
          minimap: false,
          environment: false,
          activity: true,
          path: true,
          result: false,
        },
      } as any,
    });
    const { display } = useSettingsStore.getState().workspaceSelector;
    expect(display.minimap).toBe(false);
    expect(display.environment).toBe(false);
    expect(display.result).toBe(false);
  });

  it("loadFromSettings fills missing workspaceSelector.display fields with defaults", () => {
    useSettingsStore.getState().loadFromSettings({
      workspaceSelector: { display: { minimap: false } } as any,
    });
    const { display } = useSettingsStore.getState().workspaceSelector;
    expect(display.minimap).toBe(false);
    expect(display.environment).toBe(true);
    expect(display.activity).toBe(true);
    expect(display.path).toBe(true);
    expect(display.result).toBe(true);
  });

  it("loadFromSettings without workspaceSelector preserves display defaults", () => {
    useSettingsStore.getState().loadFromSettings({
      defaultProfile: "WSL",
    });
    const { display } = useSettingsStore.getState().workspaceSelector;
    expect(display.minimap).toBe(true);
    expect(display.environment).toBe(true);
    expect(display.activity).toBe(true);
    expect(display.path).toBe(true);
    expect(display.result).toBe(true);
  });

  // --- syncCwdDefaults ---

  it("has default syncCwdDefaults", () => {
    const { syncCwdDefaults } = useSettingsStore.getState();
    expect(syncCwdDefaults.workspace).toEqual({ send: false, receive: true });
    expect(syncCwdDefaults.dock).toEqual({ send: false, receive: true });
  });

  it("loads syncCwdDefaults from settings", () => {
    useSettingsStore.getState().loadFromSettings({
      syncCwdDefaults: {
        workspace: { send: true, receive: false },
        dock: { send: true, receive: true },
      },
    });
    const { syncCwdDefaults } = useSettingsStore.getState();
    expect(syncCwdDefaults.workspace).toEqual({ send: true, receive: false });
    expect(syncCwdDefaults.dock).toEqual({ send: true, receive: true });
  });

  it("uses default syncCwdDefaults when not in loaded settings", () => {
    useSettingsStore.getState().loadFromSettings({
      defaultProfile: "WSL",
    });
    const { syncCwdDefaults } = useSettingsStore.getState();
    expect(syncCwdDefaults.workspace).toEqual({ send: false, receive: true });
    expect(syncCwdDefaults.dock).toEqual({ send: false, receive: true });
  });

  it("setSyncCwdDefaults updates partial values", () => {
    useSettingsStore.getState().setSyncCwdDefaults({
      dock: { send: true, receive: true },
    });
    const { syncCwdDefaults } = useSettingsStore.getState();
    expect(syncCwdDefaults.workspace).toEqual({ send: false, receive: true }); // unchanged
    expect(syncCwdDefaults.dock).toEqual({ send: true, receive: true }); // updated
  });

  // --- resolveSyncCwdForProfile ---

  it("resolveSyncCwdForProfile returns workspace defaults for unset profile", () => {
    const result = useSettingsStore.getState().resolveSyncCwdForProfile("WSL", "workspace");
    expect(result).toEqual({ send: false, receive: true });
  });

  it("resolveSyncCwdForProfile returns dock defaults for unset profile", () => {
    const result = useSettingsStore.getState().resolveSyncCwdForProfile("WSL", "dock");
    expect(result).toEqual({ send: false, receive: true });
  });

  it("resolveSyncCwdForProfile uses profile syncCwd override", () => {
    useSettingsStore.getState().updateProfile(1, {
      syncCwd: { send: false, receive: false },
    });
    const result = useSettingsStore.getState().resolveSyncCwdForProfile("WSL", "workspace");
    expect(result).toEqual({ send: false, receive: false });
  });

  it("resolveSyncCwdForProfile uses profileDefaults.syncCwd when profile has no override", () => {
    useSettingsStore.getState().setProfileDefaults({
      syncCwd: { send: true, receive: false },
    });
    const result = useSettingsStore.getState().resolveSyncCwdForProfile("PowerShell", "workspace");
    expect(result).toEqual({ send: true, receive: false });
  });

  it('resolveSyncCwdForProfile: profileDefaults.syncCwd "default" delegates to location', () => {
    useSettingsStore.getState().setProfileDefaults({
      syncCwd: "default",
    });
    const result = useSettingsStore.getState().resolveSyncCwdForProfile("WSL", "dock");
    expect(result).toEqual({ send: false, receive: true });
  });

  it("loads profile syncCwd from settings", () => {
    useSettingsStore.getState().loadFromSettings({
      profiles: [
        {
          name: "Monitor",
          commandLine: "wsl.exe",
          colorScheme: "",
          startingDirectory: "",
          hidden: false,
          syncCwd: { send: false, receive: false },
        } as any,
      ],
    });
    const result = useSettingsStore.getState().resolveSyncCwdForProfile("Monitor", "workspace");
    expect(result).toEqual({ send: false, receive: false });
  });

  it("loads profileDefaults.syncCwd from settings", () => {
    useSettingsStore.getState().loadFromSettings({
      profileDefaults: {
        syncCwd: { send: false, receive: true },
      } as any,
    });
    const result = useSettingsStore.getState().resolveSyncCwdForProfile("WSL", "workspace");
    expect(result).toEqual({ send: false, receive: true });
  });

  // -- Issue Reporter --

  it("has default issueReporter with empty shell", () => {
    const { issueReporter } = useSettingsStore.getState();
    expect(issueReporter.shell).toBe("");
  });

  it("setIssueReporter updates shell", () => {
    useSettingsStore.getState().setIssueReporter({ shell: "wsl.exe -d Ubuntu --" });
    expect(useSettingsStore.getState().issueReporter.shell).toBe("wsl.exe -d Ubuntu --");
  });

  it("loadFromSettings loads issueReporter", () => {
    useSettingsStore.getState().loadFromSettings({
      issueReporter: { shell: "bash -c" },
    });
    expect(useSettingsStore.getState().issueReporter.shell).toBe("bash -c");
  });

  it("loadFromSettings without issueReporter preserves defaults", () => {
    useSettingsStore.getState().loadFromSettings({});
    expect(useSettingsStore.getState().issueReporter.shell).toBe("");
  });

  it("has default issueReporter with the laymux repo as default", () => {
    expect(useSettingsStore.getState().issueReporter.repositories).toEqual(["kochul2000/laymux"]);
  });

  it("setIssueReporter updates repositories", () => {
    useSettingsStore.getState().setIssueReporter({ repositories: ["owner/a", "owner/b"] });
    expect(useSettingsStore.getState().issueReporter.repositories).toEqual(["owner/a", "owner/b"]);
  });

  it("loadFromSettings loads issueReporter repositories", () => {
    useSettingsStore.getState().loadFromSettings({
      issueReporter: { repositories: ["foo/bar"] },
    });
    expect(useSettingsStore.getState().issueReporter.repositories).toEqual(["foo/bar"]);
  });

  it("loadFromSettings fills repositories default when omitted", () => {
    // Older settings without `repositories` should still merge to the default.
    useSettingsStore.getState().loadFromSettings({
      issueReporter: { shell: "bash -c" },
    });
    expect(useSettingsStore.getState().issueReporter.repositories).toEqual(["kochul2000/laymux"]);
  });

  // workspaceSelector.sortOrder
  it("has default sortOrder of 'manual'", () => {
    expect(useSettingsStore.getState().workspaceSelector.sortOrder).toBe("manual");
  });

  it("setWorkspaceSelector changes sort order", () => {
    useSettingsStore.getState().setWorkspaceSelector({ sortOrder: "notification" });
    expect(useSettingsStore.getState().workspaceSelector.sortOrder).toBe("notification");

    useSettingsStore.getState().setWorkspaceSelector({ sortOrder: "manual" });
    expect(useSettingsStore.getState().workspaceSelector.sortOrder).toBe("manual");
  });

  it("loadFromSettings loads sortOrder", () => {
    useSettingsStore.getState().loadFromSettings({
      workspaceSelector: { sortOrder: "notification" } as any,
    });
    expect(useSettingsStore.getState().workspaceSelector.sortOrder).toBe("notification");
  });

  it("loadFromSettings without workspaceSelector preserves sortOrder default", () => {
    useSettingsStore.getState().loadFromSettings({});
    expect(useSettingsStore.getState().workspaceSelector.sortOrder).toBe("manual");
  });

  it("loadFromSettings ignores invalid sortOrder values", () => {
    useSettingsStore.getState().loadFromSettings({
      workspaceSelector: { sortOrder: "invalid-value" } as any,
    });
    // Should keep the default, not blindly accept the invalid value
    expect(useSettingsStore.getState().workspaceSelector.sortOrder).toBe("manual");
  });

  it("has default automatic mobile mode width threshold", () => {
    expect(useSettingsStore.getState().remote.autoMobileModeMinWidth).toBe(720);
    expect(useSettingsStore.getState().remote.preferredHost).toBe("");
    expect(useSettingsStore.getState().remote.customHosts).toEqual([]);
  });

  it("setRemote updates automatic mobile mode width threshold", () => {
    useSettingsStore.getState().setRemote({
      autoMobileModeMinWidth: 0,
      preferredHost: "100.64.0.2",
      customHosts: ["devbox.tailnet.ts.net"],
    });
    expect(useSettingsStore.getState().remote.autoMobileModeMinWidth).toBe(0);
    expect(useSettingsStore.getState().remote.preferredHost).toBe("100.64.0.2");
    expect(useSettingsStore.getState().remote.customHosts).toEqual(["devbox.tailnet.ts.net"]);
  });

  it("loadFromSettings fills missing remote resilience and mobile defaults", () => {
    useSettingsStore.getState().loadFromSettings({
      remote: { enabled: true, authToken: "secret" } as any,
    });
    expect(useSettingsStore.getState().remote.autoMobileModeMinWidth).toBe(720);
    expect(useSettingsStore.getState().remote.heartbeatTimeoutSeconds).toBe(45);
    expect(useSettingsStore.getState().remote.preferredHost).toBe("");
    expect(useSettingsStore.getState().remote.customHosts).toEqual([]);
  });

  it("loadFromSettings preserves explicit remote automatic mobile mode width", () => {
    useSettingsStore.getState().loadFromSettings({
      remote: {
        autoMobileModeMinWidth: 0,
        preferredHost: "100.64.0.2",
        customHosts: ["devbox.tailnet.ts.net"],
      } as any,
    });
    expect(useSettingsStore.getState().remote.autoMobileModeMinWidth).toBe(0);
    expect(useSettingsStore.getState().remote.preferredHost).toBe("100.64.0.2");
    expect(useSettingsStore.getState().remote.customHosts).toEqual(["devbox.tailnet.ts.net"]);
  });
});
