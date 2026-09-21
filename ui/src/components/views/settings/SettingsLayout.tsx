/**
 * Layout primitives for the settings surface.
 *
 * Every settings page is assembled from the same few pieces so the surface
 * reads as one design instead of per-section hand layout. Sections own the
 * controls and their state; these components only own where things sit.
 *
 * - `SettingsPageTitle` — the page heading (one per section).
 * - `SettingsGroup` — a heading above a list of individual setting cards.
 * - `SettingsField` — one setting.
 *   - `inline` (default): label and description stay together on the left;
 *     the control is centered beside them, as in Windows Terminal settings.
 *   - `stack`: label, description, then the control on its own full-width row.
 *     For controls that need the width — lists, command lines, padding grids.
 * - `SettingsInlineFields` / `SettingsMiniField` — a wrapping row of small
 *   labelled inputs (padding top/right/bottom/left) inside a `stack` field.
 *
 * Styling lives in `index.css` under `.settings-*`: CSS variables, square
 * corners, no `color-mix()` (api-contracts §15). The container query there
 * collapses `inline` fields to a single column inside a narrow dock.
 */
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ToggleSwitch } from "@/components/ui/ToggleSwitch";

export function SettingsPageTitle({
  children,
  description,
}: {
  children: ReactNode;
  /** Optional one-paragraph intro shown under the heading. */
  description?: ReactNode;
}) {
  return (
    <header className="settings-page__header">
      <h2 className="settings-page__title">{children}</h2>
      {description ? <p className="settings-page__desc">{description}</p> : null}
    </header>
  );
}

export function SettingsGroup({
  title,
  description,
  actions,
  children,
  testId,
}: {
  title?: ReactNode;
  /** Intro paragraph between the title and the card. */
  description?: ReactNode;
  /** Right-aligned slot on the title line — a per-group reset button, for example. */
  actions?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  const hasHeader = Boolean(title) || Boolean(actions);
  return (
    <section className="settings-group" data-testid={testId}>
      {hasHeader ? (
        <div className="settings-group__header">
          {title ? <h3 className="settings-group__title">{title}</h3> : <span />}
          {actions ? <div className="settings-group__actions">{actions}</div> : null}
        </div>
      ) : null}
      {description ? <p className="settings-group__desc">{description}</p> : null}
      <div className="settings-group__body">{children}</div>
    </section>
  );
}

export type SettingsFieldLayout = "inline" | "stack";

export function SettingsField({
  label,
  desc,
  layout = "inline",
  children,
  testId,
  className = "",
}: {
  label: ReactNode;
  desc?: ReactNode;
  layout?: SettingsFieldLayout;
  children: ReactNode;
  testId?: string;
  className?: string;
}) {
  return (
    <div className={`settings-field settings-field--${layout} ${className}`} data-testid={testId}>
      <div className="settings-field__text">
        <div className="settings-field__label">{label}</div>
        {desc ? <p className="settings-field__desc">{desc}</p> : null}
      </div>
      <div className="settings-field__control">{children}</div>
    </div>
  );
}

/**
 * A boolean setting: switch plus an "enabled / disabled" caption, right-aligned
 * like every other inline control. Every on/off setting uses this — a plain
 * checkbox is reserved for multi-select lists — so the switches line up and
 * read the same on every page. `trailing` takes a per-field reset button.
 */
export function SettingsToggleField({
  label,
  desc,
  testId,
  checked,
  onChange,
  trailing,
}: {
  label: string;
  desc?: ReactNode;
  testId?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  trailing?: ReactNode;
}) {
  const { t } = useTranslation("settings");
  return (
    <SettingsField label={label} desc={desc} className="settings-field--toggle">
      <div className="settings-toggle">
        <span className="settings-toggle__state">
          {checked ? t("common.enabled") : t("common.disabled")}
        </span>
        <ToggleSwitch
          data-testid={testId}
          aria-label={label}
          checked={checked}
          onChange={onChange}
        />
        {trailing}
      </div>
    </SettingsField>
  );
}

/** A wrapping row of `SettingsMiniField`s. */
export function SettingsInlineFields({ children }: { children: ReactNode }) {
  return <div className="settings-inline-fields">{children}</div>;
}

/** A short caption glued to one small input, e.g. "Top [ 8 ]". */
export function SettingsMiniField({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <label className="settings-mini-field">
      <span className="settings-mini-field__label">{label}</span>
      {children}
    </label>
  );
}
