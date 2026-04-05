import { useState } from "react";

export const inputCls = "w-full rounded px-2 py-1.5 text-[13px]";

export const inputStyle: React.CSSProperties = {
  border: "1px solid var(--border)",
  background: "var(--bg-base)",
  color: "var(--text-primary)",
  outline: "none",
  transition: "border-color 0.15s",
  colorScheme: "dark",
};

export const inputFocusStyle: React.CSSProperties = {
  ...inputStyle,
  border: "1px solid var(--accent)",
};

/** Input wrapper that adds focus ring */
export function FocusInput(
  props: React.InputHTMLAttributes<HTMLInputElement> & { inputStyle?: React.CSSProperties },
) {
  const [focused, setFocused] = useState(false);
  const { inputStyle: customStyle, ...rest } = props;
  return (
    <input
      {...rest}
      style={focused ? { ...inputFocusStyle, ...customStyle } : { ...inputStyle, ...customStyle }}
      onFocus={(e) => {
        setFocused(true);
        props.onFocus?.(e);
      }}
      onBlur={(e) => {
        setFocused(false);
        props.onBlur?.(e);
      }}
    />
  );
}

export function FocusSelect(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  const [focused, setFocused] = useState(false);
  return (
    <select
      {...props}
      style={focused ? inputFocusStyle : inputStyle}
      onFocus={(e) => {
        setFocused(true);
        props.onFocus?.(e);
      }}
      onBlur={(e) => {
        setFocused(false);
        props.onBlur?.(e);
      }}
    />
  );
}
