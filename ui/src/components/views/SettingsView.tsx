import { useState, useRef, useEffect, createContext, useContext, useCallback } from "react";
import { useUiStore } from "@/stores/ui-store";
import {
  useSettingsStore,
  makeDefaultColorScheme,
  makeProfileFromDefaults,
  builtinAppThemes,
  type FontSettings,
  type Profile,
  type ProfileDefaults,
  type CursorShape,
  type BellStyle,
  type CloseOnExit,
  type AntialiasingMode,
} from "@/stores/settings-store";
import { persistSession } from "@/lib/persist-session";
import { MONOSPACED_FONTS, getSystemMonospaceFonts } from "@/lib/system-fonts";

// -- Shared styles --
const inputCls = "w-full rounded px-2 py-1.5 text-[13px]";
const inputStyle: React.CSSProperties = {
  border: "1px solid var(--border)",
  background: "var(--bg-base)",
  color: "var(--text-primary)",
  outline: "none",
  transition: "border-color 0.15s",
  colorScheme: "dark",
};
const inputFocusStyle: React.CSSProperties = {
  ...inputStyle,
  border: "1px solid var(--accent)",
};
const cardStyle: React.CSSProperties = {
  background: "var(--bg-overlay)",
  borderRadius: "6px",
  border: "1px solid var(--border)",
};

// -- Sub-components --

