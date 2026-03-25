import { describe, it, expect } from "vitest";
import { findNotificationNavTarget } from "./notification-navigation";
import type { Notification } from "@/stores/notification-store";

function makeNotif(
  overrides: Partial<Notification> & Pick<Notification, "id" | "terminalId" | "workspaceId" | "createdAt">,
): Notification {
  return {
    message: "test",
    level: "info",
    readAt: null,
    navigatedAt: null,
    ...overrides,
  };
}

describe("findNotificationNavTarget", () => {
  it("returns null when no unread notifications exist", () => {
    expect(findNotificationNavTarget([], "recent")).toBeNull();
    expect(findNotificationNavTarget([], "oldest")).toBeNull();
  });

  it("returns null when all notifications are navigated", () => {
    const notifs: Notification[] = [
      makeNotif({ id: "n1", terminalId: "terminal-p1", workspaceId: "ws-1", createdAt: 100, navigatedAt: 200 }),
    ];
    expect(findNotificationNavTarget(notifs, "recent")).toBeNull();
  });

  it("returns the most recent unread notification for 'recent'", () => {
    const notifs: Notification[] = [
      makeNotif({ id: "n1", terminalId: "terminal-p1", workspaceId: "ws-1", createdAt: 100 }),
      makeNotif({ id: "n2", terminalId: "terminal-p2", workspaceId: "ws-1", createdAt: 200 }),
      makeNotif({ id: "n3", terminalId: "terminal-p3", workspaceId: "ws-2", createdAt: 300 }),
    ];
    const result = findNotificationNavTarget(notifs, "recent")!;
    expect(result.workspaceId).toBe("ws-2");
    expect(result.terminalId).toBe("terminal-p3");
    expect(result.notificationIds).toEqual(["n3"]);
  });

  it("returns the oldest unread notification for 'oldest'", () => {
    const notifs: Notification[] = [
      makeNotif({ id: "n1", terminalId: "terminal-p1", workspaceId: "ws-1", createdAt: 100 }),
      makeNotif({ id: "n2", terminalId: "terminal-p2", workspaceId: "ws-1", createdAt: 200 }),
      makeNotif({ id: "n3", terminalId: "terminal-p3", workspaceId: "ws-2", createdAt: 300 }),
    ];
    const result = findNotificationNavTarget(notifs, "oldest")!;
    expect(result.workspaceId).toBe("ws-1");
    expect(result.terminalId).toBe("terminal-p1");
    expect(result.notificationIds).toEqual(["n1"]);
  });

  it("consumes consecutive same-terminal notifications (recent, desc order)", () => {
    const notifs: Notification[] = [
      makeNotif({ id: "n1", terminalId: "terminal-pA", workspaceId: "ws-1", createdAt: 100 }),
      makeNotif({ id: "n2", terminalId: "terminal-pB", workspaceId: "ws-1", createdAt: 200 }),
      makeNotif({ id: "n3", terminalId: "terminal-pA", workspaceId: "ws-1", createdAt: 300 }),
      makeNotif({ id: "n4", terminalId: "terminal-pA", workspaceId: "ws-1", createdAt: 400 }),
    ];
    const result = findNotificationNavTarget(notifs, "recent")!;
    // Sorted desc: n4(pA,400), n3(pA,300), n2(pB,200), n1(pA,100)
    // Consecutive from top: n4, n3 (both pA)
    expect(result.terminalId).toBe("terminal-pA");
    expect(result.notificationIds).toEqual(["n4", "n3"]);
  });

  it("consumes consecutive same-terminal notifications (oldest, asc order)", () => {
    const notifs: Notification[] = [
      makeNotif({ id: "n1", terminalId: "terminal-pA", workspaceId: "ws-1", createdAt: 100 }),
      makeNotif({ id: "n2", terminalId: "terminal-pA", workspaceId: "ws-1", createdAt: 200 }),
      makeNotif({ id: "n3", terminalId: "terminal-pB", workspaceId: "ws-1", createdAt: 300 }),
      makeNotif({ id: "n4", terminalId: "terminal-pA", workspaceId: "ws-1", createdAt: 400 }),
    ];
    const result = findNotificationNavTarget(notifs, "oldest")!;
    // Sorted asc: n1(pA,100), n2(pA,200), n3(pB,300), n4(pA,400)
    // Consecutive from top: n1, n2 (both pA)
    expect(result.terminalId).toBe("terminal-pA");
    expect(result.notificationIds).toEqual(["n1", "n2"]);
  });

  it("stops consecutive consumption at different terminal", () => {
    const notifs: Notification[] = [
      makeNotif({ id: "n1", terminalId: "terminal-pA", workspaceId: "ws-1", createdAt: 100 }),
      makeNotif({ id: "n2", terminalId: "terminal-pB", workspaceId: "ws-1", createdAt: 200 }),
      makeNotif({ id: "n3", terminalId: "terminal-pA", workspaceId: "ws-1", createdAt: 300 }),
    ];
    const result = findNotificationNavTarget(notifs, "recent")!;
    // Sorted desc: n3(pA,300), n2(pB,200), n1(pA,100)
    // Only n3 is consecutive from top (n2 breaks it)
    expect(result.notificationIds).toEqual(["n3"]);
  });

  it("skips already-navigated notifications when finding consecutive", () => {
    const notifs: Notification[] = [
      makeNotif({ id: "n1", terminalId: "terminal-pA", workspaceId: "ws-1", createdAt: 100 }),
      makeNotif({ id: "n2", terminalId: "terminal-pA", workspaceId: "ws-1", createdAt: 200, navigatedAt: 250 }),
      makeNotif({ id: "n3", terminalId: "terminal-pA", workspaceId: "ws-1", createdAt: 300 }),
    ];
    const result = findNotificationNavTarget(notifs, "recent")!;
    // Only unnavigated: n3(pA,300), n1(pA,100)
    // Consecutive from top: n3, n1 (both pA, no break)
    expect(result.notificationIds).toEqual(["n3", "n1"]);
  });

  it("includes read-but-not-navigated notifications (auto-dismissed)", () => {
    const notifs: Notification[] = [
      makeNotif({ id: "n1", terminalId: "terminal-pA", workspaceId: "ws-1", createdAt: 100, readAt: 150 }),
      makeNotif({ id: "n2", terminalId: "terminal-pB", workspaceId: "ws-1", createdAt: 200, readAt: 250 }),
    ];
    // Both are read (auto-dismissed) but not navigated — should still be found
    const result = findNotificationNavTarget(notifs, "recent")!;
    expect(result.terminalId).toBe("terminal-pB");
    expect(result.notificationIds).toEqual(["n2"]);
  });

  it("handles single unread notification", () => {
    const notifs: Notification[] = [
      makeNotif({ id: "n1", terminalId: "terminal-p1", workspaceId: "ws-1", createdAt: 100 }),
    ];
    const result = findNotificationNavTarget(notifs, "recent")!;
    expect(result.workspaceId).toBe("ws-1");
    expect(result.terminalId).toBe("terminal-p1");
    expect(result.notificationIds).toEqual(["n1"]);
  });

  it("works across different workspaces", () => {
    const notifs: Notification[] = [
      makeNotif({ id: "n1", terminalId: "terminal-p1", workspaceId: "ws-1", createdAt: 100 }),
      makeNotif({ id: "n2", terminalId: "terminal-p2", workspaceId: "ws-2", createdAt: 200 }),
    ];
    const result = findNotificationNavTarget(notifs, "recent")!;
    expect(result.workspaceId).toBe("ws-2");

    const resultOldest = findNotificationNavTarget(notifs, "oldest")!;
    expect(resultOldest.workspaceId).toBe("ws-1");
  });
});
