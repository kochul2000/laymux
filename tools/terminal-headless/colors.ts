import type { Terminal } from "@xterm/headless";
import type { XtermTheme } from "../../ui/src/lib/color-scheme";
import { DEFAULT_TERMINAL_THEME, XTERM_DEFAULT_ANSI } from "../../ui/src/lib/terminal-color-defaults";

type Rgb = [number, number, number];
type Request = { type: 0 | 1 | 2; index?: number; color?: Rgb };
const slotNames = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"] as const;
const rgb = (hex: string): Rgb => {
  if (!/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(hex)) throw new Error("invalid daemon terminal theme color");
  const value = Number.parseInt(hex.slice(1, 7), 16);
  return [value >>> 16 & 255, value >>> 8 & 255, value & 255];
};
const rgbString = (value: Rgb) => "rgb:" + value.map((channel) => (channel * 257).toString(16).padStart(4, "0")).join("/");
const identifier = (index: number) => index >= 256 ? String(index - 246) : `4;${index}`;

/** Uses xterm's existing color parser; no second OSC grammar or business hooks. */
export class HeadlessColors {
  private readonly defaults: Rgb[];
  private readonly current: Rgb[];
  private readonly changed = new Set<number>();

  constructor(terminal: Terminal, theme: XtermTheme, reply: (data: string) => void) {
    this.defaults = XTERM_DEFAULT_ANSI.map((fallback, index) => rgb(theme[slotNames[index]] || fallback));
    const levels = [0, 95, 135, 175, 215, 255];
    for (let index = 0; index < 216; index++) this.defaults.push([
      levels[Math.floor(index / 36) % 6], levels[Math.floor(index / 6) % 6], levels[index % 6],
    ]);
    for (let index = 0; index < 24; index++) { const value = 8 + index * 10; this.defaults.push([value, value, value]); }
    for (const slot of ["foreground", "background", "cursor"] as const) this.defaults.push(rgb(theme[slot] || DEFAULT_TERMINAL_THEME[slot]));
    this.current = this.defaults.map((color) => [...color]);
    const handler = (terminal as unknown as { _core: { _inputHandler: { onColor(callback: (requests: Request[]) => void): { dispose(): void } } } })._core._inputHandler;
    if (typeof handler.onColor !== "function") throw new Error("incompatible headless color parser");
    // The parser owns the listener lifetime through terminal.dispose().
    handler.onColor((requests) => {
      for (const request of requests) {
        const index = request.index;
        if (request.type === 2 && index === undefined) {
          for (let index = 0; index < 256; index++) { this.current[index] = [...this.defaults[index]]; this.changed.delete(index); }
          continue;
        }
        if (index === undefined || !Number.isInteger(index) || index < 0 || index > 258) throw new Error("invalid xterm color index");
        if (request.type === 0) reply(`\x1b]${identifier(index)};${rgbString(this.current[index])}\x1b\\`);
        else if (request.type === 1 && request.color) { this.current[index] = [...request.color]; this.changed.add(index); }
        else if (request.type === 2) { this.current[index] = [...this.defaults[index]]; this.changed.delete(index); }
      }
    });
  }

  checkpointPrefix(): string {
    // The GUI resolves the same theme, including alpha. OSC setters are opaque
    // RGB, so replay only actual overrides; flattening defaults loses alpha.
    const reset = [104, 110, 111, 112].map((code) => `\x1b]${code}\x1b\\`).join("");
    return reset + [...this.changed].map((index) => `\x1b]${identifier(index)};${rgbString(this.current[index])}\x1b\\`).join("");
  }
}
