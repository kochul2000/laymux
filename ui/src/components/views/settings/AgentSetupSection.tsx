import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/Button";
import { ExternalLinkIcon } from "@/components/ui/icons";
import { FocusSelect } from "@/components/ui/FormControls";
import { inputCls } from "@/components/ui/form-control-styles";
import {
  checkAgentInstallation,
  clipboardWriteText,
  openExternal,
  type AgentInstallationResult,
} from "@/lib/tauri-api";
import { openAgentSetupPane } from "@/lib/agent-setup-pane";
import { agentInstallGuidance } from "@/lib/agent-install-guidance";
import {
  resolveAgentCommand,
  DEFAULT_CLAUDE_COMMAND,
  DEFAULT_CODEX_COMMAND,
  DEFAULT_GROK_COMMAND,
} from "@/lib/agent-command";
import { useSettingsStore } from "@/stores/settings-store";
import type { AgentId } from "@/stores/agent-startup-store";
import { useAgentStartupStore } from "@/stores/agent-startup-store";
import { SettingsField, SettingsGroup, SettingsPageTitle } from "./SettingsLayout";

const AGENTS: AgentId[] = ["claude", "codex", "grok"];
const DEFAULT_COMMANDS = {
  claude: DEFAULT_CLAUDE_COMMAND,
  codex: DEFAULT_CODEX_COMMAND,
  grok: DEFAULT_GROK_COMMAND,
};
const LOGIN_DOCS: Record<AgentId, string> = {
  claude: "https://code.claude.com/docs/en/setup",
  codex: "https://learn.chatgpt.com/docs/developer-commands",
  grok: "https://docs.x.ai/build/cli/reference",
};

