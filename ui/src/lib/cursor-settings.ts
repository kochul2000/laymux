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
