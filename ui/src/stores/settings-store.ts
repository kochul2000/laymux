import { create } from "zustand";

export interface FontSettings {
  face: string;
  size: number;
  weight: string;
}

export interface PaddingSettings {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface ColorScheme {
  name: string;
  foreground: string;
  background: string;
  cursorColor: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  purple: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightPurple: string;
  brightCyan: string;
  brightWhite: string;
  [key: string]: string;
}

export type NotificationDismissMode = "workspace" | "paneFocus" | "manual";

export interface ConvenienceSettings {
  smartPaste: boolean;
  pasteImageDir: string;
  /** Seconds of mouse inactivity before hiding the pane control bar. 0 = never hide. */
  hoverIdleSeconds: number;
  /** When to auto-dismiss notifications as read. */
  notificationDismiss: NotificationDismissMode;
  /** Automatically copy text to clipboard when selected in terminal. */
  copyOnSelect: boolean;
}

export type CursorShape = "bar" | "underscore" | "filledBox" | "emptyBox" | "doubleUnderscore" | "vintage";
export type BellStyle = "audible" | "none" | "window" | "taskbar" | "all";
export type CloseOnExit = "automatic" | "graceful" | "always" | "never";
export type AntialiasingMode = "grayscale" | "cleartype" | "aliased";

/** Settings that can be inherited from profile defaults. */
export interface ProfileDefaults {
  colorScheme: string;
  cursorShape: CursorShape;
  padding: PaddingSettings;
  scrollbackLines: number;
  opacity: number;
  bellStyle: BellStyle;
  closeOnExit: CloseOnExit;
  antialiasingMode: AntialiasingMode;
  suppressApplicationTitle: boolean;
  snapOnInput: boolean;
}

export interface Profile {
  name: string;
  commandLine: string;
  colorScheme: string;
  startingDirectory: string;
  hidden: boolean;
  cursorShape: CursorShape;
  padding: PaddingSettings;
  scrollbackLines: number;
  opacity: number;
  tabTitle: string;
  bellStyle: BellStyle;
  closeOnExit: CloseOnExit;
  antialiasingMode: AntialiasingMode;
  suppressApplicationTitle: boolean;
  snapOnInput: boolean;
}

export interface Keybinding {
  keys: string;
  command: string;
}

/** Keys of Profile that are inheritable from defaults (= ProfileDefaults keys). */
export const INHERITABLE_KEYS: (keyof ProfileDefaults)[] = [
  "colorScheme", "cursorShape", "padding", "scrollbackLines", "opacity",
  "bellStyle", "closeOnExit", "antialiasingMode", "suppressApplicationTitle", "snapOnInput",
];

/** App UI theme — separate from terminal color schemes. */
export interface AppTheme {
  id: string;
  name: string;
  bgBase: string;
  bgSurface: string;
  bgOverlay: string;
  border: string;
  textPrimary: string;
  textSecondary: string;
  accent: string;
  green: string;
  red: string;
  yellow: string;
}

export const builtinAppThemes: AppTheme[] = [
  {
    id: "catppuccin-mocha",
    name: "Catppuccin Mocha",
    bgBase: "#1e1e2e", bgSurface: "#181825", bgOverlay: "#313244", border: "#313244",
    textPrimary: "#cdd6f4", textSecondary: "#a6adc8", accent: "#89b4fa",
    green: "#a6e3a1", red: "#f38ba8", yellow: "#f9e2af",
  },
  {
    id: "dracula",
    name: "Dracula",
    bgBase: "#282a36", bgSurface: "#21222c", bgOverlay: "#44475a", border: "#44475a",
    textPrimary: "#f8f8f2", textSecondary: "#6272a4", accent: "#bd93f9",
    green: "#50fa7b", red: "#ff5555", yellow: "#f1fa8c",
  },
  {
    id: "wsl-dark",
    name: "WSL Dark",
    bgBase: "#0c0c0c", bgSurface: "#1a1a1a", bgOverlay: "#2d2d2d", border: "#333333",
    textPrimary: "#f0f0f0", textSecondary: "#888888", accent: "#3b78ff",
    green: "#16c60c", red: "#e74856", yellow: "#f9f1a5",
  },
  {
    id: "github-light",
    name: "GitHub Light",
    bgBase: "#ffffff", bgSurface: "#f6f8fa", bgOverlay: "#e1e4e8", border: "#d0d7de",
    textPrimary: "#24292f", textSecondary: "#57606a", accent: "#0969da",
    green: "#1a7f37", red: "#cf222e", yellow: "#9a6700",
  },
];

interface SettingsState {
  font: FontSettings;
  defaultProfile: string;
  profileDefaults: ProfileDefaults;
  profiles: Profile[];
  colorSchemes: ColorScheme[];
  keybindings: Keybinding[];
  viewOrder: string[];
  appThemeId: string;
  convenience: ConvenienceSettings;

