import {
  useState,
  useRef,
  useEffect,
  createContext,
  useContext,
  useCallback,
  useMemo,
} from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
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
  type BellStyle,
  type CloseOnExit,
  type AntialiasingMode,
  type ColorScheme,
  type Keybinding,
  type LanguageSetting,
} from "@/stores/settings-store";
import {
  cloudConnectStart,
  cloudDisconnect,
  getCloudStatus,
  loadSettings,
  getRemoteAccessStatus,
  setRemoteRuntimeAccess,
  type CloudStatus,
  type ExtensionViewer,
  type FileExplorerSettings,
  type RemoteSettings,
} from "@/lib/tauri-api";
import type { SyncCwdConfig } from "@/lib/sync-cwd-config";
import { persistSession } from "@/lib/persist-session";
import {
  DEFAULT_KEYBINDINGS,
  coerceArrowWildcard,
  usesArrowWildcard,
} from "@/lib/keybinding-registry";
import { toSupportedCursorShape } from "@/lib/cursor-settings";
import type { PastePathSeparator } from "@/lib/smart-text";
import { MONOSPACED_FONTS, getSystemMonospaceFonts } from "@/lib/system-fonts";
import { FocusInput, FocusSelect, inputStyle, inputCls } from "@/components/ui/FormControls";
import { ToggleSwitch } from "@/components/ui/ToggleSwitch";
import { useRemoteAccessStore } from "@/stores/remote-access-store";
import {
  appendAllowedIps,
  formatAllowedIps,
  generateRemoteToken,
  LOOPBACK_ALLOWED_IPS,
  normalizeAutoMobileWidth,
  normalizeCustomHosts,
  parseAllowedIps,
  TAILSCALE_ALLOWED_IPS,
} from "@/lib/remote-hosts";
import { useRemoteHostOptions } from "@/hooks/useRemoteHostOptions";

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

