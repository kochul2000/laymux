# 0018. Remote Navigation Reflects UI Hidden and Notification State

- Status: Accepted
- Date: 2026-07-03
- Source: User feedback on mobile remote UX; docs/architecture/api-contracts.md §13.3; ADR-0013, ADR-0015

## Context

Focused Remote UI is a separate HTML surface served by the Rust remote server. It intentionally does not mount the full React layout, so it must receive a compact navigation payload from the host WebView through the automation bridge.

Before this decision, `/remote/v1/navigation` summarized workspaces, panes, docks, and terminal metadata, but did not include the host UI's workspace display order, hidden workspace/pane state, WorkspaceSelector display settings, or notification read state. That made the mobile drawer drift from the desktop selector: workspace order could differ, hidden rows used a different removal model, and notification badges had no reliable visual feedback after remote navigation.

## Decision

`/remote/v1/navigation` must be derived from the same frontend UI state that drives the desktop WorkspaceSelectorView:

- hidden workspace IDs and hidden pane IDs come from the frontend `ui.state` bridge query;
- `workspaceDisplayOrder` comes from the frontend `workspaces.list` bridge query;
- `workspaceSelector` display settings come from the frontend `ui.state` bridge query;
- notification records come from the frontend `notifications.list` bridge query;
- workspaces are sorted with the same manual/notification sort rules used by `WorkspaceSelectorView`;
- hidden workspaces and panes stay in the payload with `hidden`/`collapsed` flags instead of being filtered out, matching the desktop selector's collapse model;
- the currently active workspace remains uncollapsed even if hidden so the current terminal context is not lost;
- workspace and pane summaries include unread notification counts;
- remote drawer rendering respects WorkspaceSelector display toggles for pane minimap/environment/activity/path/result rows;
- remote workspace switching marks that workspace's notifications read, and remote terminal focusing marks that terminal's notifications read, before the next navigation payload is fetched.

The remote page remains a focused terminal controller, not a full workspace editor. It can show and consume notification state, but hidden-mode editing stays in the desktop WorkspaceSelectorView and existing automation/MCP `ui.toggle*Hidden` actions.

## Consequences

Mobile remote navigation now matches the user's desktop selector order, hidden-row collapse behavior, and unread counts that disappear after explicit remote navigation.

The remote navigation payload has additive fields (`hidden`, `collapsed`, `unreadCount`, `workspaceSelector`, `unreadNotificationCount`) and includes per-workspace pane summaries. Remote clients that want the raw workspace array should use the automation/MCP workspace APIs instead of `/remote/v1/navigation`.

The Rust remote server depends on two additional frontend bridge reads for navigation. If the frontend bridge is unavailable, remote navigation already fails consistently rather than serving stale partial UI state.