  setFont: (font: FontSettings) => void;
  setDefaultProfile: (profile: string) => void;
  setViewOrder: (order: string[]) => void;
  setAppTheme: (themeId: string) => void;
  setConvenience: (data: Partial<ConvenienceSettings>) => void;
  setProfileDefaults: (data: Partial<ProfileDefaults>) => void;
  addProfile: (profile: Profile) => void;
  removeProfile: (index: number) => void;
  updateProfile: (index: number, data: Partial<Profile>) => void;
  addColorScheme: (scheme: ColorScheme) => void;
  removeColorScheme: (index: number) => void;
  updateColorScheme: (index: number, data: Partial<ColorScheme>) => void;
  addKeybinding: (keybinding: Keybinding) => void;
  removeKeybinding: (index: number) => void;
  updateKeybinding: (index: number, data: Partial<Keybinding>) => void;
  loadFromSettings: (data: Partial<Pick<SettingsState, "font" | "defaultProfile" | "profileDefaults" | "profiles" | "colorSchemes" | "keybindings" | "viewOrder" | "appThemeId" | "convenience"> & { claude?: ConvenienceSettings }>) => void;
}

const defaultPadding: PaddingSettings = { top: 8, right: 8, bottom: 8, left: 8 };

const defaultProfileDefaults: ProfileDefaults = {
  colorScheme: "CampbellClear",
  cursorShape: "bar",
  padding: { ...defaultPadding },
  scrollbackLines: 9001,
  opacity: 100,
  bellStyle: "audible",
  closeOnExit: "automatic",
  antialiasingMode: "grayscale",
  suppressApplicationTitle: false,
  snapOnInput: true,
};

function makeProfile(
  name: string,
  commandLine: string,
  overrides?: Partial<Profile>,
): Profile {
  return {
    name,
    commandLine,
    ...defaultProfileDefaults,
    startingDirectory: "",
    hidden: false,
    tabTitle: "",
    ...overrides,
  };
}

/** Create a new profile using the current profile defaults. */
export function makeProfileFromDefaults(
  name: string,
  commandLine: string,
  defaults: ProfileDefaults,
): Profile {
  return {
    name,
    commandLine,
    ...defaults,
    startingDirectory: "",
    hidden: false,
    tabTitle: "",
  };
}

export function makeDefaultColorScheme(): ColorScheme {
  return {
    name: "",
    foreground: "#CCCCCC",
    background: "#1E1E1E",
    cursorColor: "#FFFFFF",
    selectionBackground: "#264F78",
    black: "#0C0C0C",
    red: "#C50F1F",
    green: "#13A10E",
    yellow: "#C19C00",
    blue: "#0037DA",
    purple: "#881798",
    cyan: "#3A96DD",
    white: "#CCCCCC",
    brightBlack: "#767676",
    brightRed: "#E74856",
    brightGreen: "#16C60C",
    brightYellow: "#F9F1A5",
    brightBlue: "#3B78FF",
    brightPurple: "#B4009E",
    brightCyan: "#61D6D6",
    brightWhite: "#F2F2F2",
  };
}

/** Windows Terminal built-in color schemes (identical format to settings.json). */
export const builtinColorSchemes: ColorScheme[] = [
  {
    name: "CampbellClear",
    background: "#0C0C0C", black: "#0C0C0C", blue: "#0037DA",
    brightBlack: "#767676", brightBlue: "#3B78FF", brightCyan: "#61D6D6",
    brightGreen: "#16C60C", brightPurple: "#B4009E", brightRed: "#E74856",
    brightWhite: "#FFFFFF", brightYellow: "#F9F1A5", cursorColor: "#FFFFFF",
    cyan: "#3A96DD", foreground: "#F0F0F0", green: "#13A10E",
    purple: "#881798", red: "#C50F1F", selectionBackground: "#232042",
    white: "#F0F0F0", yellow: "#C19C00",
  },
  {
    name: "Campbell",
    background: "#0C0C0C", black: "#0C0C0C", blue: "#0037DA",
    brightBlack: "#767676", brightBlue: "#3B78FF", brightCyan: "#61D6D6",
    brightGreen: "#16C60C", brightPurple: "#B4009E", brightRed: "#E74856",
    brightWhite: "#F2F2F2", brightYellow: "#F9F1A5", cursorColor: "#FFFFFF",
    cyan: "#3A96DD", foreground: "#CCCCCC", green: "#13A10E",
    purple: "#881798", red: "#C50F1F", selectionBackground: "#264F78",
    white: "#CCCCCC", yellow: "#C19C00",
  },
  {
    name: "Campbell Powershell",
    background: "#012456", black: "#0C0C0C", blue: "#0037DA",
    brightBlack: "#767676", brightBlue: "#3B78FF", brightCyan: "#61D6D6",
    brightGreen: "#16C60C", brightPurple: "#B4009E", brightRed: "#E74856",
    brightWhite: "#F2F2F2", brightYellow: "#F9F1A5", cursorColor: "#FFFFFF",
    cyan: "#3A96DD", foreground: "#CCCCCC", green: "#13A10E",
    purple: "#881798", red: "#C50F1F", selectionBackground: "#264F78",
    white: "#CCCCCC", yellow: "#C19C00",
  },
  {
    name: "One Half Dark",
    background: "#282C34", black: "#282C34", blue: "#61AFEF",
    brightBlack: "#5A6374", brightBlue: "#61AFEF", brightCyan: "#56B6C2",
    brightGreen: "#98C379", brightPurple: "#C678DD", brightRed: "#E06C75",
    brightWhite: "#DCDFE4", brightYellow: "#E5C07B", cursorColor: "#FFFFFF",
    cyan: "#56B6C2", foreground: "#DCDFE4", green: "#98C379",
    purple: "#C678DD", red: "#E06C75", selectionBackground: "#264F78",
    white: "#DCDFE4", yellow: "#E5C07B",
  },
  {
    name: "One Half Light",
    background: "#FAFAFA", black: "#383A42", blue: "#0184BC",
    brightBlack: "#4F525D", brightBlue: "#61AFEF", brightCyan: "#56B6C2",
    brightGreen: "#98C379", brightPurple: "#C678DD", brightRed: "#E06C75",
    brightWhite: "#FFFFFF", brightYellow: "#E5C07B", cursorColor: "#4F525D",
    cyan: "#0997B3", foreground: "#383A42", green: "#50A14F",
    purple: "#A626A4", red: "#E45649", selectionBackground: "#264F78",
    white: "#FAFAFA", yellow: "#C18401",
  },
  {
    name: "Solarized Dark",
    background: "#002B36", black: "#002B36", blue: "#268BD2",
    brightBlack: "#073642", brightBlue: "#839496", brightCyan: "#93A1A1",
    brightGreen: "#586E75", brightPurple: "#6C71C4", brightRed: "#CB4B16",
    brightWhite: "#FDF6E3", brightYellow: "#657B83", cursorColor: "#FFFFFF",
    cyan: "#2AA198", foreground: "#839496", green: "#859900",
    purple: "#D33682", red: "#DC322F", selectionBackground: "#264F78",
    white: "#EEE8D5", yellow: "#B58900",
  },
  {
    name: "Solarized Light",
    background: "#FDF6E3", black: "#002B36", blue: "#268BD2",
    brightBlack: "#073642", brightBlue: "#839496", brightCyan: "#93A1A1",
    brightGreen: "#586E75", brightPurple: "#6C71C4", brightRed: "#CB4B16",
    brightWhite: "#FDF6E3", brightYellow: "#657B83", cursorColor: "#002B36",
    cyan: "#2AA198", foreground: "#657B83", green: "#859900",
    purple: "#D33682", red: "#DC322F", selectionBackground: "#264F78",
    white: "#EEE8D5", yellow: "#B58900",
  },
  {
    name: "Tango Dark",
    background: "#000000", black: "#000000", blue: "#3465A4",
    brightBlack: "#555753", brightBlue: "#729FCF", brightCyan: "#34E2E2",
    brightGreen: "#8AE234", brightPurple: "#AD7FA8", brightRed: "#EF2929",
    brightWhite: "#EEEEEC", brightYellow: "#FCE94F", cursorColor: "#FFFFFF",
    cyan: "#06989A", foreground: "#D3D7CF", green: "#4E9A06",
    purple: "#75507B", red: "#CC0000", selectionBackground: "#264F78",
    white: "#D3D7CF", yellow: "#C4A000",
  },
  {
    name: "Tango Light",
    background: "#FFFFFF", black: "#000000", blue: "#3465A4",
    brightBlack: "#555753", brightBlue: "#729FCF", brightCyan: "#34E2E2",
    brightGreen: "#8AE234", brightPurple: "#AD7FA8", brightRed: "#EF2929",
    brightWhite: "#EEEEEC", brightYellow: "#FCE94F", cursorColor: "#000000",
    cyan: "#06989A", foreground: "#000000", green: "#4E9A06",
    purple: "#75507B", red: "#CC0000", selectionBackground: "#264F78",
    white: "#D3D7CF", yellow: "#C4A000",
  },
  {
    name: "Vintage",
    background: "#000000", black: "#000000", blue: "#000080",
    brightBlack: "#808080", brightBlue: "#0000FF", brightCyan: "#00FFFF",
    brightGreen: "#00FF00", brightPurple: "#FF00FF", brightRed: "#FF0000",
    brightWhite: "#FFFFFF", brightYellow: "#FFFF00", cursorColor: "#FFFFFF",
    cyan: "#008080", foreground: "#C0C0C0", green: "#008000",
    purple: "#800080", red: "#800000", selectionBackground: "#264F78",
    white: "#C0C0C0", yellow: "#808000",
  },
];

export const useSettingsStore = create<SettingsState>()((set, _get) => ({
  font: { face: "Cascadia Mono", size: 14, weight: "normal" },
  defaultProfile: "PowerShell",
  profileDefaults: { ...defaultProfileDefaults },
  profiles: [
    makeProfile("PowerShell", "powershell.exe -NoLogo"),
    makeProfile("WSL", "wsl.exe"),
  ],
  colorSchemes: [...builtinColorSchemes],
  keybindings: [],
  viewOrder: [],
  appThemeId: "catppuccin-mocha",
  convenience: { smartPaste: true, pasteImageDir: "", hoverIdleSeconds: 2, notificationDismiss: "workspace" as const, copyOnSelect: true },

  setFont: (font) => set({ font }),

  setAppTheme: (appThemeId) => set({ appThemeId }),

  setConvenience: (data) =>
    set((state) => ({
      convenience: { ...state.convenience, ...data },
    })),

  setDefaultProfile: (defaultProfile) => set({ defaultProfile }),

  setViewOrder: (viewOrder) => set({ viewOrder }),

  setProfileDefaults: (data) =>
    set((state) => ({
      profileDefaults: { ...state.profileDefaults, ...data },
    })),

  addProfile: (profile) =>
    set((state) => ({ profiles: [...state.profiles, profile] })),

  removeProfile: (index) =>
    set((state) => ({
      profiles: state.profiles.filter((_, i) => i !== index),
    })),

  updateProfile: (index, data) =>
    set((state) => ({
      profiles: state.profiles.map((p, i) =>
        i === index ? { ...p, ...data } : p,
      ),
    })),

  addColorScheme: (scheme) =>
    set((state) => ({ colorSchemes: [...state.colorSchemes, scheme] })),

  removeColorScheme: (index) =>
    set((state) => ({
      colorSchemes: state.colorSchemes.filter((_, i) => i !== index),
    })),

  updateColorScheme: (index, data) =>
    set((state) => ({
      colorSchemes: state.colorSchemes.map((cs, i) =>
        i === index ? ({ ...cs, ...data } as ColorScheme) : cs,
      ),
    })),

  addKeybinding: (keybinding) =>
    set((state) => ({ keybindings: [...state.keybindings, keybinding] })),

  removeKeybinding: (index) =>
    set((state) => ({
      keybindings: state.keybindings.filter((_, i) => i !== index),
    })),

  updateKeybinding: (index, data) =>
    set((state) => ({
      keybindings: state.keybindings.map((kb, i) =>
        i === index ? { ...kb, ...data } : kb,
      ),
    })),

  loadFromSettings: (data) => {
    // Ensure profiles have all required fields (backwards compat)
    const profiles = data.profiles?.map((p) => ({
      ...makeProfile(p.name, p.commandLine),
      ...p,
      padding: p.padding ?? { ...defaultPadding },
    }));
    // Ensure font has weight (backwards compat — explicit undefined in spread would override)
    const font = data.font ? { ...data.font, weight: data.font.weight ?? "normal" } : undefined;
    // Ensure profileDefaults has all fields (backwards compat)
    const profileDefaults = data.profileDefaults
      ? { ...defaultProfileDefaults, ...data.profileDefaults }
      : undefined;
    // Merge loaded color schemes with builtins (builtins first, user schemes appended)
    const loadedSchemes = data.colorSchemes?.map((cs) => ({
      ...makeDefaultColorScheme(),
      ...cs,
    }));
    // Ensure builtins are always present; user schemes with same name override builtins
    const mergedSchemes = loadedSchemes !== undefined ? (() => {
      const userNames = new Set(loadedSchemes.map((s) => s.name));
      const kept = builtinColorSchemes.filter((b) => !userNames.has(b.name));
      return [...kept, ...loadedSchemes];
    })() : undefined;
    // Ensure convenience settings have all fields (backwards compat, also accepts "claude" alias)
    const convSource = data.convenience ?? (data as { claude?: ConvenienceSettings }).claude;
    const convenience = convSource
      ? { smartPaste: true, pasteImageDir: "", hoverIdleSeconds: 2, notificationDismiss: "workspace" as const, copyOnSelect: true, ...(convSource as Partial<ConvenienceSettings>) }
      : undefined;

    set((state) => ({
      ...state,
      ...data,
      ...(profiles ? { profiles } : {}),
      ...(font ? { font } : {}),
      ...(profileDefaults ? { profileDefaults } : {}),
      ...(mergedSchemes ? { colorSchemes: mergedSchemes } : {}),
      ...(convenience ? { convenience } : {}),
    }));
  },
}));
