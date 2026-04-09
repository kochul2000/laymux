import { useState, useRef, useEffect, createContext, useContext, useCallback } from "react";
import { useUiStore } from "@/stores/ui-store";
import {
  useSettingsStore,
  makeDefaultColorScheme,
  makeProfileFromDefaults,
  builtinAppThemes,
  defaultProfileDefaults,
  type FontSettings,
  type Profile,
  type ProfileDefaults,
  type CursorShape,
  type SupportedCursorShape,
  type BellStyle,
  type CloseOnExit,
  type AntialiasingMode,
  type ColorScheme,
  type Keybinding,
} from "@/stores/settings-store";
import type { FileExplorerSettings, ExtensionViewer } from "@/lib/tauri-api";
import { persistSession } from "@/lib/persist-session";
import { MONOSPACED_FONTS, getSystemMonospaceFonts } from "@/lib/system-fonts";
import { FocusInput, FocusSelect, inputStyle, inputCls } from "@/components/ui/FormControls";

const cardStyle: React.CSSProperties = {
  background: "var(--bg-overlay)",
  borderRadius: "var(--radius-lg)",
  border: "1px solid var(--border)",
};

// -- Sub-components --

function SettingRow({
  label,
  desc,
  children,
}: {
  label: string;
  desc?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 py-1.5">
      <div className="w-36 shrink-0 pt-1">
        <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
          {label}
        </span>
        {desc && (
          <p
            className="mt-0.5 text-[11px] leading-tight"
            style={{ color: "var(--text-secondary)", opacity: 0.65 }}
          >
            {desc}
          </p>
        )}
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3
      className="mb-3 border-b pb-2 text-[15px] font-semibold"
      style={{ borderColor: "var(--border)", color: "var(--text-primary)" }}
    >
      {children}
    </h3>
  );
}

function ColorSwatch({
  color,
  label,
  onChange,
}: {
  color: string;
  label: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex cursor-pointer flex-col items-center gap-1">
      <input
        type="color"
        value={color || "#000000"}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 w-7 cursor-pointer rounded border-0 p-0"
        style={{ background: "transparent" }}
      />
      <span className="text-center text-[9px]" style={{ color: "var(--text-secondary)" }}>
        {label}
      </span>
    </label>
  );
}

// -- Section: Startup (renamed from General) --

const fontWeightOptions = [
  "thin",
  "extra-light",
  "light",
  "semi-light",
  "normal",
  "medium",
  "semi-bold",
  "bold",
  "extra-bold",
  "black",
  "extra-black",
];

