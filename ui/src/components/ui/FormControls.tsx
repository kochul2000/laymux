import { forwardRef } from "react";
import type React from "react";
import { inputCls, inputStyle } from "./form-control-styles";

/** Input with CSS focus ring */
export const FocusInput = forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement> & { inputStyle?: React.CSSProperties }
>(function FocusInput(props, ref) {
  const { inputStyle: customStyle, ...rest } = props;
  return (
    <input
      ref={ref}
      {...rest}
      className={`${inputCls} ${rest.className ?? ""}`}
      style={{ ...inputStyle, ...customStyle }}
    />
  );
});

export function FocusSelect(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={`ui-focus-ring ${props.className ?? ""}`}
      style={{ ...inputStyle, ...props.style }}
    />
  );
}