export function AgentSetupSection({ onNavigate }: { onNavigate: (section: string) => void }) {
  const { t } = useTranslation("settings");
  const profiles = useSettingsStore((state) => state.profiles);
  const defaultProfile = useSettingsStore((state) => state.defaultProfile);
  const profileDefaults = useSettingsStore((state) => state.profileDefaults);
  const claudeCommand = useSettingsStore((state) => state.claude.command);
  const codexCommand = useSettingsStore((state) => state.codex.command);
  const grokCommand = useSettingsStore((state) => state.grok.command);
  const claudeSettings = useSettingsStore((state) => state.claude);
  const codexSettings = useSettingsStore((state) => state.codex);
  const grokSettings = useSettingsStore((state) => state.grok);
  const [agentId, setAgentId] = useState<AgentId>("claude");
  const [profileChoice, setProfileChoice] = useState("");
  const [check, setCheck] = useState<{ key: string; result: AgentInstallationResult } | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<{ key: string; message: string } | null>(null);
  const [openedPaneId, setOpenedPaneId] = useState<string | null>(null);
  const openedOutcome = useAgentStartupStore((state) =>
    openedPaneId ? state.outcomes[openedPaneId] : undefined,
  );
  const checkSequence = useRef(0);

  const profileName = profiles.some((profile) => profile.name === profileChoice)
    ? profileChoice
    : (profiles.find((profile) => profile.name === defaultProfile)?.name ??
      profiles[0]?.name ??
      "");
  const profile = profiles.find((candidate) => candidate.name === profileName);
  const configuredCommand = { claude: claudeCommand, codex: codexCommand, grok: grokCommand }[
    agentId
  ];
  const effectiveCommand = resolveAgentCommand(configuredCommand, DEFAULT_COMMANDS[agentId]);
  const agentSettings = { claude: claudeSettings, codex: codexSettings, grok: grokSettings }[
    agentId
  ];
  const key = JSON.stringify([agentId, profileName, profile, profileDefaults, agentSettings]);
  const result = check?.key === key ? check.result : null;
  const installGuidance = agentInstallGuidance(
    agentId,
    result?.environment ?? "unknown",
    profile?.commandLine ?? "",
  );
  const visibleError = error?.key === key ? error.message : null;

  const changeTarget = () => {
    checkSequence.current += 1;
    setCheck(null);
    setChecking(null);
    setError(null);
    setCopyFeedback(null);
  };

  const runCheck = async () => {
    const sequence = ++checkSequence.current;
    setChecking(key);
    setError(null);
    try {
      const checked = await checkAgentInstallation(agentId, profileName);
      if (checkSequence.current === sequence) setCheck({ key, result: checked });
    } catch (cause) {
      if (checkSequence.current === sequence) {
        setCheck(null);
        setError({ key, message: cause instanceof Error ? cause.message : String(cause) });
      }
    } finally {
      if (checkSequence.current === sequence) setChecking(null);
    }
  };

  const openPane = (intent: AgentId | "shell") => {
    const paneId = openAgentSetupPane(profileName, intent);
    if (paneId) setOpenedPaneId(paneId);
    else setError({ key, message: t("agentSetup.openFailed") });
  };

  const copyCommand = async () => {
    if (!installGuidance.command) return;
    try {
      await clipboardWriteText(installGuidance.command);
      setCopyFeedback({ key, message: t("agentSetup.copied") });
    } catch {
      setCopyFeedback({ key, message: t("agentSetup.copyFailed") });
    }
  };

  return (
    <div className="settings-page" data-testid="agent-setup-page">
      <SettingsPageTitle>{t("agentSetup.title")}</SettingsPageTitle>
      <SettingsGroup title={t("agentSetup.chooseGroup")} description={t("agentSetup.intro")}>
        <SettingsField label={t("agentSetup.agent")}>
          <FocusSelect
            className={inputCls}
            data-testid="agent-setup-agent"
            value={agentId}
            onChange={(event) => {
              changeTarget();
              setAgentId(event.target.value as AgentId);
            }}
          >
            {AGENTS.map((agent) => (
              <option key={agent} value={agent}>
                {t(`nav.${agent}`)}
              </option>
            ))}
          </FocusSelect>
        </SettingsField>
        <SettingsField label={t("agentSetup.profile")} desc={t("agentSetup.profileDesc")}>
          <FocusSelect
            className={inputCls}
            data-testid="agent-setup-profile"
            value={profileName}
            onChange={(event) => {
              changeTarget();
              setProfileChoice(event.target.value);
            }}
          >
            {profiles.map((candidate) => (
              <option key={candidate.name} value={candidate.name}>
                {candidate.name}
              </option>
            ))}
          </FocusSelect>
        </SettingsField>
        <SettingsField
          label={t("agentSetup.command")}
          desc={t("agentSetup.commandDesc")}
          layout="stack"
        >
          <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
            <code
              className="min-w-0 max-w-full break-all whitespace-pre-wrap"
              data-testid="agent-setup-command"
            >
              {result?.effectiveCommand ?? effectiveCommand}
            </code>
            <Button onClick={() => onNavigate(agentId)} data-testid="agent-setup-advanced">
              {t("agentSetup.advanced")}
            </Button>
          </div>
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup title={t("agentSetup.checkGroup")}>
        <SettingsField label={t("agentSetup.installation")}>
          <Button
            data-testid="agent-setup-check"
            onClick={runCheck}
            disabled={checking === key || !profileName}
            title={
              checking === key
                ? t("agentSetup.checking")
                : !profileName
                  ? t("agentSetup.noProfile")
                  : undefined
            }
          >
            {checking === key ? t("agentSetup.checking") : t("agentSetup.check")}
          </Button>
        </SettingsField>
        {result?.status === "installed" && (
          <p data-testid="agent-setup-installed" role="status">
            {t("agentSetup.installed", {
              environment: t(`agentSetup.environment.${result.environment}`),
            })}
            {result.version ? (
              <>
                {" "}
                · <span>{result.version}</span>
              </>
            ) : null}
          </p>
        )}
        {result?.status === "unknown" && <p role="status">{t("agentSetup.unknown")}</p>}
        {result?.detail && <p>{result.detail}</p>}
        {visibleError && <p role="alert">{visibleError}</p>}
        {(result?.status === "missing" || result?.status === "unknown" || visibleError) && (
          <div
            data-testid={
              result?.status === "missing" ? "agent-setup-install-help" : "agent-setup-check-help"
            }
          >
            {result?.status === "missing" && (
              <p>
                {t("agentSetup.missing", {
                  environment: t(`agentSetup.environment.${result.environment}`),
                })}
              </p>
            )}
            {result?.status === "missing" && installGuidance.command && (
              <SettingsField label={t("agentSetup.installCommand")} layout="stack">
                <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
                  <code
                    className="min-w-0 max-w-full break-all whitespace-pre-wrap"
                    data-testid="agent-setup-install-command"
                  >
                    {installGuidance.command}
                  </code>
                  <Button data-testid="agent-setup-copy-command" onClick={() => void copyCommand()}>
                    {t("agentSetup.copyCommand")}
                  </Button>
                  {copyFeedback?.key === key && <span role="status">{copyFeedback.message}</span>}
                </div>
              </SettingsField>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                data-testid="agent-setup-install-docs"
                icon={<ExternalLinkIcon size={16} />}
                title={t("agentSetup.opensBrowser")}
                onClick={() => void openExternal(installGuidance.docs)}
              >
                {t("agentSetup.installDocs")}
              </Button>
              <Button data-testid="agent-setup-open-terminal" onClick={() => openPane("shell")}>
                {t("agentSetup.openTerminal")}
              </Button>
            </div>
          </div>
        )}
      </SettingsGroup>

      <SettingsGroup title={t("agentSetup.loginGroup")} description={t("agentSetup.loginDesc")}>
        <SettingsField label={t("agentSetup.loginGuide")} desc={t(`agentSetup.login.${agentId}`)}>
          <Button
            icon={<ExternalLinkIcon size={16} />}
            title={t("agentSetup.opensBrowser")}
            onClick={() => void openExternal(LOGIN_DOCS[agentId])}
          >
            {t("agentSetup.loginDocs")}
          </Button>
        </SettingsField>
        <SettingsField label={t("agentSetup.launch")} desc={t("agentSetup.launchDesc")}>
          <Button
            variant="primary"
            data-testid="agent-setup-launch"
            disabled={result?.status !== "installed"}
            title={result?.status !== "installed" ? t("agentSetup.launchDisabled") : undefined}
            onClick={() => openPane(agentId)}
          >
            {t("agentSetup.launch")}
          </Button>
        </SettingsField>
        {openedPaneId && (
          <p
            role={openedOutcome?.status === "failed" ? "alert" : "status"}
            data-testid="agent-setup-start-status"
          >
            {openedOutcome?.status === "ready"
              ? t("agentSetup.terminalReady")
              : openedOutcome?.status === "failed"
                ? t("agentSetup.terminalFailed", { detail: openedOutcome.detail ?? "" })
                : t("agentSetup.terminalOpening")}
          </p>
        )}
      </SettingsGroup>
    </div>
  );
}
