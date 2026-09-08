import type { ButtonHTMLAttributes, ReactNode } from "react";

/**
 * The app's action button
 * ([ADR-0192](../../../../docs/adr/0192-standard-action-button-and-disabled-affordance.md)).
 *
 * Settings and dialog actions used to be assembled per call site — accent text,
 * a hairline border, `cursor: pointer` written into the inline style regardless
 * of `disabled`. A disabled button therefore looked and hovered exactly like an
 * enabled one, so the click that legitimately did nothing read as a broken
 * feature. Variants, hover and `:disabled` live in `index.css` (`.ui-btn*`)
 * because that is where hover belongs; this component only picks the class and
 * keeps the icon slot honest.
 *
 * `primary` is the one action a surface wants the user to take; `secondary` is
 * everything else, including anything that leaves the app.
 */
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary";
  /**
   * Leading glyph — an inline SVG from `components/ui/icons.tsx`. It is marked
   * `aria-hidden` at the icon, so the label text stays the accessible name.
   */
  icon?: ReactNode;
}

export function Button({
  variant = "secondary",
  icon,
  children,
  className,
  type = "button",
  ...rest
}: ButtonProps) {
  const variantClass = variant === "primary" ? "ui-btn-primary" : "ui-btn-secondary";
  return (
    <button type={type} className={`ui-btn ${variantClass} ${className ?? ""}`.trim()} {...rest}>
      {icon}
      {children}
    </button>
  );
}
