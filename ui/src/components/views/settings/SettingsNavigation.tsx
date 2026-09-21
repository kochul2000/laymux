import type { ComponentType } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/Button";
import {
  BotIcon,
  ClipboardIcon,
  DownloadIcon,
  FileIcon,
  FileJsonIcon,
  FolderIcon,
  GitBranchIcon,
  KeyboardIcon,
  LayersIcon,
  PaletteIcon,
  PanelTopIcon,
  PencilIcon,
  PlusIcon,
  RadioTowerIcon,
  RocketIcon,
  SettingsIcon,
  TerminalIcon,
  TypeIcon,
  WarningIcon,
  XIcon,
  type IconProps,
} from "@/components/ui/icons";

type NavigationItem = { id: string; label: string; icon: ComponentType<IconProps> };
const groups: { label: string; items: NavigationItem[] }[] = [
  {
    label: "groupGeneral",
    items: [
      { id: "startup", label: "startup", icon: RocketIcon },
      { id: "update", label: "update", icon: DownloadIcon },
    ],
  },
  {
    label: "groupAppearance",
    items: [
      { id: "font", label: "appFont", icon: TypeIcon },
      { id: "interface", label: "interface", icon: SettingsIcon },
      { id: "workspaceDisplay", label: "workspaces", icon: LayersIcon },
      { id: "widgets", label: "widgets", icon: PanelTopIcon },
    ],
  },
  {
    label: "groupTerminal",
    items: [
      { id: "terminal", label: "terminal", icon: TerminalIcon },
      { id: "colorSchemes", label: "colorSchemes", icon: PaletteIcon },
    ],
  },
  {
    label: "groupInput",
    items: [
      { id: "paste", label: "paste", icon: ClipboardIcon },
      { id: "keybindings", label: "keybindings", icon: KeyboardIcon },
    ],
  },
  {
    label: "groupViews",
    items: [
      { id: "memo", label: "memo", icon: PencilIcon },
      { id: "fileExplorer", label: "fileExplorer", icon: FolderIcon },
      { id: "viewer", label: "viewer", icon: FileIcon },
      { id: "github", label: "github", icon: GitBranchIcon },
      { id: "issueReporter", label: "issueReporter", icon: WarningIcon },
    ],
  },
  {
    label: "groupAgents",
    items: [
      { id: "claude", label: "claude", icon: BotIcon },
      { id: "codex", label: "codex", icon: BotIcon },
      { id: "grok", label: "grok", icon: BotIcon },
    ],
  },
  {
    label: "groupRemote",
    items: [{ id: "remoteConnection", label: "remoteConnection", icon: RadioTowerIcon }],
  },
];

/** Navigation stays independent of the page scroll; JSON is always reachable. */
export function SettingsNavigation({
  activeNav,
  profiles,
  onNavigate,
  onAddProfile,
  onRemoveProfile,
  onOpenJson,
}: {
  activeNav: string;
  profiles: readonly { name: string }[];
  onNavigate: (id: string) => void;
  onAddProfile: () => void;
  onRemoveProfile: (index: number) => void;
  onOpenJson: () => void;
}) {
  const { t } = useTranslation("settings");
  return (
    <aside className="settings-sidebar">
      <nav className="settings-nav-scroll">
        {groups.map(({ label, items }) => (
          <section
            key={label}
            data-testid={`settings-group-${label}`}
            aria-label={t(`nav.${label}`)}
          >
            <div className="settings-nav-heading">
              <h3>{t(`nav.${label}`)}</h3>
            </div>
            {items.map(({ id, label: itemLabel, icon: Icon }) => (
              <button
                key={id}
                data-testid={`nav-${id === "remoteConnection" ? "remote" : id}`}
                className="settings-nav-button"
                aria-label={t(`nav.${itemLabel}`)}
                title={t(`nav.${itemLabel}`)}
                aria-current={activeNav === id ? "page" : undefined}
                onClick={() => onNavigate(id)}
              >
                <Icon size={16} />
                <span className="settings-nav-label">{t(`nav.${itemLabel}`)}</span>
              </button>
            ))}
          </section>
        ))}

        <section aria-label={t("nav.groupProfiles")}>
          <div className="settings-nav-heading">
            <h3>{t("nav.groupProfiles")}</h3>
          </div>
          <button
            data-testid="nav-profile-defaults"
            className="settings-nav-button"
            aria-label={t("nav.profileDefaults")}
            title={t("nav.profileDefaults")}
            aria-current={activeNav === "defaults" ? "page" : undefined}
            onClick={() => onNavigate("defaults")}
          >
            <LayersIcon size={16} />
            <span className="settings-nav-label">{t("nav.profileDefaults")}</span>
          </button>
          {profiles.map((profile, index) => (
            <div key={`profile-${index}`} className="settings-profile-nav">
              <button
                className="settings-nav-button"
                aria-label={profile.name}
                title={profile.name}
                aria-current={activeNav === `profile-${index}` ? "page" : undefined}
                onClick={() => onNavigate(`profile-${index}`)}
              >
                <TerminalIcon size={16} />
                <span className="settings-nav-label">{profile.name}</span>
              </button>
              <button
                data-testid={`remove-profile-${index}`}
                className="settings-profile-remove"
                title={t("nav.deleteProfile")}
                aria-label={t("nav.deleteProfile")}
                onClick={() => onRemoveProfile(index)}
              >
                <XIcon size={12} />
              </button>
            </div>
          ))}
          <button
            data-testid="add-profile-btn"
            className="settings-nav-button"
            title={t("nav.addProfile")}
            aria-label={t("nav.addProfile")}
            onClick={onAddProfile}
          >
            <PlusIcon size={16} />
            <span className="settings-nav-label">{t("nav.addProfile")}</span>
          </button>
        </section>
      </nav>
      <div className="settings-nav-footer">
        <Button
          data-testid="sidebar-open-json"
          className="settings-json-button"
          icon={<FileJsonIcon size={16} />}
          onClick={onOpenJson}
          title={t("nav.openJsonTitle")}
          aria-label={t("nav.openJsonTitle")}
        >
          <span className="settings-nav-label">{t("nav.openJson")}</span>
        </Button>
      </div>
    </aside>
  );
}
