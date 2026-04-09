import type { CursorShape, SupportedCursorShape } from "@/stores/settings-store";

export function toSupportedCursorShape(shape: CursorShape): SupportedCursorShape {
  switch (shape) {
    case "bar":
    case "underscore":
    case "filledBox":
      return shape;
    default:
      return "filledBox";
  }
}

export function toXtermCursorOptions(shape: CursorShape): {
  cursorStyle: "bar" | "underline" | "block";
  cursorWidth?: number;
} {
  switch (toSupportedCursorShape(shape)) {
    case "bar":
      return { cursorStyle: "bar", cursorWidth: 1 };
    case "underscore":
      return { cursorStyle: "underline" };
    case "filledBox":
    default:
      return { cursorStyle: "block" };
  }
}

export function toCursorStyleEscape(shape: CursorShape, blink: boolean): string {
  switch (toSupportedCursorShape(shape)) {
    case "bar":
      return `\x1b[${blink ? 5 : 6} q`;
    case "underscore":
      return `\x1b[${blink ? 3 : 4} q`;
    case "filledBox":
    default:
      return `\x1b[${blink ? 1 : 2} q`;
  }
}
