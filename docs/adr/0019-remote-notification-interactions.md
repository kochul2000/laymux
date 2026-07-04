# 0019. Remote Notification Interactions Use Navigation Targets and Bridge Dismissal

- Status: Accepted
- Date: 2026-07-04
- Source: Remote notification UX follow-up after PR #414; docs/architecture/api-contracts.md section 13.3; ADR-0013, ADR-0018

## Context

PR #414 made `/remote/v1/navigation` expose unread notification counts and made the remote drawer follow desktop WorkspaceSelector ordering and hidden/collapsed state. The focused remote HTML surface still only rendered badges, so a browser remote client could see that notifications existed but could not inspect, mark, or clear them.

Desktop notification behavior is owned by the React/Zustand notification store. The remote page should not mount the full desktop app or duplicate unrelated workspace/pane editing features, but it needs enough notification metadata and actions to consume alerts while controlling the active terminal.

## Decision

`/remote/v1/navigation` includes an additive top-level `notifications` list. Each item summarizes the frontend notification record with display and target metadata: id, title, message, level, created/read timestamps, read state, workspace id/name, terminal id/label, and requires-action state.

The list uses the same ordering as desktop `NotificationPanel`: unread notifications first, and newest insertion order inside unread/read groups. The remote page groups the ordered list by workspace in first-seen order and renders it in the navigation drawer.

Notification taps reuse existing focused remote navigation actions whenever possible:

- workspace-targeted notifications call `/remote/v1/workspaces/active`, which already marks that workspace read;
- terminal-targeted notifications call `/remote/v1/terminals/{id}/focus`, which already marks that terminal read;
- target-less notifications call `/remote/v1/notifications/{id}/read`, which marks only that notification id read through the frontend bridge.

Remote mark-all-read and clear-all are explicit controller actions:

- `/remote/v1/notifications/mark-all-read` calls bridge action `notifications.markAllRead`;
- `DELETE /remote/v1/notifications` reads `notifications.list`, then calls existing bridge action `notifications.clear` with the collected ids.

All notification mutation endpoints require the active remote lease, like workspace switching and terminal focus. `/remote/v1/navigation` remains a token-gated read-only query and does not require a lease.

## Consequences

Browser remote clients can inspect and consume notifications without gaining broader workspace editing, pane editing, file-viewer, settings, token, or TLS responsibilities.

The remote notification API is additive. Existing clients that only use unread counts can ignore the new `notifications` field and mutation endpoints.

The Rust remote server depends on additional frontend bridge notification actions for id-based and all-read dismissal. Clear-all intentionally reuses the existing `notifications.clear` bridge semantics by passing ids rather than introducing a second deletion path.
