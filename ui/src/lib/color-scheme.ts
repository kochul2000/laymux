/**
 * Maps a Windows Terminal color scheme to an xterm.js ITheme.
 */

export interface WTColorScheme {
  name: string;
  foreground: string;
  background: string;
  cursorColor: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  purple: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightPurple: string;
  brightCyan: string;
  brightWhite: string;
}

export interface XtermTheme {
  foreground?: string;
  background?: string;
  cursor?: string;
  cursorAccent?: string;
  selectionBackground?: string;
  selectionForeground?: string;
  black?: string;
  red?: string;
  green?: string;
  yellow?: string;
  blue?: string;
  magenta?: string;
  cyan?: string;
  white?: string;
  brightBlack?: string;
  brightRed?: string;
  brightGreen?: string;
  brightYellow?: string;
  brightBlue?: string;
  brightMagenta?: string;
  brightCyan?: string;
  brightWhite?: string;
}

function setIfNonEmpty(
  obj: Record<string, string | undefined>,
  key: string,
  value: string,
) {
  if (value) {
    obj[key] = value;
  }
}

export function colorSchemeToXtermTheme(scheme: WTColorScheme): XtermTheme {
  const theme: XtermTheme = {};

  setIfNonEmpty(theme as Record<string, string | undefined>, "foreground", scheme.foreground);
  setIfNonEmpty(theme as Record<string, string | undefined>, "background", scheme.background);
  setIfNonEmpty(theme as Record<string, string | undefined>, "cursor", scheme.cursorColor);
  setIfNonEmpty(theme as Record<string, string | undefined>, "selectionBackground", scheme.selectionBackground);

  // ANSI colors — Windows Terminal uses "purple", xterm.js uses "magenta"
  setIfNonEmpty(theme as Record<string, string | undefined>, "black", scheme.black);
  setIfNonEmpty(theme as Record<string, string | undefined>, "red", scheme.red);
  setIfNonEmpty(theme as Record<string, string | undefined>, "green", scheme.green);
  setIfNonEmpty(theme as Record<string, string | undefined>, "yellow", scheme.yellow);
  setIfNonEmpty(theme as Record<string, string | undefined>, "blue", scheme.blue);
  setIfNonEmpty(theme as Record<string, string | undefined>, "magenta", scheme.purple);
  setIfNonEmpty(theme as Record<string, string | undefined>, "cyan", scheme.cyan);
  setIfNonEmpty(theme as Record<string, string | undefined>, "white", scheme.white);

  // Bright colors
  setIfNonEmpty(theme as Record<string, string | undefined>, "brightBlack", scheme.brightBlack);
  setIfNonEmpty(theme as Record<string, string | undefined>, "brightRed", scheme.brightRed);
  setIfNonEmpty(theme as Record<string, string | undefined>, "brightGreen", scheme.brightGreen);
  setIfNonEmpty(theme as Record<string, string | undefined>, "brightYellow", scheme.brightYellow);
  setIfNonEmpty(theme as Record<string, string | undefined>, "brightBlue", scheme.brightBlue);
  setIfNonEmpty(theme as Record<string, string | undefined>, "brightMagenta", scheme.brightPurple);
  setIfNonEmpty(theme as Record<string, string | undefined>, "brightCyan", scheme.brightCyan);
  setIfNonEmpty(theme as Record<string, string | undefined>, "brightWhite", scheme.brightWhite);

  return theme;
}
