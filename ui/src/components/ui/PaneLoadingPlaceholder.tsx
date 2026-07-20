/**
 * Fills a pane slot with a dark background + spinner while its real view is
 * still queued for the global terminal startup slot. Reuses the existing
 * terminal loading-spinner styling so the placeholder is visually continuous
 * with the spinner TerminalView shows during its own renderer init.
 */
export interface PaneLoadingPlaceholderProps {
  "data-testid"?: string;
}

export function PaneLoadingPlaceholder({ "data-testid": testId }: PaneLoadingPlaceholderProps) {
  return (
    <div data-testid={testId} className="pane-loading-placeholder" aria-hidden>
      <div className="terminal-loading-spinner" />
    </div>
  );
}
