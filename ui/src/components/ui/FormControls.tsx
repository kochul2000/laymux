import type React from "react";

export const inputCls = "w-full rounded px-2 py-1.5 text-[13px] ui-focus-ring";

export const inputStyle: React.CSSProperties = {
  border: "1px solid var(--border)",
  background: "var(--bg-base)",
  color: "var(--text-primary)",
  outline: "none",
  transition: "border-color 0.15s",
  colorScheme: "dark",
};

/** Input with CSS focus ring */
export function FocusInput(
  props: React.InputHTMLAttributes<HTMLInputElement> & { inputStyle?: React.CSSProperties },
) {
  const { inputStyle: customStyle, ...rest } = props;
  return (
    <input
      {...rest}
      className={`${inputCls} ${rest.className ?? ""}`}
      style={{ ...inputStyle, ...customStyle }}
    />
  );
}

export function FocusSelect(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={`ui-focus-ring ${props.className ?? ""}`}
      style={{ ...inputStyle, ...props.style }}
    />
  );
}
