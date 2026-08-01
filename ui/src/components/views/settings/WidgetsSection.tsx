/**
 * The only place widget placement is edited (ADR-0105).
 *
 * Four ordered lists are the whole model, so the UI is four lists: adding,
 * moving and reordering are the same array transforms `lib/widget-placement`
 * exposes, and nothing here knows what a widget draws.
 */

import { useTranslation } from "react-i18next";
import { ToggleSwitch } from "@/components/ui/ToggleSwitch";
import { WIDGET_DEFINITIONS, findWidgetDefinition } from "@/components/widgets/registry";
import type { WidgetOptionSpec } from "@/components/widgets/types";
import {
  addWidget,
  nudgeWidget,
  moveWidget,
  removeWidget,
  slotKey,
  updateWidgetOptions,
  WIDGET_SLOT_IDS,
  readSlot,
  type WidgetInstance,
  type WidgetSlotId,
  type WidgetsSettings,
} from "@/lib/widget-placement";

export interface WidgetsSectionBodyProps {
  widgets: WidgetsSettings;
  onChange: (next: WidgetsSettings) => void;
  /** Claude config dirs offered for a `claudeUsage` widget; "" is the default one. */
  claudeConfigDirs: readonly string[];
}

function newInstanceId(): string {
  return `w-${crypto.randomUUID().slice(0, 8)}`;
}

const rowButtonStyle: React.CSSProperties = {
  background: "transparent",
  border: "1px solid var(--border)",
  color: "var(--text-secondary)",
  borderRadius: "var(--radius-sm)",
  cursor: "pointer",
};

const selectStyle: React.CSSProperties = {
  background: "var(--bg-base)",
  border: "1px solid var(--border)",
  color: "var(--text-primary)",
  borderRadius: "var(--radius-sm)",
  fontSize: "var(--fs-xs)",
  padding: "2px 4px",
};

export function WidgetsSectionBody({
  widgets,
  onChange,
  claudeConfigDirs,
}: WidgetsSectionBodyProps) {
  const { t } = useTranslation("settings");

  return (
    <div data-testid="settings-widgets-section-body">
      <div className="flex items-center justify-between px-4 py-2">
        <div className="min-w-0">
          <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
            {t("widgets.statusLineEnabled")}
          </span>
          <p
            className="mt-0.5 text-[11px] leading-tight"
            style={{ color: "var(--text-secondary)", opacity: 0.65 }}
          >
            {t("widgets.statusLineEnabledDesc")}
          </p>
        </div>
        <ToggleSwitch
          data-testid="widgets-status-line-toggle"
          checked={widgets.statusLine.enabled}
          onChange={(enabled) =>
            onChange({ ...widgets, statusLine: { ...widgets.statusLine, enabled } })
          }
        />
      </div>

      {WIDGET_SLOT_IDS.map((slot) => (
        <SlotEditor
          key={slotKey(slot)}
          slot={slot}
          widgets={widgets}
          onChange={onChange}
          claudeConfigDirs={claudeConfigDirs}
        />
      ))}
    </div>
  );
}

function SlotEditor({
  slot,
  widgets,
  onChange,
  claudeConfigDirs,
}: {
  slot: WidgetSlotId;
  widgets: WidgetsSettings;
  onChange: (next: WidgetsSettings) => void;
  claudeConfigDirs: readonly string[];
}) {
  const { t } = useTranslation("settings");
  const instances = readSlot(widgets, slot);
  const key = slotKey(slot);

  return (
    <div className="px-4 py-2">
      <div className="mb-1 flex items-center justify-between">
        <span
          className="text-[12px] font-medium"
          style={{ color: "var(--text-primary)" }}
          data-testid={`widgets-slot-title-${key}`}
        >
          {t(`widgets.slot.${key}`)}
        </span>
        <select
          data-testid={`widgets-add-${key}`}
          style={selectStyle}
          value=""
          onChange={(event) => {
            const definition = findWidgetDefinition(event.target.value);
            if (!definition) return;
            onChange(
              addWidget(widgets, slot, {
                id: newInstanceId(),
                type: definition.type,
                options: { ...definition.defaultOptions },
              }),
            );
          }}
        >
          <option value="">{t("widgets.add")}</option>
          {WIDGET_DEFINITIONS.map((definition) => (
            <option key={definition.type} value={definition.type}>
              {t(definition.labelKey)}
            </option>
          ))}
        </select>
      </div>

      {instances.length === 0 && (
        <p className="text-[11px]" style={{ color: "var(--text-secondary)", opacity: 0.65 }}>
          {t("widgets.empty")}
        </p>
      )}

      {instances.map((instance, index) => (
        <WidgetRow
          key={instance.id}
          instance={instance}
          index={index}
          count={instances.length}
          slot={slot}
          widgets={widgets}
          onChange={onChange}
          claudeConfigDirs={claudeConfigDirs}
        />
      ))}
    </div>
  );
}

