/**
 * Hand-written inline icons
 * ([ADR-0192](../../../../docs/adr/0192-standard-action-button-and-disabled-affordance.md)).
 *
 * The app ships no icon font or icon package — every glyph in the UI is an
 * inline `<svg>` drawn on a small integer grid with `stroke="currentColor"`, so
 * it inherits the button's colour and disabled opacity and costs no bundle
 * weight. New icons belong here rather than pasted into a component, so a
 * second call site reuses the same drawing.
 */

export interface IconProps {
  /** Square edge in px. Defaults to the 12px used next to `--fs-sm` labels. */
  size?: number;
}

/**
 * "Opens outside the app" — the conventional square-with-arrow. Every button
 * that hands the click to the OS browser carries it, so leaving the app is
 * visible before the click, not after.
 */
export function ExternalLinkIcon({ size = 12 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
      focusable="false"
      style={{ flex: "0 0 auto" }}
    >
      {/* The window: left open on the top-right so the arrow reads as leaving it. */}
      <path
        d="M9.5 7.5v2.5a.5.5 0 0 1-.5.5H2a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5h2.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      {/* The arrow out, plus the two edges that make its corner. */}
      <path d="M6.75 5.25 10.5 1.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <path
        d="M7.5 1.5h3v3"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