/** Hook to detect installed monospace fonts via system enumeration + canvas check. */
function useMonospacedFonts() {
  const [installed, setInstalled] = useState<string[]>(MONOSPACED_FONTS);
  useEffect(() => {
    let cancelled = false;
    getSystemMonospaceFonts().then((fonts) => {
      if (!cancelled) setInstalled(fonts);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return installed;
}

function StartupSection() {
  const storeDefaultProfile = useSettingsStore((s) => s.defaultProfile);
  const setDefaultProfile = useSettingsStore((s) => s.setDefaultProfile);
  const profiles = useSettingsStore((s) => s.profiles);
  const storeAppThemeId = useSettingsStore((s) => s.appThemeId ?? "catppuccin-mocha");
  const setAppTheme = useSettingsStore((s) => s.setAppTheme);

  // Draft state — only committed to store on Save
  const [draftAppTheme, setDraftAppTheme] = useDraft(
    "startup-appTheme",
    storeAppThemeId,
    setAppTheme,
  );
  const [draftDefaultProfile, setDraftDefaultProfile] = useDraft(
    "startup-defaultProfile",
    storeDefaultProfile,
    setDefaultProfile,
  );

  return (
    <div>
      <SectionTitle>Startup</SectionTitle>

      {/* App Theme */}
      <div className="mb-3" style={cardStyle}>
        <div className="px-4 py-2">
          <div className="flex items-center justify-between">
            <div>
              <h4 className="text-xs font-semibold" style={{ color: "var(--text-primary)" }}>
                App Theme
              </h4>
              <p
                className="mt-0.5 text-[11px]"
                style={{ color: "var(--text-secondary)", opacity: 0.6 }}
              >
                Application UI appearance
              </p>
            </div>
            <FocusSelect
              data-testid="app-theme-select"
              value={draftAppTheme}
              onChange={(e) => setDraftAppTheme(e.target.value)}
              className="w-44 rounded px-2 py-1.5 text-xs"
            >
              {builtinAppThemes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </FocusSelect>
          </div>
        </div>
      </div>

      {/* Default profile */}
      <div className="mb-4" style={cardStyle}>
        <div className="px-4 py-2">
          <div className="flex items-center justify-between">
            <div>
              <h4 className="text-xs font-semibold" style={{ color: "var(--text-primary)" }}>
                Default Profile
              </h4>
              <p
                className="mt-0.5 text-[11px]"
                style={{ color: "var(--text-secondary)", opacity: 0.6 }}
              >
                New terminal sessions will use this profile
              </p>
            </div>
            <FocusSelect
              data-testid="default-profile-select"
              value={draftDefaultProfile}
              onChange={(e) => setDraftDefaultProfile(e.target.value)}
              className="w-44 rounded px-2 py-1.5 text-xs"
            >
              {profiles
                .filter((p) => !p.hidden)
                .map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name}
                  </option>
                ))}
            </FocusSelect>
          </div>
        </div>
      </div>
    </div>
  );
}

// -- Shared: Font fields (used by both Defaults and Profile) --

function FontSection() {
  const storeAppFont = useSettingsStore((s) => s.appFont);
  const setAppFont = useSettingsStore((s) => s.setAppFont);
  const monoFonts = useMonospacedFonts();
  const [draftFont, setDraftFont] = useDraft("appFont", storeAppFont, setAppFont);

  return (
    <div>
      <SectionTitle>Font</SectionTitle>
      <p className="mb-3 text-[11px]" style={{ color: "var(--text-secondary)", opacity: 0.6 }}>
        앱 기본 폰트. Memo, Issue Reporter 등 비터미널 뷰에서 상속됩니다. 터미널 폰트는 Profile
        Defaults에서 설정합니다.
      </p>
      <FontFields
        font={draftFont}
        onChange={setDraftFont}
        monoFonts={monoFonts}
        faceDesc="Default font for non-terminal views"
      />
    </div>
  );
}

function FontFields({
  font,
  onChange,
  defaults,
  showReset,
  monoFonts,
  faceDesc,
}: {
  font: FontSettings;
  onChange: (font: FontSettings) => void;
  defaults?: FontSettings;
  showReset?: boolean;
  monoFonts: string[];
  faceDesc?: string;
}) {
  const isDefault = defaults && JSON.stringify(font) === JSON.stringify(defaults);
  const resetBtn =
    showReset && defaults && !isDefault ? (
      <button
        onClick={() => onChange({ ...defaults })}
        className="ml-1 shrink-0 rounded px-1.5 py-0.5 text-[9px]"
        style={{
          color: "var(--accent)",
          background: "var(--accent-10)",
          border: "none",
          cursor: "pointer",
        }}
        title="Reset to default"
      >
        Reset
      </button>
    ) : null;

  return (
    <div style={cardStyle} className="mb-3">
      <div className="px-4 py-2">
        <div className="flex items-center gap-2 mb-2">
          <h4 className="text-xs font-semibold" style={{ color: "var(--text-primary)" }}>
            Font
          </h4>
          {resetBtn}
        </div>
        <SettingRow label="Font Face" desc={faceDesc ?? "Monospaced font for terminals"}>
          <FocusSelect
            data-testid="font-face-input"
            value={font.face}
            onChange={(e) => onChange({ ...font, face: e.target.value })}
            className={inputCls}
          >
            {!monoFonts.includes(font.face) && <option value={font.face}>{font.face}</option>}
            {monoFonts.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </FocusSelect>
        </SettingRow>
        <SettingRow label="Font Size" desc="Size in points (6-72)">
          <FocusInput
            data-testid="font-size-input"
            type="number"
            value={font.size}
            onChange={(e) => onChange({ ...font, size: parseInt(e.target.value) || 14 })}
            className="w-24 rounded px-2 py-1.5 text-xs"
            min={6}
            max={72}
          />
        </SettingRow>
        <SettingRow label="Font Weight">
          <select
            data-testid="font-weight-select"
            value={font.weight}
            onChange={(e) => onChange({ ...font, weight: e.target.value })}
            className={inputCls}
            style={inputStyle}
          >
            {fontWeightOptions.map((w) => (
              <option key={w} value={w}>
                {w.charAt(0).toUpperCase() + w.slice(1)}
              </option>
            ))}
          </select>
        </SettingRow>
      </div>
    </div>
  );
}

// -- Shared: Appearance + Advanced fields (used by both Defaults and Profile) --

function AppearanceFields({
  data,
  onChange,
  colorSchemes,
  defaults,
  showReset,
}: {
  data: Pick<Profile, "colorScheme" | "cursorShape" | "cursorBlink" | "opacity" | "padding">;
  onChange: (d: Partial<Profile>) => void;
  colorSchemes: { name: string }[];
  defaults?: ProfileDefaults;
  showReset?: boolean;
}) {
  const supportedCursorShape: SupportedCursorShape =
    data.cursorShape === "underscore" ||
    data.cursorShape === "filledBox" ||
    data.cursorShape === "bar"
      ? data.cursorShape
      : "filledBox";
  const isDefault = (key: keyof ProfileDefaults) =>
    defaults && JSON.stringify(data[key as keyof typeof data]) === JSON.stringify(defaults[key]);
  const resetBtn = (key: keyof ProfileDefaults) =>
    showReset && defaults && !isDefault(key) ? (
      <button
        onClick={() =>
          onChange({ [key]: key === "padding" ? { ...defaults.padding } : defaults[key] })
        }
        className="ml-1 shrink-0 rounded px-1.5 py-0.5 text-[9px]"
        style={{
          color: "var(--accent)",
          background: "var(--accent-10)",
          border: "none",
          cursor: "pointer",
        }}
        title="Reset to default"
      >
        Reset
      </button>
    ) : null;

  return (
    <>
      <div style={cardStyle} className="mb-3">
        <div className="px-4 py-2">
          <h4 className="mb-2 text-xs font-semibold" style={{ color: "var(--text-primary)" }}>
            Appearance
          </h4>
          <SettingRow label="Color Scheme">
            <div className="flex items-center">
              <select
                value={data.colorScheme}
                onChange={(e) => onChange({ colorScheme: e.target.value })}
                className={inputCls}
                style={inputStyle}
              >
                <option value="">(default)</option>
                {colorSchemes.map((cs) => (
                  <option key={cs.name} value={cs.name}>
                    {cs.name}
                  </option>
                ))}
              </select>
              {resetBtn("colorScheme")}
            </div>
          </SettingRow>
          <SettingRow label="Cursor Shape">
            <div className="flex items-center">
              <select
                data-testid="cursor-shape-select"
                value={supportedCursorShape}
                onChange={(e) =>
                  onChange({ cursorShape: e.target.value as SupportedCursorShape as CursorShape })
                }
                className={inputCls}
                style={inputStyle}
              >
                <option value="bar">Bar |</option>
                <option value="underscore">Underscore _</option>
                <option value="filledBox">Filled Box &#9608;</option>
              </select>
              {resetBtn("cursorShape")}
            </div>
          </SettingRow>
          <SettingRow label="Cursor Blink">
            <div className="flex items-center gap-2">
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  data-testid="cursor-blink-toggle"
                  type="checkbox"
                  checked={data.cursorBlink}
                  onChange={(e) => onChange({ cursorBlink: e.target.checked })}
                />
                <span className="text-[12px]" style={{ color: "var(--text-secondary)" }}>
                  Enable blinking cursor
                </span>
              </label>
              {resetBtn("cursorBlink")}
            </div>
          </SettingRow>
          <SettingRow label="Opacity">
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={10}
                max={100}
                value={data.opacity}
                onChange={(e) => onChange({ opacity: parseInt(e.target.value) })}
                className="flex-1"
              />
              <span className="w-8 text-right text-xs" style={{ color: "var(--text-secondary)" }}>
                {data.opacity}%
              </span>
              {resetBtn("opacity")}
            </div>
          </SettingRow>
        </div>
      </div>

      {/* Padding */}
      <div style={cardStyle} className="mb-3">
        <div className="px-4 py-2">
          <div className="flex items-center gap-2 mb-2">
            <h4 className="text-xs font-semibold" style={{ color: "var(--text-primary)" }}>
              Padding
            </h4>
            {resetBtn("padding")}
          </div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1">
            {(["top", "right", "bottom", "left"] as const).map((side) => (
              <SettingRow key={side} label={side.charAt(0).toUpperCase() + side.slice(1)}>
                <input
                  type="number"
                  value={data.padding[side]}
                  onChange={(e) =>
                    onChange({
                      padding: {
                        ...data.padding,
                        [side]: Math.max(0, parseInt(e.target.value) || 0),
                      },
                    })
                  }
                  className="w-20 rounded px-2 py-1.5 text-xs"
                  style={inputStyle}
                  min={0}
                  max={100}
                />
              </SettingRow>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

function AdvancedFields({
  data,
  onChange,
  defaults,
  showReset,
}: {
  data: Pick<
    Profile,
    | "scrollbackLines"
    | "bellStyle"
    | "closeOnExit"
    | "antialiasingMode"
    | "suppressApplicationTitle"
    | "snapOnInput"
    | "restoreCwd"
    | "restoreOutput"
  >;
  onChange: (d: Partial<Profile>) => void;
  defaults?: ProfileDefaults;
  showReset?: boolean;
}) {
  const isDefault = (key: keyof ProfileDefaults) =>
    defaults && data[key as keyof typeof data] === defaults[key];
  const resetBtn = (key: keyof ProfileDefaults) =>
    showReset && defaults && !isDefault(key) ? (
      <button
        onClick={() => onChange({ [key]: defaults[key] })}
        className="ml-1 shrink-0 rounded px-1.5 py-0.5 text-[9px]"
        style={{
          color: "var(--accent)",
          background: "var(--accent-10)",
          border: "none",
          cursor: "pointer",
        }}
        title="Reset to default"
      >
        Reset
      </button>
    ) : null;

  return (
    <div style={cardStyle}>
      <div className="px-4 py-2">
        <h4 className="mb-2 text-xs font-semibold" style={{ color: "var(--text-primary)" }}>
          Advanced
        </h4>
        <SettingRow label="Scrollback Lines" desc="Number of lines stored in history">
          <div className="flex items-center">
            <input
              type="number"
              value={data.scrollbackLines}
              onChange={(e) =>
                onChange({ scrollbackLines: Math.max(0, parseInt(e.target.value) || 0) })
              }
              className="w-28 rounded px-2 py-1.5 text-xs"
              style={inputStyle}
              min={0}
              max={999999}
            />
            {resetBtn("scrollbackLines")}
          </div>
        </SettingRow>
        <SettingRow label="Bell Style" desc="How the terminal bell is signaled">
          <div className="flex items-center">
            <select
              value={data.bellStyle}
              onChange={(e) => onChange({ bellStyle: e.target.value as BellStyle })}
              className={inputCls}
              style={inputStyle}
            >
              <option value="audible">Audible</option>
              <option value="none">None</option>
              <option value="window">Window flash</option>
              <option value="taskbar">Taskbar flash</option>
              <option value="all">All</option>
            </select>
            {resetBtn("bellStyle")}
          </div>
        </SettingRow>
        <SettingRow label="Close on Exit" desc="When the shell process terminates">
          <div className="flex items-center">
            <select
              value={data.closeOnExit}
              onChange={(e) => onChange({ closeOnExit: e.target.value as CloseOnExit })}
              className={inputCls}
              style={inputStyle}
            >
              <option value="automatic">Automatic</option>
              <option value="graceful">Graceful</option>
              <option value="always">Always</option>
              <option value="never">Never</option>
            </select>
            {resetBtn("closeOnExit")}
          </div>
        </SettingRow>
        <SettingRow label="Text Antialiasing" desc="Text rendering method">
          <div className="flex items-center">
            <select
              value={data.antialiasingMode}
              onChange={(e) => onChange({ antialiasingMode: e.target.value as AntialiasingMode })}
              className={inputCls}
              style={inputStyle}
            >
              <option value="grayscale">Grayscale</option>
              <option value="cleartype">ClearType</option>
              <option value="aliased">Aliased</option>
            </select>
            {resetBtn("antialiasingMode")}
          </div>
        </SettingRow>
        <SettingRow label="Suppress Title Changes">
          <div className="flex items-center gap-2">
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={data.suppressApplicationTitle}
                onChange={(e) => onChange({ suppressApplicationTitle: e.target.checked })}
              />
              <span className="text-xs" style={{ color: "var(--text-secondary)" }}>
                Prevent shell from changing the tab title
              </span>
            </label>
            {resetBtn("suppressApplicationTitle")}
          </div>
        </SettingRow>
        <SettingRow label="Scroll to Input on Typing">
          <div className="flex items-center gap-2">
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={data.snapOnInput}
                onChange={(e) => onChange({ snapOnInput: e.target.checked })}
              />
              <span className="text-xs" style={{ color: "var(--text-secondary)" }}>
                Auto-scroll to input line when typing
              </span>
            </label>
            {resetBtn("snapOnInput")}
          </div>
        </SettingRow>

        <h4 className="mb-2 mt-4 text-xs font-semibold" style={{ color: "var(--text-primary)" }}>
          Session Restore
        </h4>
        <SettingRow
          label="Restore Working Directory"
          desc="Restore last working directory on restart"
        >
          <div className="flex items-center gap-2">
            <label className="flex cursor-pointer items-center gap-2">
              <input
                data-testid="restore-cwd-checkbox"
                type="checkbox"
                checked={data.restoreCwd}
                onChange={(e) => onChange({ restoreCwd: e.target.checked })}
              />
              <span className="text-xs" style={{ color: "var(--text-secondary)" }}>
                Start terminal in last used directory
              </span>
            </label>
            {resetBtn("restoreCwd")}
          </div>
        </SettingRow>
        <SettingRow
          label="Restore Terminal Output"
          desc="Restore previous terminal output on restart"
        >
          <div className="flex items-center gap-2">
            <label className="flex cursor-pointer items-center gap-2">
              <input
                data-testid="restore-output-checkbox"
                type="checkbox"
                checked={data.restoreOutput}
                onChange={(e) => onChange({ restoreOutput: e.target.checked })}
              />
              <span className="text-xs" style={{ color: "var(--text-secondary)" }}>
                Show previous session output above new shell
              </span>
            </label>
            {resetBtn("restoreOutput")}
          </div>
        </SettingRow>
      </div>
    </div>
  );
}

// -- Section: Profile Defaults --

const fallbackDefaults: ProfileDefaults = { ...defaultProfileDefaults };

function DefaultsSection() {
  const rawDefaults = useSettingsStore((s) => s.profileDefaults);
  const storeDefaults = rawDefaults ?? fallbackDefaults;
  const setProfileDefaults = useSettingsStore((s) => s.setProfileDefaults);
  const colorSchemes = useSettingsStore((s) => s.colorSchemes);
  const monoFonts = useMonospacedFonts();
  const [draftDefaults, setDraftDefaults] = useDraft("profileDefaults", storeDefaults, (v) =>
    setProfileDefaults(v as Partial<ProfileDefaults>),
  );
  const updateDefaults = (partial: Partial<ProfileDefaults>) =>
    setDraftDefaults((prev) => ({ ...prev, ...partial }));

  return (
    <div>
      <SectionTitle>Profile Defaults</SectionTitle>
      <p className="mb-4 text-[11px]" style={{ color: "var(--text-secondary)", opacity: 0.6 }}>
        These settings apply to all new profiles. Individual profiles can override them.
      </p>

      <FontFields
        font={draftDefaults.font}
        onChange={(font) => updateDefaults({ font })}
        monoFonts={monoFonts}
      />

      <AppearanceFields
        data={draftDefaults}
        onChange={updateDefaults}
        colorSchemes={colorSchemes}
      />

      <AdvancedFields data={draftDefaults} onChange={updateDefaults} />
    </div>
  );
}

// -- Section: Profile Editor with sub-tabs --

type ProfileTab = "general" | "additional";

const profileTabStyle = (active: boolean): React.CSSProperties => ({
  background: "transparent",
  color: active ? "var(--accent)" : "var(--text-secondary)",
  cursor: "pointer",
  transition: "all 0.1s",
  border: "none",
  borderBottom: active ? "2px solid var(--accent)" : "2px solid transparent",
});

function ProfileSection({ profileIndex }: { profileIndex: number }) {
  const storeProfile = useSettingsStore((s) => s.profiles[profileIndex]);
  const updateProfile = useSettingsStore((s) => s.updateProfile);
  const colorSchemes = useSettingsStore((s) => s.colorSchemes);
  const rawProfileDefaults = useSettingsStore((s) => s.profileDefaults);
  const profileDefaults = rawProfileDefaults ?? fallbackDefaults;
  const [activeTab, setActiveTab] = useState<ProfileTab>("general");
  const monoFonts = useMonospacedFonts();

  const [profile, setDraftProfile] = useDraft(`profile-${profileIndex}`, storeProfile, (v) => {
    if (v) updateProfile(profileIndex, v as Partial<Profile>);
  });

  if (!profile) return null;

  const update = (data: Partial<Profile>) =>
    setDraftProfile((prev) => (prev ? { ...prev, ...data } : prev));

  return (
    <div>
      <SectionTitle>{profile.name}</SectionTitle>

      {/* Sub-tab bar */}
      <div
        data-testid="profile-tabs"
        className="mb-4 flex gap-0"
        style={{ borderBottom: "1px solid var(--border)" }}
      >
        {(
          [
            ["general", "General"],
            ["additional", "Additional Settings"],
          ] as const
        ).map(([tab, label]) => (
          <button
            key={tab}
            className="px-4 py-2 text-xs font-medium"
            style={profileTabStyle(activeTab === tab)}
            onClick={() => setActiveTab(tab as ProfileTab)}
          >
            {label}
          </button>
        ))}
      </div>

      {/* General Tab */}
      {activeTab === "general" && (
        <div style={cardStyle} className="mb-3">
          <div className="px-4 py-2">
            <SettingRow label="Name">
              <input
                data-testid="profile-name-input"
                type="text"
                value={profile.name}
                onChange={(e) => update({ name: e.target.value })}
                className={inputCls}
                style={inputStyle}
              />
            </SettingRow>
            <SettingRow label="Command Line" desc="Executable to run when this profile is launched">
              <input
                type="text"
                value={profile.commandLine}
                onChange={(e) => update({ commandLine: e.target.value })}
                className={inputCls}
                style={inputStyle}
                placeholder="powershell.exe"
              />
            </SettingRow>
            <SettingRow label="Startup Command" desc="Command to run after shell initialization">
              <input
                type="text"
                value={profile.startupCommand}
                onChange={(e) => update({ startupCommand: e.target.value })}
                className={inputCls}
                style={inputStyle}
                placeholder="cd ~/project && conda activate myenv"
              />
            </SettingRow>
            <SettingRow label="Starting Directory" desc="Directory where the shell starts">
              <input
                type="text"
                value={profile.startingDirectory}
                onChange={(e) => update({ startingDirectory: e.target.value })}
                className={inputCls}
                style={inputStyle}
                placeholder="~"
              />
            </SettingRow>
            <SettingRow label="Tab Title" desc="Leave empty to use profile name">
              <input
                type="text"
                value={profile.tabTitle}
                onChange={(e) => update({ tabTitle: e.target.value })}
                className={inputCls}
                style={inputStyle}
                placeholder=""
              />
            </SettingRow>
            <SettingRow label="Hidden">
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={profile.hidden}
                  onChange={(e) => update({ hidden: e.target.checked })}
                />
                <span className="text-xs" style={{ color: "var(--text-secondary)" }}>
                  Hide this profile from dropdown menus
                </span>
              </label>
            </SettingRow>
          </div>
        </div>
      )}

      {/* Additional Settings Tab (Font + Appearance + Advanced — inherited from defaults) */}
      {activeTab === "additional" && (
        <>
          <p className="mb-3 text-[11px]" style={{ color: "var(--text-secondary)", opacity: 0.6 }}>
            Override defaults for this profile. Click "Reset" to restore inherited value.
          </p>
          <FontFields
            font={profile.font ?? profileDefaults.font}
            onChange={(font) => update({ font })}
            defaults={profileDefaults.font}
            showReset
            monoFonts={monoFonts}
          />
          <AppearanceFields
            data={profile}
            onChange={update}
            colorSchemes={colorSchemes}
            defaults={profileDefaults}
            showReset
          />
          <AdvancedFields data={profile} onChange={update} defaults={profileDefaults} showReset />
        </>
      )}
    </div>
  );
}

// -- Section: Color Schemes --

function ColorSchemesSection() {
  const storeColorSchemes = useSettingsStore((s) => s.colorSchemes);
  const setColorSchemes = useSettingsStore((s) => s.setColorSchemes);
  const [colorSchemes, setDraftColorSchemes] = useDraft<ColorScheme[]>(
    "colorSchemes",
    storeColorSchemes,
    (v) => setColorSchemes(v),
  );
  const [selectedIdx, setSelectedIdx] = useState(0);

  const scheme = colorSchemes[selectedIdx];

  const handleAdd = () => {
    const cs = makeDefaultColorScheme();
    cs.name = `Scheme ${colorSchemes.length + 1}`;
    setDraftColorSchemes((prev) => [...prev, cs]);
    setSelectedIdx(colorSchemes.length);
  };

  const handleRemove = () => {
    if (!scheme) return;
    setDraftColorSchemes((prev) => prev.filter((_, i) => i !== selectedIdx));
    setSelectedIdx(Math.max(0, selectedIdx - 1));
  };

  const updateField = (field: string, value: string) => {
    if (scheme) {
      setDraftColorSchemes((prev) =>
        prev.map((cs, i) => (i === selectedIdx ? ({ ...cs, [field]: value } as ColorScheme) : cs)),
      );
    }
  };

  const ansiColors = [
    ["black", "Black"],
    ["red", "Red"],
    ["green", "Green"],
    ["yellow", "Yellow"],
    ["blue", "Blue"],
    ["purple", "Purple"],
    ["cyan", "Cyan"],
    ["white", "White"],
  ] as const;

  const brightColors = [
    ["brightBlack", "Bright Black"],
    ["brightRed", "Bright Red"],
    ["brightGreen", "Bright Green"],
    ["brightYellow", "Bright Yellow"],
    ["brightBlue", "Bright Blue"],
    ["brightPurple", "Bright Purple"],
    ["brightCyan", "Bright Cyan"],
    ["brightWhite", "Bright White"],
  ] as const;

  return (
    <div>
      <SectionTitle>Color Schemes</SectionTitle>

      {/* Scheme selector */}
      <div className="mb-4 flex items-center gap-2">
        <select
          value={selectedIdx}
          onChange={(e) => setSelectedIdx(parseInt(e.target.value))}
          className={inputCls + " flex-1"}
          style={inputStyle}
        >
          {colorSchemes.length === 0 && (
            <option value="" disabled>
              No schemes
            </option>
          )}
          {colorSchemes.map((cs, i) => (
            <option key={i} value={i}>
              {cs.name}
            </option>
          ))}
        </select>
        <button
          data-testid="add-color-scheme-btn"
          onClick={handleAdd}
          className="shrink-0 rounded px-3 py-1.5 text-xs"
          style={{ ...inputStyle, cursor: "pointer" }}
        >
          + Add
        </button>
        {scheme && (
          <button
            onClick={handleRemove}
            className="shrink-0 rounded px-3 py-1.5 text-xs"
            style={{ ...inputStyle, color: "var(--red)", cursor: "pointer" }}
          >
            Delete
          </button>
        )}
      </div>

      {scheme && (
        <>
          <div style={cardStyle} className="mb-3">
            <div className="px-4 py-2">
              <h4 className="mb-2 text-xs font-semibold" style={{ color: "var(--text-primary)" }}>
                Scheme Name
              </h4>
              <input
                type="text"
                value={scheme.name}
                onChange={(e) => updateField("name", e.target.value)}
                className={inputCls}
                style={inputStyle}
              />
            </div>
          </div>

          {/* Terminal Colors */}
          <div style={cardStyle} className="mb-3">
            <div className="px-4 py-2">
              <h4 className="mb-3 text-xs font-semibold" style={{ color: "var(--text-primary)" }}>
                Terminal Colors
              </h4>
              <div className="mb-3 flex gap-2">
                <ColorSwatch
                  color={scheme.foreground}
                  label="Fg"
                  onChange={(v) => updateField("foreground", v)}
                />
                <ColorSwatch
                  color={scheme.background}
                  label="Bg"
                  onChange={(v) => updateField("background", v)}
                />
                <ColorSwatch
                  color={scheme.cursorColor}
                  label="Cursor"
                  onChange={(v) => updateField("cursorColor", v)}
                />
                <ColorSwatch
                  color={scheme.selectionBackground}
                  label="Select"
                  onChange={(v) => updateField("selectionBackground", v)}
                />
              </div>

              <h4
                className="mb-2 mt-4 text-xs font-semibold"
                style={{ color: "var(--text-primary)" }}
              >
                ANSI Colors
              </h4>
              <div className="mb-2 flex gap-2">
                {ansiColors.map(([key, label]) => (
                  <ColorSwatch
                    key={key}
                    color={scheme[key]}
                    label={label.replace("Bright ", "")}
                    onChange={(v) => updateField(key, v)}
                  />
                ))}
              </div>
              <div className="flex gap-2">
                {brightColors.map(([key, label]) => (
                  <ColorSwatch
                    key={key}
                    color={scheme[key]}
                    label={"B." + label.replace("Bright ", "")}
                    onChange={(v) => updateField(key, v)}
                  />
                ))}
              </div>
            </div>
          </div>

          {/* Preview */}
          <div style={cardStyle}>
            <div className="px-4 py-2">
              <h4 className="mb-2 text-xs font-semibold" style={{ color: "var(--text-primary)" }}>
                Preview
              </h4>
              <div
                className="rounded p-3 font-mono text-xs"
                style={{ background: scheme.background, color: scheme.foreground }}
              >
                <span style={{ color: scheme.green }}>user@host</span>
                <span style={{ color: scheme.white }}>:</span>
                <span style={{ color: scheme.blue }}>~/project</span>
                <span style={{ color: scheme.white }}>$ </span>
                <span style={{ color: scheme.yellow }}>npm</span>
                <span style={{ color: scheme.white }}> run dev</span>
                <br />
                <span style={{ color: scheme.cyan }}>Ready</span>
                <span style={{ color: scheme.white }}> on </span>
                <span style={{ color: scheme.purple }}>http://localhost:3000</span>
                <br />
                <span style={{ color: scheme.red }}>error</span>
                <span style={{ color: scheme.white }}>: module not found</span>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// -- Section: Convenience --

function ConvenienceSection() {
  const storeConvenience = useSettingsStore((s) => s.convenience);
  const setConvenience = useSettingsStore((s) => s.setConvenience);
  const [convenience, setDraftConvenience] = useDraft("convenience", storeConvenience, (v) =>
    setConvenience(v),
  );
  const updateConvenience = (partial: Partial<typeof convenience>) =>
    setDraftConvenience((prev) => ({ ...prev, ...partial }));

  return (
    <div>
      <SectionTitle>Convenience</SectionTitle>

      <div style={cardStyle} className="p-4">
        {/* Smart Paste toggle */}
        <div className="flex items-start gap-3 py-1">
          <div className="w-36 shrink-0 pt-1">
            <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
              Smart Paste
            </span>
            <p
              className="mt-0.5 text-[11px] leading-tight"
              style={{ color: "var(--text-secondary)", opacity: 0.65 }}
            >
              Ctrl+V 시 클립보드의 파일/이미지를 경로로 붙여넣기
            </p>
          </div>
          <div className="min-w-0 flex-1">
            <label className="flex cursor-pointer items-center gap-2">
              <input
                data-testid="smart-paste-toggle"
                type="checkbox"
                checked={convenience.smartPaste}
                onChange={(e) => updateConvenience({ smartPaste: e.target.checked })}
              />
              <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
                {convenience.smartPaste ? "Enabled" : "Disabled"}
              </span>
            </label>
          </div>
        </div>

        {/* Smart Remove Indent toggle */}
        <div className="mt-3 flex items-start gap-3 py-1">
          <div className="w-36 shrink-0 pt-1">
            <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
              Smart Remove Indent
            </span>
            <p
              className="mt-0.5 text-[11px] leading-tight"
              style={{ color: "var(--text-secondary)", opacity: 0.65 }}
            >
              붙여넣기 시 공통 들여쓰기 제거
            </p>
          </div>
          <div className="min-w-0 flex-1">
            <label className="flex cursor-pointer items-center gap-2">
              <input
                data-testid="smart-remove-indent-toggle"
                type="checkbox"
                checked={convenience.smartRemoveIndent}
                onChange={(e) => updateConvenience({ smartRemoveIndent: e.target.checked })}
              />
              <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
                {convenience.smartRemoveIndent ? "Enabled" : "Disabled"}
              </span>
            </label>
          </div>
        </div>

        {/* Smart Remove Line Break toggle */}
        <div className="mt-3 flex items-start gap-3 py-1">
          <div className="w-36 shrink-0 pt-1">
            <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
              Smart Remove Line Break
            </span>
            <p
              className="mt-0.5 text-[11px] leading-tight"
              style={{ color: "var(--text-secondary)", opacity: 0.65 }}
            >
              붙여넣기 시 줄바꿈으로 깨진 URL 복원
            </p>
          </div>
          <div className="min-w-0 flex-1">
            <label className="flex cursor-pointer items-center gap-2">
              <input
                data-testid="smart-remove-linebreak-toggle"
                type="checkbox"
                checked={convenience.smartRemoveLineBreak}
                onChange={(e) => updateConvenience({ smartRemoveLineBreak: e.target.checked })}
              />
              <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
                {convenience.smartRemoveLineBreak ? "Enabled" : "Disabled"}
              </span>
            </label>
          </div>
        </div>

        {/* Smart Link Join toggle */}
        <div className="mt-3 flex items-start gap-3 py-1">
          <div className="w-36 shrink-0 pt-1">
            <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
              Smart Link Join
            </span>
            <p
              className="mt-0.5 text-[11px] leading-tight"
              style={{ color: "var(--text-secondary)", opacity: 0.65 }}
            >
              인덴트된 여러 줄 URL을 하나의 클릭 가능한 링크로 감지
            </p>
          </div>
          <div className="min-w-0 flex-1">
            <label className="flex cursor-pointer items-center gap-2">
              <input
                data-testid="smart-link-join-toggle"
                type="checkbox"
                checked={convenience.smartLinkJoin}
                onChange={(e) => updateConvenience({ smartLinkJoin: e.target.checked })}
              />
              <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
                {convenience.smartLinkJoin ? "Enabled" : "Disabled"}
              </span>
            </label>
          </div>
        </div>

        {/* Copy On Select toggle */}
        <div className="mt-3 flex items-start gap-3 py-1">
          <div className="w-36 shrink-0 pt-1">
            <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
              Copy On Select
            </span>
            <p
              className="mt-0.5 text-[11px] leading-tight"
              style={{ color: "var(--text-secondary)", opacity: 0.65 }}
            >
              터미널에서 텍스트 선택 시 자동으로 클립보드에 복사
            </p>
          </div>
          <div className="min-w-0 flex-1">
            <label className="flex cursor-pointer items-center gap-2">
              <input
                data-testid="copy-on-select-toggle"
                type="checkbox"
                checked={convenience.copyOnSelect}
                onChange={(e) => updateConvenience({ copyOnSelect: e.target.checked })}
              />
              <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
                {convenience.copyOnSelect ? "Enabled" : "Disabled"}
              </span>
            </label>
          </div>
        </div>

        {/* Large Paste Warning toggle */}
        <div className="mt-3 flex items-start gap-3 py-1">
          <div className="w-36 shrink-0 pt-1">
            <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
              Large Paste Warning
            </span>
            <p
              className="mt-0.5 text-[11px] leading-tight"
              style={{ color: "var(--text-secondary)", opacity: 0.65 }}
            >
              대용량 텍스트 붙여넣기 시 확인 다이얼로그 표시
            </p>
          </div>
          <div className="min-w-0 flex-1">
            <label className="flex cursor-pointer items-center gap-2">
              <input
                data-testid="large-paste-warning-toggle"
                type="checkbox"
                checked={convenience.largePasteWarning}
                onChange={(e) => updateConvenience({ largePasteWarning: e.target.checked })}
              />
              <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
                {convenience.largePasteWarning ? "Enabled" : "Disabled"}
              </span>
            </label>
          </div>
        </div>

        {/* Paste Image Directory */}
        <div className="mt-3 flex items-start gap-3 py-1">
          <div className="w-36 shrink-0 pt-1">
            <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
              Image Directory
            </span>
            <p
              className="mt-0.5 text-[11px] leading-tight"
              style={{ color: "var(--text-secondary)", opacity: 0.65 }}
            >
              이미지 저장 경로 (비워두면 기본 디렉터리 사용)
            </p>
          </div>
          <div className="min-w-0 flex-1">
            <FocusInput
              data-testid="paste-image-dir-input"
              className={inputCls}
              placeholder="(default: %APPDATA%\laymux\paste-images)"
              value={convenience.pasteImageDir}
              onChange={(e) => updateConvenience({ pasteImageDir: e.target.value })}
            />
          </div>
        </div>

        {/* Hover idle seconds */}
        <div className="flex items-start gap-3 py-1">
          <div className="w-36 shrink-0 pt-1">
            <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
              Hover Auto-hide
            </span>
            <p
              className="mt-0.5 text-[11px] leading-tight"
              style={{ color: "var(--text-secondary)", opacity: 0.65 }}
            >
              마우스 움직임 없을 때 컨트롤 바 숨김 대기 시간 (0 = 숨기지 않음)
            </p>
          </div>
          <div className="flex items-center gap-2">
            <FocusInput
              data-testid="hover-idle-seconds-input"
              type="number"
              min={0}
              max={30}
              step={0.5}
              className={inputCls}
              style={{ width: 70 }}
              value={convenience.hoverIdleSeconds}
              onChange={(e) =>
                updateConvenience({ hoverIdleSeconds: Math.max(0, Number(e.target.value)) })
              }
            />
            <span className="text-[11px]" style={{ color: "var(--text-secondary)" }}>
              초
            </span>
          </div>
        </div>

        {/* Default control bar mode */}
        <div className="flex items-start gap-3 py-1.5">
          <div className="w-36 shrink-0 pt-1">
            <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
              Control Bar Mode
            </span>
            <p
              className="mt-0.5 text-[11px] leading-tight"
              style={{ color: "var(--text-secondary)", opacity: 0.65 }}
            >
              새 Pane의 기본 컨트롤 바 모드
            </p>
          </div>
          <div className="min-w-0 flex-1">
            <FocusSelect
              data-testid="default-control-bar-mode-select"
              className={inputCls}
              value={convenience.defaultControlBarMode}
              onChange={(e) =>
                updateConvenience({
                  defaultControlBarMode: e.target.value as "hover" | "pinned" | "minimized",
                })
              }
            >
              <option value="minimized">Minimized (최소화, 호버 시 ⋯ 버튼)</option>
              <option value="hover">Hover (호버 시 바 표시)</option>
              <option value="pinned">Pinned (항상 고정 표시)</option>
            </FocusSelect>
          </div>
        </div>

        {/* Notification dismiss mode */}
        <div className="flex items-start gap-3 py-1.5">
          <div className="w-36 shrink-0 pt-1">
            <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
              Notification Dismiss
            </span>
            <p
              className="mt-0.5 text-[11px] leading-tight"
              style={{ color: "var(--text-secondary)", opacity: 0.65 }}
            >
              알림을 읽음 처리하는 시점
            </p>
          </div>
          <div className="min-w-0 flex-1">
            <FocusSelect
              data-testid="notification-dismiss-select"
              className={inputCls}
              value={convenience.notificationDismiss}
              onChange={(e) =>
                updateConvenience({
                  notificationDismiss: e.target.value as "workspace" | "paneFocus" | "manual",
                })
              }
            >
              <option value="workspace">워크스페이스 선택 시 자동 해제</option>
              <option value="paneFocus">Pane 포커스 시 자동 해제</option>
              <option value="manual">알림 클릭으로만 해제</option>
            </FocusSelect>
          </div>
        </div>

        {/* Path ellipsis mode */}
        <div className="flex items-start gap-3 py-1.5">
          <div className="w-36 shrink-0 pt-1">
            <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
              Path Ellipsis
            </span>
            <p
              className="mt-0.5 text-[11px] leading-tight"
              style={{ color: "var(--text-secondary)", opacity: 0.65 }}
            >
              경로가 길 때 생략 방향 (워크스페이스 목록)
            </p>
          </div>
          <div className="min-w-0 flex-1">
            <FocusSelect
              data-testid="path-ellipsis-select"
              className={inputCls}
              value={convenience.pathEllipsis}
              onChange={(e) => setConvenience({ pathEllipsis: e.target.value as "start" | "end" })}
            >
              <option value="start">앞부분 생략 (.../dir/file)</option>
              <option value="end">뒷부분 생략 (/home/user/...)</option>
            </FocusSelect>
          </div>
        </div>

        {/* Scrollbar style */}
        <div className="flex items-start gap-3 py-1.5">
          <div className="w-36 shrink-0 pt-1">
            <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
              Scrollbar Style
            </span>
            <p
              className="mt-0.5 text-[11px] leading-tight"
              style={{ color: "var(--text-secondary)", opacity: 0.65 }}
            >
              터미널 스크롤바 표시 방식. Overlay는 콘텐츠 위에 겹쳐서, Separate는 별도 공간을
              차지합니다.
            </p>
          </div>
          <div className="min-w-0 flex-1">
            <FocusSelect
              data-testid="scrollbar-style-select"
              className={inputCls}
              value={convenience.scrollbarStyle}
              onChange={(e) =>
                setConvenience({ scrollbarStyle: e.target.value as "overlay" | "separate" })
              }
            >
              <option value="overlay">Overlay (콘텐츠 위에 겹침)</option>
              <option value="separate">Separate (별도 공간 차지)</option>
            </FocusSelect>
          </div>
        </div>

        {/* Dock Persist State toggle */}
        <div className="mt-3 flex items-start gap-3 py-1">
          <div className="w-36 shrink-0 pt-1">
            <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
              Dock Persist State
            </span>
            <p
              className="mt-0.5 text-[11px] leading-tight"
              style={{ color: "var(--text-secondary)", opacity: 0.65 }}
            >
              Dock을 숨겨도 백그라운드에서 상태를 유지 (터미널 프로세스가 계속 실행됨)
            </p>
          </div>
          <div className="min-w-0 flex-1">
            <label className="flex cursor-pointer items-center gap-2">
              <input
                data-testid="dock-persist-state-toggle"
                type="checkbox"
                checked={convenience.dockPersistState}
                onChange={(e) => updateConvenience({ dockPersistState: e.target.checked })}
              />
              <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
                {convenience.dockPersistState ? "Enabled" : "Disabled"}
              </span>
            </label>
          </div>
        </div>

        {/* Dock Arrow Nav toggle */}
        <div className="mt-3 flex items-start gap-3 py-1">
          <div className="w-36 shrink-0 pt-1">
            <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
              Dock Arrow Nav
            </span>
            <p
              className="mt-0.5 text-[11px] leading-tight"
              style={{ color: "var(--text-secondary)", opacity: 0.65 }}
            >
              Alt+Arrow로 Dock 영역 진입/이탈 허용
            </p>
          </div>
          <div className="min-w-0 flex-1">
            <label className="flex cursor-pointer items-center gap-2">
              <input
                data-testid="dock-arrow-nav-toggle"
                type="checkbox"
                checked={convenience.dockArrowNav}
                onChange={(e) => updateConvenience({ dockArrowNav: e.target.checked })}
              />
              <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
                {convenience.dockArrowNav ? "Enabled" : "Disabled"}
              </span>
            </label>
          </div>
        </div>
      </div>
    </div>
  );
}

// -- Section: Workspaces --

function WorkspacesSection() {
  const storeWsDisplay = useSettingsStore((s) => s.workspaceDisplay);
  const setWsDisplay = useSettingsStore((s) => s.setWorkspaceDisplay);
  const [wsDisplay, setDraftWsDisplay] = useDraft("workspaceDisplay", storeWsDisplay, (v) =>
    setWsDisplay(v),
  );
  const updateWsDisplay = (partial: Partial<typeof wsDisplay>) =>
    setDraftWsDisplay((prev) => ({ ...prev, ...partial }));

  const displayItems: { key: keyof typeof wsDisplay; label: string; desc: string }[] = [
    { key: "minimap", label: "Minimap", desc: "Pane 위치를 나타내는 미니맵" },
    { key: "environment", label: "Environment", desc: "실행 환경 (PS, WSL 등)" },
    { key: "activity", label: "Activity", desc: "실행 프로그램 (shell, Claude 등)" },
    { key: "path", label: "Path", desc: "Git 브랜치 및 현재 경로" },
    { key: "result", label: "Result", desc: "명령 실행 결과 및 알림" },
  ];

  return (
    <div>
      <SectionTitle>Workspaces</SectionTitle>

      {/* Display */}
      <div style={cardStyle} className="p-4">
        <h3
          className="mb-3 text-[12px] font-semibold uppercase tracking-wider"
          style={{ color: "var(--text-secondary)", opacity: 0.7 }}
        >
          Display
        </h3>
        {displayItems.map((item, i) => (
          <div key={item.key} className={`flex items-start gap-3 py-1${i > 0 ? " mt-2" : ""}`}>
            <div className="w-36 shrink-0 pt-1">
              <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
                {item.label}
              </span>
              <p
                className="mt-0.5 text-[11px] leading-tight"
                style={{ color: "var(--text-secondary)", opacity: 0.65 }}
              >
                {item.desc}
              </p>
            </div>
            <div className="min-w-0 flex-1">
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  data-testid={`ws-display-${item.key}-toggle`}
                  type="checkbox"
                  checked={wsDisplay[item.key]}
                  onChange={(e) => updateWsDisplay({ [item.key]: e.target.checked })}
                />
                <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
                  {wsDisplay[item.key] ? "Enabled" : "Disabled"}
                </span>
              </label>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// -- Section: Claude Code --

const DEFAULT_STATUS_MESSAGE_DELIMITER = " · ";

function ClaudeSection() {
  const storeClaude = useSettingsStore((s) => s.claude);
  const setClaude = useSettingsStore((s) => s.setClaude);
  const [claude, setDraftClaude] = useDraft("claude", storeClaude, (v) => setClaude(v));
  const updateClaude = (partial: Partial<typeof claude>) =>
    setDraftClaude((prev) => ({ ...prev, ...partial }));

  return (
    <div>
      <SectionTitle>Claude Code</SectionTitle>

      <div style={cardStyle} className="p-4">
        {/* Sync CWD mode */}
        <div className="flex items-start gap-3 py-1.5">
          <div className="w-36 shrink-0 pt-1">
            <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
              Sync CWD
            </span>
            <p
              className="mt-0.5 text-[11px] leading-tight"
              style={{ color: "var(--text-secondary)", opacity: 0.65 }}
            >
              Claude Code 실행 중인 터미널에 cd 전파 방식
            </p>
          </div>
          <div className="min-w-0 flex-1">
            <FocusSelect
              data-testid="claude-sync-cwd-select"
              className={inputCls}
              value={claude.syncCwd}
              onChange={(e) => updateClaude({ syncCwd: e.target.value as "skip" | "command" })}
            >
              <option value="skip">Skip (전파하지 않음)</option>
              <option value="command">Command (유휴 시 ! cd 전송)</option>
            </FocusSelect>
          </div>
        </div>

        {/* Restore Session */}
        <div className="flex items-start gap-3 py-1.5">
          <div className="w-36 shrink-0 pt-1">
            <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
              세션 복원
            </span>
            <p
              className="mt-0.5 text-[11px] leading-tight"
              style={{ color: "var(--text-secondary)", opacity: 0.65 }}
            >
              앱 재시작 시 Claude Code 세션을 자동 복원
            </p>
          </div>
          <div className="min-w-0 flex-1 pt-1">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                data-testid="claude-restore-session-toggle"
                type="checkbox"
                checked={claude.restoreSession}
                onChange={(e) => updateClaude({ restoreSession: e.target.checked })}
              />
              <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
                {claude.restoreSession ? "사용" : "사용 안함"}
              </span>
            </label>
          </div>
        </div>

        {/* Session Max Age */}
        <div className="flex items-start gap-3 py-1.5">
          <div className="w-36 shrink-0 pt-1">
            <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
              세션 유효 기간
            </span>
            <p
              className="mt-0.5 text-[11px] leading-tight"
              style={{ color: "var(--text-secondary)", opacity: 0.65 }}
            >
              이 시간보다 오래된 세션 파일은 무시 (0 = 무제한)
            </p>
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <FocusInput
                data-testid="claude-session-max-age-input"
                className={inputCls}
                type="number"
                min={0}
                style={{ width: 80 }}
                value={claude.sessionMaxAgeHours}
                onChange={(e) => {
                  const parsed = parseInt(e.target.value, 10);
                  updateClaude({
                    sessionMaxAgeHours: Number.isNaN(parsed) ? 24 : Math.max(0, parsed),
                  });
                }}
              />
              <span className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
                시간
              </span>
            </div>
          </div>
        </div>

        {/* Status Message Mode */}
        <div className="flex items-start gap-3 py-1.5">
          <div className="w-36 shrink-0 pt-1">
            <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
              상태 메시지 모드
            </span>
            <p
              className="mt-0.5 text-[11px] leading-tight"
              style={{ color: "var(--text-secondary)", opacity: 0.65 }}
            >
              워크스페이스 목록에 표시할 상태 소스
            </p>
          </div>
          <div className="min-w-0 flex-1">
            <FocusSelect
              data-testid="claude-status-message-mode-select"
              className={inputCls}
              value={claude.statusMessageMode}
              onChange={(e) =>
                updateClaude({
                  statusMessageMode: e.target.value as
                    | "bullet"
                    | "title"
                    | "bullet-title"
                    | "title-bullet",
                })
              }
            >
              <option value="bullet-title">Bullet · Title (기본)</option>
              <option value="title-bullet">Title · Bullet</option>
              <option value="bullet">Bullet만</option>
              <option value="title">Title만</option>
            </FocusSelect>
          </div>
        </div>

        {/* Status Message Delimiter */}
        {(claude.statusMessageMode === "bullet-title" ||
          claude.statusMessageMode === "title-bullet") && (
          <div className="flex items-start gap-3 py-1.5">
            <div className="w-36 shrink-0 pt-1">
              <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
                구분자
              </span>
              <p
                className="mt-0.5 text-[11px] leading-tight"
                style={{ color: "var(--text-secondary)", opacity: 0.65 }}
              >
                두 소스 사이 구분 텍스트
              </p>
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <FocusInput
                  data-testid="claude-status-message-delimiter-input"
                  className={inputCls}
                  type="text"
                  style={{ width: 100 }}
                  value={claude.statusMessageDelimiter}
                  onChange={(e) => updateClaude({ statusMessageDelimiter: e.target.value })}
                />
                {claude.statusMessageDelimiter !== DEFAULT_STATUS_MESSAGE_DELIMITER && (
                  <button
                    data-testid="claude-status-message-delimiter-reset"
                    className="hover-bg px-1.5 py-0.5 rounded text-[11px]"
                    style={{ color: "var(--text-secondary)" }}
                    onClick={() =>
                      updateClaude({
                        statusMessageDelimiter: DEFAULT_STATUS_MESSAGE_DELIMITER,
                      })
                    }
                  >
                    기본값
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function CodexSection() {
  const storeCodex = useSettingsStore((s) => s.codex);
  const setCodex = useSettingsStore((s) => s.setCodex);
  const [codex, setDraftCodex] = useDraft("codex", storeCodex, (v) => setCodex(v));
  const updateCodex = (partial: Partial<typeof codex>) =>
    setDraftCodex((prev) => ({ ...prev, ...partial }));

  return (
    <div>
      <SectionTitle>Codex</SectionTitle>

      <div style={cardStyle} className="p-4">
        <SettingRow label="Cursor Blink Override">
          <label className="flex cursor-pointer items-center gap-2">
            <input
              data-testid="codex-disable-cursor-blink-toggle"
              type="checkbox"
              checked={codex.disableCursorBlink}
              onChange={(e) => updateCodex({ disableCursorBlink: e.target.checked })}
            />
            <span className="text-[12px]" style={{ color: "var(--text-secondary)" }}>
              Disable cursor blinking while Codex is active
            </span>
          </label>
        </SettingRow>

        <div className="flex items-start gap-3 py-1.5">
          <div className="w-36 shrink-0 pt-1">
            <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
              상태 메시지 모드
            </span>
            <p
              className="mt-0.5 text-[11px] leading-tight"
              style={{ color: "var(--text-secondary)", opacity: 0.65 }}
            >
              워크스페이스 목록에서 Codex 상태 텍스트 표시 방식
            </p>
          </div>
          <div className="min-w-0 flex-1">
            <FocusSelect
              data-testid="codex-status-message-mode-select"
              className={inputCls}
              value={codex.statusMessageMode}
              onChange={(e) =>
                updateCodex({
                  statusMessageMode: e.target.value as
                    | "bullet"
                    | "title"
                    | "bullet-title"
                    | "title-bullet",
                })
              }
            >
              <option value="title">Title만 (기본)</option>
              <option value="bullet-title">Bullet · Title</option>
              <option value="title-bullet">Title · Bullet</option>
              <option value="bullet">Bullet만</option>
            </FocusSelect>
          </div>
        </div>

        {(codex.statusMessageMode === "bullet-title" ||
          codex.statusMessageMode === "title-bullet") && (
          <div className="flex items-start gap-3 py-1.5">
            <div className="w-36 shrink-0 pt-1">
              <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
                구분자
              </span>
              <p
                className="mt-0.5 text-[11px] leading-tight"
                style={{ color: "var(--text-secondary)", opacity: 0.65 }}
              >
                두 텍스트 사이 구분 문자열
              </p>
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <FocusInput
                  data-testid="codex-status-message-delimiter-input"
                  className={inputCls}
                  type="text"
                  style={{ width: 100 }}
                  value={codex.statusMessageDelimiter}
                  onChange={(e) => updateCodex({ statusMessageDelimiter: e.target.value })}
                />
                {codex.statusMessageDelimiter !== DEFAULT_STATUS_MESSAGE_DELIMITER && (
                  <button
                    data-testid="codex-status-message-delimiter-reset"
                    className="hover-bg rounded px-1.5 py-0.5 text-[11px]"
                    style={{ color: "var(--text-secondary)" }}
                    onClick={() =>
                      updateCodex({
                        statusMessageDelimiter: DEFAULT_STATUS_MESSAGE_DELIMITER,
                      })
                    }
                  >
                    기본값
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// -- Section: Issue Reporter --

function FileExplorerSection() {
  const storeFileExplorer = useSettingsStore((s) => s.fileExplorer);
  const setFileExplorer = useSettingsStore((s) => s.setFileExplorer);
  const profiles = useSettingsStore((s) => s.profiles);
  const [fe, setDraftFe] = useDraft("fileExplorer", storeFileExplorer, (v) => setFileExplorer(v));
  const updateFe = (partial: Partial<FileExplorerSettings>) =>
    setDraftFe((prev) => ({ ...prev, ...partial }));

  const addViewer = () =>
    updateFe({
      extensionViewers: [...fe.extensionViewers, { extensions: [".txt"], command: "vi" }],
    });
  const removeViewer = (index: number) =>
    updateFe({ extensionViewers: fe.extensionViewers.filter((_, i) => i !== index) });
  const updateViewer = (index: number, partial: Partial<ExtensionViewer>) =>
    updateFe({
      extensionViewers: fe.extensionViewers.map((v, i) => (i === index ? { ...v, ...partial } : v)),
    });

  return (
    <div>
      <SectionTitle>File Explorer</SectionTitle>

      <div style={cardStyle} className="p-4">
        {/* Shell Profile */}
        <SettingRow
          label="Shell Profile"
          desc="CWD 동기화에 사용할 쉘 프로파일. 비우면 기본 프로파일 사용."
        >
          <FocusSelect
            data-testid="fe-shell-profile"
            className={inputCls}
            value={fe.shellProfile}
            onChange={(e) => updateFe({ shellProfile: e.target.value })}
          >
            <option value="">Default</option>
            {profiles.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
          </FocusSelect>
        </SettingRow>

        {/* Font */}
        <SettingRow label="Font Family" desc="파일 목록 영역의 폰트. 비워두면 기본 폰트 상속.">
          <FocusInput
            data-testid="fe-font-family"
            className={inputCls}
            placeholder="예: Consolas, monospace"
            value={fe.fontFamily}
            onChange={(e) => updateFe({ fontFamily: e.target.value })}
          />
        </SettingRow>

        <SettingRow label="Font Size" desc="파일 목록 영역의 폰트 크기 (px). 기본값: 13">
          <input
            data-testid="fe-font-size"
            type="number"
            min={8}
            max={32}
            className={inputCls}
            style={{ width: 60 }}
            value={fe.fontSize}
            onChange={(e) =>
              updateFe({ fontSize: Math.max(8, Math.min(32, Number(e.target.value) || 13)) })
            }
          />
        </SettingRow>

        {/* Padding */}
        <div className="flex items-start gap-3 py-1.5">
          <div className="w-36 shrink-0 pt-1">
            <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
              Padding
            </span>
            <p
              className="mt-0.5 text-[11px] leading-tight"
              style={{ color: "var(--text-secondary)", opacity: 0.65 }}
            >
              파일 목록 영역의 안쪽 여백 (px)
            </p>
          </div>
          <div className="min-w-0 flex-1">
            <div className="grid grid-cols-2 gap-2">
              {(["Top", "Right", "Bottom", "Left"] as const).map((dir) => {
                const key = `padding${dir}` as
                  | "paddingTop"
                  | "paddingRight"
                  | "paddingBottom"
                  | "paddingLeft";
                return (
                  <label key={dir} className="flex items-center gap-1.5">
                    <span className="w-12 text-[11px]" style={{ color: "var(--text-secondary)" }}>
                      {dir}
                    </span>
                    <input
                      data-testid={`fe-padding-${dir.toLowerCase()}`}
                      type="number"
                      min={0}
                      max={64}
                      className={inputCls}
                      style={{ width: 60 }}
                      value={fe[key]}
                      onChange={(e) =>
                        updateFe({
                          [key]: Math.max(0, Math.min(64, Number(e.target.value) || 0)),
                        })
                      }
                    />
                  </label>
                );
              })}
            </div>
          </div>
        </div>

        {/* Copy on Select */}
        <SettingRow label="Copy on Select" desc="파일 선택 시 자동으로 경로를 클립보드에 복사.">
          <label className="flex items-center gap-2">
            <input
              data-testid="fe-copy-on-select"
              type="checkbox"
              checked={fe.copyOnSelect}
              onChange={(e) => updateFe({ copyOnSelect: e.target.checked })}
            />
            <span className="text-[12px]" style={{ color: "var(--text-secondary)" }}>
              활성화
            </span>
          </label>
        </SettingRow>

        {/* Extension Viewers */}
        <div className="flex items-start gap-3 py-1.5">
          <div className="w-36 shrink-0 pt-1">
            <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
              Extension Viewers
            </span>
            <p
              className="mt-0.5 text-[11px] leading-tight"
              style={{ color: "var(--text-secondary)", opacity: 0.65 }}
            >
              확장자별 쉘 프로그램으로 파일 열기
            </p>
          </div>
          <div className="min-w-0 flex-1">
            {fe.extensionViewers.map((viewer, i) => (
              <div key={i} className="flex items-center gap-2 mb-2">
                <FocusInput
                  data-testid={`fe-ext-viewer-ext-${i}`}
                  className={inputCls}
                  style={{ width: 120 }}
                  placeholder=".txt,.log"
                  value={viewer.extensions.join(",")}
                  onChange={(e) =>
                    updateViewer(i, {
                      extensions: e.target.value
                        .split(",")
                        .map((s) => s.trim())
                        .filter(Boolean),
                    })
                  }
                />
                <FocusInput
                  data-testid={`fe-ext-viewer-cmd-${i}`}
                  className={inputCls}
                  style={{ width: 120 }}
                  placeholder="vi"
                  value={viewer.command}
                  onChange={(e) => updateViewer(i, { command: e.target.value })}
                />
                <button
                  data-testid={`fe-ext-viewer-remove-${i}`}
                  className="text-xs px-1.5 py-0.5 rounded"
                  style={{
                    background: "var(--bg-overlay)",
                    color: "var(--red)",
                    border: "1px solid var(--border)",
                  }}
                  onClick={() => removeViewer(i)}
                >
                  Remove
                </button>
              </div>
            ))}
            <button
              data-testid="fe-ext-viewer-add"
              className="text-xs px-2 py-1 rounded"
              style={{
                background: "var(--bg-overlay)",
                color: "var(--accent)",
                border: "1px solid var(--border)",
              }}
              onClick={addViewer}
            >
              + Add Viewer
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function IssueReporterSection() {
  const storeIssueReporter = useSettingsStore((s) => s.issueReporter);
  const setIssueReporter = useSettingsStore((s) => s.setIssueReporter);
  const appFont = useSettingsStore((s) => s.appFont);
  const monoFonts = useMonospacedFonts();
  const [issueReporter, setDraftIssueReporter] = useDraft(
    "issueReporter",
    storeIssueReporter,
    (v) => setIssueReporter(v),
  );
  const updateIssueReporter = (partial: Partial<typeof issueReporter>) =>
    setDraftIssueReporter((prev) => ({ ...prev, ...partial }));

  // Adapt flat fontFamily/fontSize/fontWeight to FontSettings for FontFields
  const irFont: FontSettings = {
    face: issueReporter.fontFamily || appFont.face,
    size: issueReporter.fontSize || appFont.size,
    weight: issueReporter.fontWeight || appFont.weight,
  };

  return (
    <div>
      <SectionTitle>Issue Reporter</SectionTitle>

      {/* Font (inherits from App Font) */}
      <FontFields
        font={irFont}
        onChange={(f) => {
          updateIssueReporter({
            fontFamily: f.face === appFont.face ? "" : f.face,
            fontSize: f.size === appFont.size ? 0 : f.size,
            fontWeight: f.weight === appFont.weight ? "" : f.weight,
          });
        }}
        defaults={appFont}
        showReset
        monoFonts={monoFonts}
        faceDesc="비워두면 앱 기본 폰트 상속"
      />

      <div style={cardStyle} className="p-4">
        <SettingRow
          label="Shell"
          desc="gh CLI를 실행할 셸 접두어. 비워두면 gh를 직접 실행. 따옴표 지원."
        >
          <FocusInput
            data-testid="issue-reporter-shell-input"
            className={inputCls}
            placeholder='예: wsl.exe -d "My Distro" --'
            value={issueReporter.shell}
            onChange={(e) => updateIssueReporter({ shell: e.target.value })}
          />
        </SettingRow>

        {/* Padding */}
        <div className="flex items-start gap-3 py-1.5">
          <div className="w-36 shrink-0 pt-1">
            <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
              Padding
            </span>
            <p
              className="mt-0.5 text-[11px] leading-tight"
              style={{ color: "var(--text-secondary)", opacity: 0.65 }}
            >
              이슈 리포터 영역의 안쪽 여백 (px)
            </p>
          </div>
          <div className="min-w-0 flex-1">
            <div className="grid grid-cols-2 gap-2">
              {(["Top", "Right", "Bottom", "Left"] as const).map((dir) => {
                const key = `padding${dir}` as keyof typeof issueReporter;
                return (
                  <label key={dir} className="flex items-center gap-1.5">
                    <span className="w-12 text-[11px]" style={{ color: "var(--text-secondary)" }}>
                      {dir}
                    </span>
                    <input
                      data-testid={`issue-reporter-padding-${dir.toLowerCase()}`}
                      type="number"
                      min={0}
                      max={64}
                      className={inputCls}
                      style={{ width: 60 }}
                      value={issueReporter[key]}
                      onChange={(e) =>
                        updateIssueReporter({
                          [key]: Math.max(0, Math.min(64, Number(e.target.value) || 0)),
                        })
                      }
                    />
                  </label>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// -- Section: Memo --

function MemoSection() {
  const storeMemo = useSettingsStore((s) => s.memo);
  const setMemo = useSettingsStore((s) => s.setMemo);
  const appFont = useSettingsStore((s) => s.appFont);
  const monoFonts = useMonospacedFonts();
  const [memo, setDraftMemo] = useDraft("memo", storeMemo, (v) => setMemo(v));
  const updateMemo = (partial: Partial<typeof memo>) =>
    setDraftMemo((prev) => ({ ...prev, ...partial }));

  // Adapt flat fontFamily/fontSize/fontWeight to FontSettings for FontFields
  const memoFont: FontSettings = {
    face: memo.fontFamily || appFont.face,
    size: memo.fontSize || appFont.size,
    weight: memo.fontWeight || appFont.weight,
  };

  return (
    <div>
      <SectionTitle>Memo</SectionTitle>

      {/* Font (inherits from App Font) */}
      <FontFields
        font={memoFont}
        onChange={(f) => {
          updateMemo({
            fontFamily: f.face === appFont.face ? "" : f.face,
            fontSize: f.size === appFont.size ? 0 : f.size,
            fontWeight: f.weight === appFont.weight ? "" : f.weight,
          });
        }}
        defaults={appFont}
        showReset
        monoFonts={monoFonts}
        faceDesc="비워두면 앱 기본 폰트 상속"
      />

      <div style={cardStyle} className="p-4">
        {/* Padding */}
        <div className="flex items-start gap-3 py-1.5">
          <div className="w-36 shrink-0 pt-1">
            <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
              Padding
            </span>
            <p
              className="mt-0.5 text-[11px] leading-tight"
              style={{ color: "var(--text-secondary)", opacity: 0.65 }}
            >
              메모 영역의 안쪽 여백 (px)
            </p>
          </div>
          <div className="min-w-0 flex-1">
            <div className="grid grid-cols-2 gap-2">
              {(["Top", "Right", "Bottom", "Left"] as const).map((dir) => {
                const key = `padding${dir}` as
                  | "paddingTop"
                  | "paddingRight"
                  | "paddingBottom"
                  | "paddingLeft";
                return (
                  <label key={dir} className="flex items-center gap-1.5">
                    <span className="w-12 text-[11px]" style={{ color: "var(--text-secondary)" }}>
                      {dir}
                    </span>
                    <input
                      data-testid={`memo-padding-${dir.toLowerCase()}`}
                      type="number"
                      min={0}
                      max={64}
                      className={inputCls}
                      style={{ width: 60 }}
                      value={memo[key]}
                      onChange={(e) =>
                        updateMemo({
                          [key]: Math.max(0, Math.min(64, Number(e.target.value) || 0)),
                        })
                      }
                    />
                  </label>
                );
              })}
            </div>
          </div>
        </div>

        {/* Paragraph Copy */}
        <div className="flex items-start gap-3 py-1.5">
          <div className="w-36 shrink-0 pt-1">
            <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
              단락 복사
            </span>
            <p
              className="mt-0.5 text-[11px] leading-tight"
              style={{ color: "var(--text-secondary)", opacity: 0.65 }}
            >
              N줄 이상 빈 줄로 구분된 단락에 복사 버튼 표시
            </p>
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1.5">
                <input
                  data-testid="memo-paragraph-copy-enabled"
                  type="checkbox"
                  checked={memo.paragraphCopy.enabled}
                  onChange={(e) =>
                    updateMemo({
                      paragraphCopy: { ...memo.paragraphCopy, enabled: e.target.checked },
                    })
                  }
                />
                <span className="text-[12px]" style={{ color: "var(--text-secondary)" }}>
                  활성화
                </span>
              </label>
              <label className="flex items-center gap-1.5">
                <span className="text-[11px]" style={{ color: "var(--text-secondary)" }}>
                  빈 줄 수
                </span>
                <input
                  data-testid="memo-paragraph-copy-min-blank-lines"
                  type="number"
                  min={1}
                  max={10}
                  className={inputCls}
                  style={{ width: 50 }}
                  value={memo.paragraphCopy.minBlankLines}
                  onChange={(e) =>
                    updateMemo({
                      paragraphCopy: {
                        ...memo.paragraphCopy,
                        minBlankLines: Math.max(1, Math.min(10, Number(e.target.value) || 1)),
                      },
                    })
                  }
                />
              </label>
            </div>
          </div>
        </div>

        {/* Double-click Paragraph Select */}
        <div className="flex items-start gap-3 py-1.5">
          <div className="w-36 shrink-0 pt-1">
            <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
              더블클릭 단락 선택
            </span>
            <p
              className="mt-0.5 text-[11px] leading-tight"
              style={{ color: "var(--text-secondary)", opacity: 0.65 }}
            >
              더블클릭 시 해당 단락 전체를 선택
            </p>
          </div>
          <div className="min-w-0 flex-1">
            <label className="flex items-center gap-1.5">
              <input
                data-testid="memo-dbl-click-paragraph-select"
                type="checkbox"
                checked={memo.dblClickParagraphSelect}
                onChange={(e) => updateMemo({ dblClickParagraphSelect: e.target.checked })}
              />
              <span className="text-[12px]" style={{ color: "var(--text-secondary)" }}>
                활성화
              </span>
            </label>
          </div>
        </div>

        {/* Copy on Select */}
        <div className="flex items-start gap-3 py-1.5">
          <div className="w-36 shrink-0 pt-1">
            <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
              선택 시 복사
            </span>
            <p
              className="mt-0.5 text-[11px] leading-tight"
              style={{ color: "var(--text-secondary)", opacity: 0.65 }}
            >
              텍스트 드래그 선택 시 자동으로 클립보드에 복사
            </p>
          </div>
          <div className="min-w-0 flex-1">
            <label className="flex items-center gap-1.5">
              <input
                data-testid="memo-copy-on-select"
                type="checkbox"
                checked={memo.copyOnSelect}
                onChange={(e) => updateMemo({ copyOnSelect: e.target.checked })}
              />
              <span className="text-[12px]" style={{ color: "var(--text-secondary)" }}>
                활성화
              </span>
            </label>
          </div>
        </div>
      </div>
    </div>
  );
}

// -- Section: Keybindings --

interface KeybindingDef {
  id: string;
  label: string;
  defaultKeys: string;
  group: string;
}

const defaultKeybindings: KeybindingDef[] = [
  // Workspace switch
  { id: "workspace.1", label: "워크스페이스 1", defaultKeys: "Ctrl+Alt+1", group: "Workspace" },
  { id: "workspace.2", label: "워크스페이스 2", defaultKeys: "Ctrl+Alt+2", group: "Workspace" },
  { id: "workspace.3", label: "워크스페이스 3", defaultKeys: "Ctrl+Alt+3", group: "Workspace" },
  { id: "workspace.4", label: "워크스페이스 4", defaultKeys: "Ctrl+Alt+4", group: "Workspace" },
  { id: "workspace.5", label: "워크스페이스 5", defaultKeys: "Ctrl+Alt+5", group: "Workspace" },
  { id: "workspace.6", label: "워크스페이스 6", defaultKeys: "Ctrl+Alt+6", group: "Workspace" },
  { id: "workspace.7", label: "워크스페이스 7", defaultKeys: "Ctrl+Alt+7", group: "Workspace" },
  { id: "workspace.8", label: "워크스페이스 8", defaultKeys: "Ctrl+Alt+8", group: "Workspace" },
  {
    id: "workspace.last",
    label: "마지막 워크스페이스",
    defaultKeys: "Ctrl+Alt+9",
    group: "Workspace",
  },
  {
    id: "workspace.next",
    label: "다음 워크스페이스",
    defaultKeys: "Ctrl+Alt+Down",
    group: "Workspace",
  },
  {
    id: "workspace.prev",
    label: "이전 워크스페이스",
    defaultKeys: "Ctrl+Alt+Up",
    group: "Workspace",
  },
  { id: "workspace.new", label: "새 워크스페이스", defaultKeys: "Ctrl+Alt+N", group: "Workspace" },
  {
    id: "workspace.duplicate",
    label: "워크스페이스 복제",
    defaultKeys: "Ctrl+Alt+D",
    group: "Workspace",
  },
  {
    id: "workspace.close",
    label: "워크스페이스 닫기",
    defaultKeys: "Ctrl+Alt+W",
    group: "Workspace",
  },
  {
    id: "workspace.rename",
    label: "워크스페이스 이름 변경",
    defaultKeys: "Ctrl+Alt+R",
    group: "Workspace",
  },
  // Pane
  { id: "pane.focus", label: "Pane 포커스 이동", defaultKeys: "Alt+Arrow", group: "Pane" },
  { id: "pane.delete", label: "Pane 제거 (편집 모드)", defaultKeys: "Delete", group: "Pane" },
  // UI
  { id: "sidebar.toggle", label: "사이드바 토글", defaultKeys: "Ctrl+Shift+B", group: "UI" },
  { id: "notifications.toggle", label: "알림 패널 토글", defaultKeys: "Ctrl+Shift+I", group: "UI" },
  {
    id: "notifications.unread",
    label: "읽지 않은 알림으로 이동",
    defaultKeys: "Ctrl+Shift+U",
    group: "UI",
  },
  {
    id: "notifications.recent",
    label: "최근 알림 Pane으로 이동",
    defaultKeys: "Ctrl+Alt+Left",
    group: "UI",
  },
  {
    id: "notifications.oldest",
    label: "오래된 알림 Pane으로 이동",
    defaultKeys: "Ctrl+Alt+Right",
    group: "UI",
  },
  { id: "settings.open", label: "설정 열기", defaultKeys: "Ctrl+,", group: "UI" },
];

const kbdStyle: React.CSSProperties = {
  background: "var(--bg-surface)",
  border: "1px solid var(--border)",
  borderBottom: "2px solid var(--border)",
  borderRadius: "var(--radius-md)",
  padding: "2px 8px",
  fontFamily: "'Consolas', monospace",
  fontSize: "var(--fs-sm)",
  color: "var(--text-primary)",
  whiteSpace: "nowrap" as const,
  display: "inline-block",
};

/** Convert a KeyboardEvent to a shortcut string like "Ctrl+Shift+K" */
function keyEventToString(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");

  const key = e.key;
  // Skip standalone modifier keys
  if (["Control", "Alt", "Shift", "Meta"].includes(key)) return parts.join("+");

  // Normalize key name
  const normalized =
    key === " "
      ? "Space"
      : key === "ArrowUp"
        ? "Up"
        : key === "ArrowDown"
          ? "Down"
          : key === "ArrowLeft"
            ? "Left"
            : key === "ArrowRight"
              ? "Right"
              : key.length === 1
                ? key.toUpperCase()
                : key;

  parts.push(normalized);
  return parts.join("+");
}

function KeybindingsSection() {
  const storeKeybindings = useSettingsStore((s) => s.keybindings);
  const setKeybindings = useSettingsStore((s) => s.setKeybindings);
  const [keybindings, setDraftKeybindings] = useDraft<Keybinding[]>(
    "keybindings",
    storeKeybindings,
    (v) => setKeybindings(v),
  );
  const [editingId, setEditingId] = useState<string | null>(null);
  const [capturedKeys, setCapturedKeys] = useState<string>("");

  const overrideMap = new Map<string, { keys: string; index: number }>();
  keybindings.forEach((kb, i) => {
    if (kb.command) overrideMap.set(kb.command, { keys: kb.keys, index: i });
  });

  const handleStartCapture = (actionId: string, defaultKeys: string) => {
    const existing = overrideMap.get(actionId);
    if (!existing) {
      setDraftKeybindings((prev) => [...prev, { keys: defaultKeys, command: actionId }]);
    }
    setCapturedKeys("");
    setEditingId(actionId);
  };

  const handleResetDefault = (actionId: string) => {
    const existing = overrideMap.get(actionId);
    if (existing) {
      setDraftKeybindings((prev) => prev.filter((_, i) => i !== existing.index));
    }
    setEditingId(null);
  };

  const customOnly = keybindings
    .map((kb, i) => ({ ...kb, index: i }))
    .filter((kb) => !defaultKeybindings.some((d) => d.id === kb.command));

  return (
    <div>
      <SectionTitle>Keybindings</SectionTitle>

      <div data-testid="default-keybindings" className="flex flex-col gap-0">
        {defaultKeybindings.map((def, idx) => {
          // Render group header when group changes
          const prevGroup = idx > 0 ? defaultKeybindings[idx - 1].group : null;
          const showGroupHeader = def.group !== prevGroup;
          const override = overrideMap.get(def.id);
          const isOverridden = !!override;
          const isEditing = editingId === def.id;
          const displayKeys = isOverridden ? override.keys : def.defaultKeys;

          return (
            <div key={def.id}>
              {showGroupHeader && (
                <div
                  className="px-3 pt-3 pb-1 text-[10px] font-medium uppercase tracking-wider"
                  style={{ color: "var(--text-secondary)", opacity: 0.5 }}
                >
                  {def.group}
                </div>
              )}
              <div
                className="flex items-center gap-3 px-3 py-1.5"
                style={{
                  background: isEditing ? "var(--accent-06)" : "transparent",
                  borderLeft: isOverridden ? "2px solid var(--accent)" : "2px solid transparent",
                }}
              >
                <span className="min-w-0 flex-1 text-xs" style={{ color: "var(--text-primary)" }}>
                  {def.label}
                </span>

                {isEditing ? (
                  <div
                    tabIndex={0}
                    autoFocus
                    onKeyDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      const str = keyEventToString(e.nativeEvent);
                      if (!str) return;
                      setCapturedKeys(str);
                      // Update the keybinding in draft
                      setDraftKeybindings((prev) =>
                        prev.map((kb) => (kb.command === def.id ? { ...kb, keys: str } : kb)),
                      );
                    }}
                    onBlur={() => setEditingId(null)}
                    className="flex items-center gap-2 rounded px-2 py-1 text-xs"
                    style={{
                      border: "1px solid var(--accent)",
                      background: "var(--bg-base)",
                      color: "var(--accent)",
                      outline: "none",
                      minWidth: 120,
                      fontFamily: "'Consolas', monospace",
                      fontSize: "var(--fs-sm)",
                    }}
                  >
                    {capturedKeys || <span style={{ opacity: 0.5 }}>Press keys...</span>}
                  </div>
                ) : (
                  <kbd
                    style={{ ...kbdStyle, cursor: "pointer" }}
                    onClick={() => handleStartCapture(def.id, def.defaultKeys)}
                    title="Click to change shortcut"
                  >
                    {displayKeys}
                  </kbd>
                )}

                <div className="w-12 shrink-0 text-right">
                  {isOverridden && !isEditing && (
                    <button
                      onClick={() => handleResetDefault(def.id)}
                      className="rounded px-1.5 py-0.5 text-[10px]"
                      style={{
                        color: "var(--text-secondary)",
                        background: "transparent",
                        border: "1px solid var(--border)",
                        cursor: "pointer",
                      }}
                      title="Reset to default"
                    >
                      Reset
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}

        {customOnly.map((kb) => (
          <div
            key={`custom-${kb.index}`}
            className="flex items-center gap-3 px-3 py-1.5"
            style={{ borderLeft: "2px solid var(--accent)" }}
          >
            <FocusInput
              type="text"
              value={kb.command}
              onChange={(e) => {
                const val = e.target.value;
                setDraftKeybindings((prev) =>
                  prev.map((k, i) => (i === kb.index ? { ...k, command: val } : k)),
                );
              }}
              placeholder="action.name"
              className="min-w-0 flex-1 rounded px-2 py-0.5 text-xs"
            />
            <kbd
              style={{ ...kbdStyle, cursor: "pointer" }}
              onClick={() => setEditingId(`custom-${kb.index}`)}
            >
              {kb.keys || "—"}
            </kbd>
            {editingId === `custom-${kb.index}` && (
              <div
                tabIndex={0}
                autoFocus
                onKeyDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const str = keyEventToString(e.nativeEvent);
                  if (str) {
                    setDraftKeybindings((prev) =>
                      prev.map((k, i) => (i === kb.index ? { ...k, keys: str } : k)),
                    );
                  }
                }}
                onBlur={() => setEditingId(null)}
                className="flex items-center gap-2 rounded px-2 py-1 text-xs"
                style={{
                  border: "1px solid var(--accent)",
                  background: "var(--bg-base)",
                  color: "var(--accent)",
                  outline: "none",
                  minWidth: 120,
                  fontFamily: "'Consolas', monospace",
                  fontSize: "var(--fs-sm)",
                }}
              >
                {kb.keys || <span style={{ opacity: 0.5 }}>Press keys...</span>}
              </div>
            )}
            <div className="w-12 shrink-0 text-right">
              <button
                data-testid={`remove-keybinding-${kb.index}`}
                onClick={() => setDraftKeybindings((prev) => prev.filter((_, i) => i !== kb.index))}
                className="text-xs"
                style={{
                  color: "var(--red)",
                  cursor: "pointer",
                  background: "transparent",
                  border: "none",
                }}
                title="Remove"
              >
                ✕
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-3">
        <button
          data-testid="add-keybinding-btn"
          onClick={() => setDraftKeybindings((prev) => [...prev, { keys: "", command: "" }])}
          className="rounded px-4 py-1.5 text-xs"
          style={{ ...inputStyle, cursor: "pointer" }}
        >
          + Add new binding
        </button>
      </div>
    </div>
  );
}

// -- Draft flush context --
// Sections register flush/reset callbacks that SettingsView invokes on Save/Discard.

type FlushFn = () => void;
interface SettingsDraftCtx {
  registerFlush: (id: string, fn: FlushFn) => void;
  registerReset: (id: string, fn: FlushFn) => void;
  markDirty: (id: string) => void;
  clearDirtyFor: (id: string) => void;
  draftValues: React.MutableRefObject<Map<string, unknown>>;
}
const defaultDraftValues = { current: new Map<string, unknown>() };
const SettingsDraftContext = createContext<SettingsDraftCtx>({
  registerFlush: () => {},
  registerReset: () => {},
  markDirty: () => {},
  clearDirtyFor: () => {},
  draftValues: defaultDraftValues,
});

/** Hook for sections to register flush/reset callbacks. */
function useSettingsDraft() {
  return useContext(SettingsDraftContext);
}

/** Hook: local draft state that flushes on Save and resets on Discard.
 *  Draft values are persisted in a shared Map so they survive section unmount/remount. */
function useDraft<T>(
  id: string,
  storeValue: T,
  storeSetter: (v: T) => void,
): [T, React.Dispatch<React.SetStateAction<T>>] {
  const { registerFlush, registerReset, markDirty, clearDirtyFor, draftValues } =
    useSettingsDraft();

  const setterRef = useRef(storeSetter);
  const storeRef = useRef(storeValue);
  useEffect(() => {
    setterRef.current = storeSetter;
    storeRef.current = storeValue;
  });

  // Restore preserved draft on remount, otherwise use store value
  const [draft, setDraft] = useState<T>(() =>
    draftValues.current.has(id) ? (draftValues.current.get(id) as T) : storeValue,
  );

  // Keep shared map in sync with local draft
  useEffect(() => {
    draftValues.current.set(id, draft);
  }, [id, draft, draftValues]);

  // #51: Sync draft when store value changes externally (e.g. settings.json hot-reload)
  // Uses JSON serialization to detect deep changes — Windows Terminal approach: full reset.
  const prevStoreJson = useRef(JSON.stringify(storeValue));
  useEffect(() => {
    const json = JSON.stringify(storeValue);
    if (json !== prevStoreJson.current) {
      prevStoreJson.current = json;
      setDraft(storeValue); // eslint-disable-line react-hooks/set-state-in-effect
      draftValues.current.set(id, storeValue);
      clearDirtyFor(id);
    }
  }, [storeValue, id, draftValues, clearDirtyFor]);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Register flush/reset once — intentionally no cleanup so callbacks survive unmount
  useEffect(() => {
    registerFlush(id, () => {
      const val = draftValues.current.get(id);
      if (val !== undefined) setterRef.current(val as T);
    });
    registerReset(id, () => {
      draftValues.current.delete(id);
      if (mountedRef.current) setDraft(storeRef.current);
    });
  }, [id, registerFlush, registerReset, draftValues]);

  /* eslint-disable react-hooks/preserve-manual-memoization */
  const wrappedSetDraft: React.Dispatch<React.SetStateAction<T>> = useCallback(
    (action) => {
      setDraft((prev) => {
        const next = typeof action === "function" ? (action as (p: T) => T)(prev) : action;
        draftValues.current.set(id, next);
        return next;
      });
      markDirty(id);
    },
    [id, markDirty, draftValues],
  );
  /* eslint-enable react-hooks/preserve-manual-memoization */

  return [draft, wrappedSetDraft];
}

// -- Main SettingsView --

export function SettingsView() {
  const profiles = useSettingsStore((s) => s.profiles);
  const addProfile = useSettingsStore((s) => s.addProfile);
  const removeProfile = useSettingsStore((s) => s.removeProfile);
  const [activeNav, setActiveNav] = useState<string>("startup");
  const settingsNavTarget = useUiStore((s) => s.settingsNavTarget);
  const setSettingsNavTarget = useUiStore((s) => s.setSettingsNavTarget);

  // External navigation via automation API
  useEffect(() => {
    if (settingsNavTarget) {
      setActiveNav(settingsNavTarget);
      setSettingsNavTarget(null);
    }
  }, [settingsNavTarget, setSettingsNavTarget]);

  const profileDefaults = useSettingsStore((s) => s.profileDefaults);

  const handleOpenSettingsJson = async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("open_settings_file");
    } catch {
      /* ignore — not available outside Tauri */
    }
  };

  const handleAddProfile = () => {
    addProfile(makeProfileFromDefaults(`Profile ${profiles.length + 1}`, "", profileDefaults));
  };

  const [saveLabel, setSaveLabel] = useState("Save");
  const [navHover, setNavHover] = useState<string | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Draft flush/reset registry — sections register callbacks invoked on Save/Discard
  const flushMapRef = useRef<Map<string, FlushFn>>(new Map());
  const resetMapRef = useRef<Map<string, FlushFn>>(new Map());
  const draftValuesRef = useRef<Map<string, unknown>>(new Map());
  const dirtySetRef = useRef<Set<string>>(new Set());
  const [dirty, setDirty] = useState(false);
  const registerFlush = useCallback((id: string, fn: FlushFn) => {
    flushMapRef.current.set(id, fn);
  }, []);
  const registerReset = useCallback((id: string, fn: FlushFn) => {
    resetMapRef.current.set(id, fn);
  }, []);
  const markDirty = useCallback((id: string) => {
    dirtySetRef.current.add(id);
    setDirty(true);
  }, []);
  const clearDirtyFor = useCallback((id: string) => {
    dirtySetRef.current.delete(id);
    setDirty(dirtySetRef.current.size > 0);
  }, []);
  const draftCtx = useRef<SettingsDraftCtx>({
    registerFlush,
    registerReset,
    markDirty,
    clearDirtyFor,
    draftValues: draftValuesRef,
  }).current;

  const handleSave = () => {
    // Flush all draft states to store first
    for (const fn of flushMapRef.current.values()) fn();
    draftValuesRef.current.clear();
    dirtySetRef.current.clear();
    setDirty(false);
    clearTimeout(saveTimerRef.current);
    persistSession()
      .then(() => {
        setSaveLabel("Saved!");
        saveTimerRef.current = setTimeout(() => setSaveLabel("Save"), 1500);
      })
      .catch(() => {
        setSaveLabel("Error!");
        saveTimerRef.current = setTimeout(() => setSaveLabel("Save"), 2000);
      });
  };

  const handleDiscard = () => {
    for (const fn of resetMapRef.current.values()) fn();
    draftValuesRef.current.clear();
    dirtySetRef.current.clear();
    setDirty(false);
  };

  const navBtnStyle = (id: string): React.CSSProperties => {
    const isActive = activeNav === id;
    const isHover = navHover === id;
    return {
      background: isActive
        ? "var(--bg-overlay)"
        : isHover
          ? "var(--hover-bg-subtle)"
          : "transparent",
      color: isActive ? "var(--accent)" : "var(--text-primary)",
      borderLeft: isActive ? "3px solid var(--accent)" : "3px solid transparent",
      cursor: "pointer",
      transition: "all 0.1s",
    };
  };

  return (
    <SettingsDraftContext.Provider value={draftCtx}>
      <div
        data-testid="settings-view"
        className="flex h-full"
        style={{ color: "var(--text-primary)" }}
      >
        {/* Sidebar Navigation */}
        <nav
          className="flex h-full w-40 shrink-0 flex-col overflow-y-auto py-3"
          style={{
            background: "var(--bg-surface)",
            borderRight: "1px solid var(--border)",
          }}
        >
          {/* Open JSON — Windows Terminal style top-right link */}
          <button
            data-testid="sidebar-open-json"
            onClick={handleOpenSettingsJson}
            className="mx-3 mb-2 px-2 py-1 text-left text-[10px]"
            style={{
              color: "var(--text-secondary)",
              background: "transparent",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-md)",
              cursor: "pointer",
              opacity: 0.7,
            }}
            title="Open settings.json"
          >
            settings.json
          </button>

          {/* General settings */}
          <button
            className="w-full px-4 py-2 text-left text-[13px]"
            style={navBtnStyle("startup")}
            onClick={() => setActiveNav("startup")}
            onMouseEnter={() => setNavHover("startup")}
            onMouseLeave={() => setNavHover(null)}
          >
            Startup
          </button>
          <button
            data-testid="nav-font"
            className="w-full px-4 py-2 text-left text-[13px]"
            style={navBtnStyle("font")}
            onClick={() => setActiveNav("font")}
            onMouseEnter={() => setNavHover("font")}
            onMouseLeave={() => setNavHover(null)}
          >
            Font
          </button>
          <button
            className="w-full px-4 py-2 text-left text-[13px]"
            style={navBtnStyle("colorSchemes")}
            onClick={() => setActiveNav("colorSchemes")}
            onMouseEnter={() => setNavHover("colorSchemes")}
            onMouseLeave={() => setNavHover(null)}
          >
            Color Schemes
          </button>
          <button
            className="w-full px-4 py-2 text-left text-[13px]"
            style={navBtnStyle("keybindings")}
            onClick={() => setActiveNav("keybindings")}
            onMouseEnter={() => setNavHover("keybindings")}
            onMouseLeave={() => setNavHover(null)}
          >
            Keybindings
          </button>
          <button
            data-testid="nav-convenience"
            className="w-full px-4 py-2 text-left text-[13px]"
            style={navBtnStyle("convenience")}
            onClick={() => setActiveNav("convenience")}
            onMouseEnter={() => setNavHover("convenience")}
            onMouseLeave={() => setNavHover(null)}
          >
            Convenience
          </button>
          <button
            data-testid="nav-workspaceDisplay"
            className="w-full px-4 py-2 text-left text-[13px]"
            style={navBtnStyle("workspaceDisplay")}
            onClick={() => setActiveNav("workspaceDisplay")}
            onMouseEnter={() => setNavHover("workspaceDisplay")}
            onMouseLeave={() => setNavHover(null)}
          >
            Workspaces
          </button>
          <button
            data-testid="nav-claude"
            className="w-full px-4 py-2 text-left text-[13px]"
            style={navBtnStyle("claude")}
            onClick={() => setActiveNav("claude")}
            onMouseEnter={() => setNavHover("claude")}
            onMouseLeave={() => setNavHover(null)}
          >
            Claude Code
          </button>
          <button
            data-testid="nav-codex"
            className="w-full px-4 py-2 text-left text-[13px]"
            style={navBtnStyle("codex")}
            onClick={() => setActiveNav("codex")}
            onMouseEnter={() => setNavHover("codex")}
            onMouseLeave={() => setNavHover(null)}
          >
            Codex
          </button>
          <button
            data-testid="nav-memo"
            className="w-full px-4 py-2 text-left text-[13px]"
            style={navBtnStyle("memo")}
            onClick={() => setActiveNav("memo")}
            onMouseEnter={() => setNavHover("memo")}
            onMouseLeave={() => setNavHover(null)}
          >
            Memo
          </button>
          <button
            data-testid="nav-fileExplorer"
            className="w-full px-4 py-2 text-left text-[13px]"
            style={navBtnStyle("fileExplorer")}
            onClick={() => setActiveNav("fileExplorer")}
            onMouseEnter={() => setNavHover("fileExplorer")}
            onMouseLeave={() => setNavHover(null)}
          >
            File Explorer
          </button>
          <button
            data-testid="nav-issueReporter"
            className="w-full px-4 py-2 text-left text-[13px]"
            style={navBtnStyle("issueReporter")}
            onClick={() => setActiveNav("issueReporter")}
            onMouseEnter={() => setNavHover("issueReporter")}
            onMouseLeave={() => setNavHover(null)}
          >
            Issue Reporter
          </button>

          {/* Profiles group */}
          <div className="mt-3 flex items-center justify-between px-3 pb-1">
            <span
              className="text-[10px] uppercase tracking-wider"
              style={{ color: "var(--text-secondary)", opacity: 0.7 }}
            >
              Profiles
            </span>
            <button
              data-testid="add-profile-btn"
              onClick={handleAddProfile}
              className="text-xs"
              style={{
                color: "var(--accent)",
                background: "transparent",
                border: "none",
                cursor: "pointer",
              }}
            >
              +
            </button>
          </div>

          <button
            data-testid="nav-profile-defaults"
            className="w-full px-4 py-2 text-left text-[13px] italic"
            style={navBtnStyle("defaults")}
            onClick={() => setActiveNav("defaults")}
            onMouseEnter={() => setNavHover("defaults")}
            onMouseLeave={() => setNavHover(null)}
          >
            Defaults
          </button>

          {profiles.map((p, i) => {
            const id = `profile-${i}`;
            return (
              <div key={id} className="group flex items-center">
                <button
                  className="min-w-0 flex-1 truncate px-4 py-2 text-left text-[13px]"
                  style={navBtnStyle(id)}
                  onClick={() => setActiveNav(id)}
                  onMouseEnter={() => setNavHover(id)}
                  onMouseLeave={() => setNavHover(null)}
                >
                  {p.name}
                </button>
                <button
                  data-testid={`remove-profile-${i}`}
                  onClick={() => {
                    removeProfile(i);
                    setActiveNav("startup");
                  }}
                  className="mr-2 hidden text-xs opacity-50 hover:opacity-100 group-hover:inline"
                  style={{
                    color: "var(--red)",
                    background: "transparent",
                    border: "none",
                    cursor: "pointer",
                  }}
                  title="Delete profile"
                >
                  ✕
                </button>
              </div>
            );
          })}

          <div className="mt-auto" />
        </nav>

        {/* Content Area */}
        <div
          className="relative min-w-0 flex-1 overflow-y-auto"
          style={{ background: "var(--bg-base)" }}
        >
          <div className="p-4 pb-14" style={{ maxWidth: 720 }}>
            {activeNav === "startup" && <StartupSection />}
            {activeNav === "font" && <FontSection />}
            {activeNav === "defaults" && <DefaultsSection />}
            {activeNav.startsWith("profile-") && (
              <ProfileSection key={activeNav} profileIndex={parseInt(activeNav.split("-")[1])} />
            )}
            {activeNav === "colorSchemes" && <ColorSchemesSection />}
            {activeNav === "keybindings" && <KeybindingsSection />}
            {activeNav === "convenience" && <ConvenienceSection />}
            {activeNav === "workspaceDisplay" && <WorkspacesSection />}
            {activeNav === "claude" && <ClaudeSection />}
            {activeNav === "codex" && <CodexSection />}
            {activeNav === "memo" && <MemoSection />}
            {activeNav === "fileExplorer" && <FileExplorerSection />}
            {activeNav === "issueReporter" && <IssueReporterSection />}
          </div>

          {/* Sticky save bar — always visible at bottom */}
          <div
            className="sticky bottom-0 flex items-center justify-end gap-2 px-4 py-3"
            style={{ background: "var(--bg-surface)", borderTop: "1px solid var(--border)" }}
          >
            <button
              data-testid="discard-settings-btn"
              onClick={handleDiscard}
              disabled={!dirty}
              className="px-5 py-2 text-[13px] font-medium"
              style={{
                background: "transparent",
                color: "var(--text-secondary)",
                border: "1px solid var(--border)",
                cursor: dirty ? "pointer" : "default",
                transition: "all 0.15s",
                borderRadius: "var(--radius-md)",
                opacity: dirty ? 1 : 0.4,
              }}
            >
              Discard changes
            </button>
            <button
              data-testid="save-settings-btn"
              onClick={handleSave}
              disabled={!dirty}
              className="px-8 py-2 text-[13px] font-medium"
              style={{
                background:
                  saveLabel === "Saved!"
                    ? "var(--green)"
                    : saveLabel === "Error!"
                      ? "var(--red)"
                      : "var(--accent)",
                color: "var(--bg-base)",
                border: "none",
                cursor: dirty ? "pointer" : "default",
                transition: "all 0.15s",
                borderRadius: "var(--radius-md)",
                opacity: dirty ? 1 : 0.4,
              }}
            >
              {saveLabel}
            </button>
          </div>
        </div>
      </div>
    </SettingsDraftContext.Provider>
  );
}