function SettingRow({ label, desc, children }: { label: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-1.5">
      <div className="w-36 shrink-0 pt-1">
        <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>{label}</span>
        {desc && (
          <p className="mt-0.5 text-[11px] leading-tight" style={{ color: "var(--text-secondary)", opacity: 0.65 }}>
            {desc}
          </p>
        )}
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** Input wrapper that adds focus ring */
function FocusInput(props: React.InputHTMLAttributes<HTMLInputElement> & { inputStyle?: React.CSSProperties }) {
  const [focused, setFocused] = useState(false);
  const { inputStyle: customStyle, ...rest } = props;
  return (
    <input
      {...rest}
      style={focused ? { ...inputFocusStyle, ...customStyle } : { ...inputStyle, ...customStyle }}
      onFocus={(e) => { setFocused(true); props.onFocus?.(e); }}
      onBlur={(e) => { setFocused(false); props.onBlur?.(e); }}
    />
  );
}

function FocusSelect(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  const [focused, setFocused] = useState(false);
  return (
    <select
      {...props}
      style={focused ? inputFocusStyle : inputStyle}
      onFocus={(e) => { setFocused(true); props.onFocus?.(e); }}
      onBlur={(e) => { setFocused(false); props.onBlur?.(e); }}
    />
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
  "thin", "extra-light", "light", "semi-light", "normal",
  "medium", "semi-bold", "bold", "extra-bold", "black", "extra-black",
];

/** Hook to detect installed monospace fonts via system enumeration + canvas check. */
function useMonospacedFonts() {
  const [installed, setInstalled] = useState<string[]>(MONOSPACED_FONTS);
  useEffect(() => {
    let cancelled = false;
    getSystemMonospaceFonts().then((fonts) => {
      if (!cancelled) setInstalled(fonts);
    });
    return () => { cancelled = true; };
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
  const [draftAppTheme, setDraftAppTheme] = useDraft("startup-appTheme", storeAppThemeId, setAppTheme);
  const [draftDefaultProfile, setDraftDefaultProfile] = useDraft("startup-defaultProfile", storeDefaultProfile, setDefaultProfile);

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
              <p className="mt-0.5 text-[11px]" style={{ color: "var(--text-secondary)", opacity: 0.6 }}>
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
                <option key={t.id} value={t.id}>{t.name}</option>
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
              <p className="mt-0.5 text-[11px]" style={{ color: "var(--text-secondary)", opacity: 0.6 }}>
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

function FontFields({
  font,
  onChange,
  defaults,
  showReset,
  monoFonts,
}: {
  font: FontSettings;
  onChange: (font: FontSettings) => void;
  defaults?: FontSettings;
  showReset?: boolean;
  monoFonts: string[];
}) {
  const isDefault = defaults && JSON.stringify(font) === JSON.stringify(defaults);
  const resetBtn = showReset && defaults && !isDefault ? (
    <button
      onClick={() => onChange({ ...defaults })}
      className="ml-1 shrink-0 rounded px-1.5 py-0.5 text-[9px]"
      style={{ color: "var(--accent)", background: "rgba(137,180,250,0.1)", border: "none", cursor: "pointer" }}
      title="Reset to default"
    >
      Reset
    </button>
  ) : null;

  return (
    <div style={cardStyle} className="mb-3">
      <div className="px-4 py-2">
        <div className="flex items-center gap-2 mb-2">
          <h4 className="text-xs font-semibold" style={{ color: "var(--text-primary)" }}>Font</h4>
          {resetBtn}
        </div>
        <SettingRow label="Font Face" desc="Monospaced font for terminals">
          <FocusSelect
            data-testid="font-face-input"
            value={font.face}
            onChange={(e) => onChange({ ...font, face: e.target.value })}
            className={inputCls}
          >
            {!monoFonts.includes(font.face) && (
              <option value={font.face}>{font.face}</option>
            )}
            {monoFonts.map((f) => (
              <option key={f} value={f}>{f}</option>
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
  data: Pick<Profile, "colorScheme" | "cursorShape" | "opacity" | "padding">;
  onChange: (d: Partial<Profile>) => void;
  colorSchemes: { name: string }[];
  defaults?: ProfileDefaults;
  showReset?: boolean;
}) {
  const isDefault = (key: keyof ProfileDefaults) =>
    defaults && JSON.stringify(data[key as keyof typeof data]) === JSON.stringify(defaults[key]);
  const resetBtn = (key: keyof ProfileDefaults) =>
    showReset && defaults && !isDefault(key) ? (
      <button
        onClick={() => onChange({ [key]: key === "padding" ? { ...defaults.padding } : defaults[key] })}
        className="ml-1 shrink-0 rounded px-1.5 py-0.5 text-[9px]"
        style={{ color: "var(--accent)", background: "rgba(137,180,250,0.1)", border: "none", cursor: "pointer" }}
        title="Reset to default"
      >
        Reset
      </button>
    ) : null;

  return (
    <>
      <div style={cardStyle} className="mb-3">
        <div className="px-4 py-2">
          <h4 className="mb-2 text-xs font-semibold" style={{ color: "var(--text-primary)" }}>Appearance</h4>
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
                  <option key={cs.name} value={cs.name}>{cs.name}</option>
                ))}
              </select>
              {resetBtn("colorScheme")}
            </div>
          </SettingRow>
          <SettingRow label="Cursor Shape">
            <div className="flex items-center">
              <select
                data-testid="cursor-shape-select"
                value={data.cursorShape}
                onChange={(e) => onChange({ cursorShape: e.target.value as CursorShape })}
                className={inputCls}
                style={inputStyle}
              >
                <option value="bar">Bar |</option>
                <option value="underscore">Underscore _</option>
                <option value="filledBox">Filled Box &#9608;</option>
                <option value="emptyBox">Empty Box &#9744;</option>
                <option value="doubleUnderscore">Double Underscore &#818;&#818;</option>
                <option value="vintage">Vintage (bottom 25%)</option>
              </select>
              {resetBtn("cursorShape")}
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
            <h4 className="text-xs font-semibold" style={{ color: "var(--text-primary)" }}>Padding</h4>
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
  data: Pick<Profile, "scrollbackLines" | "bellStyle" | "closeOnExit" | "antialiasingMode" | "suppressApplicationTitle" | "snapOnInput">;
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
        style={{ color: "var(--accent)", background: "rgba(137,180,250,0.1)", border: "none", cursor: "pointer" }}
        title="Reset to default"
      >
        Reset
      </button>
    ) : null;

  return (
    <div style={cardStyle}>
      <div className="px-4 py-2">
        <h4 className="mb-2 text-xs font-semibold" style={{ color: "var(--text-primary)" }}>Advanced</h4>
        <SettingRow label="Scrollback Lines" desc="Number of lines stored in history">
          <div className="flex items-center">
            <input
              type="number"
              value={data.scrollbackLines}
              onChange={(e) => onChange({ scrollbackLines: Math.max(0, parseInt(e.target.value) || 0) })}
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
      </div>
    </div>
  );
}

// -- Section: Profile Defaults --

const fallbackDefaults: ProfileDefaults = {
  colorScheme: "",
  cursorShape: "bar",
  padding: { top: 8, right: 8, bottom: 8, left: 8 },
  scrollbackLines: 9001,
  opacity: 100,
  bellStyle: "audible",
  closeOnExit: "automatic",
  antialiasingMode: "grayscale",
  suppressApplicationTitle: false,
  snapOnInput: true,
  font: { face: "Cascadia Mono", size: 14, weight: "normal" },
};

function DefaultsSection() {
  const rawDefaults = useSettingsStore((s) => s.profileDefaults);
  const storeDefaults = rawDefaults ?? fallbackDefaults;
  const setProfileDefaults = useSettingsStore((s) => s.setProfileDefaults);
  const colorSchemes = useSettingsStore((s) => s.colorSchemes);
  const monoFonts = useMonospacedFonts();
  const [draftDefaults, setDraftDefaults] = useDraft(
    "profileDefaults",
    storeDefaults,
    (v) => setProfileDefaults(v as Partial<ProfileDefaults>),
  );
  const updateDefaults = (partial: Partial<ProfileDefaults>) =>
    setDraftDefaults(prev => ({ ...prev, ...partial }));

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

      <AdvancedFields
        data={draftDefaults}
        onChange={updateDefaults}
      />
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

  const [profile, setDraftProfile] = useDraft(
    `profile-${profileIndex}`,
    storeProfile,
    (v) => { if (v) updateProfile(profileIndex, v as Partial<Profile>); },
  );

  if (!profile) return null;

  const update = (data: Partial<Profile>) => setDraftProfile(prev => prev ? { ...prev, ...data } : prev);

  return (
    <div>
      <SectionTitle>{profile.name}</SectionTitle>

      {/* Sub-tab bar */}
      <div
        data-testid="profile-tabs"
        className="mb-4 flex gap-0"
        style={{ borderBottom: "1px solid var(--border)" }}
      >
        {([
          ["general", "General"],
          ["additional", "Additional Settings"],
        ] as const).map(([tab, label]) => (
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
          <AdvancedFields
            data={profile}
            onChange={update}
            defaults={profileDefaults}
            showReset
          />
        </>
      )}
    </div>
  );
}

// -- Section: Color Schemes --

function ColorSchemesSection() {
  const colorSchemes = useSettingsStore((s) => s.colorSchemes);
  const addColorScheme = useSettingsStore((s) => s.addColorScheme);
  const removeColorScheme = useSettingsStore((s) => s.removeColorScheme);
  const updateColorScheme = useSettingsStore((s) => s.updateColorScheme);
  const [selectedIdx, setSelectedIdx] = useState(0);

  const scheme = colorSchemes[selectedIdx];

  const handleAdd = () => {
    const cs = makeDefaultColorScheme();
    cs.name = `Scheme ${colorSchemes.length + 1}`;
    addColorScheme(cs);
    setSelectedIdx(colorSchemes.length);
  };

  const handleRemove = () => {
    if (!scheme) return;
    removeColorScheme(selectedIdx);
    setSelectedIdx(Math.max(0, selectedIdx - 1));
  };

  const updateField = (field: string, value: string) => {
    if (scheme) updateColorScheme(selectedIdx, { [field]: value });
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
          {colorSchemes.length === 0 && <option value="" disabled>No schemes</option>}
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
                <ColorSwatch color={scheme.foreground} label="Fg" onChange={(v) => updateField("foreground", v)} />
                <ColorSwatch color={scheme.background} label="Bg" onChange={(v) => updateField("background", v)} />
                <ColorSwatch color={scheme.cursorColor} label="Cursor" onChange={(v) => updateField("cursorColor", v)} />
                <ColorSwatch color={scheme.selectionBackground} label="Select" onChange={(v) => updateField("selectionBackground", v)} />
              </div>

              <h4 className="mb-2 mt-4 text-xs font-semibold" style={{ color: "var(--text-primary)" }}>
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
  const [convenience, setDraftConvenience] = useDraft("convenience", storeConvenience, (v) => setConvenience(v));
  const updateConvenience = (partial: Partial<typeof convenience>) => setDraftConvenience(prev => ({ ...prev, ...partial }));

  return (
    <div>
      <SectionTitle>Convenience</SectionTitle>

      <div style={cardStyle} className="p-4">
        {/* Smart Paste toggle */}
        <div className="flex items-start gap-3 py-1">
          <div className="w-36 shrink-0 pt-1">
            <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>Smart Paste</span>
            <p className="mt-0.5 text-[11px] leading-tight" style={{ color: "var(--text-secondary)", opacity: 0.65 }}>
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

        {/* Copy On Select toggle */}
        <div className="mt-3 flex items-start gap-3 py-1">
          <div className="w-36 shrink-0 pt-1">
            <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>Copy On Select</span>
            <p className="mt-0.5 text-[11px] leading-tight" style={{ color: "var(--text-secondary)", opacity: 0.65 }}>
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

        {/* Paste Image Directory */}
        <div className="mt-3 flex items-start gap-3 py-1">
          <div className="w-36 shrink-0 pt-1">
            <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>Image Directory</span>
            <p className="mt-0.5 text-[11px] leading-tight" style={{ color: "var(--text-secondary)", opacity: 0.65 }}>
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
            <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>Hover Auto-hide</span>
            <p className="mt-0.5 text-[11px] leading-tight" style={{ color: "var(--text-secondary)", opacity: 0.65 }}>
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
              onChange={(e) => updateConvenience({ hoverIdleSeconds: Math.max(0, Number(e.target.value)) })}
            />
            <span className="text-[11px]" style={{ color: "var(--text-secondary)" }}>초</span>
          </div>
        </div>

        {/* Notification dismiss mode */}
        <div className="flex items-start gap-3 py-1.5">
          <div className="w-36 shrink-0 pt-1">
            <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>Notification Dismiss</span>
            <p className="mt-0.5 text-[11px] leading-tight" style={{ color: "var(--text-secondary)", opacity: 0.65 }}>
              알림을 읽음 처리하는 시점
            </p>
          </div>
          <div className="min-w-0 flex-1">
            <FocusSelect
              data-testid="notification-dismiss-select"
              className={inputCls}
              value={convenience.notificationDismiss}
              onChange={(e) => updateConvenience({ notificationDismiss: e.target.value as "workspace" | "paneFocus" | "manual" })}
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
            <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>Path Ellipsis</span>
            <p className="mt-0.5 text-[11px] leading-tight" style={{ color: "var(--text-secondary)", opacity: 0.65 }}>
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
            <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>Scrollbar Style</span>
            <p className="mt-0.5 text-[11px] leading-tight" style={{ color: "var(--text-secondary)", opacity: 0.65 }}>
              터미널 스크롤바 표시 방식. Overlay는 콘텐츠 위에 겹쳐서, Separate는 별도 공간을 차지합니다.
            </p>
          </div>
          <div className="min-w-0 flex-1">
            <FocusSelect
              data-testid="scrollbar-style-select"
              className={inputCls}
              value={convenience.scrollbarStyle}
              onChange={(e) => setConvenience({ scrollbarStyle: e.target.value as "overlay" | "separate" })}
            >
              <option value="overlay">Overlay (콘텐츠 위에 겹침)</option>
              <option value="separate">Separate (별도 공간 차지)</option>
            </FocusSelect>
          </div>
        </div>
      </div>

      {/* Workspace Display toggles */}
      <div style={cardStyle} className="mt-4 p-4">
        <p className="mb-2 text-[13px] font-medium" style={{ color: "var(--text-primary)" }}>
          Workspace Display
        </p>
        <p className="mb-3 text-[11px] leading-tight" style={{ color: "var(--text-secondary)", opacity: 0.65 }}>
          워크스페이스 목록에서 각 pane 요약에 표시할 항목을 선택합니다.
        </p>
        {([
          { key: "minimap" as const, label: "Minimap", desc: "Pane 위치 미니맵" },
          { key: "profile" as const, label: "Profile", desc: "실행 환경 (WSL, PS, ...)" },
          { key: "activity" as const, label: "Activity", desc: "실행 프로그램 (Claude, shell, ...)" },
          { key: "path" as const, label: "Path", desc: "작업 디렉터리 경로" },
          { key: "commandStatus" as const, label: "Command Status", desc: "마지막 명령 결과" },
        ]).map(({ key, label, desc }) => (
          <div key={key} className="flex items-center gap-2 py-1">
            <label className="flex cursor-pointer items-center gap-2">
              <input
                data-testid={`ws-display-${key}`}
                type="checkbox"
                checked={convenience.workspaceDisplay?.[key] ?? true}
                onChange={(e) => {
                  const current = convenience.workspaceDisplay ?? { minimap: true, profile: true, activity: true, path: true, commandStatus: true };
                  updateConvenience({
                    workspaceDisplay: { ...current, [key]: e.target.checked },
                  });
                }}
              />
              <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>{label}</span>
              <span className="text-[11px]" style={{ color: "var(--text-secondary)", opacity: 0.65 }}>{desc}</span>
            </label>
          </div>
        ))}
      </div>
    </div>
  );
}

// -- Section: Claude Code --

function ClaudeSection() {
  const storeClaude = useSettingsStore((s) => s.claude);
  const setClaude = useSettingsStore((s) => s.setClaude);
  const [claude, setDraftClaude] = useDraft("claude", storeClaude, (v) => setClaude(v));
  const updateClaude = (partial: Partial<typeof claude>) => setDraftClaude(prev => ({ ...prev, ...partial }));

  return (
    <div>
      <SectionTitle>Claude Code</SectionTitle>

      <div style={cardStyle} className="p-4">
        {/* Sync CWD mode */}
        <div className="flex items-start gap-3 py-1.5">
          <div className="w-36 shrink-0 pt-1">
            <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>Sync CWD</span>
            <p className="mt-0.5 text-[11px] leading-tight" style={{ color: "var(--text-secondary)", opacity: 0.65 }}>
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
  { id: "workspace.1",          label: "워크스페이스 1",            defaultKeys: "Ctrl+Alt+1",     group: "Workspace" },
  { id: "workspace.2",          label: "워크스페이스 2",            defaultKeys: "Ctrl+Alt+2",     group: "Workspace" },
  { id: "workspace.3",          label: "워크스페이스 3",            defaultKeys: "Ctrl+Alt+3",     group: "Workspace" },
  { id: "workspace.4",          label: "워크스페이스 4",            defaultKeys: "Ctrl+Alt+4",     group: "Workspace" },
  { id: "workspace.5",          label: "워크스페이스 5",            defaultKeys: "Ctrl+Alt+5",     group: "Workspace" },
  { id: "workspace.6",          label: "워크스페이스 6",            defaultKeys: "Ctrl+Alt+6",     group: "Workspace" },
  { id: "workspace.7",          label: "워크스페이스 7",            defaultKeys: "Ctrl+Alt+7",     group: "Workspace" },
  { id: "workspace.8",          label: "워크스페이스 8",            defaultKeys: "Ctrl+Alt+8",     group: "Workspace" },
  { id: "workspace.last",       label: "마지막 워크스페이스",       defaultKeys: "Ctrl+Alt+9",     group: "Workspace" },
  { id: "workspace.next",       label: "다음 워크스페이스",         defaultKeys: "Ctrl+Alt+Down",  group: "Workspace" },
  { id: "workspace.prev",       label: "이전 워크스페이스",         defaultKeys: "Ctrl+Alt+Up",    group: "Workspace" },
  { id: "workspace.new",        label: "새 워크스페이스",           defaultKeys: "Ctrl+Alt+N",     group: "Workspace" },
  { id: "workspace.duplicate",   label: "워크스페이스 복제",         defaultKeys: "Ctrl+Alt+D",     group: "Workspace" },
  { id: "workspace.close",      label: "워크스페이스 닫기",         defaultKeys: "Ctrl+Alt+W",     group: "Workspace" },
  { id: "workspace.rename",     label: "워크스페이스 이름 변경",     defaultKeys: "Ctrl+Alt+R",     group: "Workspace" },
  // Pane
  { id: "pane.focus",           label: "Pane 포커스 이동",          defaultKeys: "Alt+Arrow",      group: "Pane" },
  { id: "pane.delete",          label: "Pane 제거 (편집 모드)",     defaultKeys: "Delete",         group: "Pane" },
  // UI
  { id: "sidebar.toggle",       label: "사이드바 토글",             defaultKeys: "Ctrl+Shift+B",   group: "UI" },
  { id: "notifications.toggle", label: "알림 패널 토글",            defaultKeys: "Ctrl+Shift+I",   group: "UI" },
  { id: "notifications.unread", label: "읽지 않은 알림으로 이동",    defaultKeys: "Ctrl+Shift+U",   group: "UI" },
  { id: "notifications.recent", label: "최근 알림 Pane으로 이동",   defaultKeys: "Ctrl+Alt+Left",  group: "UI" },
  { id: "notifications.oldest", label: "오래된 알림 Pane으로 이동",  defaultKeys: "Ctrl+Alt+Right", group: "UI" },
  { id: "settings.open",        label: "설정 열기",                 defaultKeys: "Ctrl+,",         group: "UI" },
];

const kbdStyle: React.CSSProperties = {
  background: "var(--bg-surface)",
  border: "1px solid var(--border)",
  borderBottom: "2px solid var(--border)",
  borderRadius: 3,
  padding: "2px 8px",
  fontFamily: "'Consolas', monospace",
  fontSize: 11,
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
    key === " " ? "Space" :
    key === "ArrowUp" ? "Up" :
    key === "ArrowDown" ? "Down" :
    key === "ArrowLeft" ? "Left" :
    key === "ArrowRight" ? "Right" :
    key.length === 1 ? key.toUpperCase() :
    key;

  parts.push(normalized);
  return parts.join("+");
}

function KeybindingsSection() {
  const keybindings = useSettingsStore((s) => s.keybindings);
  const addKeybinding = useSettingsStore((s) => s.addKeybinding);
  const removeKeybinding = useSettingsStore((s) => s.removeKeybinding);
  const updateKeybinding = useSettingsStore((s) => s.updateKeybinding);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [capturedKeys, setCapturedKeys] = useState<string>("");

  const overrideMap = new Map<string, { keys: string; index: number }>();
  keybindings.forEach((kb, i) => {
    if (kb.command) overrideMap.set(kb.command, { keys: kb.keys, index: i });
  });

  const handleStartCapture = (actionId: string, defaultKeys: string) => {
    const existing = overrideMap.get(actionId);
    if (!existing) {
      addKeybinding({ keys: defaultKeys, command: actionId });
    }
    setCapturedKeys("");
    setEditingId(actionId);
  };

  const handleResetDefault = (actionId: string) => {
    const existing = overrideMap.get(actionId);
    if (existing) {
      removeKeybinding(existing.index);
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
                  background: isEditing ? "rgba(137,180,250,0.06)" : "transparent",
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
                    // Update the keybinding immediately
                    const existing = overrideMap.get(def.id) ?? (() => {
                      // Re-fetch from store since addKeybinding may have just run
                      const kbs = useSettingsStore.getState().keybindings;
                      const idx = kbs.findIndex((kb) => kb.command === def.id);
                      return idx >= 0 ? { keys: kbs[idx].keys, index: idx } : null;
                    })();
                    if (existing) updateKeybinding(existing.index, { keys: str });
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
                    fontSize: 11,
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
              onChange={(e) => updateKeybinding(kb.index, { command: e.target.value })}
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
                  if (str) updateKeybinding(kb.index, { keys: str });
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
                  fontSize: 11,
                }}
              >
                {kb.keys || <span style={{ opacity: 0.5 }}>Press keys...</span>}
              </div>
            )}
            <div className="w-12 shrink-0 text-right">
              <button
                data-testid={`remove-keybinding-${kb.index}`}
                onClick={() => removeKeybinding(kb.index)}
                className="text-xs"
                style={{ color: "var(--red)", cursor: "pointer", background: "transparent", border: "none" }}
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
          onClick={() => addKeybinding({ keys: "", command: "" })}
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
  markDirty: () => void;
  draftValues: React.MutableRefObject<Map<string, unknown>>;
}
const defaultDraftValues = { current: new Map<string, unknown>() };
const SettingsDraftContext = createContext<SettingsDraftCtx>({
  registerFlush: () => {},
  registerReset: () => {},
  markDirty: () => {},
  draftValues: defaultDraftValues,
});

/** Hook for sections to register flush/reset callbacks. */
function useSettingsDraft() {
  return useContext(SettingsDraftContext);
}

/** Hook: local draft state that flushes on Save and resets on Discard.
 *  Draft values are persisted in a shared Map so they survive section unmount/remount. */
function useDraft<T>(id: string, storeValue: T, storeSetter: (v: T) => void): [T, React.Dispatch<React.SetStateAction<T>>] {
  const { registerFlush, registerReset, markDirty, draftValues } = useSettingsDraft();

  const setterRef = useRef(storeSetter);
  setterRef.current = storeSetter;
  const storeRef = useRef(storeValue);
  storeRef.current = storeValue;

  // Restore preserved draft on remount, otherwise use store value
  const [draft, setDraft] = useState<T>(
    () => draftValues.current.has(id) ? draftValues.current.get(id) as T : storeValue,
  );

  // Keep shared map in sync with local draft
  useEffect(() => {
    draftValues.current.set(id, draft);
  }, [id, draft, draftValues]);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
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

  const wrappedSetDraft: React.Dispatch<React.SetStateAction<T>> = useCallback((action) => {
    setDraft((prev) => {
      const next = typeof action === "function" ? (action as (p: T) => T)(prev) : action;
      draftValues.current.set(id, next);
      return next;
    });
    markDirty();
  }, [id, markDirty, draftValues]);

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
    } catch { /* ignore — not available outside Tauri */ }
  };

  const handleAddProfile = () => {
    addProfile(makeProfileFromDefaults(
      `Profile ${profiles.length + 1}`,
      "",
      profileDefaults,
    ));
  };

  const [saveLabel, setSaveLabel] = useState("Save");
  const [navHover, setNavHover] = useState<string | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Draft flush/reset registry — sections register callbacks invoked on Save/Discard
  const flushMapRef = useRef<Map<string, FlushFn>>(new Map());
  const resetMapRef = useRef<Map<string, FlushFn>>(new Map());
  const draftValuesRef = useRef<Map<string, unknown>>(new Map());
  const [dirty, setDirty] = useState(false);
  const registerFlush = useCallback((id: string, fn: FlushFn) => {
    flushMapRef.current.set(id, fn);
  }, []);
  const registerReset = useCallback((id: string, fn: FlushFn) => {
    resetMapRef.current.set(id, fn);
  }, []);
  const markDirty = useCallback(() => setDirty(true), []);
  const draftCtx = useRef<SettingsDraftCtx>({ registerFlush, registerReset, markDirty, draftValues: draftValuesRef }).current;

  const handleSave = () => {
    // Flush all draft states to store first
    for (const fn of flushMapRef.current.values()) fn();
    draftValuesRef.current.clear();
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
    setDirty(false);
  };

  const navBtnStyle = (id: string): React.CSSProperties => {
    const isActive = activeNav === id;
    const isHover = navHover === id;
    return {
      background: isActive ? "var(--bg-overlay)" : isHover ? "rgba(255,255,255,0.03)" : "transparent",
      color: isActive ? "var(--accent)" : "var(--text-primary)",
      borderLeft: isActive ? "3px solid var(--accent)" : "3px solid transparent",
      cursor: "pointer",
      transition: "all 0.1s",
    };
  };

  return (
    <SettingsDraftContext.Provider value={draftCtx}>
    <div data-testid="settings-view" className="flex h-full" style={{ color: "var(--text-primary)" }}>
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
            borderRadius: 3,
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
          data-testid="nav-claude"
          className="w-full px-4 py-2 text-left text-[13px]"
          style={navBtnStyle("claude")}
          onClick={() => setActiveNav("claude")}
          onMouseEnter={() => setNavHover("claude")}
          onMouseLeave={() => setNavHover(null)}
        >
          Claude Code
        </button>

        {/* Profiles group */}
        <div className="mt-3 flex items-center justify-between px-3 pb-1">
          <span className="text-[10px] uppercase tracking-wider" style={{ color: "var(--text-secondary)", opacity: 0.7 }}>
            Profiles
          </span>
          <button
            data-testid="add-profile-btn"
            onClick={handleAddProfile}
            className="text-xs"
            style={{ color: "var(--accent)", background: "transparent", border: "none", cursor: "pointer" }}
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
                style={{ color: "var(--red)", background: "transparent", border: "none", cursor: "pointer" }}
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
      <div className="relative min-w-0 flex-1 overflow-y-auto" style={{ background: "var(--bg-base)" }}>
        <div className="p-4 pb-14" style={{ maxWidth: 720 }}>
          {activeNav === "startup" && <StartupSection />}
          {activeNav === "defaults" && <DefaultsSection />}
          {activeNav.startsWith("profile-") && (
            <ProfileSection key={activeNav} profileIndex={parseInt(activeNav.split("-")[1])} />
          )}
          {activeNav === "colorSchemes" && <ColorSchemesSection />}
          {activeNav === "keybindings" && <KeybindingsSection />}
          {activeNav === "convenience" && <ConvenienceSection />}
          {activeNav === "claude" && <ClaudeSection />}
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
              borderRadius: 4,
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
              background: saveLabel === "Saved!" ? "var(--green)" : saveLabel === "Error!" ? "var(--red)" : "var(--accent)",
              color: "var(--bg-base)",
              border: "none",
              cursor: dirty ? "pointer" : "default",
              transition: "all 0.15s",
              borderRadius: 4,
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
