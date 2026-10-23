import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useUiStore } from "@/stores/ui-store";
import { requestWorkspaceClose } from "@/lib/workspace-close";
import { WorkspaceCloseToasts } from "./WorkspaceCloseToasts";

beforeEach(() => {
  vi.useFakeTimers();
  useWorkspaceStore.setState(useWorkspaceStore.getInitialState());
  useUiStore.setState(useUiStore.getInitialState());
  useWorkspaceStore.getState().addWorkspace("Second", "default-layout");
});
afterEach(() => {
  act(() => vi.runOnlyPendingTimers());
  vi.useRealTimers();
});

it("토스트의 복원은 실행 중 workspace를 그대로 돌려놓는다", () => {
  const workspace = useWorkspaceStore.getState().workspaces[1];
  render(<WorkspaceCloseToasts />);
  act(() => {
    requestWorkspaceClose(workspace.id);
  });
  expect(screen.getByRole("status")).toHaveTextContent("Second");
  fireEvent.click(screen.getByRole("button", { name: "Restore" }));
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  act(() => vi.advanceTimersByTime(5000));
  expect(useWorkspaceStore.getState().workspaces[1]).toBe(workspace);
});

it("토스트를 다시 마운트해도 만료가 연장되지 않고 사라질 때 실제로 제거된다", () => {
  const workspace = useWorkspaceStore.getState().workspaces[1];
  const first = render(<WorkspaceCloseToasts />);
  act(() => {
    requestWorkspaceClose(workspace.id);
  });
  act(() => vi.advanceTimersByTime(4000));
  first.unmount();
  render(<WorkspaceCloseToasts />);
  expect(screen.getByRole("status")).toBeInTheDocument();
  act(() => vi.advanceTimersByTime(1000));
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(useWorkspaceStore.getState().workspaces).toHaveLength(1);
});
