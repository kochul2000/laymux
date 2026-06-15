import { render, screen, act } from "@testing-library/react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { WorkspaceSelectorView } from "./WorkspaceSelectorView";
import i18n from "@/i18n";

vi.mock("@/lib/persist-session", () => ({
  persistSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock("@/lib/tauri-api", () => ({
  getListeningPorts: vi.fn().mockResolvedValue([]),
  getTerminalSummaries: vi.fn().mockResolvedValue([]),
  markNotificationsRead: vi.fn().mockResolvedValue(0),
}));

describe("WorkspaceSelectorView i18n", () => {
  afterEach(async () => {
    await act(async () => {
      await i18n.changeLanguage("en");
    });
  });

  it("renders English labels when language is en", async () => {
    await act(async () => {
      await i18n.changeLanguage("en");
    });
    render(<WorkspaceSelectorView />);
    expect(screen.getByTestId("workspace-selector-header")).toHaveTextContent("New Workspace");
    expect(screen.getByText("Workspaces")).toBeInTheDocument();
    expect(screen.getByText("Notifications")).toBeInTheDocument();
  });

  it("renders Korean labels when language is ko", async () => {
    await act(async () => {
      await i18n.changeLanguage("ko");
    });
    render(<WorkspaceSelectorView />);
    expect(screen.getByTestId("workspace-selector-header")).toHaveTextContent("새 워크스페이스");
    expect(screen.getByText("워크스페이스")).toBeInTheDocument();
    expect(screen.getByText("알림")).toBeInTheDocument();
  });
});