function WidgetRow({
  instance,
  index,
  count,
  slot,
  widgets,
  onChange,
  claudeConfigDirs,
}: {
  instance: WidgetInstance;
  index: number;
  count: number;
  slot: WidgetSlotId;
  widgets: WidgetsSettings;
  onChange: (next: WidgetsSettings) => void;
  claudeConfigDirs: readonly string[];
}) {
  const { t } = useTranslation("settings");
  const definition = findWidgetDefinition(instance.type);

  return (
    <div
      data-testid={`widgets-row-${instance.id}`}
      className="mb-1 flex flex-wrap items-center gap-1 rounded px-2 py-1"
      style={{ border: "1px solid var(--separator-bg)" }}
    >
      <span className="mr-auto text-[12px]" style={{ color: "var(--text-primary)" }}>
        {definition ? t(definition.labelKey) : t("widgets.unknownType", { type: instance.type })}
      </span>

      {definition?.optionSpecs.map((spec) => (
        <OptionControl
          key={spec.key}
          spec={spec}
          instance={instance}
          widgets={widgets}
          onChange={onChange}
          claudeConfigDirs={claudeConfigDirs}
        />
      ))}

      <select
        data-testid={`widgets-move-${instance.id}`}
        style={selectStyle}
        value={slotKey(slot)}
        onChange={(event) => {
          const target = WIDGET_SLOT_IDS.find(
            (candidate) => slotKey(candidate) === event.target.value,
          );
          if (target) onChange(moveWidget(widgets, instance.id, target, Number.MAX_SAFE_INTEGER));
        }}
      >
        {WIDGET_SLOT_IDS.map((candidate) => (
          <option key={slotKey(candidate)} value={slotKey(candidate)}>
            {t(`widgets.slot.${slotKey(candidate)}`)}
          </option>
        ))}
      </select>

      <button
        type="button"
        data-testid={`widgets-up-${instance.id}`}
        className="px-1.5 text-[11px]"
        style={{ ...rowButtonStyle, opacity: index === 0 ? 0.4 : 1 }}
        disabled={index === 0}
        title={t("widgets.moveUp")}
        onClick={() => onChange(nudgeWidget(widgets, instance.id, -1))}
      >
        ↑
      </button>
      <button
        type="button"
        data-testid={`widgets-down-${instance.id}`}
        className="px-1.5 text-[11px]"
        style={{ ...rowButtonStyle, opacity: index === count - 1 ? 0.4 : 1 }}
        disabled={index === count - 1}
        title={t("widgets.moveDown")}
        onClick={() => onChange(nudgeWidget(widgets, instance.id, 1))}
      >
        ↓
      </button>
      <button
        type="button"
        data-testid={`widgets-remove-${instance.id}`}
        className="px-1.5 text-[11px]"
        style={rowButtonStyle}
        title={t("widgets.remove")}
        onClick={() => onChange(removeWidget(widgets, instance.id))}
      >
        ✕
      </button>
    </div>
  );
}

function OptionControl({
  spec,
  instance,
  widgets,
  onChange,
  claudeConfigDirs,
}: {
  spec: WidgetOptionSpec;
  instance: WidgetInstance;
  widgets: WidgetsSettings;
  onChange: (next: WidgetsSettings) => void;
  claudeConfigDirs: readonly string[];
}) {
  const { t } = useTranslation("settings");
  const value =
    typeof instance.options[spec.key] === "string" ? String(instance.options[spec.key]) : "";
  const choices =
    spec.kind === "claudeConfigDir" ? ["", ...claudeConfigDirs.filter(Boolean)] : spec.choices;

  return (
    <select
      data-testid={`widgets-option-${instance.id}-${spec.key}`}
      title={t(spec.labelKey)}
      aria-label={t(spec.labelKey)}
      style={selectStyle}
      value={value}
      onChange={(event) =>
        onChange(updateWidgetOptions(widgets, instance.id, { [spec.key]: event.target.value }))
      }
    >
      {choices.map((choice) => (
        <option key={choice} value={choice}>
          {spec.kind === "claudeConfigDir"
            ? choice || t("widgets.configDirDefault")
            : t(`widgets.value.${spec.key}.${choice}`)}
        </option>
      ))}
    </select>
  );
}
