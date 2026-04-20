# Windows Terminal IME Caret Redesign Plan

## Goal

Replace the current PR 207 shadow-cursor design with a Windows Terminal style model.

The new design must solve two problems at the same time:

- Prevent the visual caret from jumping to the last repaint position during PowerShell + Codex footer/status redraws.
- Remove the perceived lag for Korean IME composition by making composition caret ownership explicit instead of inferred from the xterm buffer.

## Decision

We are no longer treating the xterm buffer cursor as the direct source of truth for all visual caret behavior.

Instead, we will follow the Windows Terminal pattern:

- IME composition owns composition-time caret behavior.
- The renderer owns composition preview rendering.
- The terminal buffer owns only committed text state.
- Special output modes such as DEC 2026 and footer repaints are layered on top of that input model, not mixed into it.

This means the current `shadowCursorRef` sync heuristics are a dead end and should be removed after the replacement path is in place.

## Why PR 207 Must Be Rejected

The current design stabilizes the caret by guessing the intended input position from:

- `onCursorMove`
- `onWriteParsed`
- OSC prompt boundaries
- save/restore repaint detection
- row-mismatch guards

That approach can hide jumps, but it cannot produce a correct IME model because:

- xterm's buffer cursor is the committed terminal cursor, not an IME composition caret.
- composition-time text is not modeled separately from committed buffer state.
- the helper textarea caret is hidden, while the overlay caret is driven by async buffer updates.
- Codex repaint logic and IME logic are mixed into one state machine.

The result is predictable:

- jump suppression improves,
- but CJK composition feels late because the visible caret waits for echo or parser progress.

Windows Terminal avoids this by separating committed cursor state from composition preview state.

## Windows Terminal Pattern To Copy

From the Windows Terminal source in `tmp/terminal`:

- TSF owns active composition lifetime.
- While composition is active, key events are not forwarded directly to the PTY.
- Composition text is rendered as preview state, not committed into the buffer.
- The candidate/composition window anchor is calculated directly from the terminal cursor cell.
- Only finalized text is sent into the terminal input stream.

Relevant source locations:

- `src/tsf/Implementation.cpp`
- `src/cascadia/TerminalControl/TermControl.cpp`
- `src/cascadia/TerminalControl/ControlCore.cpp`
- `src/interactivity/win32/windowio.cpp`

The important behavior is structural, not cosmetic:

1. `HasActiveComposition()` gates key forwarding.
2. `_doCompositionUpdate()` builds preview text and preview caret state.
3. `renderer->NotifyPaintFrame()` refreshes preview rendering immediately.
4. `HandleOutput(finalizedString)` sends only committed text to the shell.

## New Laymux Architecture

### 1. Separate Caret Owners

We will explicitly separate four caret concepts:

- `bufferCaret`: committed xterm cursor from terminal state
- `compositionCaret`: IME composition caret inside preview text
- `visualCaret`: the caret currently shown to the user
- `syncFrameCaret`: Codex repaint bookkeeping for DEC 2026 and footer redraw handling

Only one of these may drive the visible caret at a time.

### 2. Add Composition Preview State

Add a new state object owned by `TerminalView` or a dedicated controller:

```ts
type CompositionPreviewState = {
  active: boolean;
  text: string;
  caretUtf16Index: number;
  replaceRange?: { startCell: number; endCell: number };
  anchorBufferX: number;
  anchorBufferAbsY: number;
};
```

This state is conceptually equivalent to Windows Terminal's `tsfPreview`.

It is not derived from `buffer.active.cursorX/Y` after the fact.

It is updated directly from composition events and input events.

### 3. Redefine Visual Caret Selection

The visible caret must use this priority order:

1. If unfocused: hide visual caret.
2. If alt buffer/TUI full-screen mode requires native behavior: use native xterm cursor or hide custom caret.
3. If composition preview is active: visual caret is composition caret.
4. Else if a Codex sync-frame repaint is active: visual caret is sync-frame caret.
5. Else: visual caret is committed input caret.

This removes the current mixed logic where composition and repaint fight over one shadow state object.

### 4. Stop Treating Composition As Buffer Echo

During IME composition:

- do not wait for `onWriteParsed` to advance the visible caret,
- do not assume committed buffer movement equals composition caret movement,
- do not use row-mismatch guards as a substitute for ownership.

Composition updates must move the visual caret immediately from preview state.

### 5. Gate PTY-Oriented Key Handling During Composition

Adopt the Windows Terminal rule:

- when composition is active, terminal key forwarding logic must not independently drive navigation or commit behavior,
- IME owns confirmation and navigation keys until composition ends,
- finalized input is sent after composition commits.

For laymux this means:

- `attachCustomKeyEventHandler` must branch on composition-active state,
- shortcuts may still be allowed selectively,
- PTY-bound text insertion must not race with IME-managed composition updates.

### 6. Treat Codex Repaint Logic As A Secondary Overlay

