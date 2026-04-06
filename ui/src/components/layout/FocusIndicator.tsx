import { useUiStore } from "@/stores/ui-store";

export function FocusIndicator({ testId }: { testId?: string }) {
  const isAppFocused = useUiStore((s) => s.isAppFocused);

  return (
    <div
      data-testid={testId}
      className="pointer-events-none absolute inset-0"
      style={{
        boxShadow: `inset 0 0 0 1px var(${isAppFocused ? "--accent" : "--accent-50"})`,
        zIndex: 20,
      }}
    />
  );
}