/** Sidebar group header (e.g. "Appearance", "Terminal"). */
function NavGroupHeader({ label }: { label: string }) {
  return (
    <div className="mt-3 px-3 pb-1">
      <span
        className="text-[10px] uppercase tracking-wider"
        style={{ color: "var(--text-secondary)", opacity: 0.7 }}
      >
        {label}
      </span>
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

/** Card wrapper grouping related fields under an uppercase sub-header within a section. */
function SubGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={cardStyle} className="mt-3 p-4">
      <h3
        className="mb-3 text-[12px] font-semibold uppercase tracking-wider"
        style={{ color: "var(--text-secondary)", opacity: 0.7 }}
      >
        {title}
      </h3>
      {children}
    </div>
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

const LANGUAGE_OPTIONS: LanguageSetting[] = ["system", "ko", "en"];

function StartupSection() {
  const { t } = useTranslation(["settings", "common"]);
  const language = useSettingsStore((s) => s.language);
  const setLanguage = useSettingsStore((s) => s.setLanguage);
  const storeDefaultProfile = useSettingsStore((s) => s.defaultProfile);
  const setDefaultProfile = useSettingsStore((s) => s.setDefaultProfile);
  const profiles = useSettingsStore((s) => s.profiles);
  const storeAppThemeId = useSettingsStore((s) => s.appearance.themeId ?? "catppuccin-mocha");
  const setAppearance = useSettingsStore((s) => s.setAppearance);

  // Draft state — only committed to store on Save
  const [draftAppTheme, setDraftAppTheme] = useDraft("startup-appTheme", storeAppThemeId, (v) =>
    setAppearance({ themeId: v }),
  );
  const [draftDefaultProfile, setDraftDefaultProfile] = useDraft(
    "startup-defaultProfile",
    storeDefaultProfile,
    setDefaultProfile,
  );

  return (
    <div>
      <SectionTitle>{t("settings:startup.title")}</SectionTitle>

      {/* Language — applies immediately (live i18n effect), so it is not draft-gated. */}
      <div className="mb-3" style={cardStyle}>
        <div className="px-4 py-2">
          <div className="flex items-center justify-between">
            <div>
              <h4 className="text-xs font-semibold" style={{ color: "var(--text-primary)" }}>
                {t("settings:startup.language.title")}
              </h4>
              <p
                className="mt-0.5 text-[11px]"
                style={{ color: "var(--text-secondary)", opacity: 0.6 }}
              >
                {t("settings:startup.language.description")}
              </p>
            </div>
            <FocusSelect
              data-testid="language-select"
              value={language}
              onChange={(e) => setLanguage(e.target.value as LanguageSetting)}
              className="w-44 rounded px-2 py-1.5 text-xs"
            >
              {LANGUAGE_OPTIONS.map((lng) => (
                <option key={lng} value={lng}>
                  {t(`common:language.${lng}`)}
                </option>
              ))}
            </FocusSelect>
          </div>
        </div>
      </div>

      {/* App Theme */}
      <div className="mb-3" style={cardStyle}>
        <div className="px-4 py-2">
          <div className="flex items-center justify-between">
            <div>
              <h4 className="text-xs font-semibold" style={{ color: "var(--text-primary)" }}>
                {t("startup.appTheme.title")}
              </h4>
              <p
                className="mt-0.5 text-[11px]"
                style={{ color: "var(--text-secondary)", opacity: 0.6 }}
              >
                {t("startup.appTheme.description")}
              </p>
            </div>
            <FocusSelect
              data-testid="app-theme-select"
              value={draftAppTheme}
              onChange={(e) => setDraftAppTheme(e.target.value)}
              className="w-44 rounded px-2 py-1.5 text-xs"
            >
              {builtinAppThemes.map((theme) => (
                <option key={theme.id} value={theme.id}>
                  {theme.name}
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
                {t("startup.defaultProfile.title")}
              </h4>
              <p
                className="mt-0.5 text-[11px]"
                style={{ color: "var(--text-secondary)", opacity: 0.6 }}
              >
                {t("startup.defaultProfile.description")}
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
  const { t } = useTranslation("settings");
  const storeAppFont = useSettingsStore((s) => s.appearance.font);
  const storeUiFontFamily = useSettingsStore((s) => s.appearance.uiFontFamily);
  const setAppearance = useSettingsStore((s) => s.setAppearance);
  const monoFonts = useMonospacedFonts();
  const [draftFont, setDraftFont] = useDraft("appFont", storeAppFont, (f) =>
    setAppearance({ font: f }),
  );
  const [draftUiFont, setDraftUiFont] = useDraft("uiFontFamily", storeUiFontFamily, (v) =>
    setAppearance({ uiFontFamily: v }),
  );

  return (
    <div>
      <SectionTitle>{t("font.sectionTitle")}</SectionTitle>

      {/* Interface (chrome) font — view titles, buttons, lists, workspace selector.
          Family only; same dropdown widget as the base font. "" = built-in default. */}
      <div style={cardStyle} className="mb-3">
        <div className="px-4 py-2">
          <h4 className="mb-1 text-xs font-semibold" style={{ color: "var(--text-primary)" }}>
            {t("font.uiFontTitle")}
          </h4>
          <p className="mb-2 text-[11px]" style={{ color: "var(--text-secondary)", opacity: 0.6 }}>
            {t("font.uiFontDescription")}
          </p>
          <SettingRow label={t("font.face")} desc={t("font.uiFontFaceDesc")}>
            <FocusSelect
              data-testid="ui-font-family-input"
              value={draftUiFont}
              onChange={(e) => setDraftUiFont(e.target.value)}
              className={inputCls}
            >
              <option value="">{t("font.uiFontDefaultOption")}</option>
              {draftUiFont && !monoFonts.includes(draftUiFont) && (
                <option value={draftUiFont}>{draftUiFont}</option>
              )}
              {monoFonts.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </FocusSelect>
          </SettingRow>
        </div>
      </div>

      {/* Base font — default for non-terminal text views (Memo, Issue Reporter, …). */}
      <p className="mb-3 mt-4 text-[11px]" style={{ color: "var(--text-secondary)", opacity: 0.6 }}>
        {t("font.appFontDescription")}
      </p>
      <FontFields
        font={draftFont}
        onChange={setDraftFont}
        monoFonts={monoFonts}
        faceDesc={t("font.faceDescDefault")}
        cardTitle={t("font.baseFontTitle")}
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
  cardTitle,
}: {
  font: FontSettings;
  onChange: (font: FontSettings) => void;
  defaults?: FontSettings;
  showReset?: boolean;
  monoFonts: string[];
  faceDesc?: string;
  /** Override the card heading. Defaults to the generic "Font" label. */
  cardTitle?: string;
}) {
  const { t } = useTranslation("settings");
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
        title={t("common.resetToDefault")}
      >
        {t("common.reset")}
      </button>
    ) : null;

  return (
    <div style={cardStyle} className="mb-3">
      <div className="px-4 py-2">
        <div className="flex items-center gap-2 mb-2">
          <h4 className="text-xs font-semibold" style={{ color: "var(--text-primary)" }}>
            {cardTitle ?? t("font.cardTitle")}
          </h4>
          {resetBtn}
        </div>
        <SettingRow label={t("font.face")} desc={faceDesc ?? t("font.faceDescTerminal")}>
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
        <SettingRow label={t("font.size")} desc={t("font.sizeDesc")}>
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
        <SettingRow label={t("font.weight")}>
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
  data: Pick<Profile, "colorScheme" | "opacity" | "padding">;
  onChange: (d: Partial<Profile>) => void;
  colorSchemes: { name: string }[];
  defaults?: ProfileDefaults;
  showReset?: boolean;
}) {
  const { t } = useTranslation("settings");
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
        title={t("common.resetToDefault")}
      >
        {t("common.reset")}
      </button>
    ) : null;

  return (
    <>
      <div style={cardStyle} className="mb-3">
        <div className="px-4 py-2">
          <h4 className="mb-2 text-xs font-semibold" style={{ color: "var(--text-primary)" }}>
            {t("appearance.title")}
          </h4>
          <SettingRow label={t("appearance.colorScheme")}>
            <div className="flex items-center">
              <select
                value={data.colorScheme}
                onChange={(e) => onChange({ colorScheme: e.target.value })}
                className={inputCls}
                style={inputStyle}
              >
                <option value="">{t("appearance.colorSchemeDefault")}</option>
                {colorSchemes.map((cs) => (
                  <option key={cs.name} value={cs.name}>
                    {cs.name}
                  </option>
                ))}
              </select>
              {resetBtn("colorScheme")}
            </div>
          </SettingRow>
          <SettingRow label={t("appearance.opacity")}>
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
              {t("appearance.padding")}
            </h4>
            {resetBtn("padding")}
          </div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1">
            {(["top", "right", "bottom", "left"] as const).map((side) => (
              <SettingRow key={side} label={t(`appearance.${side}`)}>
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

function CursorFields({
  data,
  onChange,
  defaults,
  showReset,
}: {
  data: Pick<Profile, "cursorShape" | "cursorBlink" | "stabilizeInteractiveCursor">;
  onChange: (d: Partial<Profile>) => void;
  defaults?: ProfileDefaults;
  showReset?: boolean;
}) {
  const { t } = useTranslation("settings");
  const supportedCursorShape = toSupportedCursorShape(data.cursorShape);
  const isDefault = (key: keyof ProfileDefaults) =>
    defaults && JSON.stringify(data[key as keyof typeof data]) === JSON.stringify(defaults[key]);
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
        title={t("common.resetToDefault")}
      >
        {t("common.reset")}
      </button>
    ) : null;

  return (
    <div style={cardStyle} className="mb-3">
      <div className="px-4 py-2">
        <h4 className="mb-2 text-xs font-semibold" style={{ color: "var(--text-primary)" }}>
          {t("cursor.title")}
        </h4>
        <SettingRow label={t("cursor.shape")}>
          <div className="flex items-center">
            <select
              data-testid="cursor-shape-select"
              value={supportedCursorShape}
              onChange={(e) => onChange({ cursorShape: e.target.value as CursorShape })}
              className={inputCls}
              style={inputStyle}
            >
              <option value="bar">{t("cursor.shapeBar")}</option>
              <option value="underscore">{t("cursor.shapeUnderscore")}</option>
              <option value="filledBox">{t("cursor.shapeFilledBox")}</option>
            </select>
            {resetBtn("cursorShape")}
          </div>
        </SettingRow>
        <SettingRow label={t("cursor.blink")}>
          <div className="flex items-center gap-2">
            <label className="flex cursor-pointer items-center gap-2">
              <input
                data-testid="cursor-blink-toggle"
                type="checkbox"
                checked={data.cursorBlink}
                onChange={(e) => onChange({ cursorBlink: e.target.checked })}
              />
              <span className="text-[12px]" style={{ color: "var(--text-secondary)" }}>
                {t("cursor.blinkEnable")}
              </span>
            </label>
            {resetBtn("cursorBlink")}
          </div>
        </SettingRow>
        <SettingRow label={t("cursor.stability")} desc={t("cursor.stabilityDesc")}>
          <div className="flex items-center gap-2">
            <label className="flex cursor-pointer items-center gap-2">
              <input
                data-testid="stabilize-interactive-cursor-toggle"
                type="checkbox"
                checked={data.stabilizeInteractiveCursor}
                onChange={(e) => onChange({ stabilizeInteractiveCursor: e.target.checked })}
              />
              <span className="text-[12px]" style={{ color: "var(--text-secondary)" }}>
                {t("cursor.stabilityEnable")}
              </span>
            </label>
            {resetBtn("stabilizeInteractiveCursor")}
          </div>
        </SettingRow>
        <p className="mt-1 text-[11px]" style={{ color: "var(--text-secondary)", opacity: 0.7 }}>
          {t("cursor.applyNote")}
        </p>
      </div>
    </div>
  );
}

/** Map a syncCwd config to a select token. */
function syncCwdToToken(v: SyncCwdConfig | undefined): string {
  if (v == null || v === "default") return "default";
  if (v.send && v.receive) return "both";
  if (!v.send && v.receive) return "receive";
  if (v.send && !v.receive) return "send";
  return "off";
}

/** Map a select token back to a syncCwd config. */
function tokenToSyncCwd(tok: string): SyncCwdConfig {
  switch (tok) {
    case "both":
      return { send: true, receive: true };
    case "receive":
      return { send: false, receive: true };
    case "send":
      return { send: true, receive: false };
    case "off":
      return { send: false, receive: false };
    default:
      return "default";
  }
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
    | "syncCwd"
  >;
  onChange: (d: Partial<Profile>) => void;
  defaults?: ProfileDefaults;
  showReset?: boolean;
}) {
  const { t } = useTranslation("settings");
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
        title={t("common.resetToDefault")}
      >
        {t("common.reset")}
      </button>
    ) : null;

  return (
    <div style={cardStyle}>
      <div className="px-4 py-2">
        <h4 className="mb-2 text-xs font-semibold" style={{ color: "var(--text-primary)" }}>
          {t("advanced.title")}
        </h4>
        <SettingRow label={t("advanced.scrollbackLines")} desc={t("advanced.scrollbackLinesDesc")}>
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
        <SettingRow label={t("advanced.bellStyle")} desc={t("advanced.bellStyleDesc")}>
          <div className="flex items-center">
            <select
              value={data.bellStyle}
              onChange={(e) => onChange({ bellStyle: e.target.value as BellStyle })}
              className={inputCls}
              style={inputStyle}
            >
              <option value="audible">{t("advanced.bellAudible")}</option>
              <option value="none">{t("advanced.bellNone")}</option>
              <option value="window">{t("advanced.bellWindow")}</option>
              <option value="taskbar">{t("advanced.bellTaskbar")}</option>
              <option value="all">{t("advanced.bellAll")}</option>
            </select>
            {resetBtn("bellStyle")}
          </div>
        </SettingRow>
        <SettingRow label={t("advanced.closeOnExit")} desc={t("advanced.closeOnExitDesc")}>
          <div className="flex items-center">
            <select
              value={data.closeOnExit}
              onChange={(e) => onChange({ closeOnExit: e.target.value as CloseOnExit })}
              className={inputCls}
              style={inputStyle}
            >
              <option value="automatic">{t("advanced.closeAutomatic")}</option>
              <option value="graceful">{t("advanced.closeGraceful")}</option>
              <option value="always">{t("advanced.closeAlways")}</option>
              <option value="never">{t("advanced.closeNever")}</option>
            </select>
            {resetBtn("closeOnExit")}
          </div>
        </SettingRow>
        <SettingRow label={t("advanced.antialiasing")} desc={t("advanced.antialiasingDesc")}>
          <div className="flex items-center">
            <select
              value={data.antialiasingMode}
              onChange={(e) => onChange({ antialiasingMode: e.target.value as AntialiasingMode })}
              className={inputCls}
              style={inputStyle}
            >
              <option value="grayscale">{t("advanced.antialiasingGrayscale")}</option>
              <option value="cleartype">{t("advanced.antialiasingClearType")}</option>
              <option value="aliased">{t("advanced.antialiasingAliased")}</option>
            </select>
            {resetBtn("antialiasingMode")}
          </div>
        </SettingRow>
        <SettingRow label={t("advanced.suppressTitle")}>
          <div className="flex items-center gap-2">
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={data.suppressApplicationTitle}
                onChange={(e) => onChange({ suppressApplicationTitle: e.target.checked })}
              />
              <span className="text-xs" style={{ color: "var(--text-secondary)" }}>
                {t("advanced.suppressTitleDesc")}
              </span>
            </label>
            {resetBtn("suppressApplicationTitle")}
          </div>
        </SettingRow>
        <SettingRow label={t("advanced.snapOnInput")}>
          <div className="flex items-center gap-2">
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={data.snapOnInput}
                onChange={(e) => onChange({ snapOnInput: e.target.checked })}
              />
              <span className="text-xs" style={{ color: "var(--text-secondary)" }}>
                {t("advanced.snapOnInputDesc")}
              </span>
            </label>
            {resetBtn("snapOnInput")}
          </div>
        </SettingRow>

        <h4 className="mb-2 mt-4 text-xs font-semibold" style={{ color: "var(--text-primary)" }}>
          {t("advanced.sessionRestore")}
        </h4>
        <SettingRow label={t("advanced.restoreCwd")} desc={t("advanced.restoreCwdDesc")}>
          <div className="flex items-center gap-2">
            <label className="flex cursor-pointer items-center gap-2">
              <input
                data-testid="restore-cwd-checkbox"
                type="checkbox"
                checked={data.restoreCwd}
                onChange={(e) => onChange({ restoreCwd: e.target.checked })}
              />
              <span className="text-xs" style={{ color: "var(--text-secondary)" }}>
                {t("advanced.restoreCwdEnable")}
              </span>
            </label>
            {resetBtn("restoreCwd")}
          </div>
        </SettingRow>
        <SettingRow label={t("advanced.restoreOutput")} desc={t("advanced.restoreOutputDesc")}>
          <div className="flex items-center gap-2">
            <label className="flex cursor-pointer items-center gap-2">
              <input
                data-testid="restore-output-checkbox"
                type="checkbox"
                checked={data.restoreOutput}
                onChange={(e) => onChange({ restoreOutput: e.target.checked })}
              />
              <span className="text-xs" style={{ color: "var(--text-secondary)" }}>
                {t("advanced.restoreOutputEnable")}
              </span>
            </label>
            {resetBtn("restoreOutput")}
          </div>
        </SettingRow>

        <h4 className="mb-2 mt-4 text-xs font-semibold" style={{ color: "var(--text-primary)" }}>
          {t("advanced.cwdPropagation")}
        </h4>
        <SettingRow label={t("advanced.cwdPropagation")} desc={t("advanced.cwdPropagationDesc")}>
          <div className="flex items-center">
            <select
              data-testid="sync-cwd-profile-select"
              value={syncCwdToToken(data.syncCwd)}
              onChange={(e) => onChange({ syncCwd: tokenToSyncCwd(e.target.value) })}
              className={inputCls}
              style={inputStyle}
            >
              <option value="default">
                {defaults ? t("advanced.cwdInherit") : t("advanced.cwdInheritLocation")}
              </option>
              <option value="both">{t("advanced.cwdBoth")}</option>
              <option value="receive">{t("advanced.cwdReceiveOnly")}</option>
              <option value="send">{t("advanced.cwdSendOnly")}</option>
              <option value="off">{t("advanced.cwdOff")}</option>
            </select>
          </div>
        </SettingRow>
      </div>
    </div>
  );
}

// -- Section: Profile Defaults --

const fallbackDefaults: ProfileDefaults = { ...defaultProfileDefaults };

function DefaultsSection() {
  const { t } = useTranslation("settings");
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
      <SectionTitle>{t("defaults.title")}</SectionTitle>
      <p className="mb-4 text-[11px]" style={{ color: "var(--text-secondary)", opacity: 0.6 }}>
        {t("defaults.description")}
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
      <CursorFields data={draftDefaults} onChange={updateDefaults} />

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
  const { t } = useTranslation("settings");
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
            ["general", t("profile.tabGeneral")],
            ["additional", t("profile.tabAdditional")],
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
            <SettingRow label={t("profile.name")}>
              <input
                data-testid="profile-name-input"
                type="text"
                value={profile.name}
                onChange={(e) => update({ name: e.target.value })}
                className={inputCls}
                style={inputStyle}
              />
            </SettingRow>
            <SettingRow label={t("profile.commandLine")} desc={t("profile.commandLineDesc")}>
              <input
                type="text"
                value={profile.commandLine}
                onChange={(e) => update({ commandLine: e.target.value })}
                className={inputCls}
                style={inputStyle}
                placeholder="powershell.exe"
              />
            </SettingRow>
            <SettingRow label={t("profile.startupCommand")} desc={t("profile.startupCommandDesc")}>
              <input
                type="text"
                value={profile.startupCommand}
                onChange={(e) => update({ startupCommand: e.target.value })}
                className={inputCls}
                style={inputStyle}
                placeholder="cd ~/project && conda activate myenv"
              />
            </SettingRow>
            <SettingRow
              label={t("profile.startingDirectory")}
              desc={t("profile.startingDirectoryDesc")}
            >
              <input
                type="text"
                value={profile.startingDirectory}
                onChange={(e) => update({ startingDirectory: e.target.value })}
                className={inputCls}
                style={inputStyle}
                placeholder="~"
              />
            </SettingRow>
            <SettingRow label={t("profile.tabTitle")} desc={t("profile.tabTitleDesc")}>
              <input
                type="text"
                value={profile.tabTitle}
                onChange={(e) => update({ tabTitle: e.target.value })}
                className={inputCls}
                style={inputStyle}
                placeholder=""
              />
            </SettingRow>
            <SettingRow label={t("profile.hidden")}>
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={profile.hidden}
                  onChange={(e) => update({ hidden: e.target.checked })}
                />
                <span className="text-xs" style={{ color: "var(--text-secondary)" }}>
                  {t("profile.hiddenDesc")}
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
            {t("profile.additionalIntro")}
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
          <CursorFields data={profile} onChange={update} defaults={profileDefaults} showReset />
          <AdvancedFields data={profile} onChange={update} defaults={profileDefaults} showReset />
        </>
      )}
    </div>
  );
}

// -- Section: Color Schemes --

function ColorSchemesSection() {
  const { t } = useTranslation("settings");
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
      <SectionTitle>{t("colorSchemes.title")}</SectionTitle>

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
              {t("colorSchemes.noSchemes")}
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
          {t("colorSchemes.add")}
        </button>
        {scheme && (
          <button
            onClick={handleRemove}
            className="shrink-0 rounded px-3 py-1.5 text-xs"
            style={{ ...inputStyle, color: "var(--red)", cursor: "pointer" }}
          >
            {t("common.delete")}
          </button>
        )}
      </div>

      {scheme && (
        <>
          <div style={cardStyle} className="mb-3">
            <div className="px-4 py-2">
              <h4 className="mb-2 text-xs font-semibold" style={{ color: "var(--text-primary)" }}>
                {t("colorSchemes.schemeName")}
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
                {t("colorSchemes.terminalColors")}
              </h4>
              <div className="mb-3 flex gap-2">
                <ColorSwatch
                  color={scheme.foreground}
                  label={t("colorSchemes.fg")}
                  onChange={(v) => updateField("foreground", v)}
                />
                <ColorSwatch
                  color={scheme.background}
                  label={t("colorSchemes.bg")}
                  onChange={(v) => updateField("background", v)}
                />
                <ColorSwatch
                  color={scheme.cursorColor}
                  label={t("colorSchemes.cursor")}
                  onChange={(v) => updateField("cursorColor", v)}
                />
                <ColorSwatch
                  color={scheme.selectionBackground}
                  label={t("colorSchemes.select")}
                  onChange={(v) => updateField("selectionBackground", v)}
                />
              </div>

              <h4
                className="mb-2 mt-4 text-xs font-semibold"
                style={{ color: "var(--text-primary)" }}
              >
                {t("colorSchemes.ansiColors")}
              </h4>
              <div className="mb-2 flex gap-2">
                {ansiColors.map(([key]) => (
                  <ColorSwatch
                    key={key}
                    color={scheme[key]}
                    label={t(`colorSchemes.${key}`)}
                    onChange={(v) => updateField(key, v)}
                  />
                ))}
              </div>
              <div className="flex gap-2">
                {brightColors.map(([key]) => {
                  const base = key.replace("bright", "").toLowerCase();
                  return (
                    <ColorSwatch
                      key={key}
                      color={scheme[key]}
                      label={t("colorSchemes.brightPrefix") + t(`colorSchemes.${base}`)}
                      onChange={(v) => updateField(key, v)}
                    />
                  );
                })}
              </div>
            </div>
          </div>

          {/* Preview */}
          <div style={cardStyle}>
            <div className="px-4 py-2">
              <h4 className="mb-2 text-xs font-semibold" style={{ color: "var(--text-primary)" }}>
                {t("colorSchemes.preview")}
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

// -- Shared: toggle row --

function ToggleRow({
  label,
  desc,
  testid,
  checked,
  onChange,
}: {
  label: string;
  desc: string;
  testid: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  const { t } = useTranslation("settings");
  return (
    <SettingRow label={label} desc={desc}>
      <div className="flex items-center gap-2">
        <ToggleSwitch
          data-testid={testid}
          aria-label={label}
          checked={checked}
          onChange={onChange}
        />
        <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
          {checked ? t("common.enabled") : t("common.disabled")}
        </span>
      </div>
    </SettingRow>
  );
}

// -- Section: Paste --

function PasteSection() {
  const { t } = useTranslation("settings");
  const storePaste = useSettingsStore((s) => s.paste);
  const setPaste = useSettingsStore((s) => s.setPaste);
  const [paste, setDraftPaste] = useDraft("paste", storePaste, (v) => setPaste(v));
  const update = (partial: Partial<typeof paste>) =>
    setDraftPaste((prev) => ({ ...prev, ...partial }));

  return (
    <div>
      <SectionTitle>{t("paste.title")}</SectionTitle>

      <SubGroup title={t("paste.groupGeneral")}>
        <ToggleRow
          label={t("paste.smartPaste")}
          desc={t("paste.smartPasteDesc")}
          testid="smart-paste-toggle"
          checked={paste.smart}
          onChange={(v) => update({ smart: v })}
        />

        <SettingRow label={t("paste.imageDir")} desc={t("paste.imageDirDesc")}>
          <FocusInput
            data-testid="paste-image-dir-input"
            className={inputCls}
            placeholder={t("paste.imageDirPlaceholder")}
            value={paste.imageDir}
            onChange={(e) => update({ imageDir: e.target.value })}
          />
        </SettingRow>
      </SubGroup>

      <SubGroup title={t("paste.groupTextTransform")}>
        <ToggleRow
          label={t("paste.smartRemoveIndent")}
          desc={t("paste.smartRemoveIndentDesc")}
          testid="smart-remove-indent-toggle"
          checked={paste.removeIndent}
          onChange={(v) => update({ removeIndent: v })}
        />

        <ToggleRow
          label={t("paste.smartRemoveLineBreak")}
          desc={t("paste.smartRemoveLineBreakDesc")}
          testid="smart-remove-linebreak-toggle"
          checked={paste.removeLineBreak}
          onChange={(v) => update({ removeLineBreak: v })}
        />

        <ToggleRow
          label={t("paste.smartLinkJoin")}
          desc={t("paste.smartLinkJoinDesc")}
          testid="smart-link-join-toggle"
          checked={paste.linkJoin}
          onChange={(v) => update({ linkJoin: v })}
        />
      </SubGroup>

      <SubGroup title={t("paste.groupMultiFile")}>
        <SettingRow label={t("paste.multiFileSeparator")} desc={t("paste.multiFileSeparatorDesc")}>
          <select
            data-testid="paste-path-separator-select"
            value={paste.pathSeparator}
            onChange={(e) => update({ pathSeparator: e.target.value as PastePathSeparator })}
            className={inputCls}
            style={inputStyle}
          >
            <option value="space">{t("paste.separatorSpace")}</option>
            <option value="newline">{t("paste.separatorNewline")}</option>
            <option value="comma">{t("paste.separatorComma")}</option>
            <option value="semicolon">{t("paste.separatorSemicolon")}</option>
          </select>
        </SettingRow>

        <ToggleRow
          label={t("paste.quotePaths")}
          desc={t("paste.quotePathsDesc")}
          testid="paste-path-quote-toggle"
          checked={paste.pathQuote}
          onChange={(v) => update({ pathQuote: v })}
        />
      </SubGroup>

      <SubGroup title={t("paste.groupSafety")}>
        <ToggleRow
          label={t("paste.largeWarning")}
          desc={t("paste.largeWarningDesc")}
          testid="large-paste-warning-toggle"
          checked={paste.largeWarning}
          onChange={(v) => update({ largeWarning: v })}
        />
      </SubGroup>
    </div>
  );
}

// -- Section: Terminal --

function TerminalSection() {
  const { t } = useTranslation("settings");
  const storeTerminal = useSettingsStore((s) => s.terminal);
  const setTerminal = useSettingsStore((s) => s.setTerminal);
  const [terminal, setDraftTerminal] = useDraft("terminal", storeTerminal, (v) => setTerminal(v));
  const update = (partial: Partial<typeof terminal>) =>
    setDraftTerminal((prev) => ({ ...prev, ...partial }));

  return (
    <div>
      <SectionTitle>{t("terminal.title")}</SectionTitle>
      <div style={cardStyle} className="p-4">
        <ToggleRow
          label={t("terminal.copyOnSelect")}
          desc={t("terminal.copyOnSelectDesc")}
          testid="copy-on-select-toggle"
          checked={terminal.copyOnSelect}
          onChange={(v) => update({ copyOnSelect: v })}
        />

        <SettingRow label={t("terminal.scrollbarStyle")} desc={t("terminal.scrollbarStyleDesc")}>
          <FocusSelect
            data-testid="scrollbar-style-select"
            className={inputCls}
            value={terminal.scrollbarStyle}
            onChange={(e) => update({ scrollbarStyle: e.target.value as "overlay" | "separate" })}
          >
            <option value="overlay">{t("terminal.scrollbarOverlay")}</option>
            <option value="separate">{t("terminal.scrollbarSeparate")}</option>
          </FocusSelect>
        </SettingRow>

        <ToggleRow
          label={t("terminal.scrollToBottomButton")}
          desc={t("terminal.scrollToBottomButtonDesc")}
          testid="scroll-to-bottom-button-toggle"
          checked={terminal.showScrollToBottomButton}
          onChange={(v) => update({ showScrollToBottomButton: v })}
        />
      </div>

      <SubGroup title={t("terminal.pathLinkGroup")}>
        <ToggleRow
          label={t("terminal.pathLink")}
          desc={t("terminal.pathLinkDesc")}
          testid="path-link-enabled-toggle"
          checked={terminal.pathLinkEnabled}
          onChange={(v) => update({ pathLinkEnabled: v })}
        />

        <SettingRow
          label={t("terminal.pathLinkMaxLength")}
          desc={t("terminal.pathLinkMaxLengthDesc")}
        >
          <FocusInput
            data-testid="path-link-max-length-input"
            type="number"
            min={8}
            max={4096}
            step={1}
            className={inputCls}
            style={{ width: 90 }}
            value={terminal.pathLinkMaxLength}
            onChange={(e) =>
              update({ pathLinkMaxLength: Math.max(8, Math.round(Number(e.target.value) || 0)) })
            }
          />
        </SettingRow>
      </SubGroup>
    </div>
  );
}

// -- Section: Interface (control bar, dock, notifications) --

function InterfaceSection() {
  const { t } = useTranslation("settings");
  const storeControlBar = useSettingsStore((s) => s.controlBar);
  const setControlBar = useSettingsStore((s) => s.setControlBar);
  const storeDock = useSettingsStore((s) => s.dock);
  const setDock = useSettingsStore((s) => s.setDock);
  const storeNotifications = useSettingsStore((s) => s.notifications);
  const setNotifications = useSettingsStore((s) => s.setNotifications);

  const [controlBar, setDraftControlBar] = useDraft("controlBar", storeControlBar, (v) =>
    setControlBar(v),
  );
  const [dock, setDraftDock] = useDraft("dock", storeDock, (v) => setDock(v));
  const [notifications, setDraftNotifications] = useDraft(
    "notifications",
    storeNotifications,
    (v) => setNotifications(v),
  );
  const updateControlBar = (partial: Partial<typeof controlBar>) =>
    setDraftControlBar((prev) => ({ ...prev, ...partial }));
  const updateDock = (partial: Partial<typeof dock>) =>
    setDraftDock((prev) => ({ ...prev, ...partial }));

  return (
    <div>
      <SectionTitle>{t("interface.title")}</SectionTitle>

      <SubGroup title={t("interface.groupControlBar")}>
        <SettingRow label={t("interface.hoverAutoHide")} desc={t("interface.hoverAutoHideDesc")}>
          <div className="flex items-center gap-2">
            <FocusInput
              data-testid="hover-idle-seconds-input"
              type="number"
              min={0}
              max={30}
              step={0.5}
              className={inputCls}
              style={{ width: 70 }}
              value={controlBar.hoverIdleSeconds}
              onChange={(e) =>
                updateControlBar({ hoverIdleSeconds: Math.max(0, Number(e.target.value)) })
              }
            />
            <span className="text-[11px]" style={{ color: "var(--text-secondary)" }}>
              {t("common.seconds")}
            </span>
          </div>
        </SettingRow>

        <SettingRow label={t("interface.controlBarMode")} desc={t("interface.controlBarModeDesc")}>
          <FocusSelect
            data-testid="default-control-bar-mode-select"
            className={inputCls}
            value={controlBar.defaultMode}
            onChange={(e) =>
              updateControlBar({ defaultMode: e.target.value as "hover" | "pinned" | "minimized" })
            }
          >
            <option value="minimized">{t("interface.controlBarMinimized")}</option>
            <option value="hover">{t("interface.controlBarHover")}</option>
            <option value="pinned">{t("interface.controlBarPinned")}</option>
          </FocusSelect>
        </SettingRow>
      </SubGroup>

      <SubGroup title={t("interface.groupDock")}>
        <ToggleRow
          label={t("interface.dockPersist")}
          desc={t("interface.dockPersistDesc")}
          testid="dock-persist-state-toggle"
          checked={dock.persistState}
          onChange={(v) => updateDock({ persistState: v })}
        />
        <ToggleRow
          label={t("interface.dockArrowNav")}
          desc={t("interface.dockArrowNavDesc")}
          testid="dock-arrow-nav-toggle"
          checked={dock.arrowNav}
          onChange={(v) => updateDock({ arrowNav: v })}
        />
        <ToggleRow
          label={t("interface.dockArrowFocusPane")}
          desc={t("interface.dockArrowFocusPaneDesc")}
          testid="dock-arrow-focus-pane-toggle"
          checked={dock.arrowFocusPane}
          onChange={(v) => updateDock({ arrowFocusPane: v })}
        />
      </SubGroup>

      <SubGroup title={t("interface.groupNotifications")}>
        <SettingRow
          label={t("interface.notificationDismiss")}
          desc={t("interface.notificationDismissDesc")}
        >
          <FocusSelect
            data-testid="notification-dismiss-select"
            className={inputCls}
            value={notifications.dismiss}
            onChange={(e) =>
              setDraftNotifications({
                dismiss: e.target.value as "workspace" | "paneFocus" | "manual",
              })
            }
          >
            <option value="workspace">{t("interface.dismissWorkspace")}</option>
            <option value="paneFocus">{t("interface.dismissPaneFocus")}</option>
            <option value="manual">{t("interface.dismissManual")}</option>
          </FocusSelect>
        </SettingRow>
      </SubGroup>
    </div>
  );
}

// -- Section: Remote --

type RemoteSectionDraft = RemoteSettings & {
  allowedIpsText: string;
  customHostInput: string;
};

function toRemoteSectionDraft(remote: RemoteSettings): RemoteSectionDraft {
  return {
    ...remote,
    allowedIpsText: formatAllowedIps(remote.allowedIps),
    customHostInput: "",
  };
}

function toRemoteSettings(draft: RemoteSectionDraft): RemoteSettings {
  const { allowedIpsText, customHostInput: _customHostInput, ...remote } = draft;
  const allowedIps = parseAllowedIps(allowedIpsText);
  const customHosts = normalizeCustomHosts(remote.customHosts);
  return {
    ...remote,
    authToken: remote.authToken.trim(),
    preferredHost: remote.preferredHost.trim(),
    relayBaseUrl: remote.relayBaseUrl.trim(),
    customHosts,
    allowedIps: allowedIps.length > 0 ? allowedIps : LOOPBACK_ALLOWED_IPS,
    autoMobileModeMinWidth: normalizeAutoMobileWidth(remote.autoMobileModeMinWidth),
  };
}

async function reconcileRemoteAccessAfterRemoteSave(
  previousRemoteEnabled: boolean,
  nextRemoteEnabled: boolean,
) {
  const { setStatus } = useRemoteAccessStore.getState();
  const current = await getRemoteAccessStatus();

  if (
    previousRemoteEnabled !== nextRemoteEnabled &&
    (nextRemoteEnabled || !current.runtimeEnabled)
  ) {
    const reconciled = await setRemoteRuntimeAccess(false, null);
    setStatus(reconciled);
    return;
  }

  setStatus(current);
}

function RemoteSection() {
  const { t } = useTranslation("settings");
  const storeRemote = useSettingsStore((s) => s.remote);
  const setRemote = useSettingsStore((s) => s.setRemote);
  const storeDraft = useMemo(() => toRemoteSectionDraft(storeRemote), [storeRemote]);
  const [remote, setDraftRemote] = useDraft<RemoteSectionDraft>("remote", storeDraft, (draft) =>
    setRemote(toRemoteSettings(draft)),
  );
  const hostOptions = useRemoteHostOptions(remote.customHosts);
  const preferredAvailable =
    remote.preferredHost === "" ||
    hostOptions.some((option) => option.host === remote.preferredHost);
  const remoteDraftChanged = useMemo(
    () => JSON.stringify(remote) !== JSON.stringify(storeDraft),
    [remote, storeDraft],
  );
  // Mirror the latest dirty state into a ref so async cloud callbacks (which
  // capture the value at click time) branch on the current draft state after a
  // long-running OAuth await instead of a stale closure snapshot.
  const remoteDraftChangedRef = useRef(remoteDraftChanged);
  remoteDraftChangedRef.current = remoteDraftChanged;
  const [cloudStatus, setCloudStatus] = useState<CloudStatus | null>(null);
  const [cloudStatusError, setCloudStatusError] = useState<string | null>(null);
  const [cloudConnectPending, setCloudConnectPending] = useState(false);
  const [cloudDisconnectPending, setCloudDisconnectPending] = useState(false);

  const update = (partial: Partial<RemoteSectionDraft>) =>
    setDraftRemote((prev) => ({ ...prev, ...partial }));

  useEffect(() => {
    let cancelled = false;

    getCloudStatus()
      .then((status) => {
        if (cancelled) return;
        setCloudStatus(status);
        setCloudStatusError(null);
      })
      .catch((error) => {
        if (cancelled) return;
        setCloudStatus(null);
        setCloudStatusError(error instanceof Error ? error.message : String(error));
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const handleToggleEnabled = (enabled: boolean) => {
    update({
      enabled,
      ...(enabled && remote.authToken.trim().length === 0
        ? { authToken: generateRemoteToken() }
        : {}),
    });
  };

  const handleAddCustomHost = () => {
    const host = remote.customHostInput.trim();
    if (!host) return;
    update({
      customHosts: normalizeCustomHosts([...remote.customHosts, host]),
      customHostInput: "",
    });
  };

  const handleRemoveCustomHost = (host: string) => {
    const customHosts = remote.customHosts.filter((candidate) => candidate !== host);
    update({
      customHosts,
      ...(remote.preferredHost === host ? { preferredHost: "" } : {}),
    });
  };

  const applyCloudFieldUpdate = (partial: Partial<RemoteSectionDraft>) => {
    // Always merge cloud fields into the draft functionally so a concurrent
    // edit made during the async flow is preserved. Only sync the store when
    // the draft has no unsaved changes (read from the ref, not a stale closure)
    // to avoid clobbering an in-progress edit.
    setDraftRemote((prev) => ({ ...prev, ...partial }));
    if (!remoteDraftChangedRef.current) {
      setRemote(partial);
    }
  };

  const handleCloudConnect = async () => {
    setCloudConnectPending(true);
    setCloudStatusError(null);
    try {
      // The backend `cloud_connect_start` reads `relay_base_url` from
      // `load_settings()` (disk), NOT from this unsaved draft. If the relay was
      // edited, run the same commit the Save button does for the remote section
      // before pairing so it pairs against the URL the user typed:
      //  - commit the FULL draft (not just relay) — a partial `setRemote` would
      //    trip useDraft's store-change sync (#51) and discard other unsaved edits,
      //  - persist to disk, and
      //  - reconcile Direct Remote runtime access if `enabled` changed
      //    (mirrors handleSave; no-ops when it did not change).
      if (remote.relayBaseUrl.trim() !== storeRemote.relayBaseUrl) {
        const previousEnabled = storeRemote.enabled;
        const committed = toRemoteSettings(remote);
        setRemote(committed);
        await persistSession();
        await reconcileRemoteAccessAfterRemoteSave(previousEnabled, committed.enabled);
      }
      const status = await cloudConnectStart();
      setCloudStatus(status);
      if (status.instanceId && !status.lastError) {
        let refreshedRemote: RemoteSettings | null = null;
        try {
          refreshedRemote = (await loadSettings()).remote ?? null;
        } catch (refreshError) {
          setCloudStatusError(
            refreshError instanceof Error ? refreshError.message : String(refreshError),
          );
        }
        applyCloudFieldUpdate({
          cloudEnabled: true,
          cloudInstanceId: refreshedRemote?.cloudInstanceId ?? status.instanceId,
          cloudTunnelUrl: refreshedRemote?.cloudTunnelUrl ?? null,
          cloudServerBaseUrl: refreshedRemote?.cloudServerBaseUrl ?? null,
          ...(remoteDraftChangedRef.current || !refreshedRemote
            ? {}
            : { relayBaseUrl: refreshedRemote.relayBaseUrl }),
        });
      }
    } catch (error) {
      setCloudStatusError(error instanceof Error ? error.message : String(error));
    } finally {
      setCloudConnectPending(false);
    }
  };

  const handleCloudDisconnect = async () => {
    setCloudDisconnectPending(true);
    setCloudStatusError(null);
    try {
      const status = await cloudDisconnect();
      setCloudStatus(status);
      applyCloudFieldUpdate({
        cloudEnabled: false,
        cloudInstanceId: null,
        cloudTunnelUrl: null,
        cloudServerBaseUrl: null,
      });
    } catch (error) {
      setCloudStatusError(error instanceof Error ? error.message : String(error));
    } finally {
      setCloudDisconnectPending(false);
    }
  };

  const cloudStatusText = cloudStatusError
    ? t("remote.cloudStatusError", { error: cloudStatusError })
    : cloudStatus?.lastError
      ? t("remote.cloudStatusError", { error: cloudStatus.lastError })
      : cloudStatus?.connected
        ? t("remote.cloudStatusConnected")
        : cloudStatus?.instanceId || remote.cloudInstanceId
          ? t("remote.cloudStatusPaired")
          : t("remote.cloudStatusDisconnected");
  const showCloudDisconnect =
    remote.cloudEnabled ||
    Boolean(remote.cloudInstanceId) ||
    Boolean(cloudStatus?.connected) ||
    Boolean(cloudStatus?.instanceId) ||
    Boolean(cloudStatus?.lastError);

  return (
    <div>
      <SectionTitle>{t("remote.title")}</SectionTitle>

      <SubGroup title={t("remote.groupAccess")}>
        <ToggleRow
          label={t("remote.enabled")}
          desc={t("remote.enabledDesc")}
          testid="remote-settings-enabled-toggle"
          checked={remote.enabled}
          onChange={handleToggleEnabled}
        />

        <SettingRow label={t("remote.allowedIps")} desc={t("remote.allowedIpsDesc")}>
          <div className="flex min-w-0 flex-col gap-2">
            <textarea
              data-testid="remote-settings-allowed-ips-input"
              value={remote.allowedIpsText}
              onChange={(event) => update({ allowedIpsText: event.target.value })}
              rows={5}
              spellCheck={false}
              className="w-full resize-y rounded px-2 py-1.5 font-mono text-[12px] ui-focus-ring"
              placeholder={t("remote.allowedIpsPlaceholder")}
              style={inputStyle}
            />
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                data-testid="remote-settings-add-tailscale"
                onClick={() =>
                  update({
                    allowedIpsText: appendAllowedIps(remote.allowedIpsText, TAILSCALE_ALLOWED_IPS),
                  })
                }
                className="hover-bg rounded px-2 py-1 text-[11px]"
                style={{
                  color: "var(--accent)",
                  background: "transparent",
                  border: "1px solid var(--border)",
                  cursor: "pointer",
                }}
              >
                {t("remote.addTailscale")}
              </button>
              <button
                type="button"
                data-testid="remote-settings-reset-loopback"
                onClick={() => update({ allowedIpsText: formatAllowedIps(LOOPBACK_ALLOWED_IPS) })}
                className="hover-bg rounded px-2 py-1 text-[11px]"
                style={{
                  color: "var(--accent)",
                  background: "transparent",
                  border: "1px solid var(--border)",
                  cursor: "pointer",
                }}
              >
                {t("remote.resetLoopback")}
              </button>
            </div>
          </div>
        </SettingRow>

        <SettingRow
          label={t("remote.autoMobileMinWidth")}
          desc={t("remote.autoMobileMinWidthDesc")}
        >
          <div className="flex items-center gap-2">
            <FocusInput
              data-testid="remote-settings-auto-mobile-width-input"
              type="number"
              min={0}
              step={1}
              className={inputCls}
              inputStyle={{ width: 110 }}
              value={remote.autoMobileModeMinWidth}
              onChange={(event) =>
                update({ autoMobileModeMinWidth: normalizeAutoMobileWidth(event.target.value) })
              }
            />
            <span className="text-[11px]" style={{ color: "var(--text-secondary)" }}>
              px
            </span>
          </div>
        </SettingRow>
      </SubGroup>

      <SubGroup title={t("remote.groupHosts")}>
        <SettingRow label={t("remote.customHosts")} desc={t("remote.customHostsDesc")}>
          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex min-w-0 gap-2">
              <FocusInput
                data-testid="remote-settings-custom-host-input"
                className={inputCls}
                placeholder={t("remote.customHostPlaceholder")}
                value={remote.customHostInput}
                onChange={(event) => update({ customHostInput: event.target.value })}
              />
              <button
                type="button"
                data-testid="remote-settings-custom-host-add"
                onClick={handleAddCustomHost}
                className="hover-bg shrink-0 rounded px-3 py-1.5 text-xs"
                style={{
                  color: "var(--accent)",
                  background: "transparent",
                  border: "1px solid var(--border)",
                  cursor: "pointer",
                }}
              >
                {t("remote.addCustomHost")}
              </button>
            </div>
            {remote.customHosts.length > 0 && (
              <div className="flex flex-col gap-1">
                {remote.customHosts.map((host) => (
                  <div key={host} className="flex items-center gap-2 text-[12px]">
                    <code
                      className="min-w-0 flex-1 truncate rounded px-2 py-1"
                      style={{
                        color: "var(--text-primary)",
                        background: "var(--bg-base)",
                        border: "1px solid var(--border)",
                      }}
                    >
                      {host}
                    </code>
                    <button
                      type="button"
                      data-testid={`remote-settings-custom-host-remove-${host}`}
                      onClick={() => handleRemoveCustomHost(host)}
                      className="hover-bg shrink-0 rounded px-2 py-1 text-[11px]"
                      style={{
                        color: "var(--red)",
                        background: "transparent",
                        border: "1px solid var(--border)",
                        cursor: "pointer",
                      }}
                    >
                      {t("common.remove")}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </SettingRow>

        <SettingRow label={t("remote.preferredHost")} desc={t("remote.preferredHostDesc")}>
          <FocusSelect
            data-testid="remote-settings-preferred-host-select"
            className={inputCls}
            value={remote.preferredHost}
            onChange={(event) => update({ preferredHost: event.target.value })}
          >
            <option value="">{t("remote.hostAuto")}</option>
            {!preferredAvailable && (
              <option value={remote.preferredHost}>{remote.preferredHost}</option>
            )}
            {hostOptions.map((option) => (
              <option key={`${option.kind}:${option.host}`} value={option.host}>
                {option.label}
              </option>
            ))}
          </FocusSelect>
        </SettingRow>
      </SubGroup>

      <SubGroup title={t("remote.groupCloud")}>
        <SettingRow label={t("remote.cloudStatus")}>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span
              data-testid="remote-settings-cloud-status"
              className="min-w-0 text-[12px]"
              style={{
                color:
                  cloudStatusError || cloudStatus?.lastError ? "var(--red)" : "var(--text-primary)",
              }}
            >
              {cloudStatusText}
            </span>
            <button
              type="button"
              data-testid="remote-settings-cloud-connect"
              onClick={handleCloudConnect}
              disabled={cloudConnectPending || cloudDisconnectPending}
              className="hover-bg rounded px-2 py-1 text-[11px] disabled:cursor-not-allowed disabled:opacity-50"
              style={{
                color: "var(--accent)",
                background: "transparent",
                border: "1px solid var(--border)",
                cursor: cloudConnectPending || cloudDisconnectPending ? "not-allowed" : "pointer",
              }}
            >
              {cloudConnectPending ? t("remote.cloudConnecting") : t("remote.cloudConnect")}
            </button>
            {showCloudDisconnect && (
              <button
                type="button"
                data-testid="remote-settings-cloud-disconnect"
                onClick={handleCloudDisconnect}
                disabled={cloudDisconnectPending || cloudConnectPending}
                className="hover-bg rounded px-2 py-1 text-[11px] disabled:cursor-not-allowed disabled:opacity-50"
                style={{
                  color: "var(--red)",
                  background: "transparent",
                  border: "1px solid var(--border)",
                  cursor: cloudDisconnectPending || cloudConnectPending ? "not-allowed" : "pointer",
                }}
              >
                {cloudDisconnectPending
                  ? t("remote.cloudDisconnecting")
                  : t("remote.cloudDisconnect")}
              </button>
            )}
          </div>
        </SettingRow>

        <SettingRow label={t("remote.cloudRelayBaseUrl")} desc={t("remote.cloudRelayBaseUrlDesc")}>
          <FocusInput
            data-testid="remote-settings-cloud-relay-base-url-input"
            className={inputCls}
            placeholder="https://relay.example.com"
            value={remote.relayBaseUrl}
            onChange={(event) => update({ relayBaseUrl: event.target.value })}
          />
        </SettingRow>
      </SubGroup>
    </div>
  );
}

// -- Section: Workspaces --

function WorkspacesSection() {
  const { t } = useTranslation("settings");
  const storeWsSelector = useSettingsStore((s) => s.workspaceSelector);
  const setWorkspaceSelector = useSettingsStore((s) => s.setWorkspaceSelector);
  const storeSyncCwdDefaults = useSettingsStore((s) => s.syncCwdDefaults);
  const setSyncCwdDefaults = useSettingsStore((s) => s.setSyncCwdDefaults);
  const [wsSelector, setDraftWsSelector] = useDraft("workspaceSelector", storeWsSelector, (v) =>
    setWorkspaceSelector(v),
  );
  const [syncCwdDefaults, setDraftSyncCwdDefaults] = useDraft(
    "syncCwdDefaults",
    storeSyncCwdDefaults,
    (v) => setSyncCwdDefaults(v),
  );
  const wsDisplay = wsSelector.display;
  const updateWsDisplay = (partial: Partial<typeof wsDisplay>) =>
    setDraftWsSelector((prev) => ({ ...prev, display: { ...prev.display, ...partial } }));
  const updateWsSelector = (partial: Partial<typeof wsSelector>) =>
    setDraftWsSelector((prev) => ({ ...prev, ...partial }));
  const updateSyncCwdDefault = (
    location: "workspace" | "dock",
    key: "send" | "receive",
    value: boolean,
  ) =>
    setDraftSyncCwdDefaults((prev) => ({
      ...prev,
      [location]: { ...prev[location], [key]: value },
    }));

  const displayItems: { key: keyof typeof wsDisplay; label: string; desc: string }[] = [
    { key: "minimap", label: t("workspaces.minimap"), desc: t("workspaces.minimapDesc") },
    {
      key: "environment",
      label: t("workspaces.environment"),
      desc: t("workspaces.environmentDesc"),
    },
    { key: "activity", label: t("workspaces.activity"), desc: t("workspaces.activityDesc") },
    { key: "path", label: t("workspaces.path"), desc: t("workspaces.pathDesc") },
    { key: "result", label: t("workspaces.result"), desc: t("workspaces.resultDesc") },
  ];

  return (
    <div>
      <SectionTitle>{t("workspaces.title")}</SectionTitle>

      <SubGroup title={t("workspaces.groupDisplay")}>
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
                  {wsDisplay[item.key] ? t("common.enabled") : t("common.disabled")}
                </span>
              </label>
            </div>
          </div>
        ))}
      </SubGroup>

      <SubGroup title={t("workspaces.groupBehavior")}>
        <SettingRow label={t("workspaces.pathEllipsis")} desc={t("workspaces.pathEllipsisDesc")}>
          <FocusSelect
            data-testid="path-ellipsis-select"
            className={inputCls}
            value={wsSelector.pathEllipsis}
            onChange={(e) => updateWsSelector({ pathEllipsis: e.target.value as "start" | "end" })}
          >
            <option value="start">{t("workspaces.ellipsisStart")}</option>
            <option value="end">{t("workspaces.ellipsisEnd")}</option>
          </FocusSelect>
        </SettingRow>

        <SettingRow
          label={t("workspaces.hiddenAutoClose")}
          desc={t("workspaces.hiddenAutoCloseDesc")}
        >
          <div className="flex items-center gap-2">
            <FocusInput
              data-testid="hidden-auto-close-seconds-input"
              type="number"
              min={0}
              step={30}
              className={inputCls}
              style={{ width: 80 }}
              value={wsSelector.hiddenAutoCloseSeconds}
              onChange={(e) =>
                updateWsSelector({
                  hiddenAutoCloseSeconds: Math.max(0, Math.floor(Number(e.target.value))),
                })
              }
            />
            <span className="text-[11px]" style={{ color: "var(--text-secondary)" }}>
              {t("common.seconds")}
            </span>
          </div>
        </SettingRow>
      </SubGroup>

      <SubGroup title={t("workspaces.groupCwdDefaults")}>
        {(["workspace", "dock"] as const).map((location, i) => {
          const label =
            location === "workspace" ? t("workspaces.cwdWorkspace") : t("workspaces.cwdDock");
          const desc =
            location === "workspace"
              ? t("workspaces.cwdWorkspaceDesc")
              : t("workspaces.cwdDockDesc");
          const value = syncCwdDefaults[location];
          return (
            <div key={location} className={`flex items-start gap-3 py-1${i > 0 ? " mt-2" : ""}`}>
              <div className="w-36 shrink-0 pt-1">
                <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
                  {label}
                </span>
                <p
                  className="mt-0.5 text-[11px] leading-tight"
                  style={{ color: "var(--text-secondary)", opacity: 0.65 }}
                >
                  {desc}
                </p>
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap gap-x-5 gap-y-2">
                  <label className="flex cursor-pointer items-center gap-2">
                    <input
                      data-testid={`sync-cwd-${location}-send-toggle`}
                      type="checkbox"
                      checked={value.send}
                      onChange={(e) => updateSyncCwdDefault(location, "send", e.target.checked)}
                    />
                    <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
                      {t("workspaces.send")}
                    </span>
                  </label>
                  <label className="flex cursor-pointer items-center gap-2">
                    <input
                      data-testid={`sync-cwd-${location}-receive-toggle`}
                      type="checkbox"
                      checked={value.receive}
                      onChange={(e) => updateSyncCwdDefault(location, "receive", e.target.checked)}
                    />
                    <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
                      {t("workspaces.receive")}
                    </span>
                  </label>
                </div>
              </div>
            </div>
          );
        })}
      </SubGroup>
    </div>
  );
}

// -- Section: Claude Code --

const DEFAULT_STATUS_MESSAGE_DELIMITER = " · ";

function ClaudeSection() {
  const { t } = useTranslation("settings");
  const storeClaude = useSettingsStore((s) => s.claude);
  const setClaude = useSettingsStore((s) => s.setClaude);
  const [claude, setDraftClaude] = useDraft("claude", storeClaude, (v) => setClaude(v));
  const updateClaude = (partial: Partial<typeof claude>) =>
    setDraftClaude((prev) => ({ ...prev, ...partial }));

  return (
    <div>
      <SectionTitle>{t("claude.title")}</SectionTitle>

      <SubGroup title={t("claude.groupSyncCwd")}>
        {/* Sync CWD mode */}
        <div className="flex items-start gap-3 py-1.5">
          <div className="w-36 shrink-0 pt-1">
            <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
              {t("claude.syncCwd")}
            </span>
            <p
              className="mt-0.5 text-[11px] leading-tight"
              style={{ color: "var(--text-secondary)", opacity: 0.65 }}
            >
              {t("claude.syncCwdDesc")}
            </p>
          </div>
          <div className="min-w-0 flex-1">
            <FocusSelect
              data-testid="claude-sync-cwd-select"
              className={inputCls}
              value={claude.syncCwd}
              onChange={(e) => updateClaude({ syncCwd: e.target.value as "skip" | "command" })}
            >
              <option value="skip">{t("claude.syncCwdSkip")}</option>
              <option value="command">{t("claude.syncCwdCommand")}</option>
            </FocusSelect>
          </div>
        </div>
      </SubGroup>

      <SubGroup title={t("claude.groupSessionRestore")}>
        {/* Restore Session */}
        <div className="flex items-start gap-3 py-1.5">
          <div className="w-36 shrink-0 pt-1">
            <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
              {t("claude.restoreSession")}
            </span>
            <p
              className="mt-0.5 text-[11px] leading-tight"
              style={{ color: "var(--text-secondary)", opacity: 0.65 }}
            >
              {t("claude.restoreSessionDesc")}
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
                {claude.restoreSession ? t("common.enabled") : t("common.disabled")}
              </span>
            </label>
          </div>
        </div>

        {/* Session Max Age */}
        <div className="flex items-start gap-3 py-1.5">
          <div className="w-36 shrink-0 pt-1">
            <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
              {t("claude.sessionMaxAge")}
            </span>
            <p
              className="mt-0.5 text-[11px] leading-tight"
              style={{ color: "var(--text-secondary)", opacity: 0.65 }}
            >
              {t("claude.sessionMaxAgeDesc")}
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
                {t("common.hours")}
              </span>
            </div>
          </div>
        </div>
      </SubGroup>

      <SubGroup title={t("claude.groupStatusMessage")}>
        {/* Status Message Mode */}
        <div className="flex items-start gap-3 py-1.5">
          <div className="w-36 shrink-0 pt-1">
            <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
              {t("claude.statusMessageMode")}
            </span>
            <p
              className="mt-0.5 text-[11px] leading-tight"
              style={{ color: "var(--text-secondary)", opacity: 0.65 }}
            >
              {t("claude.statusMessageModeDesc")}
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
              <option value="bullet-title">{t("claude.modeBulletTitle")}</option>
              <option value="title-bullet">{t("claude.modeTitleBullet")}</option>
              <option value="bullet">{t("claude.modeBullet")}</option>
              <option value="title">{t("claude.modeTitle")}</option>
            </FocusSelect>
          </div>
        </div>

        {/* Status Message Delimiter */}
        {(claude.statusMessageMode === "bullet-title" ||
          claude.statusMessageMode === "title-bullet") && (
          <div className="flex items-start gap-3 py-1.5">
            <div className="w-36 shrink-0 pt-1">
              <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
                {t("claude.delimiter")}
              </span>
              <p
                className="mt-0.5 text-[11px] leading-tight"
                style={{ color: "var(--text-secondary)", opacity: 0.65 }}
              >
                {t("claude.delimiterDesc")}
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
                    {t("common.default")}
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </SubGroup>

      <SubGroup title={t("claude.groupAutoResume")}>
        {/* Session Limit Auto Resume (issue #312) */}
        <div className="flex items-start gap-3 py-1.5">
          <div className="w-36 shrink-0 pt-1">
            <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
              {t("claude.autoResume")}
            </span>
            <p
              className="mt-0.5 text-[11px] leading-tight"
              style={{ color: "var(--text-secondary)", opacity: 0.65 }}
            >
              {t("claude.autoResumeDesc")}
            </p>
          </div>
          <div className="min-w-0 flex-1 pt-1">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                data-testid="claude-session-limit-auto-resume-toggle"
                type="checkbox"
                checked={claude.sessionLimitAutoResume}
                onChange={(e) => updateClaude({ sessionLimitAutoResume: e.target.checked })}
              />
              <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
                {claude.sessionLimitAutoResume ? t("common.enabled") : t("common.disabled")}
              </span>
            </label>
          </div>
        </div>

        {claude.sessionLimitAutoResume && (
          <>
            {/* Session Limit Resume Delay */}
            <div className="flex items-start gap-3 py-1.5">
              <div className="w-36 shrink-0 pt-1">
                <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
                  {t("claude.resumeDelay")}
                </span>
                <p
                  className="mt-0.5 text-[11px] leading-tight"
                  style={{ color: "var(--text-secondary)", opacity: 0.65 }}
                >
                  {t("claude.resumeDelayDesc")}
                </p>
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <FocusInput
                    data-testid="claude-session-limit-resume-delay-input"
                    className={inputCls}
                    type="number"
                    min={0}
                    style={{ width: 80 }}
                    value={claude.sessionLimitResumeDelaySeconds}
                    onChange={(e) => {
                      const parsed = parseInt(e.target.value, 10);
                      updateClaude({
                        sessionLimitResumeDelaySeconds: Number.isNaN(parsed)
                          ? 60
                          : Math.max(0, parsed),
                      });
                    }}
                  />
                  <span className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
                    {t("common.seconds")}
                  </span>
                </div>
              </div>
            </div>

            {/* Session Limit Resume Message */}
            <div className="flex items-start gap-3 py-1.5">
              <div className="w-36 shrink-0 pt-1">
                <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
                  {t("claude.resumeMessage")}
                </span>
                <p
                  className="mt-0.5 text-[11px] leading-tight"
                  style={{ color: "var(--text-secondary)", opacity: 0.65 }}
                >
                  {t("claude.resumeMessageDesc")}
                </p>
              </div>
              <div className="min-w-0 flex-1">
                <FocusInput
                  data-testid="claude-session-limit-resume-message-input"
                  className={inputCls}
                  type="text"
                  style={{ width: 200 }}
                  value={claude.sessionLimitResumeMessage}
                  onChange={(e) => updateClaude({ sessionLimitResumeMessage: e.target.value })}
                />
              </div>
            </div>
          </>
        )}
      </SubGroup>
    </div>
  );
}

function CodexSection() {
  const { t } = useTranslation("settings");
  const storeCodex = useSettingsStore((s) => s.codex);
  const setCodex = useSettingsStore((s) => s.setCodex);
  const [codex, setDraftCodex] = useDraft("codex", storeCodex, (v) => setCodex(v));
  const updateCodex = (partial: Partial<typeof codex>) =>
    setDraftCodex((prev) => ({ ...prev, ...partial }));

  return (
    <div>
      <SectionTitle>{t("codex.title")}</SectionTitle>

      <div style={cardStyle} className="p-4">
        <div className="flex items-start gap-3 py-1.5">
          <div className="w-36 shrink-0 pt-1">
            <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
              {t("codex.statusMessageMode")}
            </span>
            <p
              className="mt-0.5 text-[11px] leading-tight"
              style={{ color: "var(--text-secondary)", opacity: 0.65 }}
            >
              {t("codex.statusMessageModeDesc")}
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
              <option value="title">{t("codex.modeTitle")}</option>
              <option value="bullet-title">{t("codex.modeBulletTitle")}</option>
              <option value="title-bullet">{t("codex.modeTitleBullet")}</option>
              <option value="bullet">{t("codex.modeBullet")}</option>
            </FocusSelect>
          </div>
        </div>

        {(codex.statusMessageMode === "bullet-title" ||
          codex.statusMessageMode === "title-bullet") && (
          <div className="flex items-start gap-3 py-1.5">
            <div className="w-36 shrink-0 pt-1">
              <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
                {t("codex.delimiter")}
              </span>
              <p
                className="mt-0.5 text-[11px] leading-tight"
                style={{ color: "var(--text-secondary)", opacity: 0.65 }}
              >
                {t("codex.delimiterDesc")}
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
                    {t("common.default")}
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
  const { t } = useTranslation("settings");
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
      <SectionTitle>{t("fileExplorer.title")}</SectionTitle>

      <SubGroup title={t("fileExplorer.groupShell")}>
        {/* Shell Profile */}
        <SettingRow
          label={t("fileExplorer.shellProfile")}
          desc={t("fileExplorer.shellProfileDesc")}
        >
          <FocusSelect
            data-testid="fe-shell-profile"
            className={inputCls}
            value={fe.shellProfile}
            onChange={(e) => updateFe({ shellProfile: e.target.value })}
          >
            <option value="">{t("fileExplorer.shellProfileDefault")}</option>
            {profiles.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
          </FocusSelect>
        </SettingRow>
      </SubGroup>

      <SubGroup title={t("fileExplorer.groupAppearance")}>
        {/* Font */}
        <SettingRow label={t("fileExplorer.fontFamily")} desc={t("fileExplorer.fontFamilyDesc")}>
          <FocusInput
            data-testid="fe-font-family"
            className={inputCls}
            placeholder={t("fileExplorer.fontFamilyPlaceholder")}
            value={fe.fontFamily}
            onChange={(e) => updateFe({ fontFamily: e.target.value })}
          />
        </SettingRow>

        <SettingRow label={t("fileExplorer.fontSize")} desc={t("fileExplorer.fontSizeDesc")}>
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
              {t("fileExplorer.padding")}
            </span>
            <p
              className="mt-0.5 text-[11px] leading-tight"
              style={{ color: "var(--text-secondary)", opacity: 0.65 }}
            >
              {t("fileExplorer.paddingDesc")}
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
                      {t(`appearance.${dir.toLowerCase()}`)}
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
      </SubGroup>

      <SubGroup title={t("fileExplorer.groupBehavior")}>
        {/* Copy on Select */}
        <SettingRow
          label={t("fileExplorer.copyOnSelect")}
          desc={t("fileExplorer.copyOnSelectDesc")}
        >
          <label className="flex items-center gap-2">
            <input
              data-testid="fe-copy-on-select"
              type="checkbox"
              checked={fe.copyOnSelect}
              onChange={(e) => updateFe({ copyOnSelect: e.target.checked })}
            />
            <span className="text-[12px]" style={{ color: "var(--text-secondary)" }}>
              {t("common.enabledShort")}
            </span>
          </label>
        </SettingRow>

        {/* Extension Viewers */}
        <div className="flex items-start gap-3 py-1.5">
          <div className="w-36 shrink-0 pt-1">
            <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
              {t("fileExplorer.extensionViewers")}
            </span>
            <p
              className="mt-0.5 text-[11px] leading-tight"
              style={{ color: "var(--text-secondary)", opacity: 0.65 }}
            >
              {t("fileExplorer.extensionViewersDesc")}
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
                  {t("common.remove")}
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
              {t("fileExplorer.addViewer")}
            </button>
          </div>
        </div>
      </SubGroup>
    </div>
  );
}

function IssueReporterSection() {
  const { t } = useTranslation("settings");
  const storeIssueReporter = useSettingsStore((s) => s.issueReporter);
  const setIssueReporter = useSettingsStore((s) => s.setIssueReporter);
  const appFont = useSettingsStore((s) => s.appearance.font);
  const monoFonts = useMonospacedFonts();
  const [issueReporter, setDraftIssueReporter] = useDraft(
    "issueReporter",
    storeIssueReporter,
    (v) => setIssueReporter(v),
  );
  const updateIssueReporter = (partial: Partial<typeof issueReporter>) =>
    setDraftIssueReporter((prev) => ({ ...prev, ...partial }));

  const addRepository = () =>
    updateIssueReporter({ repositories: [...issueReporter.repositories, ""] });
  const removeRepository = (index: number) =>
    updateIssueReporter({
      repositories: issueReporter.repositories.filter((_, i) => i !== index),
    });
  const updateRepository = (index: number, value: string) =>
    updateIssueReporter({
      repositories: issueReporter.repositories.map((r, i) => (i === index ? value : r)),
    });

  // Adapt flat fontFamily/fontSize/fontWeight to FontSettings for FontFields
  const irFont: FontSettings = {
    face: issueReporter.fontFamily || appFont.face,
    size: issueReporter.fontSize || appFont.size,
    weight: issueReporter.fontWeight || appFont.weight,
  };

  return (
    <div>
      <SectionTitle>{t("issueReporter.title")}</SectionTitle>

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
        faceDesc={t("font.inheritAppFont")}
      />

      <SubGroup title={t("issueReporter.groupSubmit")}>
        <SettingRow label={t("issueReporter.shell")} desc={t("issueReporter.shellDesc")}>
          <FocusInput
            data-testid="issue-reporter-shell-input"
            className={inputCls}
            placeholder={t("issueReporter.shellPlaceholder")}
            value={issueReporter.shell}
            onChange={(e) => updateIssueReporter({ shell: e.target.value })}
          />
        </SettingRow>

        {/* Repositories */}
        <div className="flex items-start gap-3 py-1.5">
          <div className="w-36 shrink-0 pt-1">
            <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
              {t("issueReporter.repositories")}
            </span>
            <p
              className="mt-0.5 text-[11px] leading-tight"
              style={{ color: "var(--text-secondary)", opacity: 0.65 }}
            >
              {t("issueReporter.repositoriesDesc")}
            </p>
          </div>
          <div className="min-w-0 flex-1">
            {issueReporter.repositories.map((repo, i) => (
              <div key={i} className="flex items-center gap-2 mb-2">
                <FocusInput
                  data-testid={`issue-reporter-repo-input-${i}`}
                  className={inputCls}
                  style={{ flex: 1 }}
                  placeholder="owner/repo"
                  value={repo}
                  onChange={(e) => updateRepository(i, e.target.value)}
                />
                <button
                  data-testid={`issue-reporter-repo-remove-${i}`}
                  className="text-xs px-1.5 py-0.5 rounded"
                  style={{
                    background: "var(--bg-overlay)",
                    color: "var(--red)",
                    border: "1px solid var(--border)",
                  }}
                  onClick={() => removeRepository(i)}
                >
                  {t("common.remove")}
                </button>
              </div>
            ))}
            <button
              data-testid="issue-reporter-repo-add"
              className="text-xs px-2 py-1 rounded"
              style={{
                background: "var(--bg-overlay)",
                color: "var(--accent)",
                border: "1px solid var(--border)",
              }}
              onClick={addRepository}
            >
              {t("issueReporter.addRepository")}
            </button>
          </div>
        </div>
      </SubGroup>

      <SubGroup title={t("issueReporter.groupAppearance")}>
        {/* Padding */}
        <div className="flex items-start gap-3 py-1.5">
          <div className="w-36 shrink-0 pt-1">
            <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
              {t("issueReporter.padding")}
            </span>
            <p
              className="mt-0.5 text-[11px] leading-tight"
              style={{ color: "var(--text-secondary)", opacity: 0.65 }}
            >
              {t("issueReporter.paddingDesc")}
            </p>
          </div>
          <div className="min-w-0 flex-1">
            <div className="grid grid-cols-2 gap-2">
              {(["Top", "Right", "Bottom", "Left"] as const).map((dir) => {
                const key = `padding${dir}` as keyof typeof issueReporter;
                return (
                  <label key={dir} className="flex items-center gap-1.5">
                    <span className="w-12 text-[11px]" style={{ color: "var(--text-secondary)" }}>
                      {t(`appearance.${dir.toLowerCase()}`)}
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
      </SubGroup>
    </div>
  );
}

// -- Section: Memo --

function MemoSection() {
  const { t } = useTranslation("settings");
  const storeMemo = useSettingsStore((s) => s.memo);
  const setMemo = useSettingsStore((s) => s.setMemo);
  const appFont = useSettingsStore((s) => s.appearance.font);
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
      <SectionTitle>{t("memo.title")}</SectionTitle>

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
        faceDesc={t("font.inheritAppFont")}
      />

      <SubGroup title={t("memo.groupLayout")}>
        {/* Padding */}
        <div className="flex items-start gap-3 py-1.5">
          <div className="w-36 shrink-0 pt-1">
            <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
              {t("memo.padding")}
            </span>
            <p
              className="mt-0.5 text-[11px] leading-tight"
              style={{ color: "var(--text-secondary)", opacity: 0.65 }}
            >
              {t("memo.paddingDesc")}
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
                      {t(`appearance.${dir.toLowerCase()}`)}
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

        {/* Indent Size */}
        <div className="flex items-start gap-3 py-1.5">
          <div className="w-36 shrink-0 pt-1">
            <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
              {t("memo.indentSize")}
            </span>
            <p
              className="mt-0.5 text-[11px] leading-tight"
              style={{ color: "var(--text-secondary)", opacity: 0.65 }}
            >
              {t("memo.indentSizeDesc")}
            </p>
          </div>
          <div className="min-w-0 flex-1">
            <input
              data-testid="memo-indent-size"
              type="number"
              min={1}
              max={8}
              className={inputCls}
              style={{ width: 60 }}
              value={memo.indentSize}
              onChange={(e) =>
                updateMemo({
                  indentSize: Math.max(1, Math.min(8, Number(e.target.value) || 2)),
                })
              }
            />
          </div>
        </div>
      </SubGroup>

      <SubGroup title={t("memo.groupBehavior")}>
        {/* Paragraph Detection */}
        <div className="flex items-start gap-3 py-1.5">
          <div className="w-36 shrink-0 pt-1">
            <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
              {t("memo.paragraphDetection")}
            </span>
            <p
              className="mt-0.5 text-[11px] leading-tight"
              style={{ color: "var(--text-secondary)", opacity: 0.65 }}
            >
              {t("memo.paragraphDetectionDesc")}
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
                  {t("common.enabledShort")}
                </span>
              </label>
              <label className="flex items-center gap-1.5">
                <span className="text-[11px]" style={{ color: "var(--text-secondary)" }}>
                  {t("memo.blankLineCount")}
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

        {/* Triple-click Paragraph Select */}
        <div className="flex items-start gap-3 py-1.5">
          <div className="w-36 shrink-0 pt-1">
            <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
              {t("memo.tripleClickSelect")}
            </span>
            <p
              className="mt-0.5 text-[11px] leading-tight"
              style={{ color: "var(--text-secondary)", opacity: 0.65 }}
            >
              {t("memo.tripleClickSelectDesc")}
            </p>
          </div>
          <div className="min-w-0 flex-1">
            <label className="flex items-center gap-1.5">
              <input
                data-testid="memo-triple-click-paragraph-select"
                type="checkbox"
                checked={memo.tripleClickParagraphSelect}
                onChange={(e) => updateMemo({ tripleClickParagraphSelect: e.target.checked })}
              />
              <span className="text-[12px]" style={{ color: "var(--text-secondary)" }}>
                {t("common.enabledShort")}
              </span>
            </label>
          </div>
        </div>

        {/* Copy on Select */}
        <div className="flex items-start gap-3 py-1.5">
          <div className="w-36 shrink-0 pt-1">
            <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
              {t("memo.copyOnSelect")}
            </span>
            <p
              className="mt-0.5 text-[11px] leading-tight"
              style={{ color: "var(--text-secondary)", opacity: 0.65 }}
            >
              {t("memo.copyOnSelectDesc")}
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
                {t("common.enabledShort")}
              </span>
            </label>
          </div>
        </div>
      </SubGroup>
    </div>
  );
}

// -- Section: Keybindings --

const defaultKeybindings = DEFAULT_KEYBINDINGS;

const kbdStyle: React.CSSProperties = {
  background: "var(--bg-surface)",
  border: "1px solid var(--border)",
  borderBottom: "2px solid var(--border)",
  borderRadius: "var(--radius-md)",
  padding: "2px 8px",
  fontFamily: "var(--ui-font)",
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
  const { t } = useTranslation("settings");
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
      <SectionTitle>{t("keybindings.title")}</SectionTitle>

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
                      const raw = keyEventToString(e.nativeEvent);
                      if (!raw) return;
                      // Wildcard actions (`pane.focus` = "Alt+Arrow") bind all four
                      // directions at once — pressing any arrow during capture keeps
                      // the `Arrow` token instead of narrowing to a single direction.
                      // Non-arrow captures are rejected outright: the handler derives
                      // its direction from the pressed arrow, so a non-arrow binding
                      // could never do anything (PR #338 review).
                      let str = raw;
                      if (usesArrowWildcard(def.defaultKeys)) {
                        str = coerceArrowWildcard(raw);
                        if (str === raw) return;
                      }
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
                      fontFamily: "var(--ui-font)",
                      fontSize: "var(--fs-sm)",
                    }}
                  >
                    {capturedKeys || (
                      <span style={{ opacity: 0.5 }}>{t("keybindings.pressKeys")}</span>
                    )}
                  </div>
                ) : (
                  <kbd
                    style={{ ...kbdStyle, cursor: "pointer" }}
                    onClick={() => handleStartCapture(def.id, def.defaultKeys)}
                    title={t("keybindings.changeShortcut")}
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
                      title={t("common.resetToDefault")}
                    >
                      {t("common.reset")}
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
              placeholder={t("keybindings.actionPlaceholder")}
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
                  fontFamily: "var(--ui-font)",
                  fontSize: "var(--fs-sm)",
                }}
              >
                {kb.keys || <span style={{ opacity: 0.5 }}>{t("keybindings.pressKeys")}</span>}
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
                title={t("common.remove")}
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
          {t("keybindings.addBinding")}
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
  const { t } = useTranslation("settings");
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
    const shouldReconcileRemote = dirtySetRef.current.has("remote");
    const previousRemoteEnabled = useSettingsStore.getState().remote.enabled;
    // Flush all draft states to store first
    for (const fn of flushMapRef.current.values()) fn();
    const nextRemoteEnabled = useSettingsStore.getState().remote.enabled;
    draftValuesRef.current.clear();
    dirtySetRef.current.clear();
    setDirty(false);
    clearTimeout(saveTimerRef.current);
    persistSession()
      .then(async () => {
        if (shouldReconcileRemote) {
          await reconcileRemoteAccessAfterRemoteSave(previousRemoteEnabled, nextRemoteEnabled);
        }
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
            title={t("nav.openJsonTitle")}
          >
            {t("nav.openJson")}
          </button>

          {/* Appearance */}
          <NavGroupHeader label={t("nav.groupAppearance")} />
          <button
            className="w-full px-4 py-2 text-left text-[13px]"
            style={navBtnStyle("startup")}
            onClick={() => setActiveNav("startup")}
            onMouseEnter={() => setNavHover("startup")}
            onMouseLeave={() => setNavHover(null)}
          >
            {t("nav.startup")}
          </button>
          <button
            data-testid="nav-font"
            className="w-full px-4 py-2 text-left text-[13px]"
            style={navBtnStyle("font")}
            onClick={() => setActiveNav("font")}
            onMouseEnter={() => setNavHover("font")}
            onMouseLeave={() => setNavHover(null)}
          >
            {t("nav.appFont")}
          </button>

          {/* Terminal */}
          <NavGroupHeader label={t("nav.groupTerminal")} />
          <button
            className="w-full px-4 py-2 text-left text-[13px]"
            style={navBtnStyle("colorSchemes")}
            onClick={() => setActiveNav("colorSchemes")}
            onMouseEnter={() => setNavHover("colorSchemes")}
            onMouseLeave={() => setNavHover(null)}
          >
            {t("nav.colorSchemes")}
          </button>
          <button
            data-testid="nav-terminal"
            className="w-full px-4 py-2 text-left text-[13px]"
            style={navBtnStyle("terminal")}
            onClick={() => setActiveNav("terminal")}
            onMouseEnter={() => setNavHover("terminal")}
            onMouseLeave={() => setNavHover(null)}
          >
            {t("nav.terminal")}
          </button>
          <button
            data-testid="nav-paste"
            className="w-full px-4 py-2 text-left text-[13px]"
            style={navBtnStyle("paste")}
            onClick={() => setActiveNav("paste")}
            onMouseEnter={() => setNavHover("paste")}
            onMouseLeave={() => setNavHover(null)}
          >
            {t("nav.paste")}
          </button>

          {/* Interface */}
          <NavGroupHeader label={t("nav.groupInterface")} />
          <button
            data-testid="nav-interface"
            className="w-full px-4 py-2 text-left text-[13px]"
            style={navBtnStyle("interface")}
            onClick={() => setActiveNav("interface")}
            onMouseEnter={() => setNavHover("interface")}
            onMouseLeave={() => setNavHover(null)}
          >
            {t("nav.interface")}
          </button>
          <button
            data-testid="nav-workspaceDisplay"
            className="w-full px-4 py-2 text-left text-[13px]"
            style={navBtnStyle("workspaceDisplay")}
            onClick={() => setActiveNav("workspaceDisplay")}
            onMouseEnter={() => setNavHover("workspaceDisplay")}
            onMouseLeave={() => setNavHover(null)}
          >
            {t("nav.workspaces")}
          </button>

          {/* Integrations */}
          <NavGroupHeader label={t("nav.groupIntegrations")} />
          <button
            data-testid="nav-remote"
            className="w-full px-4 py-2 text-left text-[13px]"
            style={navBtnStyle("remote")}
            onClick={() => setActiveNav("remote")}
            onMouseEnter={() => setNavHover("remote")}
            onMouseLeave={() => setNavHover(null)}
          >
            {t("nav.remote")}
          </button>
          <button
            data-testid="nav-claude"
            className="w-full px-4 py-2 text-left text-[13px]"
            style={navBtnStyle("claude")}
            onClick={() => setActiveNav("claude")}
            onMouseEnter={() => setNavHover("claude")}
            onMouseLeave={() => setNavHover(null)}
          >
            {t("nav.claude")}
          </button>
          <button
            data-testid="nav-codex"
            className="w-full px-4 py-2 text-left text-[13px]"
            style={navBtnStyle("codex")}
            onClick={() => setActiveNav("codex")}
            onMouseEnter={() => setNavHover("codex")}
            onMouseLeave={() => setNavHover(null)}
          >
            {t("nav.codex")}
          </button>

          {/* Views */}
          <NavGroupHeader label={t("nav.groupViews")} />
          <button
            data-testid="nav-memo"
            className="w-full px-4 py-2 text-left text-[13px]"
            style={navBtnStyle("memo")}
            onClick={() => setActiveNav("memo")}
            onMouseEnter={() => setNavHover("memo")}
            onMouseLeave={() => setNavHover(null)}
          >
            {t("nav.memo")}
          </button>
          <button
            data-testid="nav-fileExplorer"
            className="w-full px-4 py-2 text-left text-[13px]"
            style={navBtnStyle("fileExplorer")}
            onClick={() => setActiveNav("fileExplorer")}
            onMouseEnter={() => setNavHover("fileExplorer")}
            onMouseLeave={() => setNavHover(null)}
          >
            {t("nav.fileExplorer")}
          </button>
          <button
            data-testid="nav-issueReporter"
            className="w-full px-4 py-2 text-left text-[13px]"
            style={navBtnStyle("issueReporter")}
            onClick={() => setActiveNav("issueReporter")}
            onMouseEnter={() => setNavHover("issueReporter")}
            onMouseLeave={() => setNavHover(null)}
          >
            {t("nav.issueReporter")}
          </button>

          {/* Input */}
          <NavGroupHeader label={t("nav.groupInput")} />
          <button
            className="w-full px-4 py-2 text-left text-[13px]"
            style={navBtnStyle("keybindings")}
            onClick={() => setActiveNav("keybindings")}
            onMouseEnter={() => setNavHover("keybindings")}
            onMouseLeave={() => setNavHover(null)}
          >
            {t("nav.keybindings")}
          </button>

          {/* Profiles group */}
          <div className="mt-3 flex items-center justify-between px-3 pb-1">
            <span
              className="text-[10px] uppercase tracking-wider"
              style={{ color: "var(--text-secondary)", opacity: 0.7 }}
            >
              {t("nav.groupProfiles")}
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
            {t("nav.profileDefaults")}
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
                  title={t("nav.deleteProfile")}
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
            {activeNav === "terminal" && <TerminalSection />}
            {activeNav === "paste" && <PasteSection />}
            {activeNav === "interface" && <InterfaceSection />}
            {activeNav === "workspaceDisplay" && <WorkspacesSection />}
            {activeNav === "remote" && <RemoteSection />}
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
              {t("save.discard")}
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
              {saveLabel === "Saved!"
                ? t("save.saved")
                : saveLabel === "Error!"
                  ? t("save.error")
                  : t("save.save")}
            </button>
          </div>
        </div>
      </div>
    </SettingsDraftContext.Provider>
  );
}
