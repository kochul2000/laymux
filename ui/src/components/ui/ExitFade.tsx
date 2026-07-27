import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

export const EXIT_FADE_DEFAULT_MS = 200;

export interface ExitFadeProps {
  /**
   * Whether the content should be visible. When this flips from true to false
   * the content stays mounted for `durationMs` while fading to opacity 0, then
   * unmounts. Appearing is instant (we only animate the exit).
   */
  show: boolean;
  /** Fade-out duration in ms; also how long the content lingers before unmount. */
  durationMs?: number;
  className?: string;
  style?: CSSProperties;
  "data-testid"?: string;
  /** Optional — omit for a self-styled fade element (e.g. a CSS-only dot). */
  children?: ReactNode;
}

/**
 * Wraps content that appears/disappears on a boolean and adds a short opacity
 * fade on *exit* so dismissals don't pop out abruptly (issue #365 follow-up —
 * notification badges/dots that clear on focus/input read smoother fading away
 * than vanishing instantly).
 *
 * The wrapper is a plain inline `<span>`, so pass layout classes via
 * `className` (e.g. `shrink-0 ml-auto`) — the fade element itself must carry
 * positioning, not an inner node, or the layout jumps when it unmounts.
 *
 * While fading out (`show` already false) the last children seen while visible
 * are frozen and kept on screen, so content driven by the same condition
 * (e.g. an unread *count* that drops to 0) doesn't blank out mid-fade.
 */
export function ExitFade({
  show,
  durationMs = EXIT_FADE_DEFAULT_MS,
  className,
  style,
  children,
  ...rest
}: ExitFadeProps) {
  // Snapshot the content shown while visible so the exit fade renders the last
  // good children even after the driving condition has gone false (e.g. an
  // unread count that drops to 0 would otherwise flash "0" mid-fade).
  //
  // The snapshot lives in state, not a ref: refs must not be written or read
  // while rendering, and the frozen children *are* render output. Adjusting
  // state during render is React's sanctioned way to derive from changing
  // props; the guard makes it converge after one extra pass.
  const [visibleChildren, setVisibleChildren] = useState<ReactNode>(children);
  if (show && visibleChildren !== children) setVisibleChildren(children);

  // `exiting` keeps the node mounted for `durationMs` after `show` goes false so
  // the opacity transition can play out. Flipping it at the show→hide edge
  // during render (instead of from an effect) avoids a cascading extra commit.
  const [wasShown, setWasShown] = useState(show);
  const [exiting, setExiting] = useState(false);
  if (wasShown !== show) {
    setWasShown(show);
    setExiting(!show);
  }

  useEffect(() => {
    if (!exiting) return;
    const timer = setTimeout(() => setExiting(false), durationMs);
    return () => clearTimeout(timer);
  }, [exiting, durationMs]);

  if (!show && !exiting) return null;

  // Appearing is instant, so opacity tracks `show` directly.
  return (
    <span
      className={className}
      style={{ ...style, opacity: show ? 1 : 0, transition: `opacity ${durationMs}ms ease` }}
      {...rest}
    >
      {show ? children : visibleChildren}
    </span>
  );
}
