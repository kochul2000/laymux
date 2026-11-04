export interface TerminalStartupColors {
  foreground: string;
  background: string;
}

/** Same resolved initial theme used to construct the visible xterm (ADR-0375). */
export function terminalStartupColors(theme: {
  foreground?: string;
  background?: string;
}): TerminalStartupColors | undefined {
  const reply = (code: number, color: string | undefined): string | undefined => {
    if (!color || !/^#[0-9a-f]{6}$/i.test(color)) return undefined;
    const channels = color.slice(1).toLowerCase().match(/../g)!;
    return `\x1b]${code};rgb:${channels.map((channel) => channel.repeat(2)).join("/")}\x1b\\`;
  };
  const foreground = reply(10, theme.foreground);
  const background = reply(11, theme.background);
  return foreground && background ? { foreground, background } : undefined;
}
