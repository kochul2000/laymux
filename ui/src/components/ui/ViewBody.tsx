import { forwardRef } from "react";

type ViewBodyVariant = "scroll" | "full";

interface ViewBodyProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
  /** "scroll": flex-1 + overflow-auto (기본), "full": relative + flex-1 (터미널/에디터용) */
  variant?: ViewBodyVariant;
  testId?: string;
}

const variantClasses: Record<ViewBodyVariant, string> = {
  scroll: "flex-1 overflow-auto",
  // A full-size child must be allowed to become smaller than its contents.
  // Otherwise a responsive view's intrinsic height wins over its pane height
  // and ResizeObserver never sees the lower density states.
  full: "relative min-h-0 flex-1",
};

/** View 본문 영역. variant에 따라 스크롤 또는 전체 채움 모드를 제공한다. */
export const ViewBody = forwardRef<HTMLDivElement, ViewBodyProps>(
  ({ children, variant = "scroll", className, testId, ...rest }, ref) => {
    return (
      <div
        ref={ref}
        data-testid={testId}
        className={`${variantClasses[variant]} ${className ?? ""}`.trim()}
        {...rest}
      >
        {children}
      </div>
    );
  },
);

ViewBody.displayName = "ViewBody";
