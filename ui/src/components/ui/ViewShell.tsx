import { forwardRef } from "react";

interface ViewShellProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
  testId?: string;
}

/** 모든 View의 최외곽 구조 컨테이너. flex column 레이아웃을 제공한다. */
export const ViewShell = forwardRef<HTMLDivElement, ViewShellProps>(
  ({ children, testId, className, ...rest }, ref) => {
    return (
      <div
        ref={ref}
        data-testid={testId}
        className={`flex h-full w-full flex-col ${className ?? ""}`.trim()}
        {...rest}
      >
        {children}
      </div>
    );
  },
);

ViewShell.displayName = "ViewShell";
