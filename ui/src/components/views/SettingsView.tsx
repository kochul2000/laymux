import {
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
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
  USAGE_REFRESH_MAX_SECONDS,
  USAGE_REFRESH_MIN_SECONDS,
  USAGE_VISIBLE_ROW_KEYS,
  CODEX_USAGE_VISIBLE_ROW_KEYS,
  GROK_USAGE_VISIBLE_ROW_KEYS,
  type UsageVisibleRow,
  type CodexUsageVisibleRow,
  type GrokUsageVisibleRow,
  type Keybinding,
  type LanguageSetting,
  type UpdateChannel,
} from "@/stores/settings-store";
import {
  cloudConnectStart,
  cloudDisconnect,
  getCloudStatus,
  loadSettings,
  checkAppUpdate,
  getAppUpdateStatus,
  installAppUpdate,
  onAppUpdateStatusChanged,
  openExternal,
  type AppUpdateStatus,
  getRemoteAccessStatus,
  setRemoteRuntimeAccess,
  type CloudStatus,
  type ExtensionViewer,
  type FileExplorerSettings,
  type GithubSettings,
  type RemoteSettings,
} from "@/lib/tauri-api";
import { Button } from "@/components/ui/Button";
import { ExternalLinkIcon, PlusIcon, XIcon } from "@/components/ui/icons";
import type { SyncCwdConfig } from "@/lib/sync-cwd-config";
import {
  GITHUB_FONT_SIZE_MAX,
  GITHUB_FONT_SIZE_MIN,
  GITHUB_LABEL_MAX_COUNT_MAX,
  GITHUB_LABEL_MAX_WIDTH_MAX,
  GITHUB_LABEL_MAX_WIDTH_MIN,
  GITHUB_NUMBER_COLORS,
  readGithubFontSize,
  readGithubLabelMaxCount,
  readGithubLabelMaxWidth,
} from "@/lib/github-display";
import { persistSession } from "@/lib/persist-session";
import {
  DEFAULT_KEYBINDINGS,
  coerceArrowWildcard,
  isAssignedKeybinding,
  usesArrowWildcard,
} from "@/lib/keybinding-registry";
import { toSupportedCursorShape } from "@/lib/cursor-settings";
import {
  readDesktopInputModePreference,
  writeDesktopInputModePreference,
  type ComposerHistoryScope,
  type InputMode,
} from "@/lib/terminal-input-composer-state";
import type { PastePathSeparator } from "@/lib/smart-text";
import { MONOSPACED_FONTS, getSystemMonospaceFonts } from "@/lib/system-fonts";
import { DEFAULT_AGENT_SESSION_MAX_AGE_HOURS } from "@/lib/agent-session-constants";
import {
  DEFAULT_CLAUDE_COMMAND,
  DEFAULT_CODEX_COMMAND,
  DEFAULT_GROK_COMMAND,
  isSafeAgentCommand,
  resolveAgentCommand,
} from "@/lib/agent-command";
import type { LinkActivationMode } from "@/lib/link-activation";
import { FocusInput, FocusSelect } from "@/components/ui/FormControls";
import { inputCls, inputStyle } from "@/components/ui/form-control-styles";
import { ToggleSwitch } from "@/components/ui/ToggleSwitch";
import { WidgetsSectionBody } from "./settings/WidgetsSection";
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
import {
  DEFAULT_FAST_SCROLL_SENSITIVITY,
  DEFAULT_SCROLL_SENSITIVITY,
  normalizeScrollSensitivity,
  SCROLL_SENSITIVITY_MAX,
  SCROLL_SENSITIVITY_MIN,
  SCROLL_SENSITIVITY_STEP,
} from "@/lib/scroll-sensitivity";
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

/** Where the update section links out to. The updater itself pins these in Rust. */
const RELEASES_URL = "https://github.com/kochul2000/laymux/releases";
const RELEASE_TAG_URL = (version: string) => `${RELEASES_URL}/tag/v${version}`;

function formatUpdateTimestamp(value: number | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = typeof value === "number" ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString();
}

/**
 * Version, channel, and the update actions in one place (ADR-0190).
 *
 * The channel is a settings draft like every other field here — it lands on
 * Save, and saving triggers a check because the backend reads the channel from
 * the file. Check and install are actions, not settings, so they run at once.
 */
