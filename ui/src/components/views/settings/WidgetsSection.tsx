/**
 * The only place widget placement is edited (ADR-0105).
 *
 * Laid out as preview → pick → detail rather than as four exhaustive forms: the
 * question a user actually has is "what will the bar look like", and the answer
 * is the bar itself. Options belong to the widget you are pointing at, so they
 * appear only once something is selected.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { FocusInput, FocusSelect } from "@/components/ui/FormControls";
import { ToggleSwitch } from "@/components/ui/ToggleSwitch";
import { WIDGET_DEFINITIONS, findWidgetDefinition } from "@/components/widgets/registry";
import type { WidgetOptionSpec } from "@/components/widgets/types";
import {
  addWidget,
  allPlacements,
  moveWidget,
  nudgeWidget,
  readSlot,
  removeWidget,
  readWidgetFontSize,
  slotKey,
  updateWidgetOptions,
  WIDGET_SLOT_IDS,
  type WidgetInstance,
  type WidgetSlotId,
  type WidgetsSettings,
  WIDGET_FONT_SIZE_MAX,
  WIDGET_FONT_SIZE_MIN,
} from "@/lib/widget-placement";

export interface WidgetsSectionBodyProps {
  widgets: WidgetsSettings;
  onChange: (next: WidgetsSettings) => void;
  /** Claude config dirs offered for a `claudeUsage` widget; "" is the default one. */
  claudeConfigDirs: readonly string[];
  /** Extra GROK_HOME dirs offered for a `grokUsage` widget; "" is the default one. */
  grokConfigDirs?: readonly string[];
  /** Installed font families offered for the shared widget face. */
  fontFamilies?: readonly string[];
}

