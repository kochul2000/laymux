# 0020. Remote Dock Terminal Navigation Stays Separate from Workspace Navigation

- Status: Accepted
- Date: 2026-07-04
- Source: Remote dock terminal UX follow-up after PR #415; docs/architecture/api-contracts.md section 13.3; ADR-0013, ADR-0018, ADR-0019

## Context

The focused remote page already receives `docks` in `/remote/v1/navigation`, but it did not render them. Users could only reach dock terminals indirectly through the preferred-terminal fallback, so visible dock terminals were missing from explicit remote navigation.

Dock panes are app-global UI state in the desktop app. They are not workspace panes and must not be mixed into the workspace list, sorted with workspace panes, or treated as children of the active workspace. The remote UI still needs a way to select a dock terminal and consume that terminal's unread notifications.

## Decision

Remote navigation keeps dock data under a separate top-level `docks` field. Dock pane summaries use `location="dock"` and `workspaceId=null` so clients cannot confuse them with workspace panes. Dock unread counts are calculated by `terminalId` only, without a workspace filter. Non-terminal dock panes keep `unreadCount=0`.

The remote page renders dock terminals in a separate dock toggle panel, not as sibling rows inside the workspace list. Hidden docks (`visible=false`) are not rendered in that panel and are not used as preferred-terminal candidates, including explicit preferred ids from the current output or notification navigation. Dock rows use dock-only DOM ids/classes and call the existing `/remote/v1/terminals/{id}/focus` action when selected.

`terminals.setFocus` treats dock terminals as global. If the target terminal belongs to a dock pane, the bridge sets desktop dock focus (`focusedDock`, `focusedDockPaneId`) and clears grid focus instead of switching active workspace. Workspace terminal focus and workspace switching clear dock focus so stale global dock focus cannot suppress workspace pane focus. Dock pane `isFocused` in `/remote/v1/navigation` is derived from `focusedDock` and `focusedDockPaneId`, not from the terminal store's `isFocused` flag, because desktop dock click and keyboard focus can update dock focus without updating terminal focus metadata. The remote server then reuses the existing `notifications.markTerminalRead` behavior in `/remote/v1/terminals/{id}/focus`.

## Consequences

Remote workspace navigation and dock navigation remain separate UI/data boundaries. Workspace ordering, hidden workspace collapse, inactive workspace pane suppression, and non-terminal unread rules from ADR-0018 remain unchanged.

Dock terminal selection now matches desktop's global dock focus model closely enough for focused remote control while avoiding broader dock editing features such as split, remove, resize, file viewer, settings, token, or TLS changes.

Existing remote clients can ignore `docks` as before. Clients that render docks must keep them separate from `workspaces` and should treat `workspaceId=null` as part of the dock contract, not missing data.