function UpdateSection() {
  const { t } = useTranslation("settings");
  const storeUpdate = useSettingsStore((s) => s.update);
  const setUpdate = useSettingsStore((s) => s.setUpdate);
  const [update, setDraftUpdate] = useDraft("update", storeUpdate, (v) => setUpdate(v));

  const [status, setStatus] = useState<AppUpdateStatus | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  // Backend status is process-global, so lastError can come from the startup or
  // periodic checker. Settings only surfaces failures for an action initiated
  // from this section; background failures remain available in the snapshot
  // without turning into a persistent user-facing wall of transport text.
  const explicitUpdateActionRef = useRef(false);

  const settleExplicitUpdateAction = useCallback((snapshot: AppUpdateStatus) => {
    setStatus(snapshot);
    if (!explicitUpdateActionRef.current || snapshot.operation !== "idle") return;
    explicitUpdateActionRef.current = false;
    setRequestError(snapshot.lastError);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    void getAppUpdateStatus()
      .then((snapshot) => {
        if (!cancelled) setStatus(snapshot);
      })
      .catch(() => {});
    void onAppUpdateStatusChanged((snapshot) => {
      if (cancelled) return;
      if (!explicitUpdateActionRef.current && snapshot.operation === "checking") {
        setRequestError(null);
      }
      settleExplicitUpdateAction(snapshot);
    })
      .then((stop) => {
        if (cancelled) stop();
        else unlisten = stop;
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [settleExplicitUpdateAction]);

  const busy = status !== null && status.operation !== "idle";
  const available = status?.availableVersion ?? null;
  const error = requestError;
  // Why the manual check cannot run right now, as the sentence to show on the
  // button itself; null when it can run. The dev-build gate is enforced in Rust
  // (a debug binary must never replace itself with a release artifact), so the
  // UI only has to explain it.
  const checkDisabledReason = !status
    ? t("update.loadingStatus")
    : !status.enabled
      ? t("update.disabledInDev")
      : busy
        ? t("update.busy")
        : null;
  const checkedAt = formatUpdateTimestamp(status?.checkedAtMs);
  const publishedAt = formatUpdateTimestamp(status?.publishedAt);

  const runCheck = useCallback(() => {
    setRequestError(null);
    explicitUpdateActionRef.current = true;
    void checkAppUpdate()
      .then(settleExplicitUpdateAction)
      .catch((reason: unknown) => {
        explicitUpdateActionRef.current = false;
        setRequestError(reason instanceof Error ? reason.message : String(reason));
      });
  }, [settleExplicitUpdateAction]);

  const runInstall = useCallback(() => {
    if (!available) return;
    if (!window.confirm(t("update.installConfirm", { version: available }))) return;
    setRequestError(null);
    explicitUpdateActionRef.current = true;
    void installAppUpdate()
      .then(settleExplicitUpdateAction)
      .catch((reason: unknown) => {
        explicitUpdateActionRef.current = false;
        setRequestError(reason instanceof Error ? reason.message : String(reason));
      });
  }, [available, settleExplicitUpdateAction, t]);

  return (
    <div>
      <SectionTitle>{t("update.title")}</SectionTitle>

      <SubGroup title={t("update.groupVersion")}>
        <SettingRow label={t("update.currentVersion")}>
          <div className="flex flex-wrap items-center gap-2">
            <span
              data-testid="update-current-version"
              className="text-[13px]"
              style={{ color: "var(--text-primary)" }}
            >
              {status?.currentVersion ?? "—"}
            </span>
            <span
              data-testid="update-current-channel"
              className="rounded px-1.5 py-0.5 text-[11px]"
              style={{ color: "var(--text-secondary)", border: "1px solid var(--border)" }}
            >
              {status?.channel === "beta" ? t("update.channelBeta") : t("update.channelStable")}
            </span>
          </div>
        </SettingRow>

        <SettingRow label={t("update.releasePage")}>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              data-testid="update-open-current-release"
              icon={<ExternalLinkIcon />}
              disabled={!status?.currentVersion}
              title={t("update.opensInBrowser")}
              onClick={() => {
                if (status?.currentVersion)
                  void openExternal(RELEASE_TAG_URL(status.currentVersion));
              }}
            >
              {t("update.openCurrentRelease")}
            </Button>
            <Button
              data-testid="update-open-releases"
              icon={<ExternalLinkIcon />}
              title={t("update.opensInBrowser")}
              onClick={() => void openExternal(RELEASES_URL)}
            >
              {t("update.openReleases")}
            </Button>
          </div>
        </SettingRow>
      </SubGroup>

      <SubGroup title={t("update.groupChannel")}>
        <SettingRow label={t("update.channel")} desc={t("update.channelDesc")}>
          <FocusSelect
            data-testid="update-channel-select"
            className={inputCls}
            value={update.channel}
            onChange={(e) => setDraftUpdate({ channel: e.target.value as UpdateChannel })}
          >
            <option value="stable">{t("update.channelStable")}</option>
            <option value="beta">{t("update.channelBeta")}</option>
          </FocusSelect>
        </SettingRow>
        {update.channel === "beta" && (
          <p
            data-testid="update-channel-beta-warning"
            className="text-[11px]"
            style={{ color: "var(--claude)", margin: "0 0 8px" }}
          >
            {t("update.channelBetaWarning")}
          </p>
        )}
      </SubGroup>

      <SubGroup title={t("update.groupCheck")}>
        <SettingRow label={t("update.manualCheck")} desc={t("update.checkNowDesc")}>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="primary"
              data-testid="update-check-btn"
              disabled={checkDisabledReason !== null}
              // A disabled button has to say why it is disabled where the
              // pointer already is. The dev-build gate is the common case and
              // its explanation used to live only in a paragraph below.
              title={checkDisabledReason ?? undefined}
              onClick={runCheck}
            >
              {status?.operation === "checking" ? t("update.checking") : t("update.checkNow")}
            </Button>
            <span
              data-testid="update-checked-at"
              className="text-[11px]"
              style={{ color: "var(--text-secondary)" }}
            >
              {checkedAt ? t("update.checkedAt", { at: checkedAt }) : t("update.neverChecked")}
            </span>
          </div>
        </SettingRow>

        {status && !status.enabled && (
          <p
            data-testid="update-disabled-note"
            className="text-[11px]"
            style={{ color: "var(--text-secondary)", margin: "0 0 8px" }}
          >
            {t("update.disabledInDev")}
          </p>
        )}

        {status?.enabled === false ? null : available ? (
          <div
            data-testid="update-available"
            className="mt-1 rounded p-3"
            style={{ border: "1px solid var(--border)" }}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
                {t("update.availableVersion", { version: available })}
              </span>
              {publishedAt && (
                <span
                  data-testid="update-published-at"
                  className="text-[11px]"
                  style={{ color: "var(--text-secondary)" }}
                >
                  {t("update.publishedAt", { at: publishedAt })}
                </span>
              )}
            </div>
            {status?.notes && (
              <pre
                data-testid="update-notes"
                className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-[11px]"
                style={{ color: "var(--text-secondary)" }}
              >
                {status.notes}
              </pre>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <Button
                variant="primary"
                data-testid="update-install-btn"
                disabled={busy}
                title={busy ? t("update.busy") : undefined}
                onClick={runInstall}
              >
                {status?.operation === "downloading" || status?.operation === "installing"
                  ? t("update.installing")
                  : t("update.install")}
              </Button>
              <Button
                data-testid="update-open-available-release"
                icon={<ExternalLinkIcon />}
                title={t("update.opensInBrowser")}
                onClick={() => void openExternal(RELEASE_TAG_URL(available))}
              >
                {t("update.openReleaseNotes")}
              </Button>
            </div>
          </div>
        ) : (
          <p
            data-testid="update-up-to-date"
            className="text-[11px]"
            style={{ color: "var(--text-secondary)", margin: "0 0 8px" }}
          >
            {t("update.upToDate")}
          </p>
        )}

        {error && (
          <p
            data-testid="update-error"
            className="min-w-0 max-w-full break-words text-[11px] [overflow-wrap:anywhere]"
            style={{ color: "var(--claude)", margin: "0 0 8px" }}
          >
            {error}
          </p>
        )}
      </SubGroup>
    </div>
  );
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

  // Exit behavior (issue #451) lives under the top-level `exit` key but is
  // edited here in the Terminal section since it interrupts terminals.
  const storeExit = useSettingsStore((s) => s.exit);
  const setExit = useSettingsStore((s) => s.setExit);
  const [exit, setDraftExit] = useDraft("exit", storeExit, (v) => setExit(v));
  const updateExit = (partial: Partial<typeof exit>) =>
    setDraftExit((prev) => ({ ...prev, ...partial }));

  const storePaneClear = useSettingsStore((s) => s.paneClear);
  const setPaneClear = useSettingsStore((s) => s.setPaneClear);
  const [paneClear, setDraftPaneClear] = useDraft("paneClear", storePaneClear, (value) =>
    setPaneClear(value),
  );
  const updatePaneClear = (partial: Partial<typeof paneClear>) =>
    setDraftPaneClear((previous) => ({ ...previous, ...partial }));

  // Default input mode is a desktop-surface UI preference (localStorage), not part
  // of the Rust-backed settings.json — so it stays outside the terminal draft.
  const [defaultInputMode, setDefaultInputMode] = useState<InputMode>(() =>
    readDesktopInputModePreference(),
  );
  const changeDefaultInputMode = (mode: InputMode) => {
    if (!writeDesktopInputModePreference(mode)) return;
    setDefaultInputMode(mode);
  };

  return (
    <div>
      <SectionTitle>{t("terminal.title")}</SectionTitle>
      <div style={cardStyle} className="p-4">
        <SettingRow
          label={t("terminal.defaultInputMode")}
          desc={t("terminal.defaultInputModeDesc")}
        >
          <FocusSelect
            data-testid="default-input-mode-select"
            className={inputCls}
            value={defaultInputMode}
            onChange={(e) => changeDefaultInputMode(e.target.value as InputMode)}
          >
            <option value="direct">{t("terminal.inputModeDirect")}</option>
            <option value="composer">{t("terminal.inputModeComposer")}</option>
          </FocusSelect>
        </SettingRow>

        <ToggleRow
          label={t("terminal.advertiseTrueColor")}
          desc={t("terminal.advertiseTrueColorDesc")}
          testid="advertise-truecolor-toggle"
          checked={terminal.advertiseTrueColor}
          onChange={(v) => update({ advertiseTrueColor: v })}
        />

        <SettingRow
          label={t("terminal.composerHistoryScope")}
          desc={t("terminal.composerHistoryScopeDesc")}
        >
          <FocusSelect
            data-testid="composer-history-scope-select"
            className={inputCls}
            value={terminal.composerHistoryScope}
            onChange={(e) =>
              update({ composerHistoryScope: e.target.value as ComposerHistoryScope })
            }
          >
            <option value="global">{t("terminal.composerHistoryScopeGlobal")}</option>
            <option value="workspace">{t("terminal.composerHistoryScopeWorkspace")}</option>
            <option value="pane">{t("terminal.composerHistoryScopePane")}</option>
          </FocusSelect>
        </SettingRow>

        <ToggleRow
          label={t("terminal.composerHistoryPopup")}
          desc={t("terminal.composerHistoryPopupDesc")}
          testid="composer-history-popup-toggle"
          checked={terminal.composerHistoryPopup}
          onChange={(v) => update({ composerHistoryPopup: v })}
        />

        <ToggleRow
          label={t("terminal.composerAutocomplete")}
          desc={t("terminal.composerAutocompleteDesc")}
          testid="composer-autocomplete-toggle"
          checked={terminal.composerAutocomplete}
          onChange={(v) => update({ composerAutocomplete: v })}
        />

        <ToggleRow
          label={t("terminal.copyOnSelect")}
          desc={t("terminal.copyOnSelectDesc")}
          testid="copy-on-select-toggle"
          checked={terminal.copyOnSelect}
          onChange={(v) => update({ copyOnSelect: v })}
        />

        <SettingRow
          label={t("terminal.scrollSensitivity")}
          desc={t("terminal.scrollSensitivityDesc")}
        >
          <FocusInput
            data-testid="scroll-sensitivity-input"
            type="number"
            min={SCROLL_SENSITIVITY_MIN}
            max={SCROLL_SENSITIVITY_MAX}
            step={SCROLL_SENSITIVITY_STEP}
            className={inputCls}
            style={{ width: 90 }}
            value={terminal.scrollSensitivity}
            onChange={(e) =>
              update({
                scrollSensitivity: normalizeScrollSensitivity(
                  e.target.value,
                  DEFAULT_SCROLL_SENSITIVITY,
                ),
              })
            }
          />
        </SettingRow>

        <SettingRow
          label={t("terminal.fastScrollSensitivity")}
          desc={t("terminal.fastScrollSensitivityDesc")}
        >
          <FocusInput
            data-testid="fast-scroll-sensitivity-input"
            type="number"
            min={SCROLL_SENSITIVITY_MIN}
            max={SCROLL_SENSITIVITY_MAX}
            step={SCROLL_SENSITIVITY_STEP}
            className={inputCls}
            style={{ width: 90 }}
            value={terminal.fastScrollSensitivity}
            onChange={(e) =>
              update({
                fastScrollSensitivity: normalizeScrollSensitivity(
                  e.target.value,
                  DEFAULT_FAST_SCROLL_SENSITIVITY,
                ),
              })
            }
          />
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

        <ToggleRow
          label={t("terminal.pathLinkOsOpen")}
          desc={t("terminal.pathLinkOsOpenDesc")}
          testid="path-link-os-open-toggle"
          checked={terminal.pathLinkOsOpenEnabled}
          onChange={(v) => update({ pathLinkOsOpenEnabled: v })}
        />

        <ToggleRow
          label={t("terminal.pathLinkOsOpenConfirm")}
          desc={t("terminal.pathLinkOsOpenConfirmDesc")}
          testid="path-link-os-open-confirm-toggle"
          checked={terminal.pathLinkOsOpenConfirm}
          onChange={(v) => update({ pathLinkOsOpenConfirm: v })}
        />
      </SubGroup>

      {/* ADR-0224: 실행 게이트는 URL 과 경로를 따로 고른다. 발견(밑줄)은 어느
          모드에서도 게이트되지 않으므로 여기에 노출하지 않는다. */}
      <SubGroup title={t("terminal.linkActivationGroup")}>
        <SettingRow
          label={t("terminal.urlLinkActivation")}
          desc={t("terminal.urlLinkActivationDesc")}
        >
          <FocusSelect
            data-testid="url-link-activation-select"
            className={inputCls}
            value={terminal.urlLinkActivation}
            onChange={(e) => update({ urlLinkActivation: e.target.value as LinkActivationMode })}
          >
            <option value="immediate">{t("terminal.linkActivationImmediate")}</option>
            <option value="chip">{t("terminal.linkActivationChip")}</option>
          </FocusSelect>
        </SettingRow>

        <SettingRow
          label={t("terminal.pathLinkActivation")}
          desc={t("terminal.pathLinkActivationDesc")}
        >
          <FocusSelect
            data-testid="path-link-activation-select"
            className={inputCls}
            value={terminal.pathLinkActivation}
            onChange={(e) => update({ pathLinkActivation: e.target.value as LinkActivationMode })}
          >
            <option value="immediate">{t("terminal.linkActivationImmediate")}</option>
            <option value="chip">{t("terminal.linkActivationChip")}</option>
          </FocusSelect>
        </SettingRow>
      </SubGroup>

      <SubGroup title={t("terminal.exitGroup")}>
        <ToggleRow
          label={t("terminal.interruptOnExit")}
          desc={t("terminal.interruptOnExitDesc")}
          testid="interrupt-on-exit-toggle"
          checked={exit.interruptTerminals}
          onChange={(v) => updateExit({ interruptTerminals: v })}
        />

        {exit.interruptTerminals && (
          <>
            <SettingRow
              label={t("terminal.interruptRounds")}
              desc={t("terminal.interruptRoundsDesc")}
            >
              <FocusInput
                data-testid="interrupt-rounds-input"
                type="number"
                min={1}
                max={10}
                step={1}
                className={inputCls}
                style={{ width: 90 }}
                value={exit.interruptRounds}
                onChange={(e) =>
                  updateExit({
                    interruptRounds: Math.min(
                      10,
                      Math.max(1, Math.round(Number(e.target.value) || 1)),
                    ),
                  })
                }
              />
            </SettingRow>

            <SettingRow
              label={t("terminal.interruptSettle")}
              desc={t("terminal.interruptSettleDesc")}
            >
              <FocusInput
                data-testid="interrupt-settle-input"
                type="number"
                min={0}
                max={10000}
                step={100}
                className={inputCls}
                style={{ width: 90 }}
                value={exit.settleMs}
                onChange={(e) =>
                  updateExit({
                    settleMs: Math.min(10000, Math.max(0, Math.round(Number(e.target.value) || 0))),
                  })
                }
              />
            </SettingRow>
          </>
        )}
      </SubGroup>

      <SubGroup title={t("terminal.paneClearGroup")}>
        <p className="mb-3 text-[11px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
          {t("terminal.paneClearGroupDesc")}
        </p>

        <SettingRow
          label={t("terminal.paneClearShellCommand")}
          desc={t("terminal.paneClearShellCommandDesc")}
        >
          <FocusInput
            data-testid="pane-clear-shell-command-input"
            type="text"
            className={inputCls}
            style={{ width: 140 }}
            value={paneClear.shellCommand}
            onChange={(event) => updatePaneClear({ shellCommand: event.target.value })}
          />
        </SettingRow>

        <SettingRow
          label={t("terminal.paneClearBusyPolicy")}
          desc={t("terminal.paneClearBusyPolicyDesc")}
        >
          <FocusSelect
            data-testid="pane-clear-busy-policy-select"
            value={paneClear.busyPolicy}
            onChange={(event) =>
              updatePaneClear({
                busyPolicy: event.target.value as typeof paneClear.busyPolicy,
              })
            }
            className={inputCls}
            style={inputStyle}
          >
            <option value="skip">{t("terminal.paneClearBusyPolicySkip")}</option>
            <option value="interrupt">{t("terminal.paneClearBusyPolicyInterrupt")}</option>
            <option value="restart">{t("terminal.paneClearBusyPolicyRestart")}</option>
          </FocusSelect>
        </SettingRow>

        {paneClear.busyPolicy === "interrupt" && (
          <>
            <SettingRow
              label={t("terminal.paneClearInterruptRounds")}
              desc={t("terminal.paneClearInterruptRoundsDesc")}
            >
              <FocusInput
                data-testid="pane-clear-rounds-input"
                type="number"
                min={1}
                max={10}
                step={1}
                className={inputCls}
                style={{ width: 90 }}
                value={paneClear.interruptRounds}
                onChange={(event) =>
                  updatePaneClear({
                    interruptRounds: Math.min(
                      10,
                      Math.max(1, Math.round(Number(event.target.value) || 1)),
                    ),
                  })
                }
              />
            </SettingRow>

            <SettingRow
              label={t("terminal.paneClearSettle")}
              desc={t("terminal.paneClearSettleDesc")}
            >
              <FocusInput
                data-testid="pane-clear-settle-input"
                type="number"
                min={0}
                max={10000}
                step={100}
                className={inputCls}
                style={{ width: 90 }}
                value={paneClear.settleMs}
                onChange={(event) =>
                  updatePaneClear({
                    settleMs: Math.min(
                      10000,
                      Math.max(0, Math.round(Number(event.target.value) || 0)),
                    ),
                  })
                }
              />
            </SettingRow>
          </>
        )}
      </SubGroup>
    </div>
  );
}

// -- Section: Interface (control bar, dock, notifications, power) --

function InterfaceSection() {
  const { t } = useTranslation("settings");
  const storeControlBar = useSettingsStore((s) => s.controlBar);
  const setControlBar = useSettingsStore((s) => s.setControlBar);
  const storeDock = useSettingsStore((s) => s.dock);
  const setDock = useSettingsStore((s) => s.setDock);
  const storeNotifications = useSettingsStore((s) => s.notifications);
  const setNotifications = useSettingsStore((s) => s.setNotifications);
  const storePower = useSettingsStore((s) => s.power);
  const setPower = useSettingsStore((s) => s.setPower);

  const [controlBar, setDraftControlBar] = useDraft("controlBar", storeControlBar, (v) =>
    setControlBar(v),
  );
  const [dock, setDraftDock] = useDraft("dock", storeDock, (v) => setDock(v));
  const [notifications, setDraftNotifications] = useDraft(
    "notifications",
    storeNotifications,
    (v) => setNotifications(v),
  );
  const [power, setDraftPower] = useDraft("power", storePower, (v) => setPower(v));
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

      <SubGroup title={t("interface.groupPower")}>
        <ToggleRow
          label={t("interface.keepAwake")}
          desc={t("interface.keepAwakeDesc")}
          testid="keep-awake-toggle"
          checked={power.keepAwake}
          onChange={(v) => setDraftPower((prev) => ({ ...prev, keepAwake: v }))}
        />
        <ToggleRow
          label={t("interface.keepAwakeWhenBusy")}
          desc={t("interface.keepAwakeWhenBusyDesc")}
          testid="keep-awake-when-busy-toggle"
          checked={power.keepAwakeWhenBusy}
          onChange={(v) => setDraftPower((prev) => ({ ...prev, keepAwakeWhenBusy: v }))}
        />
      </SubGroup>
    </div>
  );
}

// -- Section: Remote Connection and host data policy --

type RemoteConnectionSettings = RemoteSettings;

type RemoteSectionDraft = RemoteConnectionSettings & {
  allowedIpsText: string;
  customHostInput: string;
};

function toRemoteSectionDraft(remote: RemoteSettings): RemoteSectionDraft {
  return {
    enabled: remote.enabled,
    bindAddress: remote.bindAddress,
    allowedOrigins: remote.allowedOrigins,
    allowedIps: remote.allowedIps,
    tailscaleOnly: remote.tailscaleOnly,
    authToken: remote.authToken,
    heartbeatTimeoutSeconds: remote.heartbeatTimeoutSeconds,
    androidBackgroundLeaseSeconds: remote.androidBackgroundLeaseSeconds,
    autoMobileModeMinWidth: remote.autoMobileModeMinWidth,
    preferredHost: remote.preferredHost,
    customHosts: remote.customHosts,
    cloudEnabled: remote.cloudEnabled,
    relayBaseUrl: remote.relayBaseUrl,
    cloudInstanceId: remote.cloudInstanceId,
    cloudTunnelUrl: remote.cloudTunnelUrl,
    cloudServerBaseUrl: remote.cloudServerBaseUrl,
    cloudAutoReconnect: remote.cloudAutoReconnect,
    cloudAccessMode: remote.cloudAccessMode,
    serveTerminalFont: remote.serveTerminalFont,
    widgets: remote.widgets,
    allowedIpsText: formatAllowedIps(remote.allowedIps),
    customHostInput: "",
  };
}

function toRemoteSettings(draft: RemoteSectionDraft): RemoteConnectionSettings {
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
    androidBackgroundLeaseSeconds: Math.min(
      900,
      Math.max(0, Math.trunc(Number(remote.androidBackgroundLeaseSeconds) || 0)),
    ),
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

function RemoteConnectionSection() {
  const { t } = useTranslation("settings");
  const storeRemote = useSettingsStore((s) => s.remote);
  const setRemote = useSettingsStore((s) => s.setRemote);
  const storeDraft = useMemo(() => toRemoteSectionDraft(storeRemote), [storeRemote]);
  const [remote, setDraftRemote] = useDraft<RemoteSectionDraft>(
    "remoteConnection",
    storeDraft,
    (draft) => setRemote(toRemoteSettings(draft)),
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
  // long-running OAuth await instead of a stale closure snapshot. The mirror is
  // written from an effect, never during render: refs are not render input.
  //
  // `useLayoutEffect`, not `useEffect`: layout effects run synchronously inside
  // the same commit, before passive effects and before any DOM event or async
  // continuation can observe the new UI. A passive effect would leave a window
  // in which anything running during the commit phase (this component's or a
  // child's layout effect) still reads the previous value. The cost is nil and
  // it matches the guarantee the render-phase write used to give.
  const remoteDraftChangedRef = useRef(remoteDraftChanged);
  useLayoutEffect(() => {
    remoteDraftChangedRef.current = remoteDraftChanged;
  }, [remoteDraftChanged]);
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
      // edited, or the PC-owned Cloud access policy changed, run the same
      // commit the Save button does before pairing so the tunnel starts with
      // the values visible in this form:
      //  - commit the FULL draft (not just relay) — a partial `setRemote` would
      //    trip useDraft's store-change sync (#51) and discard other unsaved edits,
      //  - persist to disk, and
      //  - reconcile Direct Remote runtime access if `enabled` changed
      //    (mirrors handleSave; no-ops when it did not change).
      if (
        remote.relayBaseUrl.trim() !== storeRemote.relayBaseUrl ||
        remote.cloudAccessMode !== storeRemote.cloudAccessMode
      ) {
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
      <SectionTitle>{t("remote.connectionTitle")}</SectionTitle>

      <SubGroup title={t("remote.groupAccess")}>
        <ToggleRow
          label={t("remote.enabled")}
          desc={t("remote.enabledDesc")}
          testid="remote-settings-enabled-toggle"
          checked={remote.enabled}
          onChange={handleToggleEnabled}
        />

        <ToggleRow
          label={t("remote.tailscaleOnly")}
          desc={t("remote.tailscaleOnlyDesc")}
          testid="remote-settings-tailscale-only-toggle"
          checked={remote.tailscaleOnly}
          onChange={(checked) =>
            update({
              tailscaleOnly: checked,
              allowedIpsText: checked
                ? appendAllowedIps(remote.allowedIpsText, TAILSCALE_ALLOWED_IPS)
                : remote.allowedIpsText,
            })
          }
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

        <SettingRow
          label="Android 백그라운드 제어권 유지"
          desc="Android 앱을 잠시 벗어났을 때 Remote 제어권을 유지할 시간입니다. 0이면 즉시 반납합니다."
        >
          <div className="flex items-center gap-2">
            <FocusInput
              data-testid="remote-settings-android-background-lease-input"
              type="number"
              min={0}
              max={900}
              step={1}
              className={inputCls}
              inputStyle={{ width: 110 }}
              value={remote.androidBackgroundLeaseSeconds}
              onChange={(event) =>
                update({
                  androidBackgroundLeaseSeconds: Math.min(
                    900,
                    Math.max(0, Math.trunc(Number(event.target.value) || 0)),
                  ),
                })
              }
            />
            <span className="text-[11px]" style={{ color: "var(--text-secondary)" }}>
              초
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
        <SettingRow label={t("remote.cloudAccessMode")} desc={t("remote.cloudAccessModeDesc")}>
          <FocusSelect
            data-testid="remote-settings-cloud-access-mode-select"
            className={inputCls}
            value={remote.cloudAccessMode}
            onChange={(event) =>
              update({
                cloudAccessMode: event.target.value as RemoteSettings["cloudAccessMode"],
              })
            }
          >
            <option value="browserAndE2e">{t("remote.cloudAccessModeBrowserAndE2e")}</option>
            <option value="androidE2eOnly">{t("remote.cloudAccessModeAndroidE2eOnly")}</option>
          </FocusSelect>
        </SettingRow>

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

      <SubGroup title={t("remote.groupHostData")}>
        <ToggleRow
          label={t("remote.serveTerminalFont")}
          desc={t("remote.serveTerminalFontDesc")}
          testid="remote-settings-serve-terminal-font-toggle"
          checked={remote.serveTerminalFont}
          onChange={(value) => update({ serveTerminalFont: value })}
        />
        <ToggleRow
          label={t("remote.widgets")}
          desc={t("remote.widgetsDesc")}
          testid="remote-settings-widgets-toggle"
          checked={remote.widgets}
          onChange={(value) => update({ widgets: value })}
        />
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
        <SettingRow label={t("workspaces.lastInputMode")} desc={t("workspaces.lastInputModeDesc")}>
          <FocusSelect
            data-testid="workspace-last-input-mode-select"
            className={inputCls}
            value={wsSelector.lastInputMode}
            onChange={(e) =>
              updateWsSelector({
                lastInputMode: e.target.value as "perPane" | "workspaceLatest",
              })
            }
          >
            <option value="perPane">{t("workspaces.lastInputPerPane")}</option>
            <option value="workspaceLatest">{t("workspaces.lastInputWorkspaceLatest")}</option>
          </FocusSelect>
        </SettingRow>

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
        <ToggleRow
          label={t("workspaces.confirmDestructiveActions")}
          desc={t("workspaces.confirmDestructiveActionsDesc")}
          testid="workspace-destructive-confirm-toggle"
          checked={wsSelector.confirmDestructiveActions}
          onChange={(value) => updateWsSelector({ confirmDestructiveActions: value })}
        />

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
        {/* Launch command (flags land here, e.g. --dangerously-skip-permissions) */}
        <div className="flex items-start gap-3 py-1.5">
          <div className="w-36 shrink-0 pt-1">
            <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
              {t("claude.command")}
            </span>
            <p
              className="mt-0.5 text-[11px] leading-tight"
              style={{ color: "var(--text-secondary)", opacity: 0.65 }}
            >
              {t("claude.commandDesc")}
            </p>
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <FocusInput
                data-testid="claude-command-input"
                className={inputCls}
                type="text"
                style={{ width: 320 }}
                placeholder={DEFAULT_CLAUDE_COMMAND}
                value={claude.command}
                onChange={(e) => updateClaude({ command: e.target.value })}
              />
              {claude.command !== DEFAULT_CLAUDE_COMMAND && (
                <button
                  data-testid="claude-command-reset"
                  className="hover-bg px-1.5 py-0.5 rounded text-[11px]"
                  style={{ color: "var(--text-secondary)" }}
                  onClick={() => updateClaude({ command: DEFAULT_CLAUDE_COMMAND })}
                >
                  {t("common.default")}
                </button>
              )}
            </div>
            {isSafeAgentCommand(claude.command) ? (
              <p
                data-testid="claude-command-preview"
                className="mt-1 text-[11px] leading-tight"
                style={{ color: "var(--text-secondary)", opacity: 0.65 }}
              >
                {`${resolveAgentCommand(claude.command, DEFAULT_CLAUDE_COMMAND)} --resume <session-id>`}
              </p>
            ) : (
              <p
                data-testid="claude-command-warning"
                className="mt-1 text-[11px] leading-tight"
                style={{ color: "var(--claude)" }}
              >
                {t("claude.commandInvalid", { command: DEFAULT_CLAUDE_COMMAND })}
              </p>
            )}
          </div>
        </div>

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
                    sessionMaxAgeHours: Number.isNaN(parsed)
                      ? DEFAULT_AGENT_SESSION_MAX_AGE_HOURS
                      : Math.max(0, parsed),
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
      <ClaudeUsageGroup />
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

      <SubGroup title={t("codex.groupSessionRestore")}>
        {/* Launch command (flags land here, e.g. --yolo) */}
        <div className="flex items-start gap-3 py-1.5">
          <div className="w-36 shrink-0 pt-1">
            <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
              {t("codex.command")}
            </span>
            <p
              className="mt-0.5 text-[11px] leading-tight"
              style={{ color: "var(--text-secondary)", opacity: 0.65 }}
            >
              {t("codex.commandDesc")}
            </p>
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <FocusInput
                data-testid="codex-command-input"
                className={inputCls}
                type="text"
                style={{ width: 320 }}
                placeholder={DEFAULT_CODEX_COMMAND}
                value={codex.command}
                onChange={(e) => updateCodex({ command: e.target.value })}
              />
              {codex.command !== DEFAULT_CODEX_COMMAND && (
                <button
                  data-testid="codex-command-reset"
                  className="hover-bg px-1.5 py-0.5 rounded text-[11px]"
                  style={{ color: "var(--text-secondary)" }}
                  onClick={() => updateCodex({ command: DEFAULT_CODEX_COMMAND })}
                >
                  {t("common.default")}
                </button>
              )}
            </div>
            {isSafeAgentCommand(codex.command) ? (
              <p
                data-testid="codex-command-preview"
                className="mt-1 text-[11px] leading-tight"
                style={{ color: "var(--text-secondary)", opacity: 0.65 }}
              >
                {`${resolveAgentCommand(codex.command, DEFAULT_CODEX_COMMAND)} resume <session-id>`}
              </p>
            ) : (
              <p
                data-testid="codex-command-warning"
                className="mt-1 text-[11px] leading-tight"
                style={{ color: "var(--claude)" }}
              >
                {t("codex.commandInvalid", { command: DEFAULT_CODEX_COMMAND })}
              </p>
            )}
          </div>
        </div>

        <div className="flex items-start gap-3 py-1.5">
          <div className="w-36 shrink-0 pt-1">
            <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
              {t("codex.restoreSession")}
            </span>
            <p
              className="mt-0.5 text-[11px] leading-tight"
              style={{ color: "var(--text-secondary)", opacity: 0.65 }}
            >
              {t("codex.restoreSessionDesc")}
            </p>
          </div>
          <div className="min-w-0 flex-1 pt-1">
            <label className="flex cursor-pointer items-center gap-2">
              <input
                data-testid="codex-restore-session-toggle"
                type="checkbox"
                checked={codex.restoreSession}
                onChange={(e) => updateCodex({ restoreSession: e.target.checked })}
              />
              <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
                {codex.restoreSession ? t("common.enabled") : t("common.disabled")}
              </span>
            </label>
          </div>
        </div>

        <div className="flex items-start gap-3 py-1.5">
          <div className="w-36 shrink-0 pt-1">
            <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
              {t("codex.sessionMaxAge")}
            </span>
            <p
              className="mt-0.5 text-[11px] leading-tight"
              style={{ color: "var(--text-secondary)", opacity: 0.65 }}
            >
              {t("codex.sessionMaxAgeDesc")}
            </p>
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <FocusInput
                data-testid="codex-session-max-age-input"
                className={inputCls}
                type="number"
                min={0}
                style={{ width: 80 }}
                value={codex.sessionMaxAgeHours}
                onChange={(e) => {
                  const parsed = parseInt(e.target.value, 10);
                  updateCodex({
                    sessionMaxAgeHours: Number.isNaN(parsed)
                      ? DEFAULT_AGENT_SESSION_MAX_AGE_HOURS
                      : Math.max(0, parsed),
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

      <SubGroup title={t("codex.groupTranscript")}>
        <div className="flex items-start gap-3 py-1.5">
          <div className="w-36 shrink-0 pt-1">
            <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
              {t("codex.transcriptScroll")}
            </span>
            <p
              className="mt-0.5 text-[11px] leading-tight"
              style={{ color: "var(--text-secondary)", opacity: 0.65 }}
            >
              {t("codex.transcriptScrollDesc")}
            </p>
          </div>
          <div className="min-w-0 flex-1 pt-1">
            <label className="flex cursor-pointer items-center gap-2">
              <input
                data-testid="codex-transcript-scroll-toggle"
                type="checkbox"
                checked={codex.transcriptScrollEnabled}
                onChange={(e) => updateCodex({ transcriptScrollEnabled: e.target.checked })}
              />
              <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
                {codex.transcriptScrollEnabled ? t("common.enabled") : t("common.disabled")}
              </span>
            </label>
          </div>
        </div>
      </SubGroup>

      <SubGroup title={t("codex.groupStatusMessage")}>
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
      </SubGroup>
      <CodexUsageGroup />
    </div>
  );
}

function GrokSection() {
  const { t } = useTranslation("settings");
  const storeGrok = useSettingsStore((s) => s.grok);
  const setGrok = useSettingsStore((s) => s.setGrok);
  const [grok, setDraftGrok] = useDraft("grok", storeGrok, (v) => setGrok(v));
  const updateGrok = (partial: Partial<typeof grok>) =>
    setDraftGrok((prev) => ({ ...prev, ...partial }));

  return (
    <div>
      <SectionTitle>{t("grok.title")}</SectionTitle>
      <SubGroup title={t("grok.groupSessionRestore")}>
        <div className="flex items-start gap-3 py-1.5">
          <div className="w-36 shrink-0 pt-1">
            <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
              {t("grok.command")}
            </span>
          </div>
          <div className="min-w-0 flex-1">
            <FocusInput
              data-testid="grok-command-input"
              className={inputCls}
              type="text"
              style={{ width: 320 }}
              placeholder={DEFAULT_GROK_COMMAND}
              value={grok.command}
              onChange={(e) => updateGrok({ command: e.target.value })}
            />
            {isSafeAgentCommand(grok.command) ? (
              <p
                className="mt-1 text-[11px]"
                style={{ color: "var(--text-secondary)", opacity: 0.65 }}
              >
                {`${resolveAgentCommand(grok.command, DEFAULT_GROK_COMMAND)} --resume <session-id>`}
              </p>
            ) : (
              <p className="mt-1 text-[11px]" style={{ color: "var(--claude)" }}>
                {t("grok.commandInvalid", { command: DEFAULT_GROK_COMMAND })}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-start gap-3 py-1.5">
          <div className="w-36 shrink-0 pt-1">
            <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
              {t("grok.restoreSession")}
            </span>
          </div>
          <input
            data-testid="grok-restore-session"
            type="checkbox"
            checked={grok.restoreSession}
            onChange={(e) => updateGrok({ restoreSession: e.target.checked })}
          />
        </div>
        <div className="flex items-start gap-3 py-1.5">
          <div className="w-36 shrink-0 pt-1">
            <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
              {t("grok.sessionMaxAge")}
            </span>
          </div>
          <FocusInput
            data-testid="grok-session-max-age"
            className={inputCls}
            type="number"
            min={0}
            style={{ width: 80 }}
            value={grok.sessionMaxAgeHours}
            onChange={(e) => updateGrok({ sessionMaxAgeHours: Number(e.target.value) || 0 })}
          />
        </div>
      </SubGroup>
      <SubGroup title={t("grok.groupStatusMessage")}>
        <FocusSelect
          data-testid="grok-status-message-mode-select"
          className={inputCls}
          value={grok.statusMessageMode}
          onChange={(e) =>
            updateGrok({
              statusMessageMode: e.target.value as
                | "bullet"
                | "title"
                | "bullet-title"
                | "title-bullet",
            })
          }
        >
          <option value="title">{t("grok.modeTitle")}</option>
          <option value="bullet-title">{t("grok.modeBulletTitle")}</option>
          <option value="title-bullet">{t("grok.modeTitleBullet")}</option>
          <option value="bullet">{t("grok.modeBullet")}</option>
        </FocusSelect>
        {(grok.statusMessageMode === "bullet-title" ||
          grok.statusMessageMode === "title-bullet") && (
          <div className="flex items-start gap-3 py-1.5">
            <div className="w-36 shrink-0 pt-1">
              <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
                {t("grok.delimiter")}
              </span>
              <p
                className="mt-0.5 text-[11px] leading-tight"
                style={{ color: "var(--text-secondary)", opacity: 0.65 }}
              >
                {t("grok.delimiterDesc")}
              </p>
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <FocusInput
                  data-testid="grok-status-message-delimiter-input"
                  className={inputCls}
                  type="text"
                  style={{ width: 100 }}
                  value={grok.statusMessageDelimiter}
                  onChange={(e) => updateGrok({ statusMessageDelimiter: e.target.value })}
                />
                {grok.statusMessageDelimiter !== DEFAULT_STATUS_MESSAGE_DELIMITER && (
                  <button
                    data-testid="grok-status-message-delimiter-reset"
                    className="hover-bg rounded px-1.5 py-0.5 text-[11px]"
                    style={{ color: "var(--text-secondary)" }}
                    onClick={() =>
                      updateGrok({
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
      <GrokUsageGroup />
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
      extensionViewers: [
        ...fe.extensionViewers,
        { extensions: [".txt"], command: "vi", profile: "" },
      ],
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
            {fe.extensionViewers.map((viewer, i) => {
              const viewerProfile = viewer.profile ?? "";
              const profileExists = profiles.some((candidate) => candidate.name === viewerProfile);
              const profileError = !viewerProfile.trim()
                ? t("fileExplorer.viewerProfileRequired")
                : !profileExists
                  ? t("fileExplorer.viewerProfileMissing")
                  : null;
              return (
                <div key={i} className="mb-2">
                  <div className="flex items-center gap-2">
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
                    <FocusSelect
                      data-testid={`fe-ext-viewer-profile-${i}`}
                      className={inputCls}
                      style={{ width: 140 }}
                      value={profileExists ? viewerProfile : ""}
                      onChange={(e) => updateViewer(i, { profile: e.target.value })}
                    >
                      <option value="">{t("fileExplorer.viewerProfilePlaceholder")}</option>
                      {profiles.map((candidate) => (
                        <option key={candidate.name} value={candidate.name}>
                          {candidate.name}
                        </option>
                      ))}
                    </FocusSelect>
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
                  {profileError && (
                    <p
                      className="mt-1 text-[11px]"
                      style={{ color: "var(--red)" }}
                      data-testid={`fe-ext-viewer-profile-error-${i}`}
                    >
                      {profileError}
                    </p>
                  )}
                </div>
              );
            })}
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

// -- Section: File Viewer (opened-file body, distinct from the Explorer listing) --

function ViewerSection() {
  const { t } = useTranslation("settings");
  const storeViewer = useSettingsStore((s) => s.viewer);
  const setViewer = useSettingsStore((s) => s.setViewer);
  const [viewer, setDraftViewer] = useDraft("viewer", storeViewer, (v) => setViewer(v));
  const updateViewer = (partial: Partial<typeof viewer>) =>
    setDraftViewer((prev) => ({ ...prev, ...partial }));

  return (
    <div>
      <SectionTitle>{t("viewer.title")}</SectionTitle>

      <SubGroup title={t("viewer.groupAppearance")}>
        <SettingRow label={t("viewer.fontFamily")} desc={t("viewer.fontFamilyDesc")}>
          <FocusInput
            data-testid="viewer-font-family"
            className={inputCls}
            placeholder={t("viewer.fontFamilyPlaceholder")}
            value={viewer.fontFamily}
            onChange={(e) => updateViewer({ fontFamily: e.target.value })}
          />
        </SettingRow>

        <SettingRow label={t("viewer.fontSize")} desc={t("viewer.fontSizeDesc")}>
          <input
            data-testid="viewer-font-size"
            type="number"
            min={8}
            max={32}
            className={inputCls}
            style={{ width: 60 }}
            value={viewer.fontSize}
            onChange={(e) =>
              updateViewer({ fontSize: Math.max(8, Math.min(32, Number(e.target.value) || 13)) })
            }
          />
        </SettingRow>

        {/* Padding */}
        <div className="flex items-start gap-3 py-1.5">
          <div className="w-36 shrink-0 pt-1">
            <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
              {t("viewer.padding")}
            </span>
            <p
              className="mt-0.5 text-[11px] leading-tight"
              style={{ color: "var(--text-secondary)", opacity: 0.65 }}
            >
              {t("viewer.paddingDesc")}
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
                      data-testid={`viewer-padding-${dir.toLowerCase()}`}
                      type="number"
                      min={0}
                      max={64}
                      className={inputCls}
                      style={{ width: 60 }}
                      value={viewer[key]}
                      onChange={(e) =>
                        updateViewer({
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

// -- Section: GitHub --

function GitHubSection() {
  const { t } = useTranslation("settings");
  const storeGithub = useSettingsStore((s) => s.github);
  const setGithub = useSettingsStore((s) => s.setGithub);
  const monoFonts = useMonospacedFonts();
  const [github, setDraftGithub] = useDraft("github", storeGithub, (v) => setGithub(v));
  const updateGithub = (partial: Partial<GithubSettings>) =>
    setDraftGithub((prev) => ({ ...prev, ...partial }));

  return (
    <div>
      <SectionTitle>{t("github.title")}</SectionTitle>

      <SubGroup title={t("github.groupBehavior")}>
        <SettingRow label={t("github.defaultTab")} desc={t("github.defaultTabDesc")}>
          <FocusSelect
            data-testid="github-default-tab"
            className={inputCls}
            value={github.defaultTab}
            onChange={(e) =>
              updateGithub({ defaultTab: e.target.value as GithubSettings["defaultTab"] })
            }
          >
            <option value="issues">{t("github.defaultTabIssues")}</option>
            <option value="pulls">{t("github.defaultTabPulls")}</option>
          </FocusSelect>
        </SettingRow>

        <SettingRow label={t("github.refreshSeconds")} desc={t("github.refreshSecondsDesc")}>
          <FocusInput
            data-testid="github-refresh-input"
            type="number"
            inputStyle={{ width: "7rem" }}
            min={10}
            max={3600}
            step={10}
            value={github.refreshSeconds}
            onChange={(e) =>
              updateGithub({
                refreshSeconds: Math.max(10, Math.min(3600, Number(e.target.value) || 10)),
              })
            }
          />
        </SettingRow>

        <SettingRow label={t("github.hideDraftPulls")} desc={t("github.hideDraftPullsDesc")}>
          <label className="flex items-center gap-2">
            <input
              data-testid="github-hide-draft-pulls"
              type="checkbox"
              checked={github.hideDraftPulls}
              onChange={(e) => updateGithub({ hideDraftPulls: e.target.checked })}
            />
            <span className="text-[12px]" style={{ color: "var(--text-secondary)" }}>
              {t("common.enabledShort")}
            </span>
          </label>
        </SettingRow>
      </SubGroup>

      <SubGroup title={t("github.groupDisplay")}>
        <SettingRow label={t("github.fontFamily")} desc={t("github.fontFamilyDesc")}>
          <FocusSelect
            data-testid="github-font-family"
            className={inputCls}
            value={github.fontFamily}
            onChange={(e) => updateGithub({ fontFamily: e.target.value })}
          >
            <option value="">{t("github.fontFamilyDefault")}</option>
            {github.fontFamily && !monoFonts.includes(github.fontFamily) && (
              <option value={github.fontFamily}>{github.fontFamily}</option>
            )}
            {monoFonts.map((family) => (
              <option key={family} value={family}>
                {family}
              </option>
            ))}
          </FocusSelect>
        </SettingRow>

        <SettingRow label={t("github.fontSize")} desc={t("github.fontSizeDesc")}>
          <FocusInput
            data-testid="github-font-size"
            type="number"
            inputStyle={{ width: "7rem" }}
            min={GITHUB_FONT_SIZE_MIN}
            max={GITHUB_FONT_SIZE_MAX}
            value={github.fontSize}
            onChange={(e) => updateGithub({ fontSize: readGithubFontSize(Number(e.target.value)) })}
          />
        </SettingRow>

        <SettingRow label={t("github.numberColor")} desc={t("github.numberColorDesc")}>
          <FocusSelect
            data-testid="github-number-color"
            className={inputCls}
            value={github.numberColor}
            onChange={(e) =>
              updateGithub({ numberColor: e.target.value as GithubSettings["numberColor"] })
            }
          >
            {GITHUB_NUMBER_COLORS.map((token) => (
              <option key={token} value={token}>
                {t(`github.numberColorOption.${token}`)}
              </option>
            ))}
          </FocusSelect>
        </SettingRow>

        <SettingRow label={t("github.showAuthor")} desc={t("github.showAuthorDesc")}>
          <label className="flex items-center gap-2">
            <input
              data-testid="github-show-author"
              type="checkbox"
              checked={github.showAuthor}
              onChange={(e) => updateGithub({ showAuthor: e.target.checked })}
            />
            <span className="text-[12px]" style={{ color: "var(--text-secondary)" }}>
              {t("common.enabledShort")}
            </span>
          </label>
        </SettingRow>

        <SettingRow label={t("github.showUpdated")} desc={t("github.showUpdatedDesc")}>
          <label className="flex items-center gap-2">
            <input
              data-testid="github-show-updated"
              type="checkbox"
              checked={github.showUpdated}
              onChange={(e) => updateGithub({ showUpdated: e.target.checked })}
            />
            <span className="text-[12px]" style={{ color: "var(--text-secondary)" }}>
              {t("common.enabledShort")}
            </span>
          </label>
        </SettingRow>

        <SettingRow label={t("github.showDraftBadge")} desc={t("github.showDraftBadgeDesc")}>
          <label className="flex items-center gap-2">
            <input
              data-testid="github-show-draft-badge"
              type="checkbox"
              checked={github.showDraftBadge}
              onChange={(e) => updateGithub({ showDraftBadge: e.target.checked })}
            />
            <span className="text-[12px]" style={{ color: "var(--text-secondary)" }}>
              {t("common.enabledShort")}
            </span>
          </label>
        </SettingRow>

        <SettingRow label={t("github.labelMaxCount")} desc={t("github.labelMaxCountDesc")}>
          <FocusInput
            data-testid="github-label-max-count"
            type="number"
            inputStyle={{ width: "7rem" }}
            min={0}
            max={GITHUB_LABEL_MAX_COUNT_MAX}
            value={github.labelMaxCount}
            onChange={(e) =>
              updateGithub({ labelMaxCount: readGithubLabelMaxCount(Number(e.target.value)) })
            }
          />
        </SettingRow>

        <SettingRow label={t("github.labelMaxWidth")} desc={t("github.labelMaxWidthDesc")}>
          <FocusInput
            data-testid="github-label-max-width"
            type="number"
            inputStyle={{ width: "7rem" }}
            min={GITHUB_LABEL_MAX_WIDTH_MIN}
            max={GITHUB_LABEL_MAX_WIDTH_MAX}
            step={4}
            value={github.labelMaxWidth}
            onChange={(e) =>
              updateGithub({ labelMaxWidth: readGithubLabelMaxWidth(Number(e.target.value)) })
            }
          />
        </SettingRow>
      </SubGroup>
    </div>
  );
}

// -- Section: Memo --

/**
 * Usage monitor settings.
 *
 * Grouped per monitored agent rather than merged into the Claude/Codex
 * integration sections: these are the data-source settings of one view, not
 * agent integration behavior, and a second agent should sit next to the first
 * for comparison (ADR-0102).
 */
function UsageProfileFields({
  usage,
  update,
  profiles,
  defaultProfile,
  testIdPrefix,
  profileLabel,
  profileDescription,
  refreshDescription,
}: {
  usage: { profile: string; refreshSeconds: number };
  update: (partial: { profile?: string; refreshSeconds?: number }) => void;
  profiles: Profile[];
  defaultProfile: string;
  testIdPrefix: string;
  profileLabel: string;
  profileDescription: string;
  refreshDescription: string;
}) {
  const { t } = useTranslation("settings");
  return (
    <>
      <SettingRow label={profileLabel} desc={profileDescription}>
        <select
          data-testid={`${testIdPrefix}-profile-select`}
          value={usage.profile}
          onChange={(e) => update({ profile: e.target.value })}
          className={inputCls}
          style={inputStyle}
        >
          <option value="">
            {t("usage.profileDefault")}
            {defaultProfile ? ` (${defaultProfile})` : ""}
          </option>
          {profiles.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>
      </SettingRow>

      <SettingRow label={t("usage.refresh")} desc={refreshDescription}>
        <FocusInput
          data-testid={`${testIdPrefix}-refresh-input`}
          type="number"
          inputStyle={{ width: "7rem" }}
          min={USAGE_REFRESH_MIN_SECONDS}
          max={USAGE_REFRESH_MAX_SECONDS}
          step={30}
          value={usage.refreshSeconds}
          onChange={(e) => update({ refreshSeconds: Number(e.target.value) })}
        />
      </SettingRow>
    </>
  );
}

function UsageRowSelection<Row extends string>({
  rows,
  visibleRows,
  labels,
  testIdPrefix,
  update,
}: {
  rows: readonly Row[];
  visibleRows: readonly Row[];
  labels: Record<Row, string>;
  testIdPrefix: string;
  update: (visibleRows: Row[]) => void;
}) {
  const { t } = useTranslation("settings");
  return (
    <SettingRow label={t("usage.visibleRows")} desc={t("usage.visibleRowsDesc")}>
      <div className="flex flex-col items-start gap-1">
        {rows.map((row) => {
          const checked = visibleRows.includes(row);
          const disabled = checked && visibleRows.length === 1;
          return (
            <label key={row} className="flex items-center gap-2 text-[13px]">
              <input
                data-testid={`${testIdPrefix}-visible-row-${row}`}
                type="checkbox"
                checked={checked}
                disabled={disabled}
                onChange={(event) =>
                  update(
                    event.target.checked
                      ? [...visibleRows, row]
                      : visibleRows.filter((visible) => visible !== row),
                  )
                }
                style={{ accentColor: "var(--accent)" }}
              />
              <span style={{ color: disabled ? "var(--text-muted)" : "var(--text-primary)" }}>
                {labels[row]}
              </span>
            </label>
          );
        })}
      </div>
    </SettingRow>
  );
}

function UsageColorFields({
  colors,
  update,
  testIdPrefix,
}: {
  colors: { used: string; pace: string; track: string };
  update: (partial: { used?: string; pace?: string; track?: string }) => void;
  /** Distinguishes the two agents' pickers, which now sit on the same page. */
  testIdPrefix: string;
}) {
  const { t } = useTranslation("settings");
  const entries = [
    ["used", t("usage.colorUsed")],
    ["pace", t("usage.colorPace")],
    ["track", t("usage.colorTrack")],
  ] as const;
  return (
    <>
      {entries.map(([key, label]) => (
        <SettingRow
          key={key}
          label={label}
          desc={t(`usage.color${key[0].toUpperCase()}${key.slice(1)}Desc`)}
        >
          <input
            data-testid={`${testIdPrefix}-color-${key}`}
            type="color"
            value={colors[key]}
            onChange={(event) => update({ [key]: event.target.value })}
            className="h-7 w-12 cursor-pointer bg-transparent p-0"
          />
        </SettingRow>
      ))}
    </>
  );
}

function WidgetsSection() {
  const { t } = useTranslation("settings");
  const storeWidgets = useSettingsStore((s) => s.widgets);
  const setWidgets = useSettingsStore((s) => s.setWidgets);
  const claudeConfigDirs = useSettingsStore((s) => s.usage.claude.configDirs);
  const grokConfigDirs = useSettingsStore((s) => s.usage.grok.configDirs);
  const monoFonts = useMonospacedFonts();
  const [widgets, setDraftWidgets] = useDraft("widgets", storeWidgets, setWidgets);

  return (
    <div data-testid="settings-widgets-section">
      <SectionTitle>{t("widgets.title")}</SectionTitle>
      <p
        className="px-4 pb-2 text-[11px] leading-relaxed"
        style={{ color: "var(--text-secondary)", opacity: 0.75 }}
      >
        {t("widgets.intro")}
      </p>
      <WidgetsSectionBody
        widgets={widgets}
        onChange={setDraftWidgets}
        claudeConfigDirs={claudeConfigDirs}
        grokConfigDirs={grokConfigDirs}
        fontFamilies={monoFonts}
      />
    </div>
  );
}

function ClaudeUsageGroup() {
  const { t } = useTranslation("settings");
  const storeClaudeUsage = useSettingsStore((s) => s.usage.claude);
  const setUsageAgent = useSettingsStore((s) => s.setUsageAgent);
  const profiles = useSettingsStore((s) => s.profiles);
  const defaultProfile = useSettingsStore((s) => s.defaultProfile);
  const [claudeUsage, setDraftClaudeUsage] = useDraft("usage-claude", storeClaudeUsage, (v) =>
    setUsageAgent("claude", v),
  );

  const updateClaude = (partial: Partial<typeof claudeUsage>) =>
    setDraftClaudeUsage((prev) => ({ ...prev, ...partial }));

  const addConfigDir = () => updateClaude({ configDirs: [...claudeUsage.configDirs, ""] });
  const removeConfigDir = (index: number) =>
    updateClaude({ configDirs: claudeUsage.configDirs.filter((_, i) => i !== index) });
  const updateConfigDir = (index: number, value: string) =>
    updateClaude({ configDirs: claudeUsage.configDirs.map((d, i) => (i === index ? value : d)) });
  const visibleRowLabels: Record<UsageVisibleRow, string> = {
    session: t("usage.rowSession"),
    weekAll: t("usage.rowWeekAll"),
    weekModel: t("usage.rowWeekModel"),
  };

  return (
    <SubGroup title={t("usage.title")}>
      <p
        className="pb-2 text-[11px] leading-relaxed"
        style={{ color: "var(--text-secondary)", opacity: 0.75 }}
      >
        {t("usage.intro")}
      </p>
      <UsageProfileFields
        usage={claudeUsage}
        update={updateClaude}
        profiles={profiles}
        defaultProfile={defaultProfile}
        testIdPrefix="usage"
        profileLabel={t("usage.profile")}
        profileDescription={t("usage.profileDesc")}
        refreshDescription={t("usage.refreshDesc")}
      />
      <UsageRowSelection
        rows={USAGE_VISIBLE_ROW_KEYS}
        visibleRows={claudeUsage.visibleRows}
        labels={visibleRowLabels}
        testIdPrefix="usage"
        update={(visibleRows) => updateClaude({ visibleRows })}
      />

      <div className="flex items-start gap-3 py-1.5">
        <div className="w-36 shrink-0 pt-1">
          <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
            {t("usage.configDirs")}
          </span>
          <p
            className="mt-0.5 text-[11px] leading-tight"
            style={{ color: "var(--text-secondary)", opacity: 0.65 }}
          >
            {t("usage.configDirsDesc")}
          </p>
        </div>
        <div className="min-w-0 flex-1">
          {claudeUsage.configDirs.map((dir, i) => (
            <div key={i} className="mb-2 flex items-center gap-2">
              <FocusInput
                data-testid={`usage-config-dir-input-${i}`}
                placeholder={t("usage.configDirPlaceholder")}
                value={dir}
                onChange={(e) => updateConfigDir(i, e.target.value)}
              />
              <button
                data-testid={`usage-config-dir-remove-${i}`}
                className="rounded px-1.5 py-0.5 text-xs"
                style={{
                  background: "var(--bg-overlay)",
                  color: "var(--red)",
                  border: "1px solid var(--border)",
                }}
                onClick={() => removeConfigDir(i)}
              >
                {t("common.remove")}
              </button>
            </div>
          ))}
          <button
            data-testid="usage-config-dir-add"
            className="rounded px-2 py-1 text-xs"
            style={{
              background: "var(--bg-overlay)",
              color: "var(--accent)",
              border: "1px solid var(--border)",
            }}
            onClick={addConfigDir}
          >
            {t("usage.addConfigDir")}
          </button>
        </div>
      </div>
      <UsageColorFields
        testIdPrefix="usage-claude"
        colors={claudeUsage.colors}
        update={(partial) => updateClaude({ colors: { ...claudeUsage.colors, ...partial } })}
      />
    </SubGroup>
  );
}

function CodexUsageGroup() {
  const { t } = useTranslation("settings");
  const storeCodexUsage = useSettingsStore((s) => s.usage.codex);
  const setCodexUsage = useSettingsStore((s) => s.setCodexUsage);
  const profiles = useSettingsStore((s) => s.profiles);
  const defaultProfile = useSettingsStore((s) => s.defaultProfile);
  const [codexUsage, setDraftCodexUsage] = useDraft("usage-codex", storeCodexUsage, setCodexUsage);

  const updateCodex = (partial: Partial<typeof codexUsage>) =>
    setDraftCodexUsage((prev) => ({ ...prev, ...partial }));
  const codexVisibleRowLabels: Record<CodexUsageVisibleRow, string> = {
    weekly: t("usage.rowWeekly"),
    sparkWeekly: t("usage.rowSparkWeekly"),
  };

  return (
    <SubGroup title={t("usage.title")}>
      <UsageProfileFields
        usage={codexUsage}
        update={updateCodex}
        profiles={profiles}
        defaultProfile={defaultProfile}
        testIdPrefix="codex-usage"
        profileLabel={t("usage.codexProfile")}
        profileDescription={t("usage.codexProfileDesc")}
        refreshDescription={t("usage.codexRefreshDesc")}
      />
      <UsageRowSelection
        rows={CODEX_USAGE_VISIBLE_ROW_KEYS}
        visibleRows={codexUsage.visibleRows}
        labels={codexVisibleRowLabels}
        testIdPrefix="codex-usage"
        update={(visibleRows) => updateCodex({ visibleRows })}
      />
      <div className="flex items-start gap-3 py-1.5">
        <div className="w-36 shrink-0 pt-1">
          <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
            {t("usage.codexAccountDirs")}
          </span>
          <p
            className="mt-0.5 text-[11px] leading-tight"
            style={{ color: "var(--text-secondary)", opacity: 0.65 }}
          >
            {t("usage.codexAccountDirsDesc")}
          </p>
        </div>
        <div className="min-w-0 flex-1">
          {codexUsage.configDirs.map((dir, i) => (
            <div key={i} className="mb-2 flex items-center gap-2">
              <FocusInput
                data-testid={`codex-usage-config-dir-input-${i}`}
                placeholder={t("usage.codexAccountDirPlaceholder")}
                value={dir}
                onChange={(e) =>
                  updateCodex({
                    configDirs: codexUsage.configDirs.map((value, index) =>
                      index === i ? e.target.value : value,
                    ),
                  })
                }
              />
              <button
                data-testid={`codex-usage-config-dir-remove-${i}`}
                className="rounded px-1.5 py-0.5 text-xs"
                style={{
                  background: "var(--bg-overlay)",
                  color: "var(--red)",
                  border: "1px solid var(--border)",
                }}
                onClick={() =>
                  updateCodex({
                    configDirs: codexUsage.configDirs.filter((_, index) => index !== i),
                  })
                }
              >
                {t("common.remove")}
              </button>
            </div>
          ))}
          <button
            data-testid="codex-usage-config-dir-add"
            className="rounded px-2 py-1 text-xs"
            style={{
              background: "var(--bg-overlay)",
              color: "var(--accent)",
              border: "1px solid var(--border)",
            }}
            onClick={() => updateCodex({ configDirs: [...codexUsage.configDirs, ""] })}
          >
            {t("usage.addCodexAccount")}
          </button>
        </div>
      </div>
      <UsageColorFields
        testIdPrefix="usage-codex"
        colors={codexUsage.colors}
        update={(partial) => updateCodex({ colors: { ...codexUsage.colors, ...partial } })}
      />
    </SubGroup>
  );
}

function GrokUsageGroup() {
  const { t } = useTranslation("settings");
  const storeGrokUsage = useSettingsStore((s) => s.usage.grok);
  const setGrokUsage = useSettingsStore((s) => s.setGrokUsage);
  const profiles = useSettingsStore((s) => s.profiles);
  const defaultProfile = useSettingsStore((s) => s.defaultProfile);
  const [grokUsage, setDraftGrokUsage] = useDraft("usage-grok", storeGrokUsage, setGrokUsage);

  const updateGrokUsage = (partial: Partial<typeof grokUsage>) =>
    setDraftGrokUsage((prev) => ({ ...prev, ...partial }));
  const grokVisibleRowLabels: Record<GrokUsageVisibleRow, string> = {
    weekly: t("usage.rowWeekly"),
    credits: t("usage.rowCredits"),
    payg: t("usage.rowPayg"),
  };

  return (
    <SubGroup title={t("usage.title")}>
      <UsageProfileFields
        usage={grokUsage}
        update={updateGrokUsage}
        profiles={profiles}
        defaultProfile={defaultProfile}
        testIdPrefix="grok-usage"
        profileLabel={t("usage.grokProfile")}
        profileDescription={t("usage.grokProfileDesc")}
        refreshDescription={t("usage.grokRefreshDesc")}
      />
      <UsageRowSelection
        rows={GROK_USAGE_VISIBLE_ROW_KEYS}
        visibleRows={grokUsage.visibleRows}
        labels={grokVisibleRowLabels}
        testIdPrefix="grok-usage"
        update={(visibleRows) => updateGrokUsage({ visibleRows })}
      />
      <div className="flex items-start gap-3 py-1.5">
        <div className="w-36 shrink-0 pt-1">
          <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
            {t("usage.grokConfigDirs")}
          </span>
          <p
            className="mt-0.5 text-[11px] leading-tight"
            style={{ color: "var(--text-secondary)", opacity: 0.65 }}
          >
            {t("usage.grokConfigDirsDesc")}
          </p>
        </div>
        <div className="min-w-0 flex-1">
          {grokUsage.configDirs.map((dir, i) => (
            <div key={i} className="mb-2 flex items-center gap-2">
              <FocusInput
                data-testid={`grok-usage-config-dir-input-${i}`}
                placeholder={t("usage.grokConfigDirPlaceholder")}
                value={dir}
                onChange={(e) =>
                  updateGrokUsage({
                    configDirs: grokUsage.configDirs.map((value, index) =>
                      index === i ? e.target.value : value,
                    ),
                  })
                }
              />
              <button
                data-testid={`grok-usage-config-dir-remove-${i}`}
                className="rounded px-1.5 py-0.5 text-xs"
                style={{
                  background: "var(--bg-overlay)",
                  color: "var(--red)",
                  border: "1px solid var(--border)",
                }}
                onClick={() =>
                  updateGrokUsage({
                    configDirs: grokUsage.configDirs.filter((_, index) => index !== i),
                  })
                }
              >
                {t("common.remove")}
              </button>
            </div>
          ))}
          <button
            data-testid="grok-usage-config-dir-add"
            className="rounded px-2 py-1 text-xs"
            style={{
              background: "var(--bg-overlay)",
              color: "var(--accent)",
              border: "1px solid var(--border)",
            }}
            onClick={() => updateGrokUsage({ configDirs: [...grokUsage.configDirs, ""] })}
          >
            {t("usage.addGrokConfigDir")}
          </button>
        </div>
      </div>
      <UsageColorFields
        testIdPrefix="usage-grok"
        colors={grokUsage.colors}
        update={(partial) => updateGrokUsage({ colors: { ...grokUsage.colors, ...partial } })}
      />
    </SubGroup>
  );
}

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
                    style={{
                      ...kbdStyle,
                      cursor: "pointer",
                      ...(isAssignedKeybinding(displayKeys) ? {} : { opacity: 0.5 }),
                    }}
                    onClick={() => handleStartCapture(def.id, def.defaultKeys)}
                    title={t("keybindings.changeShortcut")}
                  >
                    {/* 의도적으로 미할당인 액션(`terminal.osInputSourceSwitch`)은 빈
                        칸이 아니라 미할당임을 보여야 클릭 대상임을 알 수 있다. */}
                    {isAssignedKeybinding(displayKeys) ? displayKeys : t("keybindings.unassigned")}
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
                <XIcon size={12} />
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
      setDraft(storeValue);
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
  const [navChoice, setNavChoice] = useState<string>("startup");
  const settingsNavTarget = useUiStore((s) => s.settingsNavTarget);
  const setSettingsNavTarget = useUiStore((s) => s.setSettingsNavTarget);

  // External navigation via automation API (`ui.navigateSettings`). The request
  // lives in the ui store and is *derived* here rather than copied into local
  // state by an effect — mirroring would need a setState-in-effect cascade and
  // would split the "which section is open" truth across two owners. The
  // external target wins until the user picks a section, which releases it;
  // closing the settings modal releases it too (see `closeSettingsPatch`), so
  // reopening never replays a stale request.
  const requestedNav = settingsNavTarget ?? navChoice;
  // Keep the historical automation target `remote` as an alias for the
  // connection page while exposing the two new navigation entries to users.
  const activeNav = requestedNav === "remote" ? "remoteConnection" : requestedNav;
  const setActiveNav = (id: string) => {
    setNavChoice(id);
    if (useUiStore.getState().settingsNavTarget !== null) setSettingsNavTarget(null);
  };

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
  // Context value for the section draft registry. Every member is stable today
  // (useCallback with no deps, or a ref object), so in practice this memo runs
  // once and the context keeps a single identity — without parking the object
  // in a ref and reading `.current` during render.
  //
  // The deps are listed rather than left empty on purpose: an empty array would
  // assert stability that only `exhaustive-deps` suppression could express, and
  // would silently serve a stale closure if one of these ever grows a dep. With
  // the deps listed, a member turning unstable costs a context re-creation
  // (children re-render) instead of a wrong callback — a loud, correct failure.
  const draftCtx = useMemo<SettingsDraftCtx>(
    () => ({
      registerFlush,
      registerReset,
      markDirty,
      clearDirtyFor,
      draftValues: draftValuesRef,
    }),
    [registerFlush, registerReset, markDirty, clearDirtyFor],
  );

  const handleSave = () => {
    const shouldReconcileRemote = dirtySetRef.current.has("remoteConnection");
    const previousRemoteEnabled = useSettingsStore.getState().remote.enabled;
    const previousUpdateChannel = useSettingsStore.getState().update.channel;
    // Flush all draft states to store first
    for (const fn of flushMapRef.current.values()) fn();
    const nextRemoteEnabled = useSettingsStore.getState().remote.enabled;
    const nextUpdateChannel = useSettingsStore.getState().update.channel;
    draftValuesRef.current.clear();
    dirtySetRef.current.clear();
    setDirty(false);
    clearTimeout(saveTimerRef.current);
    persistSession()
      .then(async () => {
        if (shouldReconcileRemote) {
          await reconcileRemoteAccessAfterRemoteSave(previousRemoteEnabled, nextRemoteEnabled);
        }
        // A channel switch has to be answered now: the periodic check is six
        // hours away, and the backend reads the channel from the file this save
        // just wrote (ADR-0190). Failures stay in the update status.
        if (nextUpdateChannel !== previousUpdateChannel) {
          void checkAppUpdate().catch(() => {});
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

          {/* General */}
          <NavGroupHeader label={t("nav.groupGeneral")} />
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
          <button
            data-testid="nav-update"
            className="w-full px-4 py-2 text-left text-[13px]"
            style={navBtnStyle("update")}
            onClick={() => setActiveNav("update")}
            onMouseEnter={() => setNavHover("update")}
            onMouseLeave={() => setNavHover(null)}
          >
            {t("nav.update")}
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
            data-testid="nav-widgets"
            className="w-full px-4 py-2 text-left text-[13px]"
            style={navBtnStyle("widgets")}
            onClick={() => setActiveNav("widgets")}
            onMouseEnter={() => setNavHover("widgets")}
            onMouseLeave={() => setNavHover(null)}
          >
            {t("nav.widgets")}
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

          {/* Remote */}
          <NavGroupHeader label={t("nav.groupRemote")} />
          <button
            data-testid="nav-remote"
            className="w-full px-4 py-2 text-left text-[13px]"
            style={navBtnStyle("remoteConnection")}
            onClick={() => setActiveNav("remoteConnection")}
            onMouseEnter={() => setNavHover("remoteConnection")}
            onMouseLeave={() => setNavHover(null)}
          >
            {t("nav.remoteConnection")}
          </button>

          {/* Agents */}
          <NavGroupHeader label={t("nav.groupAgents")} />
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
          <button
            data-testid="nav-grok"
            className="w-full px-4 py-2 text-left text-[13px]"
            style={navBtnStyle("grok")}
            onClick={() => setActiveNav("grok")}
            onMouseEnter={() => setNavHover("grok")}
            onMouseLeave={() => setNavHover(null)}
          >
            {t("nav.grok")}
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
            data-testid="nav-viewer"
            className="w-full px-4 py-2 text-left text-[13px]"
            style={navBtnStyle("viewer")}
            onClick={() => setActiveNav("viewer")}
            onMouseEnter={() => setNavHover("viewer")}
            onMouseLeave={() => setNavHover(null)}
          >
            {t("nav.viewer")}
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
          <button
            data-testid="nav-github"
            className="w-full px-4 py-2 text-left text-[13px]"
            style={navBtnStyle("github")}
            onClick={() => setActiveNav("github")}
            onMouseEnter={() => setNavHover("github")}
            onMouseLeave={() => setNavHover(null)}
          >
            {t("nav.github")}
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
              title={t("nav.addProfile")}
              aria-label={t("nav.addProfile")}
              className="text-xs"
              style={{
                color: "var(--accent)",
                background: "transparent",
                border: "none",
                cursor: "pointer",
              }}
            >
              <PlusIcon />
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
                  <XIcon size={12} />
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
            {activeNav === "update" && <UpdateSection />}
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
            {activeNav === "remoteConnection" && <RemoteConnectionSection />}
            {activeNav === "claude" && <ClaudeSection />}
            {activeNav === "codex" && <CodexSection />}
            {activeNav === "grok" && <GrokSection />}
            {activeNav === "memo" && <MemoSection />}
            {activeNav === "fileExplorer" && <FileExplorerSection />}
            {activeNav === "viewer" && <ViewerSection />}
            {activeNav === "widgets" && <WidgetsSection />}
            {activeNav === "issueReporter" && <IssueReporterSection />}
            {activeNav === "github" && <GitHubSection />}
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
