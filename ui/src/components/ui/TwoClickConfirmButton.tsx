import { useState, type ButtonHTMLAttributes, type MouseEvent, type ReactNode } from "react";

interface TwoClickConfirmButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "children" | "onClick"
> {
  children: ReactNode;
  confirmationEnabled?: boolean;
  confirmChildren?: ReactNode;
  confirmLabel: string;
  onConfirm: (event: MouseEvent<HTMLButtonElement>) => void;
  stopPropagation?: boolean;
}

/**
 * Arms a destructive action on the first activation and runs it on the second.
 * Leaving or blurring the control cancels the transient confirmation state.
 */
export function TwoClickConfirmButton({
  children,
  confirmationEnabled = true,
  confirmChildren,
  confirmLabel,
  onConfirm,
  stopPropagation = false,
  className,
  onBlur,
  onKeyDown,
  onPointerLeave,
  title,
  "aria-label": ariaLabel,
  ...buttonProps
}: TwoClickConfirmButtonProps) {
  const [confirming, setConfirming] = useState(false);
  const isConfirming = confirmationEnabled && confirming;

  return (
    <button
      {...buttonProps}
      type={buttonProps.type ?? "button"}
      className={`two-click-confirm-button ${className ?? ""}`}
      data-confirming={isConfirming ? "true" : undefined}
      aria-label={isConfirming ? confirmLabel : ariaLabel}
      title={isConfirming ? confirmLabel : title}
      onClick={(event) => {
        if (stopPropagation) event.stopPropagation();
        if (confirmationEnabled && !confirming) {
          setConfirming(true);
          return;
        }
        setConfirming(false);
        onConfirm(event);
      }}
      onBlur={(event) => {
        setConfirming(false);
        onBlur?.(event);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && isConfirming) {
          event.preventDefault();
          setConfirming(false);
        }
        onKeyDown?.(event);
      }}
      onPointerLeave={(event) => {
        setConfirming(false);
        onPointerLeave?.(event);
      }}
    >
      {isConfirming && confirmChildren !== undefined ? confirmChildren : children}
    </button>
  );
}
