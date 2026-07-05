import type React from "react";

export interface ToggleSwitchProps extends Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "type" | "checked" | "onChange"
> {
  checked: boolean;
  onChange: (checked: boolean) => void;
}

export function ToggleSwitch({
  checked,
  onChange,
  disabled,
  className,
  onKeyDown,
  ...inputProps
}: ToggleSwitchProps) {
  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (!disabled) onChange(!checked);
    }
  };

  return (
    <span
      className={`relative inline-flex h-5 w-9 shrink-0 items-center ${disabled ? "opacity-60" : ""} ${className ?? ""}`}
    >
      <input
        {...inputProps}
        type="checkbox"
        role="switch"
        aria-checked={checked}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        onKeyDown={handleKeyDown}
        className="ui-switch-input absolute inset-0 z-10 m-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-default"
      />
      <span
        aria-hidden="true"
        className="ui-switch-track pointer-events-none relative h-5 w-9 rounded-full transition-colors"
        style={{
          background: checked ? "var(--accent)" : "var(--bg-base)",
          border: "1px solid var(--border)",
        }}
      >
        <span
          className="absolute top-[2px] h-4 w-4 rounded-full transition-transform"
          style={{
            background: checked ? "var(--bg-base)" : "var(--text-secondary)",
            transform: checked ? "translateX(18px)" : "translateX(2px)",
          }}
        />
      </span>
    </span>
  );
}
