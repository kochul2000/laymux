import type { CSSProperties } from "react";

export const inputCls = "w-full rounded px-2 py-1.5 text-[13px] ui-focus-ring";

export const inputStyle: CSSProperties = {
  border: "1px solid var(--border)",
  background: "var(--bg-base)",
  color: "var(--text-primary)",
  outline: "none",
  transition: "border-color 0.15s",
  colorScheme: "dark",
};