DEC 2026, prompt OSC, save/restore repaint tracking, and footer redraw logic remain useful, but they move under a different layer:

- they maintain a stable committed input caret while the terminal output is repainting,
- they do not own composition-time caret behavior,
- they do not decide IME anchor position.

This is a strict layering rule.

## UI Policy

The current CSS policy hides both:

- xterm native cursor
- helper textarea caret

That policy is too blunt for a Windows Terminal style model.

We need an explicit visibility matrix:

| State | xterm cursor | helper textarea caret | custom overlay caret |
| --- | --- | --- | --- |
| Unfocused | hidden | browser default or hidden | hidden |
| Plain input | hidden or minimized | visible if needed for IME anchor safety | visible |
| IME composition | hidden | must remain a valid IME anchor | visible from preview state |
| DEC 2026 repaint | hidden | unchanged | frozen or sync-frame driven |
| Alt buffer/TUI | probably native or disabled custom overlay | unchanged | disabled unless proven safe |

We should assume that making the helper textarea caret fully transparent at all times is risky.

The browser IME anchor and the visible overlay caret must be aligned by design, not by coincidence.

## Proposed Code Shape

Introduce a dedicated controller, not more ad hoc refs inside `TerminalView`.

Suggested module split:

- `ui/src/lib/ime-composition-controller.ts`
- `ui/src/lib/visual-caret-controller.ts`
- `ui/src/lib/codex-sync-caret-controller.ts`

Responsibilities:

- `ime-composition-controller`
  - owns composition lifecycle
  - tracks preview text and preview caret
  - exposes `compositionActive`

- `visual-caret-controller`
  - chooses the active caret owner
  - computes pixel position for the visible caret
  - owns DOM update for the overlay caret

- `codex-sync-caret-controller`
  - tracks OSC 133, DEC 2026, save/restore repaint cycles
  - exposes a stable committed-input caret when composition is inactive

`TerminalView` should become the assembly layer, not the logic dumping ground.

## Migration Plan

### Phase 0. Freeze The Old Model

Do not extend `shadowCursorRef`.

No more fixes should be added to:

- row-mismatch sync rules
- extra `onCursorMove` heuristics
- more CSS hiding combinations

### Phase 1. Add New State Without Removing Old Code

Add composition preview state and logging:

- composition start
- composition update
- composition end
- finalized text commit

At this phase, no behavior change is required except observability.

### Phase 2. Make Composition Caret Drive The Overlay

When composition is active:

- overlay caret uses preview caret only,
- old shadow-sync path is bypassed,
- Codex repaint state is ignored for the visible caret.

This is the first meaningful behavioral switch.

### Phase 3. Gate Key Handling During Composition

Refactor terminal key handling so that:

- composition-active key events do not take the normal PTY path,
- IME confirmation ends preview state cleanly,
- committed text is inserted once.

### Phase 4. Demote The Old Shadow Cursor To Committed-Input Sync Only

After composition works:

- rename or replace `shadowCursorRef`,
- narrow its scope to committed input stabilization only,
- remove composition-specific branches from it.

### Phase 5. Revisit CSS And Native Caret Policy

Only after the behavior is correct:

- simplify cursor hiding CSS,
- restore any helper textarea behavior needed by IME,
- verify no browser caret flashes remain.

## Test Plan

### Manual Tests

Required manual scenarios:

1. PowerShell plain English typing with Codex idle
2. PowerShell Korean IME composition and commit
3. Korean composition while Codex footer/status is actively repainting
4. Candidate window position while pane is resized
5. Focus loss and regain during active composition
6. DEC 2026 synchronized output bursts without IME
7. Alternate-screen apps such as `vim`, `less`, or full-screen TUI

### Instrumentation

Add trace events for:

- composition start/update/end
- preview text length
- preview caret index
- active visual caret owner
- committed buffer caret
- sync-frame caret

The key debugging question must be answerable from logs:

"Which subsystem owned the visible caret at this moment?"

### Automated Tests

Targeted unit tests should cover:

- visual caret owner priority
- composition state transitions
- sync-frame state transitions
- composition-overrides-sync behavior
- fallback to committed caret after composition end

E2E automation for native IME will likely be limited, so the design must be traceable enough for manual verification.

## Non-Goals

This redesign does not try to:

- reproduce Windows Terminal's TSF stack literally in the browser,
- modify xterm internals to implement native TSF preview rendering,
- solve every alternate-screen cursor problem in the first pass.

The goal is to copy the ownership model, not the exact platform APIs.

## Immediate Next Steps

1. Add this document as the design baseline for branch `redesign-wt-ime-caret-model`.
2. Create `ime-composition-controller.ts` with trace-only state first.
3. Refactor `TerminalView.tsx` so composition state is isolated from current shadow cursor code.
4. Switch overlay caret owner selection to a dedicated function.
5. Only then remove PR 207-era heuristics.