function newInstanceId(): string {
  return `w-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Compact form control sizing on top of the shared style.
 *
 * `FormControls` is what carries `colorScheme: "dark"`; without it a native
 * select paints its text with the OS light-mode colour and disappears against
 * the app background.
 */
const controlStyle: React.CSSProperties = { fontSize: "var(--fs-xs)", padding: "2px 4px" };

const buttonStyle: React.CSSProperties = {
  background: "transparent",
  border: "1px solid var(--border)",
  color: "var(--text-secondary)",
  cursor: "pointer",
};

export function WidgetsSectionBody({
  widgets,
  onChange,
  claudeConfigDirs,
  grokConfigDirs = [],
  fontFamilies = [],
}: WidgetsSectionBodyProps) {
  const { t } = useTranslation("settings");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const placements = allPlacements(widgets);
  // A removed widget must not leave a detail panel behind, and the selection is
  // derived rather than synced so no effect has to chase the placement.
  const selected = placements.find((placement) => placement.instance.id === selectedId) ?? null;

  const change = (next: WidgetsSettings) => onChange(next);

  return (
    <div data-testid="settings-widgets-section-body" className="flex flex-col gap-3 px-4 py-2">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="w-36 shrink-0 text-[12px]" style={{ color: "var(--text-primary)" }}>
            {t("widgets.fontFamily")}
          </span>
          <FocusSelect
            data-testid="widgets-font-family"
            style={{ ...controlStyle, minWidth: 160 }}
            value={widgets.fontFamily}
            onChange={(event) => change({ ...widgets, fontFamily: event.target.value })}
          >
            <option value="">{t("widgets.fontFamilyDefault")}</option>
            {widgets.fontFamily && !fontFamilies.includes(widgets.fontFamily) && (
              <option value={widgets.fontFamily}>{widgets.fontFamily}</option>
            )}
            {fontFamilies.map((family) => (
              <option key={family} value={family}>
                {family}
              </option>
            ))}
          </FocusSelect>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-36 shrink-0 text-[12px]" style={{ color: "var(--text-primary)" }}>
            {t("widgets.fontSize")}
          </span>
          <FocusInput
            type="number"
            data-testid="widgets-font-size"
            inputStyle={{ ...controlStyle, width: 60 }}
            min={WIDGET_FONT_SIZE_MIN}
            max={WIDGET_FONT_SIZE_MAX}
            value={readWidgetFontSize(widgets.fontSize)}
            onChange={(event) => {
              const size = Number(event.target.value);
              if (!Number.isFinite(size)) return;
              change({
                ...widgets,
                fontSize: Math.max(
                  WIDGET_FONT_SIZE_MIN,
                  Math.min(WIDGET_FONT_SIZE_MAX, Math.round(size)),
                ),
              });
            }}
          />
        </div>
      </div>

      <div className="flex items-center justify-between">
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
            change({ ...widgets, statusLine: { ...widgets.statusLine, enabled } })
          }
        />
      </div>

      <WidgetsPreview widgets={widgets} selectedId={selectedId} onSelect={setSelectedId} />

      <div className="flex flex-col gap-2">
        {WIDGET_SLOT_IDS.map((slot) => (
          <SlotRow
            key={slotKey(slot)}
            slot={slot}
            widgets={widgets}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onChange={(next, focusId) => {
              change(next);
              if (focusId !== undefined) setSelectedId(focusId);
            }}
          />
        ))}
      </div>

      {selected ? (
        <WidgetDetail
          instance={selected.instance}
          slot={selected.slot}
          index={selected.index}
          count={readSlot(widgets, selected.slot).length}
          widgets={widgets}
          claudeConfigDirs={claudeConfigDirs}
          grokConfigDirs={grokConfigDirs}
          onChange={change}
          onRemoved={() => setSelectedId(null)}
        />
      ) : (
        <p
          data-testid="widgets-select-hint"
          className="text-[11px]"
          style={{ color: "var(--text-secondary)", opacity: 0.65 }}
        >
          {t("widgets.selectHint")}
        </p>
      )}
    </div>
  );
}

/**
 * The bars as they will actually look, drawn with the real widgets.
 *
 * A mock would drift from the thing it depicts; rendering the registry
 * components means the preview is wrong only when the bar is wrong.
 */
function WidgetsPreview({
  widgets,
  selectedId,
  onSelect,
}: {
  widgets: WidgetsSettings;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation("settings");

  const surfaces = [
    { surface: "topBar" as const, label: t("widgets.previewTopBar"), dimmed: false },
    {
      surface: "statusLine" as const,
      label: t("widgets.previewStatusLine"),
      dimmed: !widgets.statusLine.enabled,
    },
  ];

  return (
    <div data-testid="widgets-preview" className="flex flex-col gap-1">
      {surfaces.map(({ surface, label, dimmed }) => (
        <div key={surface} className="flex flex-col gap-0.5">
          <span className="text-[10px]" style={{ color: "var(--text-secondary)", opacity: 0.65 }}>
            {label}
          </span>
          <div
            data-testid={`widgets-preview-${surface}`}
            className="ui-toolbar px-1"
            style={{
              background: "var(--bg-surface)",
              border: "1px solid var(--border)",
              // Off is not gone: the placement stays visible so turning the
              // surface back on holds no surprises.
              opacity: dimmed ? 0.4 : 1,
              fontFamily: widgets.fontFamily || "var(--ui-font)",
              fontSize: readWidgetFontSize(widgets.fontSize),
            }}
          >
            <PreviewSlot
              slot={{ surface, side: "left" }}
              widgets={widgets}
              selectedId={selectedId}
              onSelect={onSelect}
            />
            <div className="min-w-0" style={{ flex: "1 1 0%" }} />
            <PreviewSlot
              slot={{ surface, side: "right" }}
              widgets={widgets}
              selectedId={selectedId}
              onSelect={onSelect}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function PreviewSlot({
  slot,
  widgets,
  selectedId,
  onSelect,
}: {
  slot: WidgetSlotId;
  widgets: WidgetsSettings;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation("settings");
  const instances = readSlot(widgets, slot);

  if (instances.length === 0) {
    return (
      <span className="px-1 text-[10px]" style={{ color: "var(--text-secondary)", opacity: 0.4 }}>
        {t("widgets.empty")}
      </span>
    );
  }

  return (
    <div className="flex h-full min-w-0 items-center">
      {instances.map((instance) => {
        const definition = findWidgetDefinition(instance.type);
        const isSelected = instance.id === selectedId;
        return (
          <button
            key={instance.id}
            type="button"
            data-testid={`widgets-preview-item-${instance.id}`}
            className="flex h-full cursor-pointer items-center"
            style={{
              background: isSelected ? "var(--hover-bg, #ffffff14)" : "transparent",
              border: "none",
              outline: isSelected ? "1px solid var(--accent)" : "none",
              fontFamily: "inherit",
              fontSize: "inherit",
            }}
            onClick={() => onSelect(instance.id)}
          >
            {/* Pointer-transparent so the whole chip is one click target and no
                widget action fires from inside the preview. */}
            <span style={{ display: "contents", pointerEvents: "none" }}>
              {definition ? (
                <definition.Component instance={instance} />
              ) : (
                <span className="px-1.5 text-[10px]" style={{ color: "var(--text-muted)" }}>
                  {t("widgets.unknownType", { type: instance.type })}
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** One slot's contents as pickable chips, plus its add control. */
function SlotRow({
  slot,
  widgets,
  selectedId,
  onSelect,
  onChange,
}: {
  slot: WidgetSlotId;
  widgets: WidgetsSettings;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onChange: (next: WidgetsSettings, focusId?: string) => void;
}) {
  const { t } = useTranslation("settings");
  const instances = readSlot(widgets, slot);
  const key = slotKey(slot);

  return (
    <div className="flex flex-wrap items-center gap-1">
      <span
        data-testid={`widgets-slot-title-${key}`}
        className="w-36 shrink-0 text-[12px]"
        style={{ color: "var(--text-primary)" }}
      >
        {t(`widgets.slot.${key}`)}
      </span>

      {instances.map((instance) => {
        const definition = findWidgetDefinition(instance.type);
        const isSelected = instance.id === selectedId;
        return (
          <button
            key={instance.id}
            type="button"
            data-testid={`widgets-chip-${instance.id}`}
            className="px-1.5 py-0.5 text-[11px]"
            style={{
              ...buttonStyle,
              color: isSelected ? "var(--bg-base)" : "var(--text-secondary)",
              background: isSelected ? "var(--accent)" : "transparent",
              borderColor: isSelected ? "var(--accent)" : "var(--border)",
            }}
            onClick={() => onSelect(instance.id)}
          >
            {definition
              ? t(definition.labelKey)
              : t("widgets.unknownType", { type: instance.type })}
          </button>
        );
      })}

      {instances.length === 0 && (
        <span className="text-[11px]" style={{ color: "var(--text-secondary)", opacity: 0.5 }}>
          {t("widgets.empty")}
        </span>
      )}

      <FocusSelect
        data-testid={`widgets-add-${key}`}
        style={{ ...controlStyle, marginLeft: "auto" }}
        value=""
        onChange={(event) => {
          const definition = findWidgetDefinition(event.target.value);
          if (!definition) return;
          const instance = {
            id: newInstanceId(),
            type: definition.type,
            options: { ...definition.defaultOptions },
          };
          // Select what was just added: the next thing the user wants is its
          // options, and hunting for it in the list is the only alternative.
          onChange(addWidget(widgets, slot, instance), instance.id);
        }}
      >
        <option value="">{t("widgets.add")}</option>
        {WIDGET_DEFINITIONS.map((definition) => (
          <option key={definition.type} value={definition.type}>
            {t(definition.labelKey)}
          </option>
        ))}
      </FocusSelect>
    </div>
  );
}

function WidgetDetail({
  instance,
  slot,
  index,
  count,
  widgets,
  claudeConfigDirs,
  grokConfigDirs,
  onChange,
  onRemoved,
}: {
  instance: WidgetInstance;
  slot: WidgetSlotId;
  index: number;
  count: number;
  widgets: WidgetsSettings;
  claudeConfigDirs: readonly string[];
  grokConfigDirs: readonly string[];
  onChange: (next: WidgetsSettings) => void;
  onRemoved: () => void;
}) {
  const { t } = useTranslation("settings");
  const definition = findWidgetDefinition(instance.type);

  return (
    <div
      data-testid={`widgets-detail-${instance.id}`}
      className="flex flex-col gap-2 p-2"
      style={{ border: "1px solid var(--separator-bg)" }}
    >
      <div className="flex items-center gap-1">
        <span className="mr-auto text-[12px]" style={{ color: "var(--text-primary)" }}>
          {definition ? t(definition.labelKey) : t("widgets.unknownType", { type: instance.type })}
        </span>

        <FocusSelect
          data-testid={`widgets-move-${instance.id}`}
          style={controlStyle}
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
        </FocusSelect>

        <button
          type="button"
          data-testid={`widgets-up-${instance.id}`}
          className="px-1.5 text-[11px]"
          style={{ ...buttonStyle, opacity: index === 0 ? 0.4 : 1 }}
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
          style={{ ...buttonStyle, opacity: index === count - 1 ? 0.4 : 1 }}
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
          style={buttonStyle}
          title={t("widgets.remove")}
          onClick={() => {
            onChange(removeWidget(widgets, instance.id));
            onRemoved();
          }}
        >
          ✕
        </button>
      </div>

      {definition && definition.optionSpecs.length > 0 && (
        <div className="flex flex-col gap-1">
          {definition.optionSpecs.map((spec) => (
            <div key={spec.key} className="flex items-center gap-2">
              <span
                className="w-36 shrink-0 text-[11px]"
                style={{ color: "var(--text-secondary)" }}
              >
                {t(spec.labelKey)}
              </span>
              <OptionControl
                spec={spec}
                instance={instance}
                defaultValue={definition.defaultOptions[spec.key]}
                widgets={widgets}
                onChange={onChange}
                claudeConfigDirs={claudeConfigDirs}
                grokConfigDirs={grokConfigDirs}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function OptionControl({
  spec,
  instance,
  defaultValue,
  widgets,
  onChange,
  claudeConfigDirs,
  grokConfigDirs,
}: {
  spec: WidgetOptionSpec;
  instance: WidgetInstance;
  defaultValue: unknown;
  widgets: WidgetsSettings;
  onChange: (next: WidgetsSettings) => void;
  claudeConfigDirs: readonly string[];
  grokConfigDirs: readonly string[];
}) {
  const { t } = useTranslation("settings");

  if (spec.kind === "number") {
    const current = instance.options[spec.key];
    const value =
      typeof current === "number" ? current : typeof defaultValue === "number" ? defaultValue : "";
    return (
      <FocusInput
        type="number"
        data-testid={`widgets-option-${instance.id}-${spec.key}`}
        aria-label={t(spec.labelKey)}
        inputStyle={{ ...controlStyle, width: 60 }}
        min={spec.min}
        max={spec.max}
        value={value}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (!Number.isFinite(next)) return;
          onChange(
            updateWidgetOptions(widgets, instance.id, {
              [spec.key]: Math.max(spec.min, Math.min(spec.max, Math.round(next))),
            }),
          );
        }}
      />
    );
  }

  const rawValue = instance.options[spec.key];
  const value =
    typeof rawValue === "string" ? rawValue : typeof defaultValue === "string" ? defaultValue : "";
  const choices =
    spec.kind === "claudeConfigDir"
      ? ["", ...claudeConfigDirs.filter(Boolean)]
      : spec.kind === "grokConfigDir"
        ? ["", ...grokConfigDirs.filter(Boolean)]
        : spec.choices;

  return (
    <FocusSelect
      data-testid={`widgets-option-${instance.id}-${spec.key}`}
      aria-label={t(spec.labelKey)}
      style={controlStyle}
      value={value}
      onChange={(event) =>
        onChange(updateWidgetOptions(widgets, instance.id, { [spec.key]: event.target.value }))
      }
    >
      {choices.map((choice) => (
        <option key={choice} value={choice}>
          {spec.kind === "claudeConfigDir" || spec.kind === "grokConfigDir"
            ? choice || t("widgets.configDirDefault")
            : t(`widgets.value.${spec.key}.${choice}`)}
        </option>
      ))}
    </FocusSelect>
  );
}
