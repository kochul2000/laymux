      (() => {
        const $ = (id) => document.getElementById(id);
        const tokenInput = $("token");
        const clientNameInput = $("clientName");
        const navToggleButton = $("navToggle");
        const drawerTitle = $("drawerTitle");
        const drawerBackButton = $("drawerBack");
        const drawerNotificationsButton = $("drawerNotificationsButton");
        const drawerConnectionButton = $("drawerConnectionButton");
        const drawerSettingsButton = $("drawerSettingsButton");
        const drawerWorkspaceView = $("drawerWorkspaceView");
        const drawerHiddenView = $("drawerHiddenView");
        const drawerNotificationsView = $("drawerNotificationsView");
        const drawerCreateView = $("drawerCreateView");
        const drawerConnectionView = $("drawerConnectionView");
        const drawerSettingsView = $("drawerSettingsView");
        const remoteTerminalFontSizeInput = $("remoteTerminalFontSize");
        const remoteComposerFontSizeInput = $("remoteComposerFontSize");
        const remoteTouchScrollSensitivityInput = $("remoteTouchScrollSensitivity");
        const remoteTwoFingerScrollSensitivityInput = $(
          "remoteTwoFingerScrollSensitivity",
        );
        const remoteDisplaySettingsStatus = $("remoteDisplaySettingsStatus");
        const pcUpdateStatusElement = $("pcUpdateStatus");
        const pcUpdateNotes = $("pcUpdateNotes");
        const checkPcUpdateButton = $("checkPcUpdate");
        const installPcUpdateButton = $("installPcUpdate");
        const desktopModeHeaderButton = $("desktopModeHeader");
        const desktopModeDrawerButton = $("desktopModeDrawer");
        const navScrim = $("navScrim");
        const connectButton = $("connect");
        const exitButton = $("exit");
        const refreshButton = $("refresh");
        const connectionPanel = document.querySelector(".connection-panel");
        const connectionHint = document.querySelector(".connection-hint");
        const statusEl = $("status");
        const statusSpinnerEl = $("statusSpinner");
        const statusTextEl = $("statusText");
        const terminalHost = $("terminal");
        const terminalSizer = $("terminalSizer");
        const scrollToBottomButton = $("scrollToBottom");
        const terminalShell = document.querySelector(".terminal-shell");
        const terminalMetaEl = $("terminalMeta");
        const terminalComposer = $("terminalComposer");
        const composerInput = $("composerInput");
        const composerHistoryList = $("composerHistoryList");
        const composerAutocompleteList = $("composerAutocompleteList");
        const workspaceSection = $("workspaceSection");
        const hiddenWorkspaceSection = $("hiddenWorkspaceSection");
        const newWorkspaceButton = $("newWorkspace");
        const newWorkspacePanel = $("newWorkspacePanel");
        const hiddenWorkspaceToggle = $("hiddenWorkspaceToggle");
        const hiddenWorkspaceShelf = $("hiddenWorkspaceShelf");
        const workspaceListEl = $("workspaceList");
        const dockSection = $("dockSection");
        const dockToggleButton = $("dockToggle");
        const dockBadge = $("dockBadge");
        const dockPanel = $("dockPanel");
        const dockListEl = $("dockList");
        const notificationSection = $("notificationSection");
        const notificationListEl = $("notificationList");
        const markAllNotificationsReadButton = $("markAllNotificationsRead");
        const clearNotificationsButton = $("clearNotifications");
        const installSection = $("installSection");
        const installButton = $("installApp");
        const installHint = $("installHint");
        const fileViewerSection = $("fileViewerSection");
        const fileViewerStatusElement = $("fileViewerStatus");
        const fileViewerPathInput = $("fileViewerPath");
        const pullHostFileViewerPathButton = $("pullHostFileViewerPath");
        const openFileViewerButton = $("openFileViewer");
        const fileViewerOverlayElement = $("fileViewerOverlay");
        const fileViewerTitleElement = $("fileViewerTitle");
        const fileViewerZoomElement = $("fileViewerZoom");
        const fileViewerZoomLevelElement = $("fileViewerZoomLevel");
        const fileViewerZoomOutButton = $("fileViewerZoomOut");
        const fileViewerZoomInButton = $("fileViewerZoomIn");
        const fileViewerZoomResetButton = $("fileViewerZoomReset");
        const fileViewerCloseButton = $("fileViewerClose");
        const fileViewerDownloadButton = $("fileViewerDownload");
        const fileViewerBodyElement = $("fileViewerBody");
        const fileViewerMessageElement = $("fileViewerMessage");
        const fileViewerTextElement = $("fileViewerText");
        const fileViewerImageElement = $("fileViewerImage");
        const fileViewerPreviewElement = $("fileViewerPreview");
        const fileViewerBinaryElement = $("fileViewerBinary");
        const fileViewerDirectoryElement = $("fileViewerDirectory");
        const fileViewerBackButton = $("fileViewerBack");
        const fileExplorerHeaderButton = $("fileExplorerHeader");
        const focusTerminalButton = $("focusTerminal");
        const ctrlCButton = $("ctrlC");
        const attachmentButton = $("attachFile");
        const attachmentInput = $("attachmentInput");
        const composerSendButton = $("composerSend");
        const mainActionRow = $("mainActionRow");
        const inputLayoutEditor = $("inputLayoutEditor");
        const coarsePointer =
          typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
        const inputModeToggleButton = $("inputModeToggle");
        const inputModeIcon = $("inputModeIcon");
        const INPUT_MODE_ICONS = {
          direct:
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M8.5 14h7" stroke-linecap="round"/></svg>',
          composer:
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 20h4L18.5 9.5a2 2 0 0 0-2.83-2.83L5 17v3z" stroke-linejoin="round"/><path d="M13.5 8.5l2.5 2.5" stroke-linecap="round"/></svg>',
        };
        const copyPaneIdButton = $("copyPaneId");
        const spatialExclusionButton = $("spatialExclusion");
        const keyBar = $("keyBar");
        const keyBarToggleButton = $("keyBarToggle");
        const keyRowEl = $("keyRow");
        const keyFlickHint = $("keyFlickHint");
        // ADR-0186 moves the former key-bar popover into the persistent drawer
        // Settings recovery path. Keep the renderer's neutral body name while
        // the presentation is no longer a popover.
        const keyPopoverBody = inputLayoutEditor;
        const tokenKey = "laymux.remote.token";
        const keyBarKey = "laymux.remote.keybar";
        const inputModeKey = "laymux.remote.inputMode";
        // Composer recall feature toggles (issues #504 / #505). Only the on/off
        // boolean is surface-local in localStorage — the past-input text itself
        // is kept in a runtime Map and never persisted (see composerHistory*).
        // ADR-0182 is the narrow exception: selected text files and long pastes
        // become bounded host-cache files only when the user attaches/pastes them.
        const composerHistoryPopupKey = "laymux.remote.composerHistoryPopup";
        const composerAutocompleteKey = "laymux.remote.composerAutocomplete";
        // A visual-only Remote preference: when Composer opens for one of the
        // supported coding agents, leave its input footer in view by scrolling
        // the terminal viewport up by that agent's fixed footer height.
        const composerAgentScrollOffsetKey = "laymux.remote.composerAgentScrollOffset";
        const composerAgentScrollOffsetLinesKey = "laymux.remote.composerAgentScrollOffsetLines";
        // Which terminals share one recall bucket (ADR-0055). Only the scope
        // choice is stored here; the recalled text stays in memory.
        const composerHistoryScopeStorageKey = "laymux.remote.composerHistoryScope";
        // The device half of the widget strip gate (ADR-0132). The host's
        // `settings.remote.widgets` still decides whether values are sent at
        // all; this only says whether *this* browser spends a chrome row on
        // them. Defaults on, so only an explicit "0" hides the strip.
        const widgetStripKey = "laymux.remote.widgetStrip";
        const spatialExcludedPaneIdsKey = "laymux.remote.spatialExcludedPaneIds";
        const spatialExcludedWorkspaceIdsKey = "laymux.remote.spatialExcludedWorkspaceIds";
        // Secret resume capability issued by a successful claim. It lives in
        // memory while the document is alive and touches sessionStorage only
        // across the unload/load boundary (stash on pagehide, consume on
        // load). A duplicated tab (window.open, Duplicate Tab) clones the
        // storage of a LIVE original — which is empty — so no clone can
        // present the capability and hijack the controller lease.
        const resumeTokenKey = "laymux.remote.resumeToken";
        // sessionStorage, not localStorage: the intent to hold control belongs to
        // *this tab*. It still survives the reload/discard a long mobile background
        // causes (the trip issue #561 is about), but a second tab does not inherit it
        // — a stale tab that kept re-claiming turned a fresh "Connect" from the
        // dashboard into a 409 lease conflict.
        const autoConnectKey = "laymux.remote.autoConnect";
        const DEFAULT_HEARTBEAT_TIMEOUT_SECONDS = 45;
        const HEARTBEAT_INTERVAL_MIN_MS = 1000;
        const HEARTBEAT_INTERVAL_MAX_MS = 5000;
        const HEARTBEAT_REQUEST_TIMEOUT_MAX_MS = 4000;
        const AUTO_CONNECT_RETRY_BASE_MS = 1000;
        const AUTO_CONNECT_RETRY_MAX_MS = 15000;
        const HEARTBEAT_RETRY_DELAY_MS = 1000;
        const TRANSIENT_CONNECTION_NOTICE_DELAY_MS = 2000;
        // The viewer keeps its own zoom: transient display state, never a
        // setting — there is no "default zoom" for looking at one file.
        const FILE_VIEWER_ZOOM_STEP = 0.25;
        const FILE_VIEWER_ZOOM_MIN = 0.25;
        const FILE_VIEWER_ZOOM_MAX = 5;
        const FILE_VIEWER_TEXT_BASE_PX = 13;
        const REMOTE_FONT_SIZE_MIN = 6;
        const REMOTE_FONT_SIZE_MAX = 72;
        const REMOTE_ATTACHMENT_MAX_BYTES = 1024 * 1024;
        const REMOTE_LONG_TEXT_ATTACHMENT_THRESHOLD_BYTES = 5 * 1024;
        const attachmentTextEncoder = new TextEncoder();
        let leaseId = null;
        let remoteDisplaySettings = null;
        let remoteDisplaySettingsLoading = false;
        let remoteDisplaySettingsPending = false;
        let remoteDisplaySettingsRevision = 0;
        let resumeToken = null;
        let fileViewerToken = null;
        let claimAttemptRevision = 0;
        let autoConnectTimer = null;
        let autoConnectAttempt = 0;
        let claimInFlight = false;
        let heartbeatTimer = null;
        let heartbeatAbortController = null;
        let heartbeatInFlight = false;
        let heartbeatRetryTimer = null;
        let heartbeatTimeoutMs = DEFAULT_HEARTBEAT_TIMEOUT_SECONDS * 1000;
        let lastHeartbeatOkAt = 0;
        let socket = null;
        let outputReconnectTimer = null;
        let outputReconnectAttempt = 0;
        // Scroll-top history expansion (ADR-0182). `outputHistoryKib` is the
        // attach screen budget this client currently asks the desktop for; it
        // belongs to `outputHistoryTerminalId` only and resets on a pane switch.
        let outputHistoryKib = 0;
        let outputHistoryTerminalId = null;
        let outputHistoryExhausted = false;
        let historyExpansion = null;
        // Serialized size of the screen checkpoint the surface currently shows.
        // A deeper budget must produce a bigger one, or there is nothing older.
        let outputSnapshotBytes = 0;
        let nextHistoryExpansionId = 0;
        let lastTerminalViewportY = 0;
        let restoringTerminalViewport = false;
        let lastTerminalUserScrollAt = 0;
        let transientConnectionNoticeTimer = null;
        let transientConnectionNoticeVisible = false;
        let heartbeatInterrupted = false;
        let outputInterrupted = false;
        let activeTerminalId = null;
        let activeGithubRepoBase = null;
        let githubRepoRequestRevision = 0;
        let githubRepoAbortController = null;
        // Keep the user's most recently attached pane across release/lease
        // loss within this document. The navigation snapshot remains the
        // authority for whether it is still live and eligible; this hint is
        // intentionally not persisted across page loads.
        let lastSelectedTerminalId = null;
        // Per-workspace variant of lastSelectedTerminalId (issue #508): remember
        // the last terminal the user attached to inside each workspace so that
        // re-entering a collapsed workspace resumes that pane instead of always
        // snapping back to the first pane. Same surface-local, non-persisted
        // lifetime as lastSelectedTerminalId; dock terminals (no workspaceId)
        // are excluded. The navigation snapshot still validates liveness/eligibility.
        const lastSelectedTerminalIdByWorkspace = new Map();
        let terminalInfoById = new Map();
        let navigationState = null;
        let workspaceLayouts = [];
        const NAVIGATION_VIEW_REFRESH_MS = 2000;
        let navigationViewRefreshTimer = null;
        let navigationViewRefreshInFlight = false;
        let spatialExcludedPaneIds = loadSpatialExcludedPaneIds();
        // Whole-workspace skip denylist (issue #507, ADR-0047). Independent
        // Set<workspaceId> alongside spatialExcludedPaneIds: a workspace is
        // skipped in remote spatial navigation when its id is here, regardless
        // of the per-pane set. The two stay consistent for the active workspace
        // via the promotion/demotion rule (all panes skipped <-> workspace
        // skipped). Navigation now carries every workspace's pane ids, so the
        // invariant can be reconciled without first entering a workspace.
        let spatialExcludedWorkspaceIds = loadSpatialExcludedWorkspaceIds();
        let fileViewerStatusInFlight = false;
        let fileViewerStatusRequestRevision = 0;
        let fileViewerPathRevision = 0;
        let fileViewerRequestRevision = 0;
        let fileViewerPath = null;
        let fileViewerDownloadInFlight = false;
        let fileViewerKind = null;
        // Explorer mode (ADR-0197): the directory the overlay is listing, and
        // the directory a file opened from it returns to. Display state only —
        // never persisted, reset on close and on every disconnect.
        let fileViewerDirectoryPath = null;
        let fileViewerExplorerReturnPath = null;
        let fileViewerZoom = 1;
        let fileViewerPinch = null;
        const fileViewerPointers = new Map();
        const REMOTE_PATH_LINK_MAX_SELECTION_LENGTH = 1024;
        const REMOTE_PATH_LINK_MAX_SELECTION_LINES = 8;
        const REMOTE_PATH_LINK_MAX_SELECTION_MATCHES = 16;
        // ADR-0188 screen trigger: one viewport, bounded rows/chars/candidates.
        const REMOTE_PATH_LINK_MAX_SCREEN_LINES = 64;
        const REMOTE_PATH_LINK_MAX_SCREEN_CHARS = 8192;
        const REMOTE_PATH_LINK_MAX_SCREEN_CANDIDATES = 64;
        const REMOTE_PATH_LINK_IDLE_SCAN_DELAY_MS = 500;
        const PATH_LINK_CLICK_SLOP_PX = 4;
        const PATH_LINK_SELECTION_DEBOUNCE_MS = 100;
        // Each discovery trigger owns its own underlines, revision and request
        // so one never retires anothers result (ADR-0188).
        const PATH_LINK_SCOPES = ["selection", "point", "screen"];
        let pathLinkScopes = { selection: [], point: [], screen: [] };
        let pathLinkRevisions = { selection: 0, point: 0, screen: 0 };
        let pathLinkAborts = { selection: null, point: null, screen: null };
        let pathLinkEvaluationTimer = null;
        let pathLinkIdleScanTimer = null;
        let pathLinkLastScreenSignature = null;
        let pathLinkPress = null;
        let terminal = null;
        // The xterm instance is reused across disconnects and pane switches.
        // Keep the id whose snapshot currently occupies it so a recovery can
        // preserve surface-local viewport state only for that same terminal.
        let renderedTerminalId = null;
        let fitAddon = null;
        let resizeObserver = null;
        // Last host geometry adopted by fitTerminal. Height-only shrinks below
        // fittedHostHeight crop the surface instead of refitting (ADR-0038).
        let fittedHostWidth = 0;
        let fittedHostHeight = 0;
        let cropActive = false;
        let resizeListenerAttached = false;
        let resizeTimer = null;
        let terminalRefreshFrame = null;
        let cropTransformFrame = null;
        let lastResizeKey = "";
        let pendingInput = "";
        let pendingInputTerminalId = null;
        let pendingInputLeaseId = null;
        let inputFlushTimer = null;
        let inputWriteChain = Promise.resolve();
        let terminalSelectionRevision = 0;
        let terminalOutputWriteChain = Promise.resolve();
        let terminalOutputGeneration = 0;
        // While an output attach is being prepared, keep the browser grid at
        // the exact geometry that was synchronously sent through /resize.
        // Deferred rAF/ResizeObserver fits resume only after the checkpoint has
        // been replayed at its authoritative source geometry.
        let outputAttachGeometryGeneration = null;
        // Raised around replay writes (snapshot / reset / synthetic mode) so
        // any onData xterm emits while parsing them is swallowed rather than
        // forwarded to the PTY. Known query replies are already suppressed at
        // the parser (suppressMirrorQueryReplies); this is the catch-all that
        // covers the reconnect flood for sequences we did not enumerate (#480).
        let terminalReplayDepth = 0;
        const inputModeByTerminalId = new Map();
        const composerDraftByTerminalId = new Map();
        // Sent-input recall history, keyed by scope bucket (ADR-0055:
        // "global" | "ws:{workspaceId}" | "pane:{terminalId}"), oldest→newest.
        // This holds the actual text the user submitted, so — like the composer
        // draft (ADR-0029) — it lives ONLY in this runtime Map and is never
        // written to localStorage / sessionStorage / disk / the network. Keeping
        // it in memory means passwords or other secrets typed into a shell
        // cannot leak through a recall surface after the page unloads.
        const composerHistoryByScopeKey = new Map();
        const MAX_COMPOSER_HISTORY = 200;
        const DEFAULT_COMPOSER_HISTORY_POPUP_ITEMS = 8;
        const DEFAULT_COMPOSER_AUTOCOMPLETE_ITEMS = 8;
        const COMPOSER_HISTORY_SCOPES = ["global", "workspace", "pane"];
        const DEFAULT_COMPOSER_HISTORY_SCOPE = "global";
        // These are deliberately line counts rather than pixels: xterm owns the
        // cell geometry, and this must remain a surface-local scroll only (it
        // must not resize the PTY; ADR-0038).
        const DEFAULT_COMPOSER_AGENT_SCROLL_OFFSETS = Object.freeze({
          Claude: 3,
          Codex: 4,
          Grok: 2,
        });
        const COMPOSER_AGENT_SCROLL_OFFSET_MIN = 0;
        const COMPOSER_AGENT_SCROLL_OFFSET_MAX = 24;
        let preferredInputMode = loadPreferredInputMode();
        // Feature on/off toggles are configuration (not content), so they are
        // the only composer-recall state allowed in localStorage. Default on to
        // match the desktop composer and stay non-destructive.
        let composerHistoryPopupEnabled = loadComposerToggle(composerHistoryPopupKey);
        let composerAutocompleteEnabled = loadComposerToggle(composerAutocompleteKey);
        let composerAgentScrollOffsetEnabled = loadComposerToggle(composerAgentScrollOffsetKey);
        let composerAgentScrollOffsets = loadComposerAgentScrollOffsets();
        let composerHistoryScope = loadComposerHistoryScope();
        let composerIsComposing = false;
        let composerReady = false;
        let attachmentUploadInFlight = false;
        let attachmentUploadAttempt = null;
        let attachmentChooserRevision = 0;
        let pendingAttachmentChooser = null;
        const attachmentChooserRetryTimers = new Set();
        // Tab recall popup (issue #504) UI state: open flag + highlighted row.
        let composerHistoryOpen = false;
        let composerHistoryIndex = 0;
        // As-you-type autocomplete (issue #505) UI state. `dismissed` is cleared
        // on the next keystroke; index −1 means "no active suggestion" so plain
        // Enter still sends.
        let composerAutocompleteDismissed = false;
        let composerAutocompleteIndex = -1;
        // Keyboard-button collapse state: in composer mode the editor pane
        // hides and restores together with the soft keyboard.
        let composerCollapsed = false;
        let dockPanelOpen = false;
        let drawerView = "workspace";
        let pcUpdateStatus = null;
        let pcUpdatePollTimer = null;
        let pcUpdateRequestInFlight = false;
        let hiddenWorkspaceCount = 0;
        let touchGesture = null;
        let touchPointers = new Map();
        let lastTouchTap = { time: 0, x: 0, y: 0, count: 0 };
        let selectionHandles = null;
        let selectionHandleDrag = null;
        let lastCopiedSelection = "";
        let suppressSelectionMouseupAfterInteraction = false;

        // UX contract: long press. This delay is only the local gesture threshold.
        const INTERNAL_TOUCH_LONG_PRESS_DELAY_MS = 500;
        const INTERNAL_TOUCH_SCROLL_SLOP_PX = 8;
        const INTERNAL_TOUCH_TAP_SLOP_PX = 18;
        const INTERNAL_TOUCH_MULTI_TAP_DELAY_MS = 320;
        const OUTPUT_RECONNECT_INITIAL_DELAY_MS = 250;
        const OUTPUT_RECONNECT_MAX_DELAY_MS = 5000;
        // Scroll-top history expansion budget (KiB). Each request asks for a
        // multiple of the screen the page already holds, floored so the very
        // first step is worth a re-attach and capped at the desktop's supported
        // ceiling for one checkpoint (ADR-0182).
        const HISTORY_EXPANSION_MIN_KIB = 64;
        const HISTORY_EXPANSION_MAX_KIB = 1024;
        const HISTORY_EXPANSION_GROWTH = 4;
        // A checkpoint stops one whole line short of its budget at most, so this
        // much slack still counts as "the budget was the limit".
        const HISTORY_EXPANSION_BUDGET_SLACK_BYTES = 8 * 1024;
        const HISTORY_EXPANSION_BUSY_STATUS = "Loading earlier output…";
        // How long a scroll gesture keeps vouching for viewport movement.
        const TERMINAL_USER_SCROLL_WINDOW_MS = 1500;
        // Automatic transport recovery keeps the expanded budget while the
        // socket still opens, so a blip does not throw away paged-in history.
        // After this many consecutive failures to open it falls back to the
        // owner budget: a flaky link must not re-drive a 1 MiB checkpoint
        // serialization on the desktop every few seconds.
        const HISTORY_EXPANSION_MAX_FAILED_OPENS = 2;
        // A history attach that never produces a snapshot (dropped socket, host
        // busy) must not wedge the next request behind an in-flight marker.
        const HISTORY_EXPANSION_TIMEOUT_MS = 20000;

        const remoteVisualViewport = window.visualViewport;

        function syncRemoteViewportHeight() {
          const height = remoteVisualViewport ? remoteVisualViewport.height : window.innerHeight;
          if (!Number.isFinite(height) || height <= 0) return;
          document.documentElement.style.setProperty("--remote-viewport-height", `${Math.round(height)}px`);
          scheduleTerminalFit();
        }

        syncRemoteViewportHeight();
        window.addEventListener("resize", syncRemoteViewportHeight);
        remoteVisualViewport?.addEventListener("resize", syncRemoteViewportHeight);

        const hashParams = new URLSearchParams(location.hash.replace(/^#/, ""));
        const searchParams = new URLSearchParams(location.search);
        const androidE2eMode =
          searchParams.get("androidE2e") === "1" &&
          window.LaymuxNative &&
          typeof window.LaymuxNative.requestRemoteHttp === "function" &&
          window.LaymuxOutputTransport &&
          typeof window.LaymuxOutputTransport.postMessage === "function";
        const localAppMode = searchParams.get("localApp") === "1" || hashParams.get("localApp") === "1";
        const autoConnectMode = searchParams.get("autoConnect") === "1" || hashParams.get("autoConnect") === "1";
        const clientNameFromParams = searchParams.get("clientName") || hashParams.get("clientName");
        tokenInput.value =
          hashParams.get("token") ||
          searchParams.get("token") ||
          localStorage.getItem(tokenKey) ||
          "";
        if (clientNameFromParams) clientNameInput.value = clientNameFromParams;
        document.querySelector(".app").classList.toggle("local-app", localAppMode);
        document.querySelector(".app").classList.toggle("android-e2e", Boolean(androidE2eMode));
        if (androidE2eMode) clientNameInput.value = "Laymux Android E2E";
        // Android E2E exits Remote control through Release. Keep the PC-mode
        // switch only for the desktop app's embedded mobile view, where it
        // changes the surrounding desktop layout rather than releasing a lease.
        desktopModeHeaderButton.hidden = !localAppMode;
        desktopModeDrawerButton.hidden = !localAppMode;
        // Layout naming (canonical Enter gesture, ADR-0036/0186):
        //   desktop layout — Enter sends, Shift+Enter inserts a newline.
        //   mobile layout  — Enter inserts a newline; the Send action submits.
        // The configurable Send action is visible in either layout whenever
        // Composer mode is active; this flag decides only the Enter gesture.
        // Rule: mobile layout when the pointer is coarse (touch device) OR when
        // the page is the PC app's embedded mobile view (localApp=1) — if it
        // looks like mobile, it behaves like mobile. A default; a settings
        // override can come later.
        const mobileLayout = coarsePointer || localAppMode;
        composerInput.placeholder = mobileLayout
          ? "Enter for a newline · tap Send to submit"
          : "Enter to send · Shift+Enter for a newline";

        const defaultAppearance = Object.freeze({
          fontFamily: "'Cascadia Mono', 'Cascadia Mono', 'Consolas', monospace",
          fontSize: 14,
          cursorStyle: "bar",
          cursorWidth: 1,
          scrollback: 10000,
          scrollSensitivity: 1,
          fastScrollSensitivity: 5,
          touchScrollSensitivity: 1,
          twoFingerScrollSensitivity: 5,
          theme: Object.freeze({
            background: "#0C0C0C",
            foreground: "#F0F0F0",
            cursor: "#FFFFFF",
            selectionBackground: "#232042",
            black: "#0C0C0C",
            red: "#C50F1F",
            green: "#13A10E",
            yellow: "#C19C00",
            blue: "#0037DA",
            magenta: "#881798",
            cyan: "#3A96DD",
            white: "#F0F0F0",
            brightBlack: "#767676",
            brightRed: "#E74856",
            brightGreen: "#16C60C",
            brightYellow: "#F9F1A5",
            brightBlue: "#3B78FF",
            brightMagenta: "#B4009E",
            brightCyan: "#61D6D6",
            brightWhite: "#FFFFFF"
          })
        });

        // The spinner is a CSS ring (.status-spinner): the animation and the
        // reduced-motion fallback both live in the stylesheet, so busy state is
        // one attribute toggle here.
        function setStatusSpinnerVisible(visible) {
          statusSpinnerEl.hidden = !visible;
        }

        function renderStatus(message, error, warning, busy) {
          statusTextEl.textContent = message;
          statusEl.classList.toggle("error", error);
          statusEl.classList.toggle("warning", warning);
          statusEl.setAttribute("aria-busy", busy ? "true" : "false");
          setStatusSpinnerVisible(busy);
        }

        function setStatus(message, error = false, warning = false) {
          renderStatus(message, error, warning, false);
        }

        function setBusyStatus(message, error = false, warning = false) {
          renderStatus(message, error, warning, true);
        }

        function hasTransientConnectionInterruption() {
          return heartbeatInterrupted || outputInterrupted;
        }

        function scheduleTransientConnectionNotice(domain) {
          if (domain === "heartbeat") heartbeatInterrupted = true;
          if (domain === "output") outputInterrupted = true;
          if (transientConnectionNoticeTimer || transientConnectionNoticeVisible) return;
          transientConnectionNoticeTimer = setTimeout(() => {
            transientConnectionNoticeTimer = null;
            if (!leaseId || !hasTransientConnectionInterruption()) return;
            transientConnectionNoticeVisible = true;
            setBusyStatus("Connection interrupted. Reconnecting…", false, true);
          }, TRANSIENT_CONNECTION_NOTICE_DELAY_MS);
        }

        function clearTransientConnectionNotice(domain, recoveredMessage) {
          if (domain === "heartbeat") heartbeatInterrupted = false;
          if (domain === "output") outputInterrupted = false;
          if (hasTransientConnectionInterruption()) return;
          if (transientConnectionNoticeTimer) {
            clearTimeout(transientConnectionNoticeTimer);
            transientConnectionNoticeTimer = null;
          }
          if (transientConnectionNoticeVisible) {
            transientConnectionNoticeVisible = false;
            setStatus(recoveredMessage || "Connected.");
          }
        }

        function resetTransientConnectionNotice() {
          heartbeatInterrupted = false;
          outputInterrupted = false;
          if (transientConnectionNoticeTimer) {
            clearTimeout(transientConnectionNoticeTimer);
            transientConnectionNoticeTimer = null;
          }
          transientConnectionNoticeVisible = false;
        }

        function token() {
          if (androidE2eMode) return "android-e2e";
          return tokenInput.value.trim();
        }

        // Move the stashed resume capability out of sessionStorage into this
        // document's memory. Consuming (get + remove) keeps the storage empty
        // while the document is alive, which is what defeats tab duplication.
        function consumeStashedResumeToken() {
          try {
            const value = sessionStorage.getItem(resumeTokenKey);
            if (value) sessionStorage.removeItem(resumeTokenKey);
            return value || null;
          } catch (_) {
            return null;
          }
        }

        function stashResumeTokenForUnload() {
          if (!resumeToken) return;
          try {
            sessionStorage.setItem(resumeTokenKey, resumeToken);
          } catch (_) {}
        }

        function discardResumeToken() {
          resumeToken = null;
          try {
            sessionStorage.removeItem(resumeTokenKey);
          } catch (_) {}
        }

        resumeToken = consumeStashedResumeToken();

        function authHeaders() {
          return {
            "authorization": `Bearer ${token()}`,
            "content-type": "application/json",
          };
        }

        function remoteHeaders(overrides) {
          const headers = new Headers(authHeaders());
          new Headers(overrides || {}).forEach((value, name) => headers.set(name, value));
          return headers;
        }

        let nextAndroidHttpRequestId = 0;
        const androidHttpDocumentId = (() => {
          const bytes = new Uint8Array(8);
          window.crypto.getRandomValues(bytes);
          return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
        })();
        let nextAndroidOutputStreamId = 0;
        const androidHttpRequests = new Map();
        const androidOutputSockets = new Map();

        function cancelAndroidRemoteHttp(requestId) {
          if (typeof window.LaymuxNative?.cancelRemoteHttp !== "function") return;
          try {
            window.LaymuxNative.cancelRemoteHttp(requestId);
          } catch (_) {}
        }

        function remoteResponseError(status, body = {}) {
          const error = new Error(body.error || `Remote request failed (${status})`);
          error.status = status;
          for (const field of [
            "code",
            "claimReservationId",
            "retryAfterMs",
            "reservationTtlMs",
            "active",
            "transitioning",
          ]) {
            if (Object.prototype.hasOwnProperty.call(body, field)) error[field] = body[field];
          }
          return error;
        }

        function androidRemoteFetch(path, options = {}) {
          return new Promise((resolve, reject) => {
            if (options.signal?.aborted) {
              reject(new DOMException("The operation was aborted.", "AbortError"));
              return;
            }
            const requestId = `http-${androidHttpDocumentId}-${++nextAndroidHttpRequestId}`;
            const abort = () => {
              if (!androidHttpRequests.delete(requestId)) return;
              cancelAndroidRemoteHttp(requestId);
              reject(new DOMException("The operation was aborted.", "AbortError"));
            };
            options.signal?.addEventListener("abort", abort, { once: true });
            androidHttpRequests.set(requestId, {
              resolve,
              reject,
              cleanup: () => options.signal?.removeEventListener("abort", abort),
            });
            try {
              window.LaymuxNative.requestRemoteHttp(
                requestId,
                String(options.method || "GET"),
                String(path),
                typeof options.body === "string" ? options.body : null,
              );
            } catch (error) {
              const request = androidHttpRequests.get(requestId);
              androidHttpRequests.delete(requestId);
              request?.cleanup();
              reject(error);
            }
          });
        }

        // Connectors that predate scroll-top history expansion reject an open
        // record carrying unknown fields, so the budget only goes to a bridge
        // that advertises it (ADR-0182).
        function androidOutputHistorySupported() {
          try {
            return window.LaymuxNative?.supportsOutputHistoryBudget?.() === true;
          } catch (_error) {
            return false;
          }
        }

        class AndroidE2eOutputSocket {
          constructor(url) {
            this.binaryType = "arraybuffer";
            this.readyState = 0;
            this.onopen = null;
            this.onmessage = null;
            this.onerror = null;
            this.onclose = null;
            this.streamId = `output-${++nextAndroidOutputStreamId}`;
            try {
              const parsed = new URL(url);
              const prefix = "/remote/v1/terminals/";
              const suffix = "/output";
              if (!parsed.pathname.startsWith(prefix) || !parsed.pathname.endsWith(suffix)) {
                throw new Error("Invalid Remote output path.");
              }
              const encodedTerminalId = parsed.pathname.slice(prefix.length, -suffix.length);
              this.terminalId = decodeURIComponent(encodedTerminalId);
              this.leaseId = parsed.searchParams.get("leaseId") || "";
              const historyKib = Number.parseInt(parsed.searchParams.get("historyKib") || "", 10);
              this.historyKib = Number.isSafeInteger(historyKib) && historyKib > 0 ? historyKib : 0;
              if (!this.terminalId || !this.leaseId) {
                throw new Error("Remote output identity is missing.");
              }
              if (!window.LaymuxOutputTransport?.postMessage) {
                throw new Error("Secure binary output bridge is unavailable.");
              }
              androidOutputSockets.set(this.streamId, this);
              setTimeout(() => {
                if (this.readyState !== 0) return;
                try {
                  const open = {
                    type: "open",
                    streamId: this.streamId,
                    terminalId: this.terminalId,
                    leaseId: this.leaseId,
                  };
                  if (this.historyKib > 0 && androidOutputHistorySupported()) {
                    open.historyKib = this.historyKib;
                  }
                  window.LaymuxOutputTransport.postMessage(JSON.stringify(open));
                } catch (error) {
                  this.fail(error instanceof Error ? error.message : String(error));
                }
              }, 0);
            } catch (error) {
              setTimeout(
                () => this.fail(error instanceof Error ? error.message : String(error)),
                0,
              );
            }
          }

          acceptBridgeEvent(kind, payload) {
            if (this.readyState >= 2) return;
            if (kind === 1) {
              if (this.readyState !== 0) return;
              this.readyState = 1;
              this.onopen?.({ type: "open", target: this });
              return;
            }
            if (kind === 2) {
              if (this.readyState !== 1 || payload.byteLength < 1) {
                this.fail("Secure output bridge record is invalid.");
                return;
              }
              const recordKind = payload[0];
              if (recordKind === 2) {
                this.onmessage?.({
                  data: new TextDecoder().decode(payload.subarray(1)),
                  target: this,
                });
                return;
              }
              if (recordKind === 3) {
                this.onmessage?.({ data: payload.slice(1).buffer, target: this });
                return;
              }
              this.fail("Secure output record type is invalid.");
              return;
            }
            if (kind === 3) {
              const isError = payload[0] === 1;
              const message = new TextDecoder().decode(payload.subarray(1));
              if (isError) this.onerror?.({ type: "error", message, target: this });
              this.finish();
            }
          }

          acknowledge() {
            if (this.readyState !== 1) return;
            window.LaymuxOutputTransport.postMessage(JSON.stringify({
              type: "ack",
              streamId: this.streamId,
            }));
          }

          fail(message) {
            if (this.readyState >= 2) return;
            this.onerror?.({ type: "error", message, target: this });
            this.close();
          }

          finish() {
            if (this.readyState === 3) return;
            this.readyState = 3;
            androidOutputSockets.delete(this.streamId);
            this.onclose?.({ type: "close", target: this });
          }

          close() {
            if (this.readyState >= 2) return;
            this.readyState = 2;
            androidOutputSockets.delete(this.streamId);
            try {
              window.LaymuxOutputTransport.postMessage(JSON.stringify({
                type: "close",
                streamId: this.streamId,
              }));
            } catch (_) {}
            setTimeout(() => this.finish(), 0);
          }
        }

        if (window.LaymuxOutputTransport) {
          window.LaymuxOutputTransport.onmessage = (event) => {
            if (!(event.data instanceof ArrayBuffer) || event.data.byteLength < 3) return;
            const bytes = new Uint8Array(event.data);
            const streamIdLength = new DataView(event.data).getUint16(1, false);
            if (bytes.byteLength < 3 + streamIdLength) return;
            const streamId = new TextDecoder().decode(bytes.subarray(3, 3 + streamIdLength));
            androidOutputSockets.get(streamId)?.acceptBridgeEvent(
              bytes[0],
              bytes.subarray(3 + streamIdLength),
            );
          };
        }

        window.laymuxAndroidE2e = Object.freeze({
          onHttpResponse(requestId, responseJson) {
            const request = androidHttpRequests.get(requestId);
            if (!request) return;
            androidHttpRequests.delete(requestId);
            request.cleanup();
            try {
              const response = JSON.parse(responseJson);
              const status = Number(response.status) || 500;
              if (status < 200 || status >= 300) {
                request.reject(remoteResponseError(status, response.body || {}));
              } else {
                request.resolve(response.body);
              }
            } catch (error) {
              request.reject(error);
            }
          },
          onHttpError(requestId, message) {
            const request = androidHttpRequests.get(requestId);
            if (!request) return;
            androidHttpRequests.delete(requestId);
            request.cleanup();
            request.reject(new Error(message || "Secure Remote request failed."));
          },
          onNativeForeground() {
            if (!androidE2eMode) return false;

            // The Android entry URL expresses standing auto-connect intent even
            // if backgrounding interrupted the very first claim before it could
            // persist that intent on success.
            if (autoConnectMode) armAutoConnect();

            // pagehide may have copied the capability to sessionStorage even
            // though Android retained this same document. Empty that temporary
            // handoff slot again before a duplicated tab can inherit it.
            const stashedResumeToken = consumeStashedResumeToken();
            if (!resumeToken && stashedResumeToken) resumeToken = stashedResumeToken;

            // Native delivers the exact resumed sequential RPC before invoking
            // this callback. Requests still left here were queued or cancelled
            // before native execution, so an in-place resume must settle them.
            const pendingRequests = Array.from(androidHttpRequests.entries());
            androidHttpRequests.clear();
            for (const [requestId, request] of pendingRequests) {
              cancelAndroidRemoteHttp(requestId);
              request.cleanup();
              request.reject(new Error("Secure Remote transport resumed after background."));
            }

            // Native output sockets were closed onStop and no longer have a
            // callback entry. Finish their JS peers so the existing snapshot
            // reattach path replaces them without resetting the current surface
            // until the new checkpoint arrives.
            for (const outputSocket of Array.from(androidOutputSockets.values())) {
              outputSocket.finish();
            }

            // Promise rejection handlers above run before this task. That clears
            // heartbeatInFlight (or a stale claim) before we probe the retained
            // lease and lets a lost lease enter the normal visible-only reclaim.
            setTimeout(() => {
              if (leaseId) heartbeat().catch((err) => handleHeartbeatError(err));
              else maybeAutoConnect();
            }, 0);
            return true;
          },
        });

        async function remoteFetch(path, options = {}) {
          if (androidE2eMode) return androidRemoteFetch(path, options);
          const response = await fetch(path, {
            ...options,
            // Header names are case-insensitive. Object spread is not: combining
            // `content-type` with `Content-Type` makes Chromium send a comma-joined
            // value that axum's strict JSON extractor rejects with HTTP 415.
            headers: remoteHeaders(options.headers),
          });
          if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            throw remoteResponseError(response.status, body);
          }
          return response.json();
        }

        function normalizeRemoteFontSize(value, fallback) {
          const parsed = Number(value);
          if (!Number.isFinite(parsed)) return fallback;
          return Math.min(
            REMOTE_FONT_SIZE_MAX,
            Math.max(REMOTE_FONT_SIZE_MIN, Math.floor(parsed)),
          );
        }

        function updateRemoteDisplaySettingsControls(message = null, error = false) {
          const editable =
            Boolean(leaseId) &&
            Boolean(remoteDisplaySettings?.revision) &&
            !remoteDisplaySettingsLoading &&
            !remoteDisplaySettingsPending;
          remoteTerminalFontSizeInput.disabled = !editable;
          remoteComposerFontSizeInput.disabled = !editable;
          remoteTouchScrollSensitivityInput.disabled = !editable;
          remoteTwoFingerScrollSensitivityInput.disabled = !editable;
          remoteDisplaySettingsStatus.textContent =
            message ||
            (leaseId
              ? remoteDisplaySettingsLoading
                ? "Loading PC settings..."
                : "Stored on this PC."
              : "Connect to edit PC settings.");
          remoteDisplaySettingsStatus.classList.toggle("error", error);
        }

        function applyRemoteDisplaySettings(settings) {
          const normalized = {
            terminalFontSize: normalizeRemoteFontSize(settings?.terminalFontSize, 14),
            composerFontSize: normalizeRemoteFontSize(settings?.composerFontSize, 16),
            touchScrollSensitivity: normalizeScrollSensitivity(
              settings?.touchScrollSensitivity,
              defaultAppearance.touchScrollSensitivity,
            ),
            twoFingerScrollSensitivity: normalizeScrollSensitivity(
              settings?.twoFingerScrollSensitivity,
              defaultAppearance.twoFingerScrollSensitivity,
            ),
            revision: typeof settings?.revision === "string" ? settings.revision : "",
          };
          remoteDisplaySettings = normalized;
          remoteTerminalFontSizeInput.value = String(normalized.terminalFontSize);
          remoteComposerFontSizeInput.value = String(normalized.composerFontSize);
          remoteTouchScrollSensitivityInput.value = String(
            normalized.touchScrollSensitivity,
          );
          remoteTwoFingerScrollSensitivityInput.value = String(
            normalized.twoFingerScrollSensitivity,
          );
          document.documentElement.style.setProperty(
            "--remote-composer-font-size",
            `${normalized.composerFontSize}px`,
          );
          for (const info of terminalInfoById.values()) {
            if (info.appearance) {
              info.appearance = {
                ...info.appearance,
                fontSize: normalized.terminalFontSize,
                touchScrollSensitivity: normalized.touchScrollSensitivity,
                twoFingerScrollSensitivity: normalized.twoFingerScrollSensitivity,
              };
            }
          }
          const appearance = activeTerminalId && terminalInfoById.get(activeTerminalId)?.appearance
            ? terminalInfoById.get(activeTerminalId).appearance
            : {
                ...defaultAppearance,
                fontSize: normalized.terminalFontSize,
                touchScrollSensitivity: normalized.touchScrollSensitivity,
                twoFingerScrollSensitivity: normalized.twoFingerScrollSensitivity,
              };
          applyTerminalAppearance(appearance);
          // The drag multipliers live in module state, not the xterm option
          // bundle, so adopt them here for immediate effect on the open surface.
          adoptTouchScrollSensitivity(appearance);
          scheduleTerminalFit();
        }

        async function loadRemoteDisplaySettings({ reportErrors = true } = {}) {
          // A same-document save owns the newest value until it settles. A
          // drawer re-entry while PUT is in flight must not start a GET that
          // can return the pre-save snapshot, supersede the PUT revision, and
          // leave the controls permanently pending.
          if (remoteDisplaySettingsPending) return;
          const revision = ++remoteDisplaySettingsRevision;
          remoteDisplaySettingsLoading = true;
          updateRemoteDisplaySettingsControls();
          let message = null;
          let failed = false;
          try {
            const settings = await remoteFetch("/remote/v1/display-settings");
            if (revision !== remoteDisplaySettingsRevision) return;
            applyRemoteDisplaySettings(settings);
          } catch (error) {
            if (revision !== remoteDisplaySettingsRevision) return;
            if (reportErrors) {
              message = error.message || String(error);
              failed = true;
            }
          } finally {
            if (revision === remoteDisplaySettingsRevision) {
              remoteDisplaySettingsLoading = false;
              updateRemoteDisplaySettingsControls(message, failed);
            }
          }
        }

        async function saveRemoteDisplaySettings() {
          const selectedLeaseId = leaseId;
          const expectedRevision = remoteDisplaySettings?.revision;
          if (!selectedLeaseId || !expectedRevision || remoteDisplaySettingsPending) return;
          const revision = ++remoteDisplaySettingsRevision;
          const terminalFontSize = normalizeRemoteFontSize(
            remoteTerminalFontSizeInput.value,
            remoteDisplaySettings?.terminalFontSize || 14,
          );
          const composerFontSize = normalizeRemoteFontSize(
            remoteComposerFontSizeInput.value,
            remoteDisplaySettings?.composerFontSize || 16,
          );
          const touchScrollSensitivityValue = normalizeScrollSensitivity(
            remoteTouchScrollSensitivityInput.value,
            remoteDisplaySettings?.touchScrollSensitivity ??
              defaultAppearance.touchScrollSensitivity,
          );
          const twoFingerScrollSensitivityValue = normalizeScrollSensitivity(
            remoteTwoFingerScrollSensitivityInput.value,
            remoteDisplaySettings?.twoFingerScrollSensitivity ??
              defaultAppearance.twoFingerScrollSensitivity,
          );
          remoteDisplaySettingsPending = true;
          updateRemoteDisplaySettingsControls("Saving...");
          let reloadAfterConflict = false;
          try {
            const settings = await remoteFetch("/remote/v1/display-settings", {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                leaseId: selectedLeaseId,
                expectedRevision,
                terminalFontSize,
                composerFontSize,
                touchScrollSensitivity: touchScrollSensitivityValue,
                twoFingerScrollSensitivity: twoFingerScrollSensitivityValue,
              }),
            });
            if (revision !== remoteDisplaySettingsRevision || leaseId !== selectedLeaseId) return;
            applyRemoteDisplaySettings(settings);
            updateRemoteDisplaySettingsControls("Saved on this PC.");
          } catch (error) {
            if (revision !== remoteDisplaySettingsRevision) return;
            if (error?.status === 409) {
              reloadAfterConflict = true;
            } else {
              updateRemoteDisplaySettingsControls(error.message || String(error), true);
            }
          } finally {
            if (revision === remoteDisplaySettingsRevision) {
              remoteDisplaySettingsPending = false;
              if (leaseId !== selectedLeaseId) {
                updateRemoteDisplaySettingsControls();
                if (leaseId) {
                  loadRemoteDisplaySettings({ reportErrors: false }).catch(() => {});
                }
              } else if (reloadAfterConflict) {
                updateRemoteDisplaySettingsControls("PC settings changed. Reloading...");
                loadRemoteDisplaySettings().catch(() => {});
              } else {
                updateRemoteDisplaySettingsControls(
                  remoteDisplaySettingsStatus.textContent,
                  remoteDisplaySettingsStatus.classList.contains("error"),
                );
              }
            }
          }
        }

        function renderPcUpdateStatus(message = null, isError = false) {
          const status = pcUpdateStatus;
          const availableVersion = status?.availableVersion || null;
          const operation = status?.operation || "idle";
          const busy = operation === "checking" || operation === "downloading" || operation === "installing";
          const total = Number(status?.totalBytes) || 0;
          const downloaded = Number(status?.downloadedBytes) || 0;
          const percent = total > 0 ? Math.min(100, Math.floor((downloaded / total) * 100)) : null;
          // The channel is the PC's setting; Remote only reports it (ADR-0190).
          const betaChannelNote = status?.channel === "beta" ? " Following the beta channel." : "";
          const defaultMessage = !status
            ? "Update status unavailable."
            : !status.enabled
              ? `Development build ${status.currentVersion}; self-update is disabled.`
              : operation === "checking"
                ? "Checking GitHub Releases..."
                : operation === "downloading"
                  ? `Downloading ${availableVersion || "update"}${percent === null ? "..." : ` (${percent}%)`}`
                  : operation === "installing"
                    ? "Installing update; the PC will restart..."
                    : availableVersion
                      ? `Laymux ${availableVersion} is available (current ${status.currentVersion}).${betaChannelNote}`
                      : `Laymux ${status.currentVersion} is up to date.${betaChannelNote}`;
          pcUpdateStatusElement.textContent = message || status?.lastError || defaultMessage;
          pcUpdateStatusElement.classList.toggle("error", isError || Boolean(status?.lastError));
          drawerSettingsButton.classList.toggle("update-available", Boolean(availableVersion));
          checkPcUpdateButton.disabled = busy || pcUpdateRequestInFlight || !status?.enabled;
          installPcUpdateButton.hidden = !availableVersion;
          installPcUpdateButton.disabled = busy || pcUpdateRequestInFlight || !leaseId;
          pcUpdateNotes.textContent = status?.notes || "";
          pcUpdateNotes.hidden = !status?.notes;
        }

        async function loadPcUpdateStatus({ check = false } = {}) {
          if (pcUpdateRequestInFlight) return;
          pcUpdateRequestInFlight = true;
          renderPcUpdateStatus(check ? "Checking GitHub Releases..." : null);
          try {
            pcUpdateStatus = await remoteFetch(check ? "/remote/v1/update/check" : "/remote/v1/update", {
              ...(check ? { method: "POST" } : {}),
            });
            renderPcUpdateStatus();
          } catch (error) {
            renderPcUpdateStatus(error.message || String(error), true);
          } finally {
            pcUpdateRequestInFlight = false;
            renderPcUpdateStatus(
              pcUpdateStatusElement.textContent,
              pcUpdateStatusElement.classList.contains("error"),
            );
            schedulePcUpdatePoll();
          }
        }

        async function installPcUpdate() {
          const selectedLeaseId = leaseId;
          if (!selectedLeaseId || !pcUpdateStatus?.availableVersion || pcUpdateRequestInFlight) return;
          if (!window.confirm(`Install Laymux ${pcUpdateStatus.availableVersion} and restart the PC now?`)) return;
          pcUpdateRequestInFlight = true;
          renderPcUpdateStatus("Starting signed update...");
          try {
            pcUpdateStatus = await remoteFetch("/remote/v1/update/install", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ leaseId: selectedLeaseId }),
            });
            renderPcUpdateStatus();
          } catch (error) {
            // The installer can sever this request while the PC is restarting.
            // Keep polling: a surviving page will reconnect to the new process.
            renderPcUpdateStatus(error.message || String(error), true);
          } finally {
            pcUpdateRequestInFlight = false;
            schedulePcUpdatePoll(1000);
          }
        }

        function schedulePcUpdatePoll(delay = null) {
          if (pcUpdatePollTimer) clearTimeout(pcUpdatePollTimer);
          const busy = pcUpdateStatus && ["checking", "downloading", "installing"].includes(pcUpdateStatus.operation);
          pcUpdatePollTimer = setTimeout(() => {
            pcUpdatePollTimer = null;
            if (document.visibilityState === "visible") {
              loadPcUpdateStatus().catch(() => {});
            } else {
              schedulePcUpdatePoll();
            }
          }, delay ?? (busy ? 1000 : 60000));
        }

        function clearActiveGithubRepo() {
          githubRepoRequestRevision += 1;
          githubRepoAbortController?.abort();
          githubRepoAbortController = null;
          activeGithubRepoBase = null;
        }

        function loadActiveGithubRepo(terminalId, cwd) {
          clearActiveGithubRepo();
          if (!terminalId || typeof cwd !== "string" || !cwd) return;
          const revision = githubRepoRequestRevision;
          const controller = typeof AbortController === "function" ? new AbortController() : null;
          githubRepoAbortController = controller;
          remoteFetch(
            `/remote/v1/terminals/${encodeURIComponent(terminalId)}/github-repo`,
            { signal: controller?.signal },
          )
            .then((data) => {
              if (
                revision !== githubRepoRequestRevision ||
                activeTerminalId !== terminalId ||
                terminalInfoById.get(terminalId)?.cwd !== cwd ||
                data.cwd !== cwd
              ) return;
              activeGithubRepoBase = normalizeRemoteGithubRepoBase(data.repoBase);
            })
            .catch(() => {
              // Missing/non-GitHub repos and transient lookup failures all use
              // the natural off state: no provider links.
            })
            .finally(() => {
              if (githubRepoAbortController === controller) {
                githubRepoAbortController = null;
              }
            });
        }

        function renderFileViewerState(message = null, isError = false) {
          const connected = Boolean(leaseId && fileViewerToken);
          // The header folder button is an entry point, not an action with a
          // recoverable disabled state: without a lease it means nothing, so it
          // is hidden rather than disabled (ADR-0192, ADR-0197).
          fileExplorerHeaderButton.hidden = !connected;
          fileViewerSection.classList.toggle("locked", !connected);
          fileViewerPathInput.disabled = !connected;
          pullHostFileViewerPathButton.disabled = !connected || fileViewerStatusInFlight;
          pullHostFileViewerPathButton.textContent = fileViewerStatusInFlight
            ? "Loading..."
            : "From host";
          openFileViewerButton.disabled = !connected || !fileViewerPathInput.value.trim();
          const text = message || (connected
            ? "Enter a path or use From host."
            : "Connect to open a host file.");
          fileViewerStatusElement.textContent = text;
          fileViewerStatusElement.title = "";
          fileViewerStatusElement.classList.toggle("error", isError);
        }

        async function pullHostFileViewerPath() {
          if (!leaseId || !fileViewerToken) return;
          if (fileViewerStatusInFlight) return;
          fileViewerStatusInFlight = true;
          const statusRequestRevision = ++fileViewerStatusRequestRevision;
          const statusLeaseId = leaseId;
          const statusFileViewerToken = fileViewerToken;
          const statusPathRevision = fileViewerPathRevision;
          let message = null;
          let isError = false;
          renderFileViewerState();
          try {
            const data = await remoteFetch("/remote/v1/file-viewer/status", {
              headers: {
                "x-laymux-remote-lease": statusLeaseId,
                "x-laymux-remote-file-viewer": statusFileViewerToken,
              },
            });
            if (leaseId !== statusLeaseId || fileViewerToken !== statusFileViewerToken) return;
            if (fileViewerPathRevision !== statusPathRevision) {
              message = "Host path was not applied because the input changed.";
              return;
            }
            if (data.open !== true || typeof data.path !== "string" || !data.path) {
              message = "No file is open in the host viewer.";
              return;
            }
            fileViewerPathInput.value = data.path;
            fileViewerPathRevision += 1;
            message = "Host viewer path loaded.";
          } catch (error) {
            message = error instanceof Error ? error.message : String(error);
            isError = true;
          } finally {
            if (fileViewerStatusRequestRevision === statusRequestRevision) {
              fileViewerStatusInFlight = false;
              renderFileViewerState(message, isError);
            }
          }
        }

        // The viewer renders in this document (ADR-0184). The render API is the
        // same one the separate tab called; what goes away is `window.open` and
        // the postMessage handshake that carried credentials to a second
        // document — the Android wrapper has no second window at all, and an
        // installed PWA loses the opener relationship the handshake needed.
        function fileViewerZoomStep(zoom, direction) {
          const next = zoom + direction * FILE_VIEWER_ZOOM_STEP;
          return Math.min(
            FILE_VIEWER_ZOOM_MAX,
            Math.max(FILE_VIEWER_ZOOM_MIN, Math.round(next * 100) / 100),
          );
        }

        function applyFileViewerZoom() {
          const percent = Math.round(fileViewerZoom * 100);
          fileViewerZoomLevelElement.textContent = `${percent}%`;
          if (fileViewerKind === "image") {
            // Real width, not a transform: a scaled element keeps its original
            // box, so the scroll container would never let the user reach the
            // parts a zoom just pushed off screen.
            fileViewerBodyElement.style.setProperty(
              "--file-viewer-image-width",
              `${percent}%`,
            );
            fileViewerBodyElement.style.setProperty(
              "--file-viewer-image-max-width",
              fileViewerZoom > 1 ? "none" : "100%",
            );
            return;
          }
          if (fileViewerKind === "text") {
            fileViewerBodyElement.style.setProperty(
              "--file-viewer-text-size",
              `${(FILE_VIEWER_TEXT_BASE_PX * fileViewerZoom).toFixed(2)}px`,
            );
          }
        }

        function resetFileViewerZoom() {
          fileViewerZoom = 1;
          fileViewerBodyElement.style.removeProperty("--file-viewer-image-width");
          fileViewerBodyElement.style.removeProperty("--file-viewer-image-max-width");
          fileViewerBodyElement.style.removeProperty("--file-viewer-text-size");
          fileViewerZoomLevelElement.textContent = "100%";
        }

        function adjustFileViewerZoom(direction) {
          if (!fileViewerZoomable()) return;
          fileViewerZoom = fileViewerZoomStep(fileViewerZoom, direction);
          applyFileViewerZoom();
        }

        function scaleFileViewerZoom(ratio) {
          if (!fileViewerZoomable()) return;
          fileViewerZoom = Math.min(
            FILE_VIEWER_ZOOM_MAX,
            Math.max(FILE_VIEWER_ZOOM_MIN, fileViewerZoom * ratio),
          );
          applyFileViewerZoom();
        }

        function fileViewerZoomable() {
          return fileViewerKind === "image" || fileViewerKind === "text";
        }

        function hideFileViewerContent() {
          fileViewerTextElement.hidden = true;
          fileViewerImageElement.hidden = true;
          fileViewerPreviewElement.hidden = true;
          fileViewerBinaryElement.hidden = true;
          fileViewerDirectoryElement.hidden = true;
          fileViewerImageElement.removeAttribute("src");
          fileViewerPreviewElement.removeAttribute("srcdoc");
          fileViewerTextElement.textContent = "";
          fileViewerBinaryElement.textContent = "";
          fileViewerDirectoryElement.textContent = "";
        }

        function setFileViewerMessage(message, isError = false) {
          fileViewerMessageElement.textContent = message;
          fileViewerMessageElement.classList.toggle("error", isError);
          fileViewerMessageElement.hidden = false;
        }

        function formatFileViewerBytes(value) {
          if (!Number.isFinite(value) || value < 0) return "Unknown size";
          if (value < 1024) return `${value} B`;
          const units = ["KiB", "MiB", "GiB"];
          let size = value / 1024;
          let unit = units[0];
          for (let index = 1; index < units.length && size >= 1024; index += 1) {
            size /= 1024;
            unit = units[index];
          }
          return `${size.toFixed(size >= 10 ? 1 : 2)} ${unit}`;
        }

        function renderFileViewerPayload(payload) {
          hideFileViewerContent();
          fileViewerMessageElement.hidden = true;
          fileViewerKind = null;
          resetFileViewerZoom();

          if (payload.kind === "text" && payload.previewDocument) {
            // `sandbox=""` is the boundary: no allow-scripts, no
            // allow-same-origin, so a sanitizer miss still cannot run.
            fileViewerPreviewElement.setAttribute("sandbox", "");
            fileViewerPreviewElement.srcdoc = payload.previewDocument;
            fileViewerPreviewElement.hidden = false;
            if (payload.truncated) {
              setFileViewerMessage("Preview truncated at the Remote viewer limit.");
            }
          } else if (payload.kind === "text") {
            fileViewerKind = "text";
            fileViewerTextElement.textContent = payload.content || "";
            fileViewerTextElement.hidden = false;
            if (payload.truncated) {
              setFileViewerMessage("Preview truncated at the Remote viewer limit.");
            }
          } else if (
            payload.kind === "image" &&
            /^data:image\//i.test(payload.dataUrl || "")
          ) {
            fileViewerKind = "image";
            fileViewerImageElement.src = payload.dataUrl;
            fileViewerImageElement.hidden = false;
          } else if (payload.kind === "binary") {
            fileViewerBinaryElement.textContent = `Binary or unsupported file · ${formatFileViewerBytes(payload.size)}`;
            fileViewerBinaryElement.hidden = false;
          } else if (payload.kind === "pdf") {
            // PDF and archive are classified by the shared desktop command, so
            // they reach Remote too. Remote deliberately does not render them
            // (ADR-0109): say what the file is instead of failing.
            fileViewerBinaryElement.textContent =
              "PDF · open this file in the desktop viewer to read it.";
            fileViewerBinaryElement.hidden = false;
          } else if (payload.kind === "archive") {
            const count = Number.isFinite(payload.totalEntries)
              ? payload.totalEntries
              : (payload.entries || []).length;
            const suffix = count === 1 ? "entry" : "entries";
            fileViewerBinaryElement.textContent = `Archive (${payload.format || "unknown"}) · ${count} ${suffix} · open this file in the desktop viewer to browse it.`;
            fileViewerBinaryElement.hidden = false;
          } else {
            throw new Error("Unsupported viewer response");
          }
          fileViewerZoomElement.hidden = !fileViewerZoomable();
        }

        function closeFileViewer() {
          fileViewerRequestRevision += 1;
          fileViewerOverlayElement.hidden = true;
          fileViewerKind = null;
          fileViewerDirectoryPath = null;
          fileViewerExplorerReturnPath = null;
          fileViewerBackButton.hidden = true;
          fileViewerPinch = null;
          hideFileViewerContent();
          resetFileViewerZoom();
          fileViewerZoomElement.hidden = true;
          fileViewerTitleElement.textContent = "";
          fileViewerTitleElement.title = "";
          fileViewerPath = null;
          fileViewerDownloadInFlight = false;
          applyFileViewerDownloadState();
          focusCurrentInputSurface();
        }

        function openFileViewerOverlay(path, explorerReturnPath = null) {
          if (!leaseId || !fileViewerToken || !path) return;
          const requestRevision = ++fileViewerRequestRevision;
          const requestLeaseId = leaseId;
          const requestFileViewerToken = fileViewerToken;
          hideFileViewerContent();
          resetFileViewerZoom();
          fileViewerKind = null;
          fileViewerZoomElement.hidden = true;
          fileViewerTitleElement.textContent = path;
          fileViewerTitleElement.title = path;
          fileViewerPath = path;
          // Back exists only for a file reached through the explorer; every
          // other entry point (drawer path, path-link) has no folder to return
          // to (ADR-0197).
          fileViewerDirectoryPath = null;
          fileViewerExplorerReturnPath = explorerReturnPath;
          fileViewerBackButton.hidden = !explorerReturnPath;
          fileViewerDownloadInFlight = false;
          applyFileViewerDownloadState();
          fileViewerOverlayElement.hidden = false;
          setFileViewerMessage("Loading file…");
          remoteFetch("/remote/v1/file-viewer/render", {
            method: "POST",
            headers: {
              "x-laymux-remote-lease": requestLeaseId,
              "x-laymux-remote-file-viewer": requestFileViewerToken,
            },
            body: JSON.stringify({ source: "path", path }),
          })
            .then((payload) => {
              if (
                requestRevision !== fileViewerRequestRevision ||
                leaseId !== requestLeaseId ||
                fileViewerToken !== requestFileViewerToken
              ) {
                return;
              }
              renderFileViewerPayload(payload);
            })
            .catch((error) => {
              if (requestRevision !== fileViewerRequestRevision) return;
              hideFileViewerContent();
              setFileViewerMessage(
                error instanceof Error ? error.message : String(error),
                true,
              );
            });
        }

        // Explorer mode (ADR-0197): the same overlay lists a host directory.
        // `request` is `{ path }` or `{ source: "terminalCwd", terminalId }` —
        // the host bridge resolves the terminal's cwd (home as fallback) and
        // completes every entry's absolute path, so this surface owns no path
        // syntax at all.
        function openFileExplorerOverlay(request) {
          if (!leaseId || !fileViewerToken || !request) return;
          const requestRevision = ++fileViewerRequestRevision;
          const requestLeaseId = leaseId;
          const requestFileViewerToken = fileViewerToken;
          hideFileViewerContent();
          resetFileViewerZoom();
          fileViewerKind = null;
          fileViewerZoomElement.hidden = true;
          fileViewerTitleElement.textContent = request.path || "Host files";
          fileViewerTitleElement.title = request.path || "";
          fileViewerPath = null;
          fileViewerDirectoryPath = null;
          fileViewerExplorerReturnPath = null;
          fileViewerBackButton.hidden = true;
          fileViewerDownloadInFlight = false;
          applyFileViewerDownloadState();
          fileViewerOverlayElement.hidden = false;
          setFileViewerMessage("Loading directory…");
          remoteFetch("/remote/v1/file-viewer/list", {
            method: "POST",
            headers: {
              "x-laymux-remote-lease": requestLeaseId,
              "x-laymux-remote-file-viewer": requestFileViewerToken,
            },
            body: JSON.stringify(request),
          })
            .then((payload) => {
              if (
                requestRevision !== fileViewerRequestRevision ||
                leaseId !== requestLeaseId ||
                fileViewerToken !== requestFileViewerToken
              ) {
                return;
              }
              renderDirectoryListing(payload);
            })
            .catch((error) => {
              if (requestRevision !== fileViewerRequestRevision) return;
              hideFileViewerContent();
              setFileViewerMessage(
                error instanceof Error ? error.message : String(error),
                true,
              );
            });
        }

        function renderDirectoryListing(payload) {
          if (!payload || typeof payload.path !== "string" || !Array.isArray(payload.entries)) {
            throw new Error("Unsupported directory response");
          }
          hideFileViewerContent();
          fileViewerMessageElement.hidden = true;
          fileViewerKind = null;
          resetFileViewerZoom();
          fileViewerZoomElement.hidden = true;
          fileViewerDirectoryPath = payload.path;
          fileViewerTitleElement.textContent = payload.path;
          fileViewerTitleElement.title = payload.path;
          if (typeof payload.parent === "string" && payload.parent) {
            appendDirectoryRow({ name: "..", path: payload.parent, isDirectory: true }, true);
          }
          let entryRows = 0;
          for (const entry of payload.entries) {
            if (!entry || typeof entry.name !== "string" || typeof entry.path !== "string") continue;
            appendDirectoryRow(entry, false);
            entryRows += 1;
          }
          if (!entryRows) {
            const empty = document.createElement("div");
            empty.className = "file-viewer-directory-empty";
            empty.textContent = "Empty directory";
            fileViewerDirectoryElement.appendChild(empty);
          }
          fileViewerDirectoryElement.hidden = false;
          if (payload.truncated) {
            setFileViewerMessage("Listing truncated at the Remote entry limit.");
          }
        }

        function appendDirectoryRow(entry, isParent) {
          const row = document.createElement("button");
          row.type = "button";
          row.className = "file-viewer-directory-row";
          const icon = document.createElement("span");
          icon.className = "file-viewer-directory-icon";
          icon.setAttribute("aria-hidden", "true");
          icon.innerHTML = entry.isDirectory
            ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>'
            : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>';
          const name = document.createElement("span");
          name.className = "file-viewer-directory-name";
          name.textContent = entry.name;
          row.appendChild(icon);
          row.appendChild(name);
          if (!entry.isDirectory && Number.isFinite(entry.size)) {
            const size = document.createElement("span");
            size.className = "file-viewer-directory-size";
            size.textContent = formatFileViewerBytes(entry.size);
            row.appendChild(size);
          }
          if (isParent) row.classList.add("parent");
          row.addEventListener("click", () => {
            if (entry.isDirectory) {
              openFileExplorerOverlay({ path: entry.path });
            } else {
              openFileViewerOverlay(entry.path, fileViewerDirectoryPath);
            }
          });
          fileViewerDirectoryElement.appendChild(row);
        }

        // Download goes to its own endpoint, never to whatever the overlay is
        // showing (ADR-0185): `render` replaces an HTML/Markdown source with a
        // sanitized preview document, and returns no bytes at all for binary or
        // archive kinds. A save has to be the file the host holds.
        function base64ToBytes(base64) {
          const binary = atob(base64);
          const bytes = new Uint8Array(binary.length);
          for (let index = 0; index < binary.length; index += 1) {
            bytes[index] = binary.charCodeAt(index);
          }
          return bytes;
        }

        function saveDownloadInBrowser(payload) {
          const blob = new Blob([base64ToBytes(payload.base64)], {
            type: payload.mediaType || "application/octet-stream",
          });
          const url = URL.createObjectURL(blob);
          const anchor = document.createElement("a");
          anchor.href = url;
          anchor.download = payload.name;
          anchor.rel = "noopener";
          document.body.appendChild(anchor);
          anchor.click();
          anchor.remove();
          // Revoking synchronously can cancel the save the click just started.
          setTimeout(() => URL.revokeObjectURL(url), 60000);
        }

        function downloadCurrentFileViewerFile() {
          const path = fileViewerPath;
          if (!leaseId || !fileViewerToken || !path || fileViewerDownloadInFlight) return;
          // The wrapper WebView has no download handler of its own, so a browser
          // save silently does nothing there. Refuse rather than pretend.
          const nativeSave =
            androidE2eMode && typeof window.LaymuxNative?.saveRemoteFile === "function"
              ? window.LaymuxNative.saveRemoteFile
              : null;
          if (androidE2eMode && !nativeSave) {
            setFileViewerMessage("This app version cannot save files. Update the app.", true);
            return;
          }
          const requestRevision = fileViewerRequestRevision;
          const requestLeaseId = leaseId;
          const requestFileViewerToken = fileViewerToken;
          fileViewerDownloadInFlight = true;
          applyFileViewerDownloadState();
          remoteFetch("/remote/v1/file-viewer/download", {
            method: "POST",
            headers: {
              "x-laymux-remote-lease": requestLeaseId,
              "x-laymux-remote-file-viewer": requestFileViewerToken,
            },
            body: JSON.stringify({ path }),
          })
            .then((payload) => {
              if (
                requestRevision !== fileViewerRequestRevision ||
                leaseId !== requestLeaseId ||
                fileViewerToken !== requestFileViewerToken
              ) {
                return;
              }
              if (!payload || typeof payload.base64 !== "string" || typeof payload.name !== "string") {
                throw new Error("Download response was not usable");
              }
              if (nativeSave) {
                nativeSave(payload.name, payload.mediaType || "", payload.base64);
                setFileViewerMessage(`Saved ${payload.name} to Downloads.`);
                return;
              }
              saveDownloadInBrowser(payload);
            })
            .catch((error) => {
              if (requestRevision !== fileViewerRequestRevision) return;
              setFileViewerMessage(
                error instanceof Error ? error.message : String(error),
                true,
              );
            })
            .finally(() => {
              if (requestRevision !== fileViewerRequestRevision) return;
              fileViewerDownloadInFlight = false;
              applyFileViewerDownloadState();
            });
        }

        function applyFileViewerDownloadState() {
          fileViewerDownloadButton.disabled =
            fileViewerDownloadInFlight || !fileViewerPath || !leaseId || !fileViewerToken;
          fileViewerDownloadButton.textContent = fileViewerDownloadInFlight
            ? "Saving..."
            : "Download";
        }

        function fileViewerPinchDistance(pointers) {
          const [first, second] = pointers;
          return Math.hypot(first.x - second.x, first.y - second.y);
        }

        function handleFileViewerPointerDown(event) {
          if (!fileViewerZoomable()) return;
          fileViewerPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
          if (fileViewerPointers.size === 2) {
            fileViewerPinch = {
              distance: fileViewerPinchDistance([...fileViewerPointers.values()]),
              zoom: fileViewerZoom,
            };
          }
        }

        function handleFileViewerPointerMove(event) {
          if (!fileViewerPointers.has(event.pointerId)) return;
          fileViewerPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
          if (fileViewerPointers.size !== 2 || !fileViewerPinch) return;
          const distance = fileViewerPinchDistance([...fileViewerPointers.values()]);
          if (fileViewerPinch.distance <= 0) return;
          event.preventDefault();
          fileViewerZoom = Math.min(
            FILE_VIEWER_ZOOM_MAX,
            Math.max(
              FILE_VIEWER_ZOOM_MIN,
              fileViewerPinch.zoom * (distance / fileViewerPinch.distance),
            ),
          );
          applyFileViewerZoom();
        }

        function handleFileViewerPointerRelease(event) {
          fileViewerPointers.delete(event.pointerId);
          if (fileViewerPointers.size < 2) fileViewerPinch = null;
        }

        function handleFileViewerWheel(event) {
          if (!event.ctrlKey || !fileViewerZoomable()) return;
          // Ctrl+Wheel is page zoom by default, so this must claim the event to
          // zoom the file instead — same contract as the desktop viewer.
          event.preventDefault();
          scaleFileViewerZoom(event.deltaY < 0 ? 1 + FILE_VIEWER_ZOOM_STEP : 1 / (1 + FILE_VIEWER_ZOOM_STEP));
        }

        function pathLinkEntries() {
          return PATH_LINK_SCOPES.flatMap((scope) => pathLinkScopes[scope]);
        }

        function updatePathLinkClickableState() {
          terminalHost.classList.toggle(
            "remote-path-link-clickable",
            pathLinkEntries().length > 0
          );
        }

        function disposePathLinkScope(scope) {
          for (const entry of pathLinkScopes[scope]) {
            try {
              entry.decoration?.dispose?.();
            } catch (_) {}
            try {
              entry.marker?.dispose?.();
            } catch (_) {}
          }
          pathLinkScopes[scope] = [];
        }

        function abortPathLinkScope(scope) {
          pathLinkRevisions[scope] += 1;
          const controller = pathLinkAborts[scope];
          if (controller) {
            controller.abort();
            pathLinkAborts[scope] = null;
          }
        }

        // Drop one trigger's underlines and in-flight request, leaving the other
        // triggers alone (ADR-0188 scope ownership).
        function clearPathLinkScope(scope) {
          abortPathLinkScope(scope);
          disposePathLinkScope(scope);
          // A press in flight keeps its own validated path, terminal and lease.
          // Output arriving mid-tap must not swallow the tap the user already
          // started on an underline; the pointerup check still gates it.
          updatePathLinkClickableState();
        }

        function clearPathLinkVisuals() {
          for (const scope of PATH_LINK_SCOPES) disposePathLinkScope(scope);
          pathLinkPress = null;
          terminalHost.classList.remove("remote-path-link-clickable");
        }

        // Full reset: terminal/lease switch, disconnect, xterm reset — every
        // scope's coordinates become meaningless at once.
        function clearPathLinkSelection() {
          for (const scope of PATH_LINK_SCOPES) abortPathLinkScope(scope);
          if (pathLinkEvaluationTimer !== null) {
            clearTimeout(pathLinkEvaluationTimer);
            pathLinkEvaluationTimer = null;
          }
          if (pathLinkIdleScanTimer !== null) {
            clearTimeout(pathLinkIdleScanTimer);
            pathLinkIdleScanTimer = null;
          }
          pathLinkLastScreenSignature = null;
          clearPathLinkVisuals();
        }

        function schedulePathLinkSelectionEvaluation(delay = PATH_LINK_SELECTION_DEBOUNCE_MS) {
          // A new selection invalidates the selection underlines and the point
          // underline (never two underlines over one spot), but not the idle
          // screen scan's result.
          clearPathLinkScope("selection");
          clearPathLinkScope("point");
          if (pathLinkEvaluationTimer !== null) {
            clearTimeout(pathLinkEvaluationTimer);
            pathLinkEvaluationTimer = null;
          }
          if (!terminal?.hasSelection?.()) return;
          pathLinkEvaluationTimer = setTimeout(() => {
            pathLinkEvaluationTimer = null;
            evaluatePathLinkSelection();
          }, delay);
        }

        // The screen scan owns "output stopped" (ADR-0188): every write pushes
        // the timer out and retires the previous screen underlines, so a scan
        // only happens on a screen that stayed still.
        function schedulePathLinkIdleScan() {
          clearPathLinkScope("screen");
          if (pathLinkIdleScanTimer !== null) clearTimeout(pathLinkIdleScanTimer);
          pathLinkIdleScanTimer = setTimeout(() => {
            pathLinkIdleScanTimer = null;
            evaluatePathLinkScreen();
          }, REMOTE_PATH_LINK_IDLE_SCAN_DELAY_MS);
        }

        function mapRemotePathLinkRange(position, match) {
          const selectionBaseCol0 = match.lineIndex === 0 ? position.start.x : 0;
          const bufferLine = position.start.y + match.lineIndex + 1;
          const line = terminal?.buffer?.active?.getLine?.(bufferLine - 1);
          if (line) {
            const { text, columns, endColumns } = reconstructRemoteLinkLine(line);
            const selectionStartCell = selectionBaseCol0 + 1;
            const selectionStartOffset = endColumns.findIndex((column) => column >= selectionStartCell);
            if (selectionStartOffset >= 0) {
              const startOffset = selectionStartOffset + match.startIndex;
              const endOffset = selectionStartOffset + match.endIndex - 1;
              if (
                text.slice(startOffset, endOffset + 1) === match.token &&
                columns[startOffset] !== undefined &&
                endColumns[endOffset] !== undefined
              ) {
                return {
                  bufferLine,
                  startCol: columns[startOffset],
                  endCol: endColumns[endOffset],
                };
              }
            }
          }
          return {
            bufferLine,
            startCol: selectionBaseCol0 + match.startIndex + 1,
            endCol: selectionBaseCol0 + match.endIndex,
          };
        }

        // Line-scoped modes (`point`, `screen`) carry whole-line offsets, so the
        // token must still sit on those cells. No string fallback here: if the
        // line moved under the request, drawing anything would mislabel it.
        function mapRemoteLinePathRange(bufferLine, match) {
          const line = terminal?.buffer?.active?.getLine?.(bufferLine - 1);
          if (!line) return null;
          const { text, columns, endColumns } = reconstructRemoteLinkLine(line);
          const startOffset = match.startIndex;
          const endOffset = match.endIndex - 1;
          if (
            text.slice(startOffset, endOffset + 1) !== match.token ||
            columns[startOffset] === undefined ||
            endColumns[endOffset] === undefined
          ) {
            return null;
          }
          return { bufferLine, startCol: columns[startOffset], endCol: endColumns[endOffset] };
        }

        function setVerifiedPathLinks(scope, selections) {
          disposePathLinkScope(scope);
          const term = terminal;
          if (!term) {
            clearPathLinkVisuals();
            return;
          }

          for (const selection of selections) {
            let marker = null;
            try {
              const buffer = term.buffer.active;
              const cursorAbsoluteLine = (buffer.baseY || 0) + (buffer.cursorY || 0);
              const targetAbsoluteLine = selection.bufferLine - 1;
              const offset = Math.trunc(targetAbsoluteLine - cursorAbsoluteLine);
              if (!Number.isFinite(offset)) throw new Error("invalid marker offset");
              marker = term.registerMarker(offset);
              if (!marker) throw new Error("selection line is outside the xterm buffer");
              const decoration = term.registerDecoration({
                marker,
                x: Math.max(0, selection.startCol - 1),
                width: Math.max(1, selection.endCol - selection.startCol + 1),
              });
              if (!decoration) throw new Error("xterm decoration is unavailable");
              pathLinkScopes[scope].push({ selection, marker, decoration });
              const styleDecoration = (element) => {
                element.classList.add("remote-path-link-decoration");
              };
              if (decoration.element) styleDecoration(decoration.element);
              decoration.onRender(styleDecoration);
            } catch (error) {
              try {
                marker?.dispose?.();
              } catch (_) {}
              console.warn("[remotePathLink] decoration failed:", error);
            }
          }
          updatePathLinkClickableState();
        }

        function evaluatePathLinkSelection() {
          if (pathLinkEvaluationTimer !== null) {
            clearTimeout(pathLinkEvaluationTimer);
            pathLinkEvaluationTimer = null;
          }
          const term = terminal;
          const requestTerminalId = activeTerminalId;
          const requestLeaseId = leaseId;
          const requestFileViewerToken = fileViewerToken;
          abortPathLinkScope("selection");
          const revision = pathLinkRevisions.selection;
          disposePathLinkScope("selection");
          updatePathLinkClickableState();
          if (!term || !requestTerminalId || !requestLeaseId || !requestFileViewerToken) return;

          const selection = term.getSelection();
          if (!selection || selection.length > REMOTE_PATH_LINK_MAX_SELECTION_LENGTH) return;
          if (!term.getSelectionPosition?.()) return;
          const selectionLines = selection.split(/\r?\n/);
          if (selectionLines.length > REMOTE_PATH_LINK_MAX_SELECTION_LINES) return;
          const abortController = typeof AbortController === "function" ? new AbortController() : null;
          pathLinkAborts.selection = abortController;

          remoteFetch("/remote/v1/file-viewer/path-link", {
            method: "POST",
            signal: abortController?.signal,
            headers: {
              "x-laymux-remote-lease": requestLeaseId,
              "x-laymux-remote-file-viewer": requestFileViewerToken,
            },
            body: JSON.stringify({
              terminalId: requestTerminalId,
              mode: "selection",
              lines: selectionLines,
            }),
          })
            .then((data) => {
              const currentPosition = term.getSelectionPosition?.();
              if (
                revision !== pathLinkRevisions.selection ||
                activeTerminalId !== requestTerminalId ||
                leaseId !== requestLeaseId ||
                fileViewerToken !== requestFileViewerToken ||
                terminal !== term ||
                term.getSelection() !== selection ||
                !currentPosition
              ) {
                return;
              }
              if (data.valid !== true || !Array.isArray(data.matches)) {
                clearPathLinkScope("selection");
                return;
              }
              if (data.matches.length === 0 || data.matches.length > REMOTE_PATH_LINK_MAX_SELECTION_MATCHES) {
                clearPathLinkScope("selection");
                return;
              }
              const matches = data.matches.filter((match) =>
                isValidPathLinkMatch(match, selectionLines)
              );
              if (matches.length === 0) {
                clearPathLinkScope("selection");
                return;
              }
              // Resize/reflow and scrollback trim can move a still-identical
              // selection while the bridge performs its filesystem stat. Use
              // the live xterm coordinates, never the pre-request snapshot.
              setVerifiedPathLinks("selection", matches.map((match) => ({
                ...mapRemotePathLinkRange(currentPosition, match),
                terminalId: requestTerminalId,
                leaseId: requestLeaseId,
                fileViewerToken: requestFileViewerToken,
                // The literal the underline covers: output can repaint the row in
                // place, and only the text tells us the link went stale.
                token: match.token,
                path: match.path,
                kind: match.kind === "directory" ? "directory" : "file",
              })));
            })
            .catch(() => {
              if (revision === pathLinkRevisions.selection) clearPathLinkScope("selection");
            })
            .finally(() => {
              if (pathLinkAborts.selection === abortController) pathLinkAborts.selection = null;
            });
        }

        function isValidPathLinkMatch(match, lines) {
          return Boolean(
            match &&
            typeof match.token === "string" &&
            match.token &&
            typeof match.path === "string" &&
            match.path &&
            Number.isSafeInteger(match.lineIndex) &&
            match.lineIndex >= 0 &&
            match.lineIndex < lines.length &&
            Number.isSafeInteger(match.startIndex) &&
            Number.isSafeInteger(match.endIndex) &&
            match.startIndex >= 0 &&
            match.endIndex > match.startIndex &&
            lines[match.lineIndex]?.slice(match.startIndex, match.endIndex) === match.token
          );
        }

        // Shared request path for the line-scoped triggers. `baseLine` is the
        // 0-based absolute buffer line that `lines[0]` was read from, so a later
        // scroll cannot shift the mapping (a scrollback trim is caught by the
        // per-match text check in `mapRemoteLinePathRange`).
        function requestLineScopedPathLinks(scope, baseLine, lines, caret, maxMatches) {
          const term = terminal;
          const requestTerminalId = activeTerminalId;
          const requestLeaseId = leaseId;
          const requestFileViewerToken = fileViewerToken;
          abortPathLinkScope(scope);
          const revision = pathLinkRevisions[scope];
          if (!term || !requestTerminalId || !requestLeaseId || !requestFileViewerToken) return;
          const body = { terminalId: requestTerminalId, mode: scope, lines };
          if (caret) body.caret = caret;
          const abortController = typeof AbortController === "function" ? new AbortController() : null;
          pathLinkAborts[scope] = abortController;

          remoteFetch("/remote/v1/file-viewer/path-link", {
            method: "POST",
            signal: abortController?.signal,
            headers: {
              "x-laymux-remote-lease": requestLeaseId,
              "x-laymux-remote-file-viewer": requestFileViewerToken,
            },
            body: JSON.stringify(body),
          })
            .then((data) => {
              if (
                revision !== pathLinkRevisions[scope] ||
                activeTerminalId !== requestTerminalId ||
                leaseId !== requestLeaseId ||
                fileViewerToken !== requestFileViewerToken ||
                terminal !== term
              ) {
                return;
              }
              if (
                data.valid !== true ||
                !Array.isArray(data.matches) ||
                data.matches.length === 0 ||
                data.matches.length > maxMatches
              ) {
                clearPathLinkScope(scope);
                return;
              }
              const selections = [];
              for (const match of data.matches) {
                if (!isValidPathLinkMatch(match, lines)) continue;
                const range = mapRemoteLinePathRange(baseLine + match.lineIndex + 1, match);
                if (!range) continue;
                selections.push({
                  ...range,
                  terminalId: requestTerminalId,
                  leaseId: requestLeaseId,
                  fileViewerToken: requestFileViewerToken,
                  // The literal the underline covers: output can repaint the row in
                  // place, and only the text tells us the link went stale.
                  token: match.token,
                  path: match.path,
                  kind: match.kind === "directory" ? "directory" : "file",
                });
              }
              if (selections.length === 0) {
                clearPathLinkScope(scope);
                return;
              }
              setVerifiedPathLinks(scope, selections);
            })
            .catch(() => {
              if (revision === pathLinkRevisions[scope]) clearPathLinkScope(scope);
            })
            .finally(() => {
              if (pathLinkAborts[scope] === abortController) pathLinkAborts[scope] = null;
            });
        }

        // A tap (or a desktop-mode click) on plain text: validate just the token
        // under that cell. The tap that follows on the underline opens it.
        function queuePathLinkPointEvaluation(point) {
          // xterm finalizes selection in its document mouseup, and that clears
          // the point scope. Run after that task so the underline survives.
          setTimeout(() => evaluatePathLinkPoint(point), 0);
        }

        function evaluatePathLinkPoint(point) {
          clearPathLinkScope("point");
          const term = terminal;
          if (!term || !activeTerminalId || !leaseId || !fileViewerToken) return;
          // A live selection owns discovery. A double-click's second release
          // arrives after the word selection exists, and two underlines over
          // one cell is what scope ownership forbids (ADR-0188).
          if (term.hasSelection?.()) return;
          // Already underlined: that spot has a click target, nothing to parse.
          if (pathLinkAtPoint(point.clientX, point.clientY)) return;
          const coords = touchCellCoords(term, point);
          if (!coords) return;
          const line = term.buffer?.active?.getLine?.(coords.y);
          if (!line) return;
          const { text, columns, endColumns } = reconstructRemoteLinkLine(line);
          const column = coords.x + 1;
          let caretIndex = -1;
          for (let offset = 0; offset < columns.length; offset += 1) {
            if (columns[offset] <= column && column <= endColumns[offset]) {
              caretIndex = offset;
              break;
            }
          }
          if (caretIndex < 0) return;
          const lineText = text.replace(/\s+$/, "");
          if (!lineText || caretIndex >= lineText.length) return;
          requestLineScopedPathLinks(
            "point",
            coords.y,
            [lineText],
            { lineIndex: 0, index: caretIndex },
            1
          );
        }

        function readPathLinkScreenLines(term) {
          const buffer = term.buffer?.active;
          if (!buffer) return null;
          const baseLine = buffer.viewportY || 0;
          const rows = Math.min(term.rows || 0, REMOTE_PATH_LINK_MAX_SCREEN_LINES);
          if (rows <= 0) return null;
          const lines = [];
          let chars = 0;
          for (let row = 0; row < rows; row += 1) {
            const line = buffer.getLine?.(baseLine + row);
            const text = line ? reconstructRemoteLinkLine(line).text.replace(/\s+$/, "") : "";
            chars += text.length;
            if (chars > REMOTE_PATH_LINK_MAX_SCREEN_CHARS) break;
            lines.push(text);
          }
          return lines.some((text) => text.length > 0) ? { baseLine, lines } : null;
        }

        function evaluatePathLinkScreen() {
          clearPathLinkScope("screen");
          const term = terminal;
          if (!term || !activeTerminalId || !leaseId || !fileViewerToken) return;
          // A live selection owns discovery while it exists.
          if (term.hasSelection?.()) return;
          const screen = readPathLinkScreenLines(term);
          if (!screen) return;
          const signature = `${screen.baseLine}\n${screen.lines.join("\n")}`;
          // Writes that leave the visible text identical (cursor moves, repaints
          // of the same frame) must not re-run the filesystem batch.
          // ...but only while the previous scan's underlines are still on
          // screen: the idle scheduler retires them before this runs, so an
          // unconditional skip would drop the display until the screen changed.
          if (signature === pathLinkLastScreenSignature && pathLinkScopes.screen.length > 0) {
            return;
          }
          pathLinkLastScreenSignature = signature;
          requestLineScopedPathLinks(
            "screen",
            screen.baseLine,
            screen.lines,
            null,
            REMOTE_PATH_LINK_MAX_SCREEN_CANDIDATES
          );
        }

        /**
         * Drop underlines whose text no longer sits on those cells (ADR-0188,
         * the desktop `revalidate()` contract). An app repainting a row in
         * place leaves the marker — and the decoration — alive, so a tap would
         * open a path the screen no longer shows. Returns before touching the
         * buffer when nothing is drawn.
         */
        function revalidatePathLinkScopes() {
          if (!PATH_LINK_SCOPES.some((scope) => pathLinkScopes[scope].length > 0)) return;
          if (!terminal) return;
          let dropped = 0;
          for (const scope of PATH_LINK_SCOPES) {
            const kept = [];
            for (const entry of pathLinkScopes[scope]) {
              if (pathLinkEntryStillOnScreen(entry)) {
                kept.push(entry);
                continue;
              }
              try {
                entry.decoration?.dispose?.();
              } catch (_) {}
              try {
                entry.marker?.dispose?.();
              } catch (_) {}
              dropped += 1;
            }
            pathLinkScopes[scope] = kept;
          }
          if (dropped > 0) updatePathLinkClickableState();
        }

        /**
         * The marker is the live line number (xterm moves it as the scrollback
         * trims), so it wins over the line the range was created from.
         */
        function pathLinkEntryStillOnScreen(entry) {
          const markerLine =
            entry.marker && entry.marker.isDisposed !== true ? entry.marker.line : undefined;
          const bufferLine =
            typeof markerLine === "number" ? markerLine + 1 : entry.selection.bufferLine;
          const line = terminal?.buffer?.active?.getLine?.(bufferLine - 1);
          if (!line) return false;
          const { text, columns } = reconstructRemoteLinkLine(line);
          const offset = columns.indexOf(entry.selection.startCol);
          if (offset < 0) return false;
          return text.slice(offset, offset + entry.selection.token.length) === entry.selection.token;
        }

        function pathLinkAtPoint(clientX, clientY) {
          for (const entry of pathLinkEntries()) {
            const element = entry.decoration?.element;
            if (!element || !element.isConnected) continue;
            const rect = element.getBoundingClientRect();
            if (
              clientX >= rect.left &&
              clientX <= rect.right &&
              clientY >= rect.top &&
              clientY <= rect.bottom
            ) return entry.selection;
          }
          return null;
        }

        function handlePathLinkPointerDown(event) {
          pathLinkPress = null;
          if (event.button !== 0 || event.isPrimary === false) return;
          const current = pathLinkAtPoint(event.clientX, event.clientY);
          // Remember the press even off an underline: a mouse click on plain
          // text is a `point` trigger (touch goes through handleTouchTap).
          pathLinkPress = {
            ...(current || {}),
            onLink: current !== null,
            pointerType: event.pointerType,
            pointerId: event.pointerId,
            clientX: event.clientX,
            clientY: event.clientY,
          };
        }

        function handlePathLinkPointerUp(event) {
          const press = pathLinkPress;
          pathLinkPress = null;
          if (!press || press.pointerId !== event.pointerId) return;
          const moved =
            Math.abs(event.clientX - press.clientX) > PATH_LINK_CLICK_SLOP_PX ||
            Math.abs(event.clientY - press.clientY) > PATH_LINK_CLICK_SLOP_PX;
          if (moved) return;
          if (!press.onLink) {
            // Touch taps are routed by handleTouchTap so a link activation or a
            // multi-tap selection is not also parsed as a point trigger.
            if (press.pointerType === "touch" || press.pointerType === "pen") return;
            queuePathLinkPointEvaluation({ clientX: event.clientX, clientY: event.clientY });
            return;
          }
          if (
            activeTerminalId !== press.terminalId ||
            leaseId !== press.leaseId ||
            fileViewerToken !== press.fileViewerToken
          ) {
            return;
          }
          // A directory link opens as an explorer listing, a file link renders
          // (ADR-0197). Desktop routes directories to cwd propagation instead,
          // but Remote has no local explorer pane to propagate into.
          if (press.kind === "directory") {
            openFileExplorerOverlay({ path: press.path });
          } else {
            openFileViewerOverlay(press.path);
          }
        }

        function handlePathLinkPointerCancel(event) {
          if (pathLinkPress?.pointerId === event.pointerId) pathLinkPress = null;
        }

        function handlePathLinkMouseMove(event) {
          terminalHost.classList.toggle(
            "remote-path-link-clickable",
            pathLinkAtPoint(event.clientX, event.clientY) !== null
          );
        }

        function loadPreferredInputMode() {
          try {
            const stored = localStorage.getItem(inputModeKey);
            if (stored === "direct" || stored === "composer") return stored;
          } catch (_) {}
          return matchMedia("(pointer: coarse)").matches ? "composer" : "direct";
        }

        function savePreferredInputMode(mode) {
          try {
            localStorage.setItem(inputModeKey, mode);
          } catch (_) {}
        }

        // Composer recall toggles default ON; only an explicit "0" turns them
        // off. These booleans are configuration, so persisting them is allowed
        // (unlike the recall text itself, which stays in memory only).
        function loadComposerToggle(key) {
          try {
            return localStorage.getItem(key) !== "0";
          } catch (_) {
            return true;
          }
        }

        function normalizeComposerAgentScrollOffset(value, fallback) {
          const parsed = Number(value);
          if (!Number.isFinite(parsed)) return fallback;
          return Math.max(
            COMPOSER_AGENT_SCROLL_OFFSET_MIN,
            Math.min(COMPOSER_AGENT_SCROLL_OFFSET_MAX, Math.round(parsed)),
          );
        }

        function loadComposerAgentScrollOffsets() {
          try {
            const stored = JSON.parse(localStorage.getItem(composerAgentScrollOffsetLinesKey) || "{}");
            return Object.fromEntries(
              Object.entries(DEFAULT_COMPOSER_AGENT_SCROLL_OFFSETS).map(([agent, fallback]) => [
                agent,
                normalizeComposerAgentScrollOffset(stored?.[agent], fallback),
              ]),
            );
          } catch (_) {
            return { ...DEFAULT_COMPOSER_AGENT_SCROLL_OFFSETS };
          }
        }

        function saveComposerAgentScrollOffsets() {
          try {
            localStorage.setItem(
              composerAgentScrollOffsetLinesKey,
              JSON.stringify(composerAgentScrollOffsets),
            );
          } catch (_) {}
        }

        function setComposerAgentScrollOffset(agent, value) {
          const fallback = DEFAULT_COMPOSER_AGENT_SCROLL_OFFSETS[agent];
          if (!Number.isInteger(fallback)) return fallback;
          const next = normalizeComposerAgentScrollOffset(value, fallback);
          composerAgentScrollOffsets = { ...composerAgentScrollOffsets, [agent]: next };
          saveComposerAgentScrollOffsets();
          return next;
        }

        function composerAgentScrollOffset(agent) {
          const fallback = DEFAULT_COMPOSER_AGENT_SCROLL_OFFSETS[agent];
          if (!Number.isInteger(fallback)) return null;
          return normalizeComposerAgentScrollOffset(composerAgentScrollOffsets[agent], fallback);
        }

        function composerAgentScrollOffsetEntries() {
          return Object.keys(DEFAULT_COMPOSER_AGENT_SCROLL_OFFSETS).map((agent) => [
            agent,
            composerAgentScrollOffset(agent),
          ]);
        }

        function saveComposerToggle(key, enabled) {
          try {
            localStorage.setItem(key, enabled ? "1" : "0");
          } catch (_) {}
        }

        // Composer history sharing scope (ADR-0055). Same three values as the
        // desktop setting; the scope CHOICE is configuration so it may live in
        // localStorage, while the recalled text never does. Remote has no way to
        // read the host settings.json, so this is surface-local by contract.
        function loadComposerHistoryScope() {
          try {
            const stored = localStorage.getItem(composerHistoryScopeStorageKey);
            return COMPOSER_HISTORY_SCOPES.includes(stored)
              ? stored
              : DEFAULT_COMPOSER_HISTORY_SCOPE;
          } catch (_) {
            return DEFAULT_COMPOSER_HISTORY_SCOPE;
          }
        }

        function saveComposerHistoryScope(scope) {
          try {
            localStorage.setItem(composerHistoryScopeStorageKey, scope);
          } catch (_) {}
        }

        // --- Runtime-only sent-input history (issues #504 / #505, ADR-0055) ---
        // readComposerHistory/pushComposerHistory only ever touch the in-memory
        // Map; there is deliberately no persistence path for this text.
        //
        // The single bucket-key derivation point: a read and a write disagreeing
        // here would silently split the history. A "workspace" scope with no
        // resolvable workspace (dock terminals are app-global) falls back to the
        // terminal's own bucket — unknown membership never widens sharing.
        function composerHistoryBucketKey(terminalId = activeTerminalId) {
          if (!terminalId) return null;
          if (composerHistoryScope === "global") return "global";
          if (composerHistoryScope === "workspace") {
            const workspaceId = terminalInfoById.get(terminalId)?.workspaceId;
            if (workspaceId) return "ws:" + workspaceId;
          }
          return "pane:" + terminalId;
        }

        function readComposerHistory(terminalId = activeTerminalId) {
          const bucket = composerHistoryBucketKey(terminalId);
          if (!bucket) return [];
          return composerHistoryByScopeKey.get(bucket) || [];
        }

        function pushComposerHistory(terminalId, text) {
          const bucket = composerHistoryBucketKey(terminalId);
          if (!bucket || !text) return;
          const list = composerHistoryByScopeKey.get(bucket) || [];
          if (list[list.length - 1] === text) return;
          list.push(text);
          if (list.length > MAX_COMPOSER_HISTORY) {
            list.splice(0, list.length - MAX_COMPOSER_HISTORY);
          }
          composerHistoryByScopeKey.set(bucket, list);
        }

        // Most-recent-first, de-duplicated, blank-skipping view of the history
        // for the Tab recall popup. Ported from the desktop
        // selectComposerHistoryEntries (terminal-input-composer-state.ts).
        function selectComposerHistoryEntries(history, max = DEFAULT_COMPOSER_HISTORY_POPUP_ITEMS) {
          if (max <= 0) return [];
          const seen = new Set();
          const entries = [];
          for (let i = history.length - 1; i >= 0; i -= 1) {
            const entry = history[i];
            if (!entry || seen.has(entry)) continue;
            seen.add(entry);
            entries.push(entry);
            if (entries.length >= max) break;
          }
          return entries;
        }

        // As-you-type suggestions: most-recent-first, de-duplicated, prefix
        // (case-insensitive), skipping blanks and the exact query. Ported from
        // the desktop selectComposerAutocompleteSuggestions.
        function selectComposerAutocompleteSuggestions(
          history,
          query,
          max = DEFAULT_COMPOSER_AUTOCOMPLETE_ITEMS
        ) {
          if (max <= 0 || query.length === 0) return [];
          const needle = query.toLowerCase();
          const seen = new Set();
          const entries = [];
          for (let i = history.length - 1; i >= 0; i -= 1) {
            const entry = history[i];
            if (!entry || entry === query || seen.has(entry)) continue;
            if (!entry.toLowerCase().startsWith(needle)) continue;
            seen.add(entry);
            entries.push(entry);
            if (entries.length >= max) break;
          }
          return entries;
        }

        function currentInputMode(terminalId = activeTerminalId) {
          if (!terminalId) return preferredInputMode;
          if (!inputModeByTerminalId.has(terminalId)) {
            inputModeByTerminalId.set(terminalId, preferredInputMode);
          }
          return inputModeByTerminalId.get(terminalId);
        }

        function composerDraft(terminalId = activeTerminalId) {
          if (!terminalId) return null;
          if (!composerDraftByTerminalId.has(terminalId)) {
            composerDraftByTerminalId.set(terminalId, { text: "", revision: 0, inFlight: null });
          }
          return composerDraftByTerminalId.get(terminalId);
        }

        // --- Composer recall UI (issues #504 / #505) ---
        // The Tab popup needs an EMPTY focused draft; autocomplete needs a
        // NON-empty draft. That split makes the two lists mutually exclusive by
        // construction, so they never fight for the same keys or screen space.
        function currentComposerHistoryEntries() {
          if (!composerHistoryPopupEnabled) return [];
          const draft = composerDraft();
          if (!draft || draft.text.length !== 0) return [];
          return selectComposerHistoryEntries(
            readComposerHistory(),
            DEFAULT_COMPOSER_HISTORY_POPUP_ITEMS
          );
        }

        function currentComposerSuggestions() {
          if (!composerAutocompleteEnabled) return [];
          const draft = composerDraft();
          if (!draft || draft.text.length === 0) return [];
          return selectComposerAutocompleteSuggestions(
            readComposerHistory(),
            draft.text,
            DEFAULT_COMPOSER_AUTOCOMPLETE_ITEMS
          );
        }

        function resetComposerSuggestions() {
          composerHistoryOpen = false;
          composerHistoryIndex = 0;
          composerAutocompleteDismissed = false;
          composerAutocompleteIndex = -1;
        }

        function dismissComposerAutocomplete() {
          composerAutocompleteDismissed = true;
          composerAutocompleteIndex = -1;
        }

        // Fill the draft (and textarea) from a recall pick without routing
        // through the input event, so the input handler's re-arm logic does not
        // fire. Caret goes to the end so the user can keep typing.
        function setComposerDraftText(text) {
          const draft = composerDraft();
          if (!draft) return;
          if (draft.text !== text) {
            draft.text = text;
            draft.revision += 1;
          }
          if (composerInput.value !== text) composerInput.value = text;
          const end = composerInput.value.length;
          try {
            composerInput.setSelectionRange(end, end);
          } catch (_) {}
          updateComposerControls();
        }

        function commitComposerHistoryEntry(entry) {
          composerHistoryOpen = false;
          if (entry != null) setComposerDraftText(entry);
          renderComposerSuggestions();
        }

        function commitComposerAutocompleteEntry(entry) {
          dismissComposerAutocomplete();
          if (entry != null) setComposerDraftText(entry);
          renderComposerSuggestions();
        }

        function buildComposerSuggestList(listEl, entries, activeIndex, onPick) {
          listEl.textContent = "";
          entries.forEach((entry, index) => {
            const item = document.createElement("li");
            item.className = "composer-suggest-item";
            item.id = `${listEl.id}-option-${index}`;
            item.setAttribute("role", "option");
            item.setAttribute("aria-selected", index === activeIndex ? "true" : "false");
            item.title = entry;
            item.textContent = entry;
            // mousedown (not click) so the textarea keeps focus through the pick.
            item.addEventListener("mousedown", (event) => {
              event.preventDefault();
              onPick(entry);
            });
            listEl.append(item);
          });
        }

        function renderComposerSuggestions() {
          const historyEntries = currentComposerHistoryEntries();
          const historyVisible = composerHistoryOpen && historyEntries.length > 0;
          if (historyVisible && composerHistoryIndex >= historyEntries.length) {
            composerHistoryIndex = 0;
          }

          const suggestions = currentComposerSuggestions();
          const autocompleteVisible =
            !composerAutocompleteDismissed && suggestions.length > 0 && !historyVisible;
          const activeAutocompleteIndex =
            composerAutocompleteIndex >= 0 && composerAutocompleteIndex < suggestions.length
              ? composerAutocompleteIndex
              : -1;

          if (historyVisible) {
            buildComposerSuggestList(
              composerHistoryList,
              historyEntries,
              composerHistoryIndex,
              commitComposerHistoryEntry
            );
          } else if (composerHistoryList.childElementCount) {
            composerHistoryList.textContent = "";
          }
          composerHistoryList.hidden = !historyVisible;

          if (autocompleteVisible) {
            buildComposerSuggestList(
              composerAutocompleteList,
              suggestions,
              activeAutocompleteIndex,
              commitComposerAutocompleteEntry
            );
          } else if (composerAutocompleteList.childElementCount) {
            composerAutocompleteList.textContent = "";
          }
          composerAutocompleteList.hidden = !autocompleteVisible;

          // Reflect the open list on the editor for assistive tech.
          composerInput.setAttribute(
            "aria-expanded",
            historyVisible || autocompleteVisible ? "true" : "false"
          );
          if (historyVisible) {
            composerInput.setAttribute("aria-controls", composerHistoryList.id);
            composerInput.setAttribute(
              "aria-activedescendant",
              `${composerHistoryList.id}-option-${composerHistoryIndex}`
            );
          } else if (autocompleteVisible && activeAutocompleteIndex >= 0) {
            composerInput.setAttribute("aria-controls", composerAutocompleteList.id);
            composerInput.setAttribute(
              "aria-activedescendant",
              `${composerAutocompleteList.id}-option-${activeAutocompleteIndex}`
            );
          } else {
            if (autocompleteVisible) {
              composerInput.setAttribute("aria-controls", composerAutocompleteList.id);
            } else {
              composerInput.removeAttribute("aria-controls");
            }
            composerInput.removeAttribute("aria-activedescendant");
          }
        }

        function updateComposerControls() {
          const draft = composerDraft();
          const composerMode = currentInputMode() === "composer";
          const canEdit = Boolean(leaseId && activeTerminalId && composerMode);
          // `data-can-send` mirrors the Send button's readiness for tests / a11y.
          // A collapsed editor never commits: its draft is invisible, so Send
          // stays disabled (not hidden — the footer buttons must not shift
          // under the finger that just tapped Keyboard).
          const canCommit = Boolean(
            canEdit &&
              composerReady &&
              draft &&
              !draft.inFlight &&
              !composerCollapsed &&
              !attachmentUploadInFlight,
          );
          composerInput.disabled = !canEdit || attachmentUploadInFlight;
          terminalComposer.dataset.canSend = canCommit ? "true" : "false";
          composerSendButton.disabled = !canCommit;
          const canAttach = Boolean(
            leaseId && activeTerminalId && composerReady && !attachmentUploadInFlight,
          );
          attachmentButton.disabled = !canAttach;
          attachmentInput.disabled = !canAttach;
          attachmentButton.classList.toggle("busy", attachmentUploadInFlight);
          attachmentButton.setAttribute(
            "aria-busy",
            attachmentUploadInFlight ? "true" : "false",
          );
          syncInputActionVisibility();
        }

        function focusCurrentInputSurface() {
          if (!leaseId || !activeTerminalId) return;
          if (currentInputMode() === "direct") {
            terminal?.focus?.();
          } else if (!composerCollapsed && !composerInput.disabled) {
            // A collapsed editor must not regain focus behind the user's back
            // (reconnect, attach-ready) — only the Keyboard button restores it.
            composerInput.focus({ preventScroll: true });
          }
        }

        // A soft keyboard only opens inside the gesture that asked for it, and
        // an attach lands many awaits after the tap that started it (claim →
        // navigation → chrome settle → pre-attach resize → socket open). On a
        // coarse pointer a focus there leaves DOM focus without an IME, which is
        // exactly the state the Keyboard button reads as "the keyboard is up" —
        // so its next tap dismisses instead of raising (ADR-0196, generalizing
        // the boot autoConnect fix in #848 to every attach). Touch devices let
        // the first real gesture own the focus; fine pointers keep typing
        // straight after Connect.
        function focusInputSurfaceAfterAwait() {
          if (coarsePointer) return;
          focusCurrentInputSurface();
        }

        function inputSurfaceFocused() {
          if (currentInputMode() === "direct") {
            return Boolean(terminal?.textarea) && document.activeElement === terminal.textarea;
          }
          return document.activeElement === composerInput;
        }

        // The Keyboard button toggles the soft keyboard: blur the focused
        // input surface to dismiss it, focus it to raise it. In composer mode
        // the editor pane collapses with the keyboard so the terminal gets the
        // space back, and restores when the keyboard is raised again.
        function toggleInputSurfaceFocus() {
          if (!leaseId || !activeTerminalId) return;
          if (currentInputMode() === "direct") {
            if (inputSurfaceFocused()) terminal?.blur?.();
            else focusCurrentInputSurface();
            return;
          }
          if (composerCollapsed) {
            composerCollapsed = false;
            renderInputSurface({ focus: true });
          } else if (inputSurfaceFocused()) {
            composerCollapsed = true;
            composerInput.blur();
            renderInputSurface();
          } else {
            focusCurrentInputSurface();
          }
        }

        function renderInputSurface(options = {}) {
          const mode = currentInputMode();
          const composerMode = mode === "composer";
          const draft = composerDraft();
          terminalComposer.hidden = !composerMode || composerCollapsed;
          inputModeToggleButton.setAttribute("aria-pressed", composerMode ? "true" : "false");
          const inputModeActionLabel = composerMode
            ? "Switch to Direct input"
            : "Switch to Composer input";
          inputModeToggleButton.title = inputModeActionLabel;
          inputModeToggleButton.setAttribute("aria-label", inputModeActionLabel);
          inputModeIcon.innerHTML = INPUT_MODE_ICONS[composerMode ? "composer" : "direct"];

          const nextText = draft ? draft.text : "";
          if (composerInput.value !== nextText) composerInput.value = nextText;

          if (terminal) {
            if (composerMode) {
              terminal.options.cursorInactiveStyle = "none";
              terminal.blur?.();
            } else {
              terminal.options.cursorInactiveStyle = "outline";
            }
            scheduleTerminalRefresh();
          }
          updateComposerControls();
          renderComposerSuggestions();
          scheduleTerminalFit();
          if (options.focus === true) {
            requestAnimationFrame(() => focusCurrentInputSurface());
          }
        }

        function setInputMode(mode, options = {}) {
          if (mode !== "direct" && mode !== "composer") return;
          preferredInputMode = mode;
          // An explicit mode switch always reveals its input surface; a stale
          // collapse would leave composer mode with no visible editor.
          composerCollapsed = false;
          // A mode switch abandons any open recall list so it never lingers
          // over the newly shown surface.
          resetComposerSuggestions();
          if (activeTerminalId) inputModeByTerminalId.set(activeTerminalId, mode);
          if (options.persist !== false) savePreferredInputMode(mode);
          renderInputSurface({ focus: options.focus !== false });
          if (mode === "composer") offsetComposerForActiveAgent();
        }

        function setActiveTerminal(nextTerminalId) {
          const nextId = nextTerminalId || null;
          if (activeTerminalId !== nextId) {
            clearPathLinkSelection();
            // Publish a terminal switch only after the previous output/input
            // surface has been isolated. Otherwise the old socket can keep
            // rendering with its readiness flag under the new terminal id.
            stopSocket();
            stopInputFlush();
            stopResizeFlush();
            scrollToBottomButton.hidden = true;
            // The isolated socket can no longer answer a pending history
            // request, and the pane this switch lands on may never reach
            // `openOutput` (a queued pane the desktop refuses to open) — so the
            // budget restarts here, not there.
            cancelHistoryExpansion();
            resetHistoryExpansion(nextId);
          }
          activeTerminalId = nextId;
          loadActiveGithubRepo(nextId, nextId ? terminalInfoById.get(nextId)?.cwd : null);
          if (nextId) {
            lastSelectedTerminalId = nextId;
            // Record this attach against its workspace so a later re-entry can
            // resume it (issue #508). Only workspace terminals carry a
            // workspaceId; dock terminals are app-global and skipped.
            const workspaceId = terminalInfoById.get(nextId)?.workspaceId;
            if (workspaceId) lastSelectedTerminalIdByWorkspace.set(workspaceId, nextId);
          }
          composerIsComposing = false;
          // Each terminal has its own draft, and the recall bucket can differ per
          // terminal too (pane / workspace scope), so drop any recall list left
          // open on the terminal we are leaving.
          resetComposerSuggestions();
          if (activeTerminalId) {
            currentInputMode(activeTerminalId);
            composerDraft(activeTerminalId);
          }
          renderInputSurface();
          updateHeaderPaneIdentity();
        }

        function setConnected(connected) {
          if (connectionPanel) connectionPanel.classList.toggle("connected", connected);
          if (connected) setConnectionHint("Connect first to load workspaces and control the active terminal.", false);
          workspaceSection.classList.toggle("locked", !connected);
          hiddenWorkspaceSection.classList.toggle("locked", !connected);
          newWorkspaceButton.disabled = !connected;
          // The create subview is lease-gated like its entry button: losing
          // control while it is open falls back to the workspace list.
          if (!connected && drawerView === "create") returnToWorkspaceView();
          dockSection.classList.toggle("locked", !connected);
          dockToggleButton.disabled = !connected;
          notificationSection.classList.toggle("locked", !connected);
          drawerNotificationsButton.disabled = !connected;
          refreshButton.disabled = !connected;
          updateRemoteDisplaySettingsControls();
          renderPcUpdateStatus();
          if (connected && !pcUpdateStatus && !pcUpdateRequestInFlight) {
            loadPcUpdateStatus().catch(() => {});
          }
          connectButton.disabled = connected;
          updateTerminalControls();
          renderInputSurface();
          updateNotificationActions();
          if (!connected) {
            clearPathLinkSelection();
            fileViewerStatusInFlight = false;
            fileViewerStatusRequestRevision += 1;
            fileViewerPathRevision += 1;
            fileViewerPathInput.value = "";
            closeFileViewer();
          }
          renderFileViewerState();
        }

        function setConnectionHint(message, attention = false) {
          if (connectionHint) connectionHint.textContent = message;
          if (connectionPanel) connectionPanel.classList.toggle("attention", attention);
        }

        // Desktop terminal font copy (ADR-0077). The desktop advertises the font
        // file it resolved locally; until those faces are really loaded here the
        // client keeps the name-only stack. That way the fontFamily string
        // actually changes on completion — xterm's OptionsService only fires
        // onOptionChange for a changed value, so an unchanged string would leave
        // the cell measured against the fallback font forever.
        const REMOTE_FONT_FAMILY_PATTERN = /^LxRemoteFont-[0-9a-f]{12}$/;
        const REMOTE_FONT_URL_PATTERN = /^\/remote\/font\/[0-9a-f]{16}\.(?:ttf|otf)$/;
        const REMOTE_FONT_WEIGHTS = new Set([400, 700]);
        const REMOTE_FONT_STYLES = new Set(["normal", "italic"]);
        // A download can fail transiently — a phone drops out mid-fetch, or the
        // desktop restarted between advertising the URL and being asked for the
        // bytes (that lookup is a 404). One such miss must not pin the session
        // to the fallback font, so a failure is retried on the next navigation
        // refresh or attach, bounded so a genuinely broken font stops asking.
        const REMOTE_FONT_MAX_ATTEMPTS = 3;
        // A hung fetch would otherwise park the state on "loading" forever and
        // block every later retry.
        const REMOTE_FONT_LOAD_TIMEOUT_MS = 20000;
        const remoteFontFamilyState = new Map();
        const remoteFontAttempts = new Map();

        // Every PTY geometry change is a window-size event the TUI redraws from,
        // and a frame-repainting TUI (Claude/Ink) erases only as many rows as it
        // believes its previous frame used — rows counted at the *previous*
        // width. So a width change that arrives after the frame is on screen
        // leaves the wrapped remainder of the old frame stranded above the new
        // one, and the next keypress repaints only the new copy. Attach used to
        // produce two or three such changes: it fitted against whatever font was
        // measurable at that instant, then the remote font landed (cell width
        // changes → cols) and the widget strip appeared (a chrome row → rows).
        // So attach waits for both of those to settle and sends one geometry.
        // Bounded: a font that never arrives must not hold the terminal
        // hostage, and past the deadline one extra reflow is the better trade
        // (ADR-0133).
        const REMOTE_ATTACH_CHROME_SETTLE_MS = 900;
        let widgetStripSettled = false;
        const attachChromeSettleWaiters = [];
        // Raised while an attach waits for that settle. The surface still fits
        // locally during the wait — layout has to stay right — but nothing
        // publishes geometry, because the attach is about to publish the one
        // that counts. Without this the strip's own refit would land first and
        // become the extra SIGWINCH this whole gate exists to remove.
        let attachGeometryHolds = 0;

        /**
         * Whether the two late-arriving surfaces that move attach geometry have
         * both answered. "Answered" is not "present": a font that gave up and a
         * strip that came back empty are settled — they will not move the grid
         * again on their own.
         */
        function attachChromeIsSettled(appearance) {
          const assets = normalizeFontAssets(appearance && appearance.fontAssets);
          const fontPending = Boolean(assets) && remoteFontFamilyState.get(assets.key) === "loading";
          const stripPending = widgetPollActive && !widgetStripSettled;
          return !fontPending && !stripPending;
        }

        function notifyAttachChromeSettled() {
          const waiters = attachChromeSettleWaiters.splice(0, attachChromeSettleWaiters.length);
          waiters.forEach((waiter) => waiter());
        }

        function awaitAttachChromeSettled(appearance) {
          if (attachChromeIsSettled(appearance)) return Promise.resolve();
          return new Promise((resolve) => {
            let settled = false;
            const finish = () => {
              if (settled) return;
              settled = true;
              clearTimeout(deadline);
              resolve();
            };
            const deadline = setTimeout(finish, REMOTE_ATTACH_CHROME_SETTLE_MS);
            const waiter = () => {
              if (settled) return;
              if (attachChromeIsSettled(appearance)) finish();
              else attachChromeSettleWaiters.push(waiter);
            };
            attachChromeSettleWaiters.push(waiter);
          });
        }

        // Server-controlled strings end up inside a CSS rule, so accept only the
        // exact shapes this contract defines.
        function normalizeFontAssets(assets) {
          if (!assets || typeof assets !== "object") return null;
          const family = typeof assets.family === "string" ? assets.family : "";
          if (!REMOTE_FONT_FAMILY_PATTERN.test(family)) return null;
          const faces = (Array.isArray(assets.faces) ? assets.faces : [])
            .filter(
              (face) =>
                face &&
                typeof face.url === "string" &&
                REMOTE_FONT_URL_PATTERN.test(face.url) &&
                REMOTE_FONT_WEIGHTS.has(Number(face.weight)) &&
                REMOTE_FONT_STYLES.has(face.style)
            )
            .map((face) => ({ url: face.url, weight: Number(face.weight), style: face.style }));
          if (faces.length === 0) return null;
          // Keyed by the advertised URLs, not by the family: the alias is a hash
          // of the face *name*, so replacing the font file keeps the alias while
          // the tokens change. Keying on content means new bytes get a fresh
          // attempt budget instead of inheriting a "ready" or exhausted state.
          const key = `${family}|${faces.map((face) => face.url).join(",")}`;
          return { family, faces, key };
        }

        function remoteFontIsReady(assets) {
          return Boolean(assets) && remoteFontFamilyState.get(assets.key) === "ready";
        }

        function ensureRemoteFont(appearance) {
          const assets = normalizeFontAssets(appearance && appearance.fontAssets);
          if (!assets || remoteFontFamilyState.has(assets.key)) return;
          const attempts = remoteFontAttempts.get(assets.key) || 0;
          if (attempts >= REMOTE_FONT_MAX_ATTEMPTS) return;
          remoteFontAttempts.set(assets.key, attempts + 1);
          remoteFontFamilyState.set(assets.key, "loading");
          loadRemoteFont(assets).catch(() => {
            remoteFontFamilyState.delete(assets.key);
            notifyAttachChromeSettled();
          });
        }

        // FontFace objects rather than an injected `@font-face` rule: a rule
        // whose src failed once stays in an error state, so a retry through it
        // never re-requests. A fresh FontFace per attempt does, and the family
        // never has to be interpolated into CSS text.
        async function loadRemoteFont(assets) {
          const fontFaces = assets.faces.map(
            (face) =>
              new FontFace(assets.family, `url("${face.url}")`, {
                weight: String(face.weight),
                style: face.style,
                display: "swap",
              })
          );
          // allSettled, not all: one missing bold must not throw away a regular
          // that loaded fine and send the whole family back to the fallback.
          const settled = await Promise.race([
            Promise.allSettled(fontFaces.map((fontFace) => fontFace.load())),
            new Promise((resolve) => setTimeout(() => resolve(null), REMOTE_FONT_LOAD_TIMEOUT_MS)),
          ]);
          const loaded = settled
            ? settled.filter((result) => result.status === "fulfilled").map((result) => result.value)
            : [];
          loaded.forEach((fontFace) => document.fonts.add(fontFace));
          // `document.fonts.check` answers true for an *unknown* family — the
          // fallback can render the text, so the query is satisfied. Readiness
          // therefore has to come from a face actually being added.
          if (loaded.length === 0 || !document.fonts.check(`16px "${assets.family}"`)) {
            // Drop the state so the next refresh can retry, up to the attempt cap.
            remoteFontFamilyState.delete(assets.key);
            notifyAttachChromeSettled();
            return;
          }
          remoteFontFamilyState.set(assets.key, "ready");
          remoteFontAttempts.delete(assets.key);
          // Cell metrics just changed under the terminal: re-apply the (now
          // different) family string to force a re-measure, then re-fit so the
          // PTY gets the column count this font actually produces. An attach
          // waiting on this font measures with it instead (ADR-0133).
          const info = activeTerminalId ? terminalInfoById.get(activeTerminalId) : null;
          if (!info || !info.appearance) {
            notifyAttachChromeSettled();
            return;
          }
          applyTerminalAppearance(info.appearance);
          notifyAttachChromeSettled();
          scheduleTerminalFit();
        }

        function normalizeAppearance(appearance = {}) {
          const fontSize = Number(appearance.fontSize);
          const cursorWidth = Number(appearance.cursorWidth);
          const cursorStyle = ["bar", "underline", "block"].includes(appearance.cursorStyle)
            ? appearance.cursorStyle
            : defaultAppearance.cursorStyle;
          const fontAssets = normalizeFontAssets(appearance.fontAssets);
          const serverFontFamily = appearance.fontFamily || defaultAppearance.fontFamily;
          return {
            fontFamily: remoteFontIsReady(fontAssets)
              ? `'${fontAssets.family}', ${serverFontFamily}`
              : serverFontFamily,
            fontSize: Number.isFinite(fontSize) && fontSize > 0 ? Math.floor(fontSize) : defaultAppearance.fontSize,
            cursorStyle,
            cursorWidth: Number.isFinite(cursorWidth) && cursorWidth > 0 ? Math.floor(cursorWidth) : undefined,
            scrollback: defaultAppearance.scrollback,
            scrollSensitivity: normalizeScrollSensitivity(
              appearance.scrollSensitivity,
              defaultAppearance.scrollSensitivity
            ),
            fastScrollSensitivity: normalizeScrollSensitivity(
              appearance.fastScrollSensitivity,
              defaultAppearance.fastScrollSensitivity
            ),
            touchScrollSensitivity: normalizeScrollSensitivity(
              appearance.touchScrollSensitivity,
              defaultAppearance.touchScrollSensitivity
            ),
            twoFingerScrollSensitivity: normalizeScrollSensitivity(
              appearance.twoFingerScrollSensitivity,
              defaultAppearance.twoFingerScrollSensitivity
            ),
            theme: { ...defaultAppearance.theme, ...(appearance.theme || {}) },
          };
        }

        // Finger-drag scrollback is converted from pixels to lines by this page,
        // not by xterm, so its multipliers live beside the gesture state instead
        // of in the terminal options bundle. One- and two-finger drags carry
        // separate factors so a two-finger swipe can cover more per drag.
        let touchScrollSensitivity = defaultAppearance.touchScrollSensitivity;
        let twoFingerScrollSensitivity =
          defaultAppearance.twoFingerScrollSensitivity;

        function adoptTouchScrollSensitivity(appearance = {}) {
          const normalized = normalizeAppearance(appearance);
          touchScrollSensitivity = normalized.touchScrollSensitivity;
          twoFingerScrollSensitivity = normalized.twoFingerScrollSensitivity;
        }

        // xterm throws on a non-positive sensitivity, so an older desktop that
        // does not send the field at all, or a hand-edited settings.json, falls
        // back to the default instead of breaking the terminal.
        const SCROLL_SENSITIVITY_MIN = 0.1;
        const SCROLL_SENSITIVITY_MAX = 20;

        function normalizeScrollSensitivity(value, fallback) {
          const parsed = Number(value);
          if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
          return Math.min(SCROLL_SENSITIVITY_MAX, Math.max(SCROLL_SENSITIVITY_MIN, parsed));
        }

        function openRemoteUrl(uri) {
          try {
            const url = new URL(uri);
            if (url.protocol !== "http:" && url.protocol !== "https:") return;
            // An installed-app OAuth link redirects to the *desktop's*
            // loopback listener; opened plainly from this device the code
            // would land on the phone's localhost and die. Route it through
            // the relay (ADR-0175) — controller lease required, because the
            // forward drives the PC.
            if (leaseId && parseOauthLoopbackRedirect(url)) {
              startOauthRelay(url);
              return;
            }
            openExternalRemoteUrl(url);
          } catch (_) {
            // Ignore malformed terminal-controlled links.
          }
        }

        function openExternalRemoteUrl(url) {
          // The Android wrapper WebView disables multiple windows, so
          // `window.open` cannot surface a link there. Hand the already
          // scheme-checked URL to native, which re-validates it and starts
          // the OS browser. Older APKs without the bridge method keep the
          // previous no-op instead of navigating the Remote document away.
          if (androidE2eMode) {
            if (typeof window.LaymuxNative?.openExternalUrl === "function") {
              window.LaymuxNative.openExternalUrl(url.href);
            }
            return;
          }
          window.open(url.href, "_blank", "noopener,noreferrer");
        }

        // --- OAuth loopback relay (ADR-0175) -------------------------------
        const oauthRelayScrim = document.getElementById("oauthRelayScrim");
        const oauthRelayHint = document.getElementById("oauthRelayHint");
        const oauthRelayManualRow = document.getElementById("oauthRelayManualRow");
        const oauthRelayCallbackInput = document.getElementById("oauthRelayCallback");
        const oauthRelayStatus = document.getElementById("oauthRelayStatus");
        const oauthRelayForwardButton = document.getElementById("oauthRelayForward");
        const oauthRelayStartButton = document.getElementById("oauthRelayStart");
        const oauthRelayCloseButton = document.getElementById("oauthRelayClose");
        let oauthRelaySession = null; // { sessionId, port, path }
        let oauthRelayPendingUrl = null; // URL awaiting the user's explicit start
        let oauthRelayForwarding = false;

        // Returns the desktop loopback listener a valid installed-app OAuth
        // URL redirects to, or null when the link is anything else.
        function parseOauthLoopbackRedirect(url) {
          if (url.protocol !== "https:") return null;
          const redirect = url.searchParams.get("redirect_uri");
          if (!redirect) return null;
          try {
            const target = new URL(redirect);
            const host = target.hostname.toLowerCase();
            const loopback =
              host === "localhost" || host === "127.0.0.1" || host === "[::1]";
            if (target.protocol !== "http:" || !loopback || !target.port) {
              return null;
            }
            return { port: Number(target.port), path: target.pathname };
          } catch (_) {
            return null;
          }
        }

        // Relay-scoped i18n (ko/en). The Remote page has no shared i18n yet;
        // this covers only the strings this feature adds. Language follows the
        // phone locale with the same ko*→ko rule the desktop uses, since the
        // relay UI is shown on the phone.
        const OAUTH_RELAY_LANG = (navigator.language || "en")
          .toLowerCase()
          .startsWith("ko")
          ? "ko"
          : "en";
        const OAUTH_RELAY_STRINGS = {
          en: {
            title: "Sign-in relay",
            hintNative:
              "This link is a {host} sign-in that returns its code to the PC's localhost:{port} listener. Start sign-in in the browser and the result returns to the PC automatically.",
            hintBrowser:
              "This link is a {host} sign-in that returns its code to the PC's localhost:{port} listener. After signing in, the browser ends on an unreachable localhost page — copy that page's full address and paste it back here.",
            registering: "Registering the sign-in relay with the PC...",
            waitingNative:
              "Finish signing in with the browser that just opened, then return to this app — the result is delivered to the PC here.",
            waitingSignin: "Waiting for the sign-in to finish...",
            startedBrowser:
              "Sign in with the tab that just opened. It ends on an unreachable localhost page — copy that page's full address and paste it below.",
            waitingPaste: "Waiting for the pasted callback address...",
            pasteInvalid:
              "The pasted address must start with http://localhost:{port}",
            forwardingPaste: "Forwarding the callback to the PC...",
            forwarding: "Forwarding the sign-in result to the PC...",
            successAnswered:
              "✓ Signed in — the PC tool answered {status}. You can close this.",
            successDelivered:
              "✓ Signed in — the sign-in was delivered to the PC. You can close this.",
            inactive: "The sign-in relay is no longer active. You can close this.",
            couldNotConfirm:
              "Could not confirm delivery — check whether the PC signed in.",
            btnStart: "Start sign-in",
            btnForward: "Forward to PC",
            btnClose: "Close",
            ariaCallback: "Callback address from the browser",
          },
          ko: {
            title: "로그인 중계",
            hintNative:
              "이 링크는 {host} 로그인으로, 코드를 PC의 localhost:{port} 리스너로 돌려보냅니다. 브라우저에서 로그인하면 결과가 PC로 자동 전달됩니다.",
            hintBrowser:
              "이 링크는 {host} 로그인으로, 코드를 PC의 localhost:{port} 리스너로 돌려보냅니다. 로그인 후 브라우저는 열리지 않는 localhost 페이지에서 끝나므로, 그 주소 전체를 복사해 아래에 붙여넣으세요.",
            registering: "PC에 로그인 중계를 등록하는 중...",
            waitingNative:
              "방금 열린 브라우저에서 로그인을 마친 뒤 이 앱으로 돌아오세요. 결과는 여기서 PC로 전달됩니다.",
            waitingSignin: "로그인이 끝나기를 기다리는 중...",
            startedBrowser:
              "방금 열린 탭에서 로그인하세요. 열리지 않는 localhost 페이지에서 끝나면 그 주소 전체를 복사해 아래에 붙여넣으세요.",
            waitingPaste: "붙여넣은 콜백 주소를 기다리는 중...",
            pasteInvalid:
              "붙여넣은 주소는 http://localhost:{port} 로 시작해야 합니다",
            forwardingPaste: "콜백을 PC로 전달하는 중...",
            forwarding: "로그인 결과를 PC로 전달하는 중...",
            successAnswered:
              "✓ 로그인 성공 — PC 도구가 {status}로 응답했습니다. 이 창을 닫아도 됩니다.",
            successDelivered:
              "✓ 로그인 성공 — PC로 전달됐습니다. 이 창을 닫아도 됩니다.",
            inactive: "로그인 중계가 더 이상 활성 상태가 아닙니다. 이 창을 닫아도 됩니다.",
            couldNotConfirm:
              "전달을 확인하지 못했습니다 — PC에서 로그인됐는지 확인하세요.",
            btnStart: "로그인 시작",
            btnForward: "PC로 전달",
            btnClose: "닫기",
            ariaCallback: "브라우저에서 받은 콜백 주소",
          },
        };
        function tRelay(key, params) {
          const table =
            OAUTH_RELAY_STRINGS[OAUTH_RELAY_LANG] || OAUTH_RELAY_STRINGS.en;
          let text = table[key] ?? OAUTH_RELAY_STRINGS.en[key] ?? key;
          if (params) {
            for (const name of Object.keys(params)) {
              text = text.split(`{${name}}`).join(params[name]);
            }
          }
          return text;
        }

        // kind: "error" | "success" | "" (neutral). Success is styled distinctly
        // so a completed sign-in reads as a clear win, not just another line.
        function setOauthRelayStatus(message, kind = "") {
          oauthRelayStatus.textContent = message;
          oauthRelayStatus.classList.toggle("error", kind === "error");
          oauthRelayStatus.classList.toggle("success", kind === "success");
        }

        // Static labels the modal ships in English — localized once here.
        (function localizeOauthRelayChrome() {
          const title = document.getElementById("oauthRelayTitle");
          if (title) title.textContent = tRelay("title");
          oauthRelayStartButton.textContent = tRelay("btnStart");
          oauthRelayForwardButton.textContent = tRelay("btnForward");
          oauthRelayCloseButton.textContent = tRelay("btnClose");
          oauthRelayCallbackInput.setAttribute("aria-label", tRelay("ariaCallback"));
        })();

        function closeOauthRelayModal() {
          oauthRelayScrim.hidden = true;
          oauthRelaySession = null;
          oauthRelayPendingUrl = null;
          oauthRelayForwarding = false;
          oauthRelayCallbackInput.value = "";
          if (typeof window.LaymuxNative?.cancelOauthRelay === "function") {
            window.LaymuxNative.cancelOauthRelay();
          }
        }

        function nativeOauthRelayAvailable() {
          return (
            androidE2eMode &&
            typeof window.LaymuxNative?.beginOauthRelay === "function"
          );
        }

        // Terminal links are untrusted text, so tapping one never starts the
        // relay by itself: this only explains what the link wants to do and
        // waits for the user's explicit start.
        function startOauthRelay(url) {
          const redirect = parseOauthLoopbackRedirect(url);
          oauthRelayPendingUrl = url;
          oauthRelaySession = null;
          oauthRelayCallbackInput.value = "";
          oauthRelayScrim.hidden = false;
          oauthRelayManualRow.hidden = true;
          oauthRelayStartButton.hidden = false;
          oauthRelayHint.textContent = tRelay(
            nativeOauthRelayAvailable() ? "hintNative" : "hintBrowser",
            { host: url.hostname, port: redirect.port },
          );
          setOauthRelayStatus("");
        }

        async function beginOauthRelayFlow() {
          const url = oauthRelayPendingUrl;
          if (!url || oauthRelaySession) return;
          const redirect = parseOauthLoopbackRedirect(url);
          const native = nativeOauthRelayAvailable();
          // Open the window inside the click's transient activation: strict
          // browsers (Safari) refuse a window.open issued after the await
          // below. Opened blank, detached from this page, navigated once the
          // relay session exists.
          let popup = null;
          if (!native) {
            popup = window.open("", "_blank");
            if (popup) popup.opener = null;
          }
          oauthRelayStartButton.hidden = true;
          setOauthRelayStatus(tRelay("registering"));
          let session;
          try {
            session = await remoteFetch("/remote/v1/oauth-relay/begin", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ authUrl: url.href, leaseId }),
            });
          } catch (error) {
            if (popup) popup.close();
            setOauthRelayStatus(error.message || String(error), "error");
            // Leave the pending URL so the user can retry from the button.
            oauthRelayStartButton.hidden = false;
            return;
          }
          oauthRelaySession = {
            sessionId: session.sessionId,
            port: session.port,
            path: redirect.path,
          };
          if (native) {
            // Native binds the phone's loopback port, opens the OS browser,
            // and parks the redirect until this app is foreground again —
            // then window.laymuxOauthRelay.onCallback forwards it.
            oauthRelayHint.textContent = tRelay("waitingNative");
            setOauthRelayStatus(tRelay("waitingSignin"));
            window.LaymuxNative.beginOauthRelay(
              session.sessionId,
              String(session.port),
              redirect.path,
              url.href,
            );
            return;
          }
          // Plain browser: nothing can listen on this device's localhost.
          // The redirect still lands in the address bar — the user copies it
          // back here and the desktop replays it.
          oauthRelayHint.textContent = tRelay("startedBrowser");
          oauthRelayManualRow.hidden = false;
          setOauthRelayStatus(tRelay("waitingPaste"));
          if (popup) {
            popup.location.href = url.href;
          } else {
            // Popup blocked despite the sync open: best-effort direct open.
            openExternalRemoteUrl(url);
          }
        }

        async function forwardOauthCallback(pathAndQuery) {
          const session = oauthRelaySession;
          if (!session || oauthRelayForwarding) return null;
          oauthRelayForwarding = true;
          try {
            const result = await remoteFetch("/remote/v1/oauth-relay/forward", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                sessionId: session.sessionId,
                pathAndQuery,
                leaseId,
              }),
            });
            oauthRelaySession = null;
            return result;
          } catch (error) {
            // A server answer means the one-shot session is spent; a pure
            // transport failure (E2E session still resuming after the OS
            // browser) leaves it intact so the caller can retry.
            if (error && typeof error.status === "number") {
              oauthRelaySession = null;
            }
            throw error;
          } finally {
            oauthRelayForwarding = false;
          }
        }

        async function forwardPastedOauthCallback() {
          const session = oauthRelaySession;
          if (!session) return;
          let pathAndQuery = null;
          try {
            const pasted = new URL(oauthRelayCallbackInput.value.trim());
            const host = pasted.hostname.toLowerCase();
            if (
              (host === "localhost" || host === "127.0.0.1") &&
              Number(pasted.port) === session.port
            ) {
              pathAndQuery = pasted.pathname + pasted.search;
            }
          } catch (_) {
            // Falls through to the error below.
          }
          if (!pathAndQuery) {
            setOauthRelayStatus(
              tRelay("pasteInvalid", { port: session.port }),
              "error",
            );
            return;
          }
          setOauthRelayStatus(tRelay("forwardingPaste"));
          try {
            const result = await forwardOauthCallback(pathAndQuery);
            if (!result) return;
            setOauthRelayStatus(
              tRelay("successAnswered", { status: result.status }),
              "success",
            );
          } catch (error) {
            setOauthRelayStatus(error.message || String(error), "error");
          }
        }

        // Native (Android) parks the captured loopback redirect while the OS
        // browser is frontmost and hands it here on the next foreground; the
        // browser already got its "return to the app" page. The E2E session
        // may still be resuming at that moment, so transport failures retry
        // with backoff before giving up.
        window.laymuxOauthRelay = {
          onCallback(pathAndQuery) {
            (async () => {
              setOauthRelayStatus(tRelay("forwarding"));
              // A transport failure can drop the *response* after the forward
              // already reached the PC and consumed the one-shot session. On
              // retry that same request answers CONFLICT/"session is not
              // active" — which means the earlier attempt was delivered, not
              // that delivery failed. Track whether a request left this device
              // so the retry can tell the two apart.
              let sent = false;
              for (let attempt = 0; attempt < 4; attempt += 1) {
                try {
                  const result = await forwardOauthCallback(String(pathAndQuery));
                  if (result) {
                    setOauthRelayStatus(
                      tRelay("successAnswered", { status: result.status }),
                      "success",
                    );
                    return;
                  }
                  // Null means the session was already consumed/cleared: a
                  // prior send reached the PC (delivered), or the relay was
                  // closed. Never leave the status stuck on "Forwarding...".
                  if (sent) {
                    setOauthRelayStatus(tRelay("successDelivered"), "success");
                  } else {
                    setOauthRelayStatus(tRelay("inactive"));
                  }
                  return;
                } catch (error) {
                  if (error && typeof error.status === "number") {
                    // A server answer to a retry that says the session is gone
                    // means an earlier send already delivered it.
                    if (sent) {
                      setOauthRelayStatus(tRelay("successDelivered"), "success");
                    } else {
                      setOauthRelayStatus(error.message || String(error), "error");
                    }
                    return;
                  }
                  // Transport failure: the request may or may not have reached
                  // the PC, so a later CONFLICT counts as delivered.
                  sent = true;
                  await new Promise((resolve) =>
                    setTimeout(resolve, 1000 * (attempt + 1)),
                  );
                }
              }
              setOauthRelayStatus(tRelay("couldNotConfirm"), "error");
            })();
          },
          onError(message) {
            setOauthRelayStatus(String(message), "error");
          },
        };

        oauthRelayForwardButton.addEventListener("click", () => {
          forwardPastedOauthCallback();
        });
        oauthRelayStartButton.addEventListener("click", () => {
          beginOauthRelayFlow();
        });
        oauthRelayCloseButton.addEventListener("click", closeOauthRelayModal);
        // --- end OAuth loopback relay ---------------------------------------

        // Equivalent to desktop's `(?<!\w)#(\d+)\b`, without regex
        // lookbehind so older iOS WebKit can parse the Remote page.
        const REMOTE_PR_TOKEN_RE = /(^|[^\w])#(\d+)\b/g;

        function findRemotePrTokens(text) {
          const matches = [];
          REMOTE_PR_TOKEN_RE.lastIndex = 0;
          let match;
          while ((match = REMOTE_PR_TOKEN_RE.exec(text)) !== null) {
            const number = Number.parseInt(match[2], 10);
            if (!Number.isSafeInteger(number)) continue;
            const startOffset = match.index + match[1].length;
            matches.push({
              number,
              startOffset,
              endOffset: startOffset + match[2].length,
            });
          }
          return matches;
        }

        function reconstructRemoteLinkLine(line) {
          let text = "";
          const columns = [];
          const endColumns = [];
          for (let x = 0; x < line.length; x += 1) {
            const cell = line.getCell(x);
            const width = cell?.getWidth?.() ?? 1;
            if (width === 0) continue;
            const chars = cell?.getChars?.() || " ";
            text += chars;
            for (let offset = 0; offset < chars.length; offset += 1) {
              columns.push(x + 1);
              endColumns.push(x + width);
            }
          }
          return { text, columns, endColumns };
        }

        function createRemotePrLinkProvider(term) {
          return {
            provideLinks(bufferLineNumber, callback) {
              const repoBase = activeGithubRepoBase;
              const repoRevision = githubRepoRequestRevision;
              if (!repoBase) {
                callback(undefined);
                return;
              }
              const line = term.buffer.active.getLine(bufferLineNumber - 1);
              if (!line) {
                callback(undefined);
                return;
              }
              const { text, columns } = reconstructRemoteLinkLine(line);
              const links = findRemotePrTokens(text).flatMap((match) => {
                const startX = columns[match.startOffset];
                const endX = columns[match.endOffset];
                if (startX === undefined || endX === undefined) return [];
                return [{
                  range: {
                    start: { x: startX, y: bufferLineNumber },
                    end: { x: endX, y: bufferLineNumber },
                  },
                  text: `#${match.number}`,
                  activate: () => {
                    if (
                      repoRevision !== githubRepoRequestRevision ||
                      activeGithubRepoBase !== repoBase
                    ) return;
                    openRemoteUrl(`${repoBase}/issues/${match.number}`);
                  },
                }];
              });
              callback(links.length > 0 ? links : undefined);
            },
          };
        }

        function normalizeRemoteGithubRepoBase(value) {
          if (typeof value !== "string") return null;
          try {
            const url = new URL(value);
            const segments = url.pathname.split("/").filter(Boolean);
            if (
              url.protocol !== "https:" ||
              url.hostname.toLowerCase() !== "github.com" ||
              url.port ||
              url.username ||
              url.password ||
              url.search ||
              url.hash ||
              segments.length !== 2
            ) return null;
            return `https://github.com/${segments[0]}/${segments[1]}`;
          } catch (_) {
            return null;
          }
        }

        function terminalOptionsForAppearance(appearance = {}) {
          const normalized = normalizeAppearance(appearance);
          const options = {
            // Remote selected-path links use the same IDecoration mechanism as
            // desktop TerminalView; xterm gates registerDecoration behind this.
            allowProposedApi: true,
            cols: 80,
            rows: 24,
            cursorBlink: true,
            cursorStyle: normalized.cursorStyle,
            fontFamily: normalized.fontFamily,
            fontSize: normalized.fontSize,
            letterSpacing: 0,
            macOptionClickForcesSelection: true,
            scrollback: normalized.scrollback,
            scrollSensitivity: normalized.scrollSensitivity,
            fastScrollSensitivity: normalized.fastScrollSensitivity,
            convertEol: false,
            theme: normalized.theme,
            // OSC 8 URIs are terminal-controlled input. Keep xterm's own
            // non-HTTP rejection enabled and route accepted web links through
            // the same safe browser opener as plain-text links.
            linkHandler: {
              activate: (_event, uri) => openRemoteUrl(uri),
              allowNonHttpProtocols: false,
            },
          };
          if (normalized.cursorWidth !== undefined) {
            options.cursorWidth = normalized.cursorWidth;
          }
          return options;
        }

        // A tail-anchored crop can expose the clipping wrapper above the sizer
        // (ADR-0056), so the wrapper is painted with the terminal's own theme
        // background instead of the fixed shell background.
        function applyTerminalSurfaceBackground(appearance = {}) {
          const background = normalizeAppearance(appearance).theme.background || defaultAppearance.theme.background;
          document.documentElement.style.setProperty("--terminal-surface-bg", background);
        }

        function applyTerminalAppearance(appearance = {}) {
          if (!terminal) return;
          applyTerminalSurfaceBackground(appearance);
          adoptTouchScrollSensitivity(appearance);
          const options = terminalOptionsForAppearance(appearance);
          delete options.cols;
          delete options.rows;
          terminal.options = options;
          if (options.cursorWidth === undefined) {
            try {
              delete terminal.options.cursorWidth;
            } catch (_) {
              terminal.options.cursorWidth = undefined;
            }
          }
          if (typeof terminal.refresh === "function" && terminal.rows > 0) {
            terminal.refresh(0, terminal.rows - 1);
          }
        }

        function updateTerminalControls() {
          const canControl = Boolean(leaseId && activeTerminalId);
          ctrlCButton.disabled = !canControl;
          focusTerminalButton.disabled = !canControl;
          updateComposerControls();
          updateKeyBarControls();
        }

        // Scroll gestures are the only evidence that the user, and not output,
        // moved the viewport. xterm does not expose its own `isUserScrolling`,
        // so the page stamps the gestures it already routes itself.
        function markTerminalUserScroll() {
          lastTerminalUserScrollAt = Date.now();
        }

        function terminalScrollIsUserDriven() {
          return Date.now() - lastTerminalUserScrollAt <= TERMINAL_USER_SCROLL_WINDOW_MS;
        }

        function isTerminalScrolledUp(term) {
          const activeBuffer = term?.buffer?.active;
          if (!activeBuffer) return false;
          const baseY = activeBuffer.baseY ?? 0;
          const viewportY = activeBuffer.viewportY ?? baseY;
          return viewportY < baseY;
        }

        function terminalViewportDistanceFromBottom(term) {
          const activeBuffer = term?.buffer?.active;
          if (!activeBuffer) return 0;
          const baseY = activeBuffer.baseY ?? 0;
          const viewportY = activeBuffer.viewportY ?? baseY;
          return Math.max(0, baseY - viewportY);
        }

        function restoreTerminalViewport(term, distanceFromBottom) {
          // Snapshot replay and its geometry fit can leave xterm at an arbitrary
          // viewport. Establish a deterministic baseline, then restore a recovery
          // attach's surface-local scroll offset in the same synchronous task so
          // the intermediate tail position is never painted.
          //
          // The scroll this drives is not a user reaching the top: a pane whose
          // whole scrollback fits the restored offset would otherwise land on
          // row 0 and ask the desktop for history nobody requested.
          restoringTerminalViewport = true;
          try {
            term.scrollToBottom();
            if (distanceFromBottom > 0) term.scrollLines(-distanceFromBottom);
          } finally {
            restoringTerminalViewport = false;
            lastTerminalViewportY = term?.buffer?.active?.viewportY ?? 0;
          }
        }

        function updateScrollToBottomButton(term = terminal) {
          scrollToBottomButton.hidden = !term || !isTerminalScrolledUp(term);
        }

        function fallbackCopyText(text) {
          const textarea = document.createElement("textarea");
          textarea.value = text;
          textarea.setAttribute("readonly", "");
          textarea.style.position = "fixed";
          textarea.style.left = "-9999px";
          textarea.style.top = "0";
          document.body.append(textarea);
          textarea.focus();
          textarea.select();
          try {
            return Boolean(document.execCommand && document.execCommand("copy"));
          } catch (_) {
            return false;
          } finally {
            textarea.remove();
          }
        }

        async function writeClipboardText(text) {
          let clipboardError = null;
          if (navigator.clipboard && window.isSecureContext) {
            try {
              await navigator.clipboard.writeText(text);
              return;
            } catch (err) {
              clipboardError = err;
            }
          }
          if (fallbackCopyText(text)) return;
          if (clipboardError) throw clipboardError;
          throw new Error("Clipboard API unavailable");
        }

        async function copySelectionToClipboard() {
          if (!terminal || !terminal.hasSelection()) {
            lastCopiedSelection = "";
            return;
          }
          const text = terminal.getSelection();
          if (!text) {
            lastCopiedSelection = "";
            return;
          }
          if (text === lastCopiedSelection) return;
          try {
            await writeClipboardText(text);
            lastCopiedSelection = text;
          } catch (err) {
            setStatus(`Copy failed: ${err.message || err}`, true);
          }
        }

        function copySelectionAfterInteraction() {
          queueMicrotask(() => {
            copySelectionToClipboard();
            // Pointer-up is the settle point. A zero-delay schedule coalesces
            // the final xterm selection event without duplicating its stat.
            schedulePathLinkSelectionEvaluation(0);
          });
        }

        function isTouchPointer(event) {
          return event.pointerType === "touch" || event.pointerType === "pen";
        }

        function touchPointFromEvent(event) {
          return {
            screenX: event.screenX,
            screenY: event.screenY,
            clientX: event.clientX,
            clientY: event.clientY,
          };
        }

        function touchDistance(a, b) {
          return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        }

        function touchCenterPoint() {
          if (touchPointers.size === 0) return null;
          let screenX = 0;
          let screenY = 0;
          let clientX = 0;
          let clientY = 0;
          for (const point of touchPointers.values()) {
            screenX += point.screenX;
            screenY += point.screenY;
            clientX += point.clientX;
            clientY += point.clientY;
          }
          const count = touchPointers.size;
          return {
            screenX: screenX / count,
            screenY: screenY / count,
            clientX: clientX / count,
            clientY: clientY / count,
          };
        }

        function rememberTouchPointer(event) {
          const point = touchPointFromEvent(event);
          touchPointers.set(event.pointerId, point);
          return point;
        }

        function hasMouseTracking(term) {
          const mouseTrackingMode = term && term.modes && term.modes.mouseTrackingMode;
          return Boolean(mouseTrackingMode && mouseTrackingMode !== "none");
        }

        function shouldForceTouchSelection(term) {
          return hasMouseTracking(term);
        }

        function isNormalScrollbackMode(term) {
          const bufferType = term && term.buffer && term.buffer.active && term.buffer.active.type;
          return bufferType === "normal" && !hasMouseTracking(term);
        }

        function isAlternateBufferCursorInput(term, data) {
          const bufferType = term && term.buffer && term.buffer.active && term.buffer.active.type;
          if (bufferType !== "alternate" || hasMouseTracking(term)) return false;
          return data === "\x1b[A" || data === "\x1b[B" || data === "\x1bOA" || data === "\x1bOB";
        }

        function touchSelectionMouseEvent(
          type,
          point,
          forceSelection,
          detail = type === "mousedown" ? 1 : 0,
          buttons = type === "mouseup" ? 0 : 1
        ) {
          return new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            view: window,
            detail,
            screenX: point.screenX,
            screenY: point.screenY,
            clientX: point.clientX,
            clientY: point.clientY,
            button: 0,
            buttons,
            shiftKey: forceSelection,
            altKey: forceSelection,
          });
        }

        function dispatchTouchSelectionMouse(target, type, point, forceSelection, detail, buttons) {
          target.dispatchEvent(
            touchSelectionMouseEvent(type, point, forceSelection, detail, buttons)
          );
        }

        function activateTouchLink(term, element, point) {
          const linkElement = element.querySelector(".xterm-screen");
          if (!linkElement) return false;
          const forceSelection = shouldForceTouchSelection(term);
          // xterm discovers both OSC 8 and provider links on mousemove, then
          // requires the same active link across mousedown -> mouseup. Touch
          // pointers do not emit those compatibility events because this
          // bridge cancels their native pointer events, so replay the sequence
          // synchronously while the pointerup still carries user activation.
          dispatchTouchSelectionMouse(linkElement, "mousemove", point, forceSelection, 0, 0);
          if (!linkElement.classList.contains("xterm-cursor-pointer")) return false;
          dispatchTouchSelectionMouse(linkElement, "mousedown", point, forceSelection);
          dispatchTouchSelectionMouse(linkElement, "mouseup", point, forceSelection);
          // Touch has no persistent hover. Clear xterm's underline/cursor state
          // after activation so it cannot linger until the next gesture.
          dispatchTouchSelectionMouse(linkElement, "mouseleave", point, forceSelection, 0, 0);
          return true;
        }

        function clearTouchLongPressTimer() {
          if (!touchGesture || touchGesture.longPressTimer === null) return;
          window.clearTimeout(touchGesture.longPressTimer);
          touchGesture.longPressTimer = null;
        }

        function releaseTouchPointer(element, pointerId) {
          if (element.hasPointerCapture?.(pointerId)) {
            element.releasePointerCapture?.(pointerId);
          }
        }

        function resetTouchGesture(element) {
          if (!touchGesture) return;
          clearTouchLongPressTimer();
          for (const pointerId of touchPointers.keys()) {
            releaseTouchPointer(element, pointerId);
          }
          touchPointers.clear();
          touchGesture = null;
        }

        function terminalMetrics(term) {
          const element = term && term.element;
          if (!element || !term.rows || !term.cols) return null;
          const screen = element.querySelector(".xterm-screen");
          const rect = (screen || element).getBoundingClientRect();
          const fallbackRect = element.getBoundingClientRect();
          const width = rect.width || fallbackRect.width;
          const height = rect.height || fallbackRect.height;
          if (width <= 0 || height <= 0) return null;
          return {
            rect,
            cellWidth: width / term.cols,
            cellHeight: height / term.rows,
            viewportY: (term.buffer && term.buffer.active && term.buffer.active.viewportY) || 0,
          };
        }

        function touchCellCoords(term, point) {
          const metrics = terminalMetrics(term);
          if (!metrics) return null;
          const x = Math.max(0, Math.min(term.cols, Math.floor((point.clientX - metrics.rect.left) / metrics.cellWidth)));
          const viewportRow = Math.max(0, Math.min(term.rows - 1, Math.floor((point.clientY - metrics.rect.top) / metrics.cellHeight)));
          const bufferLength = (term.buffer && term.buffer.active && term.buffer.active.length) || term.rows;
          const y = Math.max(0, Math.min(bufferLength - 1, metrics.viewportY + viewportRow));
          return { x, y };
        }

        function consumeTouchScrollLines(
          term,
          deltaY,
          sensitivity = touchScrollSensitivity,
          gesture = touchGesture,
        ) {
          if (!gesture) return 0;
          const metrics = terminalMetrics(term);
          if (!metrics) return 0;
          // The remainder carries the sub-cell leftover, so the multiplier is
          // applied to the raw finger delta once and never re-applied to it.
          gesture.scrollRemainderPx += -deltaY * sensitivity;
          const exactLines = gesture.scrollRemainderPx / metrics.cellHeight;
          const wholeLines = exactLines < 0 ? Math.ceil(exactLines) : Math.floor(exactLines);
          gesture.scrollRemainderPx -= wholeLines * metrics.cellHeight;
          return wholeLines;
        }

        function scrollTouchTerminal(
          term,
          deltaY,
          sensitivity = touchScrollSensitivity,
          gesture = touchGesture,
        ) {
          if (typeof term.scrollLines !== "function") return;
          const wholeLines = consumeTouchScrollLines(term, deltaY, sensitivity, gesture);
          if (wholeLines === 0) return;
          term.scrollLines(wholeLines);
          updateSelectionHandles(term);
          if (wholeLines < 0) markTerminalUserScroll();
          // Dragging further up while already at row 0 moves nothing, so this
          // is the only signal that the user wants older output than the
          // attached screen carries.
          if (wholeLines < 0) requestOlderTerminalHistory();
        }

        function sendTerminalCursorScroll(
          term,
          deltaY,
          sensitivity = touchScrollSensitivity,
          gesture = touchGesture,
        ) {
          if (terminalReplayDepth > 0) return;
          const wholeLines = consumeTouchScrollLines(term, deltaY, sensitivity, gesture);
          if (wholeLines === 0) return;
          const applicationCursor = Boolean(
            term && term.modes && term.modes.applicationCursorKeysMode,
          );
          const sequence =
            "\x1b" + (applicationCursor ? "O" : "[") + (wholeLines < 0 ? "A" : "B");
          // Keep each row as its own PTY write. ConPTY can collapse a run of
          // identical cursor sequences from one write into one console event,
          // which makes Codex's transcript pager advance only one row.
          enqueueDiscreteInput(sequence, Math.abs(wholeLines));
        }

        function sendTerminalAppScroll(term, deltaY, point) {
          const element = term && term.element;
          if (!element) return;
          const wheel = new WheelEvent("wheel", {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: point ? point.clientX : 0,
            clientY: point ? point.clientY : 0,
            deltaY: -deltaY,
            deltaMode: 0,
          });
          element.dispatchEvent(wheel);
        }

        function routeOneFingerScroll(term, deltaY, point) {
          if (isNormalScrollbackMode(term)) {
            scrollTouchTerminal(term, deltaY, touchScrollSensitivity);
          } else if (!hasMouseTracking(term)) {
            sendTerminalCursorScroll(term, deltaY, touchScrollSensitivity);
          } else {
            sendTerminalAppScroll(term, deltaY, point);
          }
        }

        function routeTwoFingerScroll(term, deltaY, point) {
          if (isNormalScrollbackMode(term)) {
            scrollTouchTerminal(term, deltaY, twoFingerScrollSensitivity);
          } else if (!hasMouseTracking(term)) {
            sendTerminalCursorScroll(term, deltaY, twoFingerScrollSensitivity);
          } else {
            // Mouse-tracking TUI mode routes to the synthesized wheel path,
            // which follows xterm's own scrollSensitivity. Alternate-buffer
            // cursor fallback above keeps the touch gesture's own multiplier.
            sendTerminalAppScroll(term, deltaY, point);
          }
        }

        function startTouchSelection(term, element, pointerId) {
          if (!touchGesture || touchGesture.pointerId !== pointerId || touchGesture.mode !== "pending") return;
          touchGesture.mode = "selecting";
          touchGesture.forceSelection = shouldForceTouchSelection(term);
          touchGesture.scrollRemainderPx = 0;
          // A stationary long press should create a useful selection immediately.
          // xterm uses click detail=2 for word mode (the same path as a desktop
          // double-click). Finish that synthetic click immediately so later
          // touch movement can extend the captured word by individual cells.
          dispatchTouchSelectionMouse(
            element,
            "mousedown",
            touchGesture.startPoint,
            touchGesture.forceSelection,
            2
          );
          suppressSelectionMouseupAfterInteraction = true;
          try {
            dispatchTouchSelectionMouse(
              document,
              "mouseup",
              touchGesture.startPoint,
              touchGesture.forceSelection,
              2
            );
          } finally {
            suppressSelectionMouseupAfterInteraction = false;
          }
          const selection = term.getSelectionPosition && term.getSelectionPosition();
          touchGesture.selectionSeed = selection
            ? {
                start: { x: selection.start.x, y: selection.start.y },
                end: { x: selection.end.x, y: selection.end.y },
              }
            : null;
          updateTerminalControls();
          updateSelectionHandles(term);
        }

        function triggerTouchTapSelection(term, element, point, detail) {
          const forceSelection = shouldForceTouchSelection(term);
          dispatchTouchSelectionMouse(element, "mousedown", point, forceSelection, detail);
          dispatchTouchSelectionMouse(document, "mouseup", point, forceSelection, detail);
          updateTerminalControls();
          updateSelectionHandles(term);
        }

        function handleTouchTap(term, element, point) {
          if (currentInputMode() === "direct") {
            term.focus?.();
          } else {
            term.blur?.();
          }
          const now = Date.now();
          const isSameTapCluster =
            now - lastTouchTap.time <= INTERNAL_TOUCH_MULTI_TAP_DELAY_MS &&
            touchDistance(point, lastTouchTap) <= INTERNAL_TOUCH_TAP_SLOP_PX;
          const count = isSameTapCluster ? lastTouchTap.count + 1 : 1;
          lastTouchTap = { time: now, x: point.clientX, y: point.clientY, clientX: point.clientX, clientY: point.clientY, count };

          if (count === 2) {
            triggerTouchTapSelection(term, element, point, 2);
            return;
          }
          if (count >= 3) {
            triggerTouchTapSelection(term, element, point, 3);
            lastTouchTap.count = 0;
            return;
          }

          if (activateTouchLink(term, element, point)) return;

          if (term.hasSelection && term.hasSelection()) {
            term.clearSelection();
            updateTerminalControls();
            updateSelectionHandles(term);
          }
          // ADR-0188: a tap on plain text is a discovery trigger. An underlined
          // path is opened by handlePathLinkPointerUp before we get here.
          queuePathLinkPointEvaluation(point);
        }

        function selectionRange(start, end, cols) {
          const forward = start.y < end.y || (start.y === end.y && start.x <= end.x);
          const first = forward ? start : end;
          const last = forward ? end : start;
          return {
            start: first,
            length: Math.max(0, (last.y - first.y) * cols + (last.x - first.x)),
          };
        }

        function applySelectionRange(term, anchor, focus) {
          const range = selectionRange(anchor, focus, term.cols);
          if (range.length <= 0) {
            term.clearSelection();
          } else {
            term.select(range.start.x, range.start.y, range.length);
          }
          updateTerminalControls();
          updateSelectionHandles(term);
        }

        function extendTouchSelection(term, gesture, point) {
          const seed = gesture && gesture.selectionSeed;
          const focus = touchCellCoords(term, point);
          if (!seed || !focus) return;
          const offset = (position) => position.y * term.cols + position.x;
          const focusOffset = offset(focus);
          const startOffset = offset(seed.start);
          const endOffset = offset(seed.end);

          if (focusOffset < startOffset) {
            applySelectionRange(term, seed.end, focus);
          } else if (focusOffset > endOffset) {
            applySelectionRange(term, seed.start, focus);
          } else {
            applySelectionRange(term, seed.start, seed.end);
          }
        }

        function handleSelectionMouseupAfterInteraction() {
          if (suppressSelectionMouseupAfterInteraction) return;
          copySelectionAfterInteraction();
        }

        function updateSelectionHandles(term) {
          if (!selectionHandles || !term || !term.getSelectionPosition || !term.hasSelection()) {
            if (selectionHandles) {
              selectionHandles.start.style.display = "none";
              selectionHandles.end.style.display = "none";
            }
            return;
          }
          const selection = term.getSelectionPosition();
          const metrics = terminalMetrics(term);
          if (!selection || !metrics) return;
          const hostRect = terminalHost.getBoundingClientRect();

          const place = (handle, pos) => {
            const viewportRow = pos.y - metrics.viewportY;
            if (viewportRow < 0 || viewportRow >= term.rows) {
              handle.style.display = "none";
              return;
            }
            handle.style.left = `${metrics.rect.left - hostRect.left + pos.x * metrics.cellWidth}px`;
            handle.style.top = `${metrics.rect.top - hostRect.top + (viewportRow + 1) * metrics.cellHeight}px`;
            handle.style.display = "block";
          };

          place(selectionHandles.start, selection.start);
          place(selectionHandles.end, selection.end);
        }

        function installSelectionHandles(term) {
          if (selectionHandles) return;
          const start = document.createElement("div");
          const end = document.createElement("div");
          start.className = "touch-selection-handle";
          end.className = "touch-selection-handle";
          start.dataset.handle = "start";
          end.dataset.handle = "end";
          terminalHost.append(start, end);
          selectionHandles = { start, end };

          const onHandlePointerDown = (event) => {
            if (!isTouchPointer(event)) return;
            const selection = term.getSelectionPosition && term.getSelectionPosition();
            if (!selection) return;
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation?.();
            const role = event.currentTarget.dataset.handle;
            selectionHandleDrag = {
              pointerId: event.pointerId,
              role,
              anchor: role === "start" ? selection.end : selection.start,
            };
            event.currentTarget.setPointerCapture?.(event.pointerId);
          };

          const onHandlePointerMove = (event) => {
            if (!selectionHandleDrag || event.pointerId !== selectionHandleDrag.pointerId) return;
            event.preventDefault();
            event.stopPropagation();
            const coords = touchCellCoords(term, touchPointFromEvent(event));
            if (!coords) return;
            applySelectionRange(term, selectionHandleDrag.anchor, coords);
          };

          const onHandlePointerUp = (event) => {
            if (!selectionHandleDrag || event.pointerId !== selectionHandleDrag.pointerId) return;
            event.preventDefault();
            event.stopPropagation();
            const target = event.currentTarget;
            if (target.hasPointerCapture?.(event.pointerId)) {
              target.releasePointerCapture?.(event.pointerId);
            }
            selectionHandleDrag = null;
            updateSelectionHandles(term);
            copySelectionAfterInteraction();
          };

          for (const handle of [start, end]) {
            handle.addEventListener("pointerdown", onHandlePointerDown, { passive: false });
            handle.addEventListener("pointermove", onHandlePointerMove, { passive: false });
            handle.addEventListener("pointerup", onHandlePointerUp, { passive: false });
            handle.addEventListener("pointercancel", onHandlePointerUp, { passive: false });
          }
        }

        function enterTwoFingerScroll(term) {
          const center = touchCenterPoint();
          if (!center) return;
          clearTouchLongPressTimer();
          touchGesture = {
            pointerId: null,
            mode: "twoFingerScrolling",
            startPoint: center,
            lastY: center.clientY,
            forceSelection: false,
            longPressTimer: null,
            scrollRemainderPx: 0,
          };
        }

        function installTouchSelectionBridge(term) {
          const element = term && term.element;
          if (!element || element.dataset.touchSelectionBridge === "true") return;
          element.dataset.touchSelectionBridge = "true";

          const pointerOptions = { passive: false };

          element.addEventListener("pointerdown", (event) => {
            if (!isTouchPointer(event)) return;
            const point = rememberTouchPointer(event);
            event.preventDefault();
            event.stopPropagation();
            element.setPointerCapture?.(event.pointerId);
            if (touchPointers.size >= 2) {
              enterTwoFingerScroll(term);
              return;
            }
            if (touchGesture !== null) return;
            touchGesture = {
              pointerId: event.pointerId,
              mode: "pending",
              startPoint: point,
              lastY: point.clientY,
              forceSelection: false,
              selectionSeed: null,
              longPressTimer: null,
              scrollRemainderPx: 0,
            };
            touchGesture.longPressTimer = window.setTimeout(
              () => startTouchSelection(term, element, event.pointerId),
              INTERNAL_TOUCH_LONG_PRESS_DELAY_MS
            );
          }, pointerOptions);

          element.addEventListener("pointermove", (event) => {
            if (!isTouchPointer(event) || !touchPointers.has(event.pointerId)) return;
            const point = rememberTouchPointer(event);
            event.preventDefault();
            event.stopPropagation();

            if (touchGesture && touchGesture.mode === "twoFingerScrolling") {
              const center = touchCenterPoint();
              if (!center) return;
              const deltaY = center.clientY - touchGesture.lastY;
              touchGesture.lastY = center.clientY;
              routeTwoFingerScroll(term, deltaY, center);
              return;
            }

            if (!touchGesture || event.pointerId !== touchGesture.pointerId) return;

            if (touchGesture.mode === "pending") {
              const movedX = point.clientX - touchGesture.startPoint.clientX;
              const movedY = point.clientY - touchGesture.startPoint.clientY;
              if (Math.hypot(movedX, movedY) <= INTERNAL_TOUCH_SCROLL_SLOP_PX) return;
              clearTouchLongPressTimer();
              touchGesture.mode = "scrolling";
            }

            if (touchGesture.mode === "scrolling") {
              const deltaY = point.clientY - touchGesture.lastY;
              touchGesture.lastY = point.clientY;
              routeOneFingerScroll(term, deltaY, point);
              return;
            }

            extendTouchSelection(term, touchGesture, point);
          }, pointerOptions);

          const finishTouchSelection = (event) => {
            if (!isTouchPointer(event) || !touchPointers.has(event.pointerId)) return;
            const point = touchPointFromEvent(event);
            event.preventDefault();
            event.stopPropagation();
            touchPointers.delete(event.pointerId);
            releaseTouchPointer(element, event.pointerId);
            if (touchGesture && touchGesture.mode === "twoFingerScrolling") {
              if (touchPointers.size >= 2) {
                const center = touchCenterPoint();
                if (center) touchGesture.lastY = center.clientY;
                return;
              }
              resetTouchGesture(element);
              updateTerminalControls();
              return;
            }
            if (!touchGesture || event.pointerId !== touchGesture.pointerId) return;
            clearTouchLongPressTimer();
            if (touchGesture.mode === "pending") {
              handleTouchTap(term, element, point);
            }
            resetTouchGesture(element);
            updateTerminalControls();
            updateSelectionHandles(term);
            copySelectionAfterInteraction();
          };

          element.addEventListener("pointerup", finishTouchSelection, pointerOptions);
          element.addEventListener("pointercancel", finishTouchSelection, pointerOptions);
        }

        // CSI query sequences whose only effect is to make the terminal emit a
        // reply. The remote xterm is a display mirror; the desktop pane is the
        // authoritative responder, so the mirror must answer none of these
        // (issue #480). Keyed the way xterm's parser matches — prefix (private
        // marker), intermediates, final byte. Pure queries carry no display
        // side effect, so a handler that returns true only drops the reply.
        // DECSCUSR (CSI SP q) is intentionally left alone; only XTVERSION
        // (CSI > q) is suppressed.
        const MIRROR_SUPPRESSED_CSI = [
          { final: "n" }, // DSR / cursor position report (ANSI)
          { prefix: "?", final: "n" }, // DSR (DEC private)
          { final: "c" }, // Primary Device Attributes
          { prefix: ">", final: "c" }, // Secondary Device Attributes
          { prefix: "=", final: "c" }, // Tertiary Device Attributes
          { intermediates: "$", final: "p" }, // DECRQM (ANSI)
          { prefix: "?", intermediates: "$", final: "p" }, // DECRQM (DEC private)
          { prefix: ">", final: "q" }, // XTVERSION
        ];

        // OSC 4/10/11/12 can stack color setters and queries in one payload.
        // Parser handlers are all-or-nothing, so claim every payload containing
        // a query and apply only its setter slots synchronously at that parser
        // position. Re-entering term.write here would append the setter behind
        // the current write buffer and reverse it with later setters/resets.
        const MIRROR_SUPPRESSED_COLOR_OSC = [4, 10, 11, 12];

        function mirrorColorSetterCalls(ident, data) {
          const fields = data.split(";");
          if (ident === 4) {
            let containsQuery = false;
            const setterFields = [];
            for (let index = 0; index + 1 < fields.length; index += 2) {
              const colorIndex = fields[index];
              const specification = fields[index + 1];
              const parsedIndex = /^\d+$/.test(colorIndex)
                ? Number(colorIndex)
                : -1;
              if (
                parsedIndex >= 0 &&
                parsedIndex <= 255 &&
                specification === "?"
              ) {
                containsQuery = true;
              } else {
                setterFields.push(colorIndex, specification);
              }
            }
            if (!containsQuery) return null;
            return setterFields.length
              ? [{ ident: 4, data: setterFields.join(";") }]
              : [];
          }

          let containsQuery = false;
          const setterCalls = [];
          for (
            let offset = 0;
            offset < fields.length && ident + offset <= 12;
            offset += 1
          ) {
            const specification = fields[offset];
            if (specification === "?") {
              containsQuery = true;
            } else if (specification) {
              setterCalls.push({ ident: ident + offset, data: specification });
            }
          }
          return containsQuery ? setterCalls : null;
        }

        function applyMirrorColorSetter(term, ident, data) {
          // xterm 6.0.0 exposes the built-in OSC color handlers through this
          // pinned private adapter. Calling them directly keeps the mutation at
          // the exact parser position while the custom handler suppresses only
          // REPORT events. A missing/changed adapter must fail loudly rather
          // than silently reordering or dropping a setter.
          const inputHandler = term && term._core && term._core._inputHandler;
          let setter = null;
          if (ident === 4) setter = inputHandler && inputHandler.setOrReportIndexedColor;
          else if (ident === 10) setter = inputHandler && inputHandler.setOrReportFgColor;
          else if (ident === 11) setter = inputHandler && inputHandler.setOrReportBgColor;
          else if (ident === 12) setter = inputHandler && inputHandler.setOrReportCursorColor;
          if (
            typeof setter !== "function" ||
            setter.call(inputHandler, data) !== true
          ) {
            throw new Error(
              `xterm color setter adapter unavailable for OSC ${ident}`,
            );
          }
        }

        // A running program's queries are answered once, by the desktop pane.
        // Without this the mirror answers them a second time — every prompt
        // render emits DSR, and reconnect replays the whole scrollback at once —
        // and those replies land on the shell prompt as stray input (issue #480).
        function suppressMirrorQueryReplies(term) {
          const parser = term.parser;
          if (!parser) return;
          if (typeof parser.registerCsiHandler === "function") {
            for (const id of MIRROR_SUPPRESSED_CSI) {
              parser.registerCsiHandler(id, () => true);
            }
          }
          if (typeof parser.registerOscHandler === "function") {
            for (const ident of MIRROR_SUPPRESSED_COLOR_OSC) {
              parser.registerOscHandler(ident, (data) => {
                const setterCalls = mirrorColorSetterCalls(ident, data);
                if (setterCalls === null) return false;
                for (const setterCall of setterCalls) {
                  applyMirrorColorSetter(
                    term,
                    setterCall.ident,
                    setterCall.data,
                  );
                }
                return true;
              });
            }
          }
        }

        // Cell clusters of a preedit string, from the one width table this
        // surface uses (`unicode-provider.js`, ADR-0058). The fallback only
        // runs when that asset is missing — the same degraded state the
        // provider registration above already warns about — and then splits per
        // code point, so a combining mark shows as its own box instead of
        // widening its base. Wrong, but bounded and still cell-aligned.
        function compositionCellClusters(text) {
          const provider = window.LaymuxUnicodeProvider;
          if (provider && typeof provider.splitCellClusters === "function") {
            return provider.splitCellClusters(text);
          }
          return Array.from(text, (segment) => ({
            segment,
            width: provider && typeof provider.wcwidth === "function"
              ? provider.wcwidth(segment.codePointAt(0) || 0)
              : 1,
          }));
        }

        // Lay the IME preedit on the cells its committed text will occupy
        // (ADR-0171).
        //
        // xterm's DOM renderer gives every committed span a per-glyph
        // letter-spacing (`_setDefaultSpacing`) so the glyph fills exactly the
        // cells `wcwidth` claims for it. Its composition view gets no such
        // spacing: it is the raw preedit string laid out at the font's natural
        // advance. A Hangul syllable advances ~1 cell in the fallback face while
        // the committed run takes 2, so the composing text renders narrower than
        // itself and every glyph jumps right the moment the IME commits.
        //
        // Fix the layout, not the position: xterm already anchors the view at the
        // cursor cell and keeps it there (`updateCompositionElements`), so only
        // the view's own content is re-laid here — one inline-block box per
        // cluster, each exactly as many cells wide as the buffer will spend.
        // xterm writes `textContent` on compositionstart and compositionupdate
        // only, and these listeners are registered on the same textarea after
        // its own, so nothing overwrites the boxes afterwards. The box widths
        // also give `updateCompositionElements` a correctly sized rect to
        // mirror onto the helper textarea, which is where the OS candidate
        // window anchors (ADR-0061).
        //
        // Not in scope: the view still does not wrap at the right edge — that is
        // xterm's own `white-space: nowrap` behaviour and is unchanged here.
        function installCompositionCellLayout(term) {
          const textarea = term.textarea;
          const view = term.element && term.element.querySelector(".composition-view");
          if (!textarea || !view) return;
          const relayout = (text) => {
            const metrics = terminalMetrics(term);
            const cellWidth = metrics ? metrics.cellWidth : 0;
            if (!text || !(cellWidth > 0)) {
              view.replaceChildren();
              return;
            }
            const cells = compositionCellClusters(text).map((cluster) => {
              const cell = document.createElement("span");
              cell.className = "remote-composition-cell";
              cell.textContent = cluster.segment;
              cell.style.width = `${Math.max(0, cluster.width) * cellWidth}px`;
              return cell;
            });
            view.replaceChildren(...cells);
          };
          textarea.addEventListener("compositionstart", () => relayout(""));
          textarea.addEventListener("compositionupdate", (event) => relayout(event.data || ""));
          // xterm drops `.active` here, so the view is hidden either way; clearing
          // keeps a stale preedit from flashing when the next composition starts.
          textarea.addEventListener("compositionend", () => relayout(""));
        }

        function ensureTerminal(appearance = {}) {
          if (terminal) return terminal;
          const TerminalCtor = window.Terminal;
          const FitAddonCtor = window.FitAddon && window.FitAddon.FitAddon;
          const WebLinksAddonCtor =
            window.WebLinksAddon && window.WebLinksAddon.WebLinksAddon;
          if (!TerminalCtor || !FitAddonCtor) {
            throw new Error("xterm assets failed to load");
          }
          applyTerminalSurfaceBackground(appearance);
          adoptTouchScrollSensitivity(appearance);
          terminal = new TerminalCtor(terminalOptionsForAppearance(appearance));
          // Register the shared width provider before any write so no row is ever
          // laid out with xterm default Unicode 6 widths and then measured with
          // these (ADR-0058, issue #538). Degrade rather than break if the asset
          // is unavailable: the terminal stays usable on xterm own widths.
          //
          // Unlike the desktop, a silent fallback here does not resurrect a second
          // source of truth — the asset is the only table on this surface. But it
          // is undiagnosable, and the symptom ("only lines with emoji wrap at the
          // wrong column") gives no path to the cause, so both miss paths warn.
          //
          // `terminal.unicode` is read outside the try on purpose: it is a
          // proposed API and only exists because `terminalOptionsForAppearance`
          // sets `allowProposedApi: true` (already required for IDecoration). If
          // that option ever goes away this read throws during terminal creation
          // rather than degrading, which is the louder and correct failure.
          const unicodeProvider = window.LaymuxUnicodeProvider;
          if (unicodeProvider && terminal.unicode) {
            try {
              terminal.unicode.register(unicodeProvider);
              terminal.unicode.activeVersion = unicodeProvider.version;
            } catch (error) {
              console.warn(
                "laymux: cell-width provider registration failed; falling back to xterm default widths",
                error
              );
            }
          } else {
            // The more likely miss in practice: the asset 404d, was blocked, or a
            // cached page.html predates the script tag.
            console.warn(
              "laymux: cell-width provider unavailable; falling back to xterm default widths",
              { assetLoaded: !!unicodeProvider, unicodeApi: !!terminal.unicode }
            );
          }
          fitAddon = new FitAddonCtor();
          terminal.loadAddon(fitAddon);
          // Keep the terminal usable if this non-core asset is unavailable;
          // OSC 8 links still use linkHandler and the Rust asset test guards
          // the production bundle. Plain-text link activation degrades only.
          if (WebLinksAddonCtor) {
            const webLinksAddon = new WebLinksAddonCtor((_event, uri) =>
              openRemoteUrl(uri)
            );
            terminal.loadAddon(webLinksAddon);
          }
          // Link providers are additive. Keep the Remote terminal usable when
          // a minimal or older xterm surface does not expose this optional API.
          if (typeof terminal.registerLinkProvider === "function") {
            terminal.registerLinkProvider(createRemotePrLinkProvider(terminal));
          }
          terminal.open(terminalSizer);
          // xterm's helper textarea ships autocorrect/autocapitalize/spellcheck
          // off but omits autocomplete, so mobile browsers offer password,
          // credit-card, and location autofill over the direct-input keyboard
          // (issue #503). Match the composer/file-path fields and opt out.
          terminal.textarea?.setAttribute("autocomplete", "off");
          suppressMirrorQueryReplies(terminal);
          terminalHost.addEventListener(
            "focusin",
            (event) => {
              if (
                currentInputMode() === "composer" &&
                terminal &&
                event.target === terminal.textarea
              ) {
                queueMicrotask(() => terminal?.blur?.());
              }
            },
            true
          );
          terminalHost.addEventListener("paste", handleDirectTerminalPaste, true);
          // Mouse wheel at row 0: xterm swallows the event without scrolling,
          // so ask for older history from here instead of from onScroll.
          terminalHost.addEventListener(
            "wheel",
            (event) => {
              if (event.deltaY >= 0 || !isNormalScrollbackMode(terminal)) return;
              markTerminalUserScroll();
              requestOlderTerminalHistory();
            },
            { passive: true }
          );
          // xterm scrolls the viewport itself on Shift+PageUp, so that scroll
          // surfaces only as `onScroll`. Stamp the key that caused it. Plain
          // PageUp and Home go to the PTY instead and must not vouch for
          // anything. A pointer press is deliberately not a vouch: a selection
          // drag auto-scrolls to row 0 too, and replacing the screen under a
          // drag in progress would destroy the selection being made.
          terminalHost.addEventListener(
            "keydown",
            (event) => {
              if (event.shiftKey && event.key === "PageUp") markTerminalUserScroll();
            },
            true
          );
          installSelectionHandles(terminal);
          installTouchSelectionBridge(terminal);
          installCompositionCellLayout(terminal);
          terminal.onData((data) => {
            // Known query replies are already suppressed at the parser
            // (suppressMirrorQueryReplies). This is the catch-all for the
            // reconnect flood (issue #480): a whole-scrollback replay can make
            // xterm emit replies to any sequence we did not enumerate, so drop
            // all onData while a replay write is in flight and forward only
            // genuine user input.
            if (terminalReplayDepth > 0) return;
            if (isAlternateBufferCursorInput(terminal, data)) {
              enqueueDiscreteInput(data);
              return;
            }
            enqueueInput(data);
          });
          terminal.onResize(({ cols, rows }) => {
            schedulePathLinkSelectionEvaluation();
            // Reflow moves every cell: the previous screen scan is void and its
            // signature must not suppress the rescan (ADR-0188).
            pathLinkLastScreenSignature = null;
            schedulePathLinkIdleScan();
            queueResize(cols, rows);
          });
          terminal.onSelectionChange(() => {
            updateTerminalControls();
            updateSelectionHandles(terminal);
            if (!terminal.hasSelection()) lastCopiedSelection = "";
            // Dragging emits one event per changed cell. Clear stale visuals
            // immediately, but wait for the selection to settle before the
            // HTTP -> bridge -> filesystem validation.
            schedulePathLinkSelectionEvaluation();
          });
          terminal.onScroll?.(() => {
            updateSelectionHandles(terminal);
            updateScrollToBottomButton(terminal);
            scheduleCropTransform();
            // A new viewport is a new screen to scan once it settles (ADR-0188).
            schedulePathLinkIdleScan();
            // Only a viewport that *arrives* at row 0 under a gesture counts as
            // reaching the top. Snapshot replay and a pane with no scrollback
            // both sit at row 0 without the user asking for anything, and a
            // flood that fills the scrollback pushes a parked viewport down to
            // row 0 on its own. Pulling further up is the gesture handlers'
            // signal, not this one.
            const viewportY = terminal.buffer?.active?.viewportY ?? 0;
            const previousViewportY = lastTerminalViewportY;
            lastTerminalViewportY = viewportY;
            if (viewportY === 0 && previousViewportY > 0 && terminalScrollIsUserDriven()) {
              requestOlderTerminalHistory();
            }
          });
          terminal.onCursorMove?.(() => updateCropTransform());
          terminal.onRender?.(() => scheduleCropTransform());
          // Entering the alternate buffer while a height-shrink crop is active
          // must re-fit so full-screen apps get the real surface rows.
          terminal.buffer?.onBufferChange?.(() => {
            schedulePathLinkSelectionEvaluation();
            // Alternate-buffer switches replace the visible screen wholesale.
            pathLinkLastScreenSignature = null;
            schedulePathLinkIdleScan();
            scheduleTerminalFit(Boolean(activeTerminalId));
          });
          if ("ResizeObserver" in window) {
            resizeObserver = new ResizeObserver(() => fitTerminal());
            resizeObserver.observe(terminalHost);
            if (terminalShell) resizeObserver.observe(terminalShell);
          } else if (!resizeListenerAttached) {
            window.addEventListener("resize", () => fitTerminal());
            resizeListenerAttached = true;
          }
          renderInputSurface();
          scheduleTerminalFit(Boolean(activeTerminalId));
          return terminal;
        }

        function stopOutputReconnect(resetAttempt = true) {
          if (outputReconnectTimer) {
            clearTimeout(outputReconnectTimer);
            outputReconnectTimer = null;
          }
          if (resetAttempt) outputReconnectAttempt = 0;
        }

        function stopSocket(resetReconnect = true) {
          terminalOutputGeneration += 1;
          outputAttachGeometryGeneration = null;
          stopOutputReconnect(resetReconnect);
          if (resetReconnect) clearTransientConnectionNotice("output");
          composerReady = false;
          updateComposerControls();
          if (socket) {
            const closingSocket = socket;
            socket = null;
            closingSocket.onclose = null;
            closingSocket.onerror = null;
            closingSocket.close();
          }
        }

        function stopHeartbeat() {
          if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
          }
          if (heartbeatRetryTimer) {
            clearTimeout(heartbeatRetryTimer);
            heartbeatRetryTimer = null;
          }
          if (heartbeatAbortController) {
            heartbeatAbortController.abort();
            heartbeatAbortController = null;
          }
          heartbeatInFlight = false;
        }

        function stopInputFlush() {
          if (inputFlushTimer) {
            clearTimeout(inputFlushTimer);
            inputFlushTimer = null;
          }
          pendingInput = "";
          pendingInputTerminalId = null;
          pendingInputLeaseId = null;
        }

        function stopResizeFlush() {
          if (resizeTimer) {
            clearTimeout(resizeTimer);
            resizeTimer = null;
          }
        }

        function heartbeatRequestTimeoutMs() {
          return Math.min(
            HEARTBEAT_REQUEST_TIMEOUT_MAX_MS,
            Math.max(HEARTBEAT_INTERVAL_MIN_MS, Math.floor(heartbeatTimeoutMs / 3))
          );
        }

        async function heartbeat() {
          if (!leaseId || heartbeatInFlight) return;
          const heartbeatLeaseId = leaseId;
          heartbeatInFlight = true;
          const controller = typeof AbortController === "function" ? new AbortController() : null;
          heartbeatAbortController = controller;
          const requestTimeoutMs = heartbeatRequestTimeoutMs();
          const abortTimer = controller
            ? setTimeout(() => controller.abort(), requestTimeoutMs)
            : null;
          try {
            await remoteFetch("/remote/v1/session/heartbeat", {
              method: "POST",
              body: JSON.stringify({ leaseId: heartbeatLeaseId }),
              ...(controller ? { signal: controller.signal } : {}),
            });
            if (leaseId !== heartbeatLeaseId || heartbeatAbortController !== controller) return;
            lastHeartbeatOkAt = Date.now();
            if (heartbeatRetryTimer) {
              clearTimeout(heartbeatRetryTimer);
              heartbeatRetryTimer = null;
            }
            clearTransientConnectionNotice(
              "heartbeat",
              activeTerminalId ? `Connected to ${activeTerminalId}` : "Connected."
            );
          } catch (err) {
            if (leaseId === heartbeatLeaseId && heartbeatAbortController === controller) throw err;
          } finally {
            if (abortTimer) clearTimeout(abortTimer);
            if (heartbeatAbortController === controller) {
              heartbeatAbortController = null;
              heartbeatInFlight = false;
            }
          }
        }

        function isFatalRemoteControlError(err) {
          return err && (err.status === 401 || err.status === 403 || err.status === 409);
        }

        function heartbeatTimedOut() {
          return Date.now() - lastHeartbeatOkAt >= heartbeatTimeoutMs;
        }

        function scheduleHeartbeatRetry() {
          if (!leaseId || heartbeatRetryTimer) return;
          heartbeatRetryTimer = setTimeout(() => {
            heartbeatRetryTimer = null;
            heartbeat().catch((err) => handleHeartbeatError(err));
          }, HEARTBEAT_RETRY_DELAY_MS);
        }

        function handleHeartbeatError(err) {
          if (!leaseId) return;
          if (isFatalRemoteControlError(err) || heartbeatTimedOut()) {
            // A heartbeat `409` is literally "your lease is not active" — it does not
            // say who has control now, and an expiry while we were away answers it the
            // same way a host takeover does. Only `401`/`403` (bad token, remote
            // access off) are answers on their own; ownership is what the next claim
            // asks, and its reply decides whether to keep trying (issue #561).
            loseRemoteControl(`Control returned to the host. ${err.message}`, {
              hostTookOver: err && (err.status === 401 || err.status === 403),
            });
            return;
          }
          scheduleTransientConnectionNotice("heartbeat");
          scheduleHeartbeatRetry();
        }

        function startHeartbeat(timeoutSeconds) {
          stopHeartbeat();
          heartbeatTimeoutMs = Math.max(
            HEARTBEAT_INTERVAL_MAX_MS,
            Math.floor(timeoutSeconds * 1000)
          );
          lastHeartbeatOkAt = Date.now();
          const intervalMs = Math.min(
            HEARTBEAT_INTERVAL_MAX_MS,
            Math.max(HEARTBEAT_INTERVAL_MIN_MS, Math.floor(heartbeatTimeoutMs / 3))
          );
          heartbeatTimer = setInterval(() => {
            heartbeat().catch((err) => {
              handleHeartbeatError(err);
            });
          }, intervalMs);
        }

        function terminalLabel(terminalInfo) {
          return [terminalInfo.title || terminalInfo.id, terminalInfo.profile || "", terminalInfo.cwd || ""]
            .filter(Boolean)
            .join(" - ");
        }

        function shortPath(path) {
          if (!path) return "";
          const parts = String(path).split(/[\\/]+/).filter(Boolean);
          return parts[parts.length - 1] || path;
        }

        function activityLabel(activity, commandRunning) {
          if (activity && activity.type === "interactiveApp") return activity.name || "Interactive";
          if (activity && activity.type === "running") return "Running";
          if (commandRunning) return "Running";
          return "";
        }

        // Mirror the desktop WorkspaceSelector activity-badge colors: Claude and
        // Codex keep their brand hue, other interactive apps use the accent, and
        // command activity uses the running color. Source of truth: formatActivity
        // in ui/src/lib/workspace-summary.ts.
        function activityClass(activity) {
          if (activity && activity.type === "interactiveApp") {
            if (activity.name === "Claude") return "claude";
            if (activity.name === "Codex") return "codex";
            return "interactive";
          }
          return "running";
        }

        function metaText(parts) {
          return parts.filter(Boolean).join(" - ");
        }

        function countBadgeText(count) {
          const value = Number(count) || 0;
          return value > 999 ? "999+" : String(value);
        }

        function countBadgeFontSize(text) {
          const sizes = ["10px", "10px", "9.5px", "8.5px", "7.5px"];
          return sizes[Math.min(text.length, sizes.length - 1)];
        }

        function fillCountBadge(element, count) {
          const text = countBadgeText(count);
          element.textContent = text;
          element.style.fontSize = countBadgeFontSize(text);
        }

        function notificationCount() {
          return ((navigationState && navigationState.notifications) || []).length;
        }

        function unreadNotificationCount() {
          return Number((navigationState && navigationState.unreadNotificationCount) || 0);
        }

        function loadSpatialExcludedPaneIds() {
          try {
            const raw = JSON.parse(localStorage.getItem(spatialExcludedPaneIdsKey) || "[]");
            if (!Array.isArray(raw)) return new Set();
            return new Set(raw.filter((paneId) => typeof paneId === "string" && paneId.length > 0));
          } catch (_) {
            return new Set();
          }
        }

        function saveSpatialExcludedPaneIds() {
          try {
            localStorage.setItem(
              spatialExcludedPaneIdsKey,
              JSON.stringify([...spatialExcludedPaneIds].sort())
            );
          } catch (_) {}
        }

        function loadSpatialExcludedWorkspaceIds() {
          try {
            const raw = JSON.parse(localStorage.getItem(spatialExcludedWorkspaceIdsKey) || "[]");
            if (!Array.isArray(raw)) return new Set();
            return new Set(raw.filter((id) => typeof id === "string" && id.length > 0));
          } catch (_) {
            return new Set();
          }
        }

        function saveSpatialExcludedWorkspaceIds() {
          try {
            localStorage.setItem(
              spatialExcludedWorkspaceIdsKey,
              JSON.stringify([...spatialExcludedWorkspaceIds].sort())
            );
          } catch (_) {}
        }

        // --- Pure workspace-skip promotion/demotion rules (issue #507, ADR-0047) ---
        //
        // These take the current denylists as string arrays plus the workspace
        // context and return the next denylists; they mutate nothing so they are
        // straightforward to reason about and test. The invariant they preserve,
        // for every workspace in the navigation snapshot: the workspace id is
        // in the workspace denylist IFF every one of its terminal panes is in
        // the pane denylist.

        // Toggling one pane: flip it in the pane set, then promote (all panes now
        // excluded) or demote (not all) the owning workspace to match.
        function computeSkipStateAfterPaneToggle({
          workspaceId,
          terminalPaneIds,
          paneId,
          excludedPaneIds,
          excludedWorkspaceIds,
        }) {
          const paneSet = new Set(excludedPaneIds);
          const workspaceSet = new Set(excludedWorkspaceIds);
          const willExclude = !paneSet.has(paneId);
          if (willExclude) paneSet.add(paneId);
          else paneSet.delete(paneId);
          if (workspaceId) {
            const allExcluded =
              terminalPaneIds.length > 0 && terminalPaneIds.every((id) => paneSet.has(id));
            if (allExcluded) workspaceSet.add(workspaceId);
            else workspaceSet.delete(workspaceId);
          }
          return {
            paneIds: [...paneSet].sort(),
            workspaceIds: [...workspaceSet].sort(),
            willExclude,
          };
        }

        // Toggling a whole workspace: flip it in the workspace set and add/remove
        // all of its known pane ids so the pane toggle stays consistent in both
        // directions.
        function computeSkipStateAfterWorkspaceToggle({
          workspaceId,
          terminalPaneIds,
          excludedPaneIds,
          excludedWorkspaceIds,
        }) {
          const paneSet = new Set(excludedPaneIds);
          const workspaceSet = new Set(excludedWorkspaceIds);
          const willExclude = !workspaceSet.has(workspaceId);
          if (willExclude) {
            workspaceSet.add(workspaceId);
            terminalPaneIds.forEach((id) => paneSet.add(id));
          } else {
            workspaceSet.delete(workspaceId);
            terminalPaneIds.forEach((id) => paneSet.delete(id));
          }
          return {
            paneIds: [...paneSet].sort(),
            workspaceIds: [...workspaceSet].sort(),
            willExclude,
          };
        }

        // Terminal pane ids of any workspace from the latest navigation snapshot.
        function workspaceTerminalPaneIds(workspaceId) {
          if (!workspaceId || !navigationState) return [];
          const workspace = (navigationState.workspaces || []).find((item) => item.id === workspaceId);
          if (!workspace) return [];
          return (workspace.panes || [])
            .filter((pane) => pane.id && pane.viewType === "TerminalView")
            .map((pane) => pane.id);
        }

        // Expand persisted whole-workspace exclusions to their pane ids and
        // persist if needed. Runs before the drawer/header are drawn.
        function reconcileWorkspaceSkips() {
          if (!navigationState) return;
          const before = spatialExcludedPaneIds.size;
          (navigationState.workspaces || [])
            .filter((workspace) => spatialExcludedWorkspaceIds.has(workspace.id))
            .forEach((workspace) => {
              workspaceTerminalPaneIds(workspace.id).forEach((id) => spatialExcludedPaneIds.add(id));
            });
          if (spatialExcludedPaneIds.size !== before) saveSpatialExcludedPaneIds();
        }

        function updateNotificationActions() {
          const hasNotifications = notificationCount() > 0;
          const hasUnread = unreadNotificationCount() > 0;
          markAllNotificationsReadButton.disabled = !leaseId || !hasUnread;
          clearNotificationsButton.disabled = !leaseId || !hasNotifications;
        }

        // Context of the terminal the viewport is attached to, resolved from
        // the last navigation payload (terminals[] carries workspaceId and
        // paneNumber; dock terminals have no workspace entry).
        function activeTerminalContext() {
          if (!activeTerminalId || !navigationState) return null;
          const info = terminalInfoById.get(activeTerminalId);
          if (!info) return null;
          const workspace = (navigationState.workspaces || []).find((ws) => ws.id === info.workspaceId) || null;
          const paneNumber = Number(info.paneNumber);
          return {
            info,
            workspace,
            paneNumber: Number.isFinite(paneNumber) && paneNumber > 0 ? paneNumber : null,
          };
        }

        function activeWorkspacePane() {
          if (!activeTerminalId || !navigationState) return null;
          const panes = (navigationState.activeWorkspace && navigationState.activeWorkspace.panes) || [];
          return panes.find(
            (pane) =>
              pane.id &&
              pane.terminalId === activeTerminalId &&
              pane.viewType === "TerminalView"
          ) || null;
        }

        // "Workspace · Pane N" header title — the friendly replacement for the
        // raw "Connected to terminal-…" id, doubling as the landing indicator
        // after a navigation step.
        function activeTerminalTitle() {
          const ctx = activeTerminalContext();
          if (!ctx) return "";
          if (!ctx.workspace) return ctx.info.title || activeTerminalId || "";
          return ctx.paneNumber
            ? `${ctx.workspace.name} · Pane ${ctx.paneNumber}`
            : ctx.workspace.name;
        }

        // lx:pane:<workspaceName>:<paneNumber> — the same LLM-facing locator the
        // desktop pane badge copies. Workspace names are stored whitespace-free;
        // guard anyway so a malformed name never produces a broken locator.
        function activePaneIdentifier() {
          const ctx = activeTerminalContext();
          if (!ctx || !ctx.workspace || !ctx.paneNumber) return null;
          const name = String(ctx.workspace.name || "");
          if (!name || /\s/.test(name)) return null;
          return `lx:pane:${name}:${ctx.paneNumber}`;
        }

        function updateHeaderPaneIdentity() {
          const pane = activeWorkspacePane();
          copyPaneIdButton.hidden = !activePaneIdentifier();
          spatialExclusionButton.hidden = !pane;
          const excluded = Boolean(pane && spatialExcludedPaneIds.has(pane.id));
          spatialExclusionButton.setAttribute("aria-pressed", String(excluded));
          const label = excluded
            ? "Include this pane in pane navigation"
            : "Exclude this pane from pane navigation";
          spatialExclusionButton.setAttribute("aria-label", label);
          spatialExclusionButton.title = label;
        }

        function setDockPanelOpen(open) {
          dockPanelOpen = Boolean(open);
          dockPanel.hidden = !dockPanelOpen;
          dockToggleButton.setAttribute("aria-expanded", String(dockPanelOpen));
        }

        function formatNotificationTime(createdAt) {
          const timestamp = Number(createdAt);
          if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
          const diff = Date.now() - timestamp;
          if (diff < 60000) return "now";
          if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
          if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
          return `${Math.floor(diff / 86400000)}d`;
        }

        function notificationSource(notification) {
          return notification.terminalLabel || notification.title || notification.workspaceName || notification.workspaceId || "Notification";
        }

        function notificationLevelClass(level) {
          return ["error", "warning", "success", "info"].includes(level) ? level : "info";
        }

        function renderNotificationPanel(notifications, unreadCount) {
          const badgeCount = Math.max(0, Number(unreadCount) || 0);
          const hasUnread = badgeCount > 0;
          drawerNotificationsButton.classList.toggle("status-indicator", hasUnread);
          const notificationLabel = hasUnread
            ? `Open notifications (${badgeCount} unread)`
            : "Open notifications";
          drawerNotificationsButton.setAttribute("aria-label", notificationLabel);
          drawerNotificationsButton.title = hasUnread
            ? `Notifications (${badgeCount} unread)`
            : "Notifications";
          notificationListEl.innerHTML = "";
          if (!notifications.length) {
            emptyNav(notificationListEl, "No notifications.");
            updateNotificationActions();
            return;
          }

          const workspaceKeys = [];
          for (const notification of notifications) {
            const workspaceKey = notification.workspaceId || "__global__";
            if (!workspaceKeys.includes(workspaceKey)) {
              workspaceKeys.push(workspaceKey);
            }
          }
          for (const workspaceKey of workspaceKeys) {
            const groupNotifications = notifications.filter((notification) => (notification.workspaceId || "__global__") === workspaceKey);
            const first = groupNotifications[0] || {};
            const title = document.createElement("div");
            title.className = "notification-group-title";
            title.textContent = first.workspaceName || first.workspaceId || "Notifications";
            notificationListEl.append(title);
            groupNotifications.forEach((notification) => {
              notificationListEl.append(renderNotificationItem(notification));
            });
          }
          updateNotificationActions();
        }

        function renderNotificationItem(notification) {
          const item = document.createElement("button");
          item.type = "button";
          item.className = `notification-item${notification.isRead ? " read" : ""}`;
          item.disabled = !leaseId;
          item.dataset.notificationId = notification.id || "";
          item.addEventListener("click", () => {
            openNotification(notification).catch((err) => setStatus(err.message || String(err), true));
          });

          const source = document.createElement("span");
          source.className = "notification-source";
          source.textContent = notificationSource(notification);
          item.append(source);

          const message = document.createElement("span");
          message.className = `notification-message ${notificationLevelClass(notification.level)}`;
          message.textContent = notification.message || "";
          item.append(message);

          const time = document.createElement("span");
          time.className = "notification-time";
          time.textContent = formatNotificationTime(notification.createdAt);
          item.append(time);

          return item;
        }

        function workspaceDisplaySettings() {
          const display = navigationState && navigationState.workspaceSelector && navigationState.workspaceSelector.display;
          return {
            minimap: display && typeof display.minimap === "boolean" ? display.minimap : true,
            environment: display && typeof display.environment === "boolean" ? display.environment : true,
            activity: display && typeof display.activity === "boolean" ? display.activity : true,
            path: display && typeof display.path === "boolean" ? display.path : true,
            result: display && typeof display.result === "boolean" ? display.result : true,
          };
        }

        function pathEllipsisMode() {
          const selector = navigationState && navigationState.workspaceSelector;
          return selector && selector.pathEllipsis === "end" ? "end" : "start";
        }

        function workspaceLastInputMode() {
          const selector = navigationState && navigationState.workspaceSelector;
          return selector && selector.lastInputMode === "workspaceLatest"
            ? "workspaceLatest"
            : "perPane";
        }

        function paneLastInputEntry(pane) {
          const selectorDisplay = pane.selectorDisplay || {};
          const text = selectorDisplay.lastInput || pane.lastCommand || "";
          if (!text) return null;
          const timestamp = Number(
            selectorDisplay.lastInputAt ?? pane.lastCommandAt ?? 0,
          );
          return {
            text,
            timestamp: Number.isFinite(timestamp) ? timestamp : 0,
          };
        }

        function latestWorkspaceInput(panes) {
          let latest = null;
          panes.forEach((pane) => {
            if (pane.hidden === true || !isTerminalPane(pane)) return;
            const candidate = paneLastInputEntry(pane);
            if (candidate && (!latest || candidate.timestamp > latest.timestamp)) {
              latest = candidate;
            }
          });
          return latest;
        }

        function emptyNav(container, text) {
          container.innerHTML = "";
          const item = document.createElement("div");
          item.className = "nav-empty";
          item.textContent = text;
          container.append(item);
        }

        function setNavigationOpen(open) {
          if (open) setDrawerView(leaseId ? "workspace" : "connection");
          document.querySelector(".app").classList.toggle("nav-open", open);
          navToggleButton.setAttribute("aria-expanded", String(open));
          navToggleButton.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
          navScrim.hidden = !open;
          if (open) startNavigationViewPolling();
          else stopNavigationViewPolling();
          scheduleTerminalFit(Boolean(activeTerminalId));
        }

        function setDrawerView(view) {
          const requestedView = ["workspace", "hidden", "notifications", "create", "connection", "settings"].includes(view)
            ? view
            : "workspace";
          const nextView =
            requestedView === "hidden" && hiddenWorkspaceCount === 0
              ? "workspace"
              : requestedView;
          drawerView = nextView;
          drawerWorkspaceView.hidden = nextView !== "workspace";
          drawerHiddenView.hidden = nextView !== "hidden";
          drawerNotificationsView.hidden = nextView !== "notifications";
          drawerCreateView.hidden = nextView !== "create";
          drawerConnectionView.hidden = nextView !== "connection";
          drawerSettingsView.hidden = nextView !== "settings";
          drawerTitle.textContent =
            nextView === "connection"
              ? "Connection"
              : nextView === "hidden"
                ? "Hidden workspaces"
                : nextView === "notifications"
                  ? "Notifications"
                  : nextView === "create"
                    ? "New workspace"
                    : nextView === "settings"
                      ? "Settings"
                      : "Remote";
          drawerBackButton.hidden = nextView === "workspace";
          newWorkspaceButton.hidden = nextView !== "workspace";
          hiddenWorkspaceToggle.hidden =
            nextView !== "workspace" || hiddenWorkspaceCount === 0;
          drawerNotificationsButton.hidden = nextView !== "workspace";
          drawerConnectionButton.hidden = nextView !== "workspace";
          drawerSettingsButton.hidden = nextView !== "workspace" && nextView !== "connection";
        }

        function drawerEntryButton(view) {
          if (view === "hidden") return hiddenWorkspaceToggle;
          if (view === "notifications") return drawerNotificationsButton;
          if (view === "create") return newWorkspaceButton;
          if (view === "connection") return drawerConnectionButton;
          if (view === "settings") return drawerSettingsButton;
          return null;
        }

        function openDrawerSubview(view) {
          setDrawerView(view);
          drawerBackButton.focus();
          if (view === "settings") {
            renderKeyPopover();
            loadPcUpdateStatus().catch(() => {});
            if (leaseId) loadRemoteDisplaySettings().catch(() => {});
          }
        }

        function returnToWorkspaceView() {
          const entryButton = drawerEntryButton(drawerView);
          setDrawerView("workspace");
          entryButton?.focus();
        }

        // ── Widget strip (ADR-0124) ─────────────────────────────────────
        // The desktop owns placement and every displayed value; this client
        // only draws what `/remote/v1/widgets` hands it. Nothing here computes
        // a percentage, picks a row or words a failure — two implementations of
        // those would let the same account read differently in a browser than
        // on the PC.
        const widgetStripEl = $("widgetStrip");
        const widgetStripLeftEl = $("widgetStripLeft");
        const widgetStripRightEl = $("widgetStripRight");
        const widgetStripToggle = $("widgetStripToggle");
        // Fixed and client-owned: the strip is a viewer, not probe demand, so it
        // has no business following `usage.*.refreshSeconds`. Fast enough for
        // the activity and notification counts, which are the parts that move.
        const WIDGET_POLL_MS = 5000;
        // Cadence while there is nothing to draw. Placement can change on the
        // desktop at any time, so the poll slows down instead of stopping.
        const WIDGET_IDLE_POLL_MS = 30000;
        const WIDGET_UNAVAILABLE_TEXT = "--";
        const WIDGET_BELL_ICON =
          '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>';
        let widgetPollTimer = null;
        let widgetPollInFlight = false;
        let widgetPollActive = false;
        let widgetStripVisible = false;
        // Two independent inputs decide whether the chain runs (ADR-0132):
        // whether the session wants widgets at all (set at connect, cleared on
        // release/disconnect) and whether this device allows the row. Keeping
        // them apart is what lets the toggle work mid-session without inventing
        // a second notion of "connected".
        let widgetPollRequested = false;
        let widgetStripAllowed = loadWidgetStripAllowed();

        function loadWidgetStripAllowed() {
          try {
            return localStorage.getItem(widgetStripKey) !== "0";
          } catch (_) {
            return true;
          }
        }

        function saveWidgetStripAllowed(allowed) {
          try {
            localStorage.setItem(widgetStripKey, allowed ? "1" : "0");
          } catch (_) {}
        }

        function clampWidgetNumber(value, min, max, fallback) {
          const number = Number(value);
          if (!Number.isFinite(number)) return fallback;
          return Math.max(min, Math.min(max, Math.round(number)));
        }

        function widgetBar(percent, width, height, color, track) {
          const bar = document.createElement("span");
          bar.className = "widget-bar";
          bar.style.width = `${width}px`;
          bar.style.height = `${height}px`;
          bar.style.background = track;
          const fill = document.createElement("span");
          fill.className = "widget-bar-fill";
          // A missing percentage draws an empty track rather than a guess; the
          // number beside it (or the tooltip) is what says why.
          const value = typeof percent === "number" ? Math.max(0, Math.min(100, percent)) : 0;
          fill.style.width = `${value}%`;
          fill.style.background = color;
          bar.append(fill);
          return bar;
        }

        function buildUsageWidget(item) {
          const node = document.createElement("span");
          node.className = "widget-item";

          const label = document.createElement("span");
          label.className = "widget-muted";
          label.textContent = item.label || "";
          node.append(label);

          // Unusable numbers are replaced, never papered over with the last good
          // capture — the same rule the desktop widget follows.
          if (item.unavailable) {
            const unavailable = document.createElement("span");
            unavailable.className = "widget-muted";
            unavailable.textContent = WIDGET_UNAVAILABLE_TEXT;
            node.append(unavailable);
            return node;
          }

          const rows = Array.isArray(item.rows) ? item.rows : [];
          if (rows.length === 0) {
            const empty = document.createElement("span");
            empty.className = "widget-muted";
            empty.textContent = WIDGET_UNAVAILABLE_TEXT;
            node.append(empty);
            return node;
          }

          const colors = item.colors || {};
          const used = colors.used || "var(--accent)";
          const pace = colors.pace || "var(--yellow)";
          const track = colors.track || "var(--border)";
          const barWidth = clampWidgetNumber(item.barWidth, 8, 200, 26);
          const barHeight = clampWidgetNumber(item.barHeight, 1, 10, 4);
          const elapsedHeight = clampWidgetNumber(item.elapsedHeight, 1, 10, 2);
          const display = item.display === "bar" || item.display === "number" ? item.display : "both";

          rows.forEach((row, index) => {
            if (index > 0) {
              const separator = document.createElement("span");
              separator.className = "widget-usage-separator";
              separator.setAttribute("aria-hidden", "true");
              node.append(separator);
            }
            const rowNode = document.createElement("span");
            rowNode.className = "widget-usage-row";
            if (display !== "bar") {
              const text = document.createElement("span");
              text.textContent = row.text || WIDGET_UNAVAILABLE_TEXT;
              rowNode.append(text);
            }
            if (display !== "number") {
              const bars = document.createElement("span");
              bars.className = "widget-bars";
              bars.append(widgetBar(row.percent, barWidth, barHeight, used, track));
              if (typeof row.elapsed === "number") {
                bars.append(widgetBar(row.elapsed, barWidth, elapsedHeight, pace, track));
              }
              rowNode.append(bars);
            }
            node.append(rowNode);
          });

          return node;
        }

        function buildActivityWidget(item) {
          const node = document.createElement("span");
          node.className = "widget-item";
          const busy = Number(item.busy) || 0;
          const dot = document.createElement("span");
          dot.className = busy > 0 ? "widget-accent" : "widget-muted";
          dot.textContent = "●";
          const count = document.createElement("span");
          count.textContent = String(busy);
          const total = document.createElement("span");
          total.className = "widget-muted";
          total.textContent = ` / ${Number(item.total) || 0}`;
          node.append(dot, count, total);
          return node;
        }

        function buildNotificationsWidget(item) {
          const unread = Number(item.unread) || 0;
          // Interactive, and it acts on *this* client: the drawer's own
          // notification panel, never the host's UI (ADR-0124).
          const node = document.createElement("button");
          node.type = "button";
          node.className = "widget-item";
          const icon = document.createElement("span");
          icon.className = "widget-muted";
          icon.innerHTML = WIDGET_BELL_ICON;
          const count = document.createElement("span");
          count.className = unread > 0 ? "widget-accent" : "widget-muted";
          count.textContent = String(unread);
          node.append(icon, count);
          keepInputSurfaceFocus(node);
          node.addEventListener("click", () => {
            setNavigationOpen(true);
            openDrawerSubview("notifications");
          });
          return node;
        }

        function buildTextWidget(item) {
          const text = document.createElement("span");
          text.className = "widget-cwd";
          text.textContent = item.text || "";
          const copyText = typeof item.copyText === "string" ? item.copyText : null;
          if (!copyText) {
            const node = document.createElement("span");
            node.className = "widget-item";
            node.append(text);
            return node;
          }
          const node = document.createElement("button");
          node.type = "button";
          node.className = "widget-item";
          node.append(text);
          keepInputSurfaceFocus(node);
          node.addEventListener("click", () => {
            writeClipboardText(copyText)
              .then(() => setStatus("Copied the working directory."))
              .catch((err) => setStatus(`Copy failed: ${err.message || err}`, true));
          });
          return node;
        }

        function buildWidgetItem(item) {
          if (!item || typeof item !== "object") return null;
          // `kind` is coarser than the desktop's widget `type` on purpose: a new
          // widget that maps onto an existing kind needs no change here. One this
          // build does not know draws nothing rather than a placeholder.
          const node =
            item.kind === "usage"
              ? buildUsageWidget(item)
              : item.kind === "activity"
                ? buildActivityWidget(item)
                : item.kind === "notifications"
                  ? buildNotificationsWidget(item)
                  : item.kind === "text"
                    ? buildTextWidget(item)
                    : null;
          if (node && typeof item.title === "string" && item.title) node.title = item.title;
          return node;
        }

        function renderWidgetStrip(data) {
          const items = data && Array.isArray(data.items) ? data.items : [];
          const wasVisible = widgetStripVisible;
          // The row's own answer has arrived, so an attach no longer has to wait
          // for it to decide the grid (ADR-0133). "Absent" counts as an answer.
          widgetStripSettled = true;
          notifyAttachChromeSettled();
          widgetStripLeftEl.replaceChildren();
          widgetStripRightEl.replaceChildren();
          if (!data || data.enabled === false || items.length === 0) {
            widgetStripVisible = false;
            widgetStripEl.hidden = true;
            if (wasVisible) rebaseTerminalFit();
            return;
          }
          widgetStripEl.style.fontFamily = typeof data.fontFamily === "string" ? data.fontFamily : "";
          widgetStripEl.style.fontSize = `${clampWidgetNumber(data.fontSize, 6, 20, 9)}px`;
          for (const item of items) {
            const node = buildWidgetItem(item);
            if (!node) continue;
            (item.align === "right" ? widgetStripRightEl : widgetStripLeftEl).append(node);
          }
          widgetStripVisible = true;
          widgetStripEl.hidden = false;
          if (!wasVisible) rebaseTerminalFit();
        }

        /**
         * Show that the values stopped arriving, without hiding the row.
         *
         * Keeping the last drawn numbers would show a stale capture as current,
         * and hiding the strip would make a transient failure look like the
         * feature being off. Only a strip that was already up says anything —
         * one that never appeared has nothing to contradict.
         */
        function renderWidgetStripFailure(message) {
          // A failed poll is still an answer about the row's height: it keeps
          // whatever it had, so an attach can stop waiting for it (ADR-0133).
          widgetStripSettled = true;
          notifyAttachChromeSettled();
          if (!widgetStripVisible) return;
          widgetStripLeftEl.replaceChildren();
          widgetStripRightEl.replaceChildren();
          const node = document.createElement("span");
          node.className = "widget-item widget-muted";
          node.textContent = WIDGET_UNAVAILABLE_TEXT;
          node.title = message || "Widget values are unavailable.";
          widgetStripLeftEl.append(node);
        }

        /**
         * One poll, then the next one is scheduled from what this one found.
         *
         * A chain of timeouts rather than an interval, because the cadence is
         * not constant: an empty answer means there is nothing on screen to keep
         * current, and asking every five seconds for a row that does not exist
         * is a bridge round trip spent on nothing. It cannot stop asking either
         * — placement can change at any time on the desktop, and the strip is
         * the only thing that would notice.
         */
        async function refreshWidgets() {
          if (!widgetPollActive || widgetPollInFlight) return;
          // A hidden tab draws nothing worth a bridge round trip. The chain
          // stays alive so returning does not depend on one event handler.
          if (document.hidden || (!androidE2eMode && !token())) {
            scheduleNextWidgetPoll(WIDGET_POLL_MS);
            return;
          }
          widgetPollInFlight = true;
          let nextDelayMs = WIDGET_POLL_MS;
          try {
            renderWidgetStrip(await remoteFetch("/remote/v1/widgets"));
            if (!widgetStripVisible) nextDelayMs = WIDGET_IDLE_POLL_MS;
          } catch (err) {
            // Token/permission answers are about this client, not the strip:
            // stop rather than retry into the same wall every interval.
            if (err && (err.status === 401 || err.status === 403)) {
              stopWidgetPolling();
              return;
            }
            renderWidgetStripFailure(err && err.message ? err.message : String(err));
          } finally {
            widgetPollInFlight = false;
          }
          scheduleNextWidgetPoll(nextDelayMs);
        }

        function scheduleNextWidgetPoll(delayMs) {
          if (!widgetPollActive || widgetPollTimer) return;
          widgetPollTimer = setTimeout(() => {
            widgetPollTimer = null;
            refreshWidgets().catch(() => {});
          }, delayMs);
        }

        /** Poll now, dropping whatever the chain had queued. */
        function refreshWidgetsNow() {
          if (!widgetPollActive) return;
          if (widgetPollTimer) {
            clearTimeout(widgetPollTimer);
            widgetPollTimer = null;
          }
          refreshWidgets().catch(() => {});
        }

        function startWidgetPolling() {
          widgetPollRequested = true;
          applyWidgetPolling();
        }

        function stopWidgetPolling() {
          widgetPollRequested = false;
          applyWidgetPolling();
        }

        /**
         * Bring the poll chain in line with the two gates.
         *
         * The device gate can flip at any time, so this is the single place
         * that decides whether the chain runs — a toggle that started its own
         * poll would leave two ways to be "polling" and only one way to stop.
         * A device that turned the row off asks for nothing at all (ADR-0132):
         * there is no placement change left for it to notice.
         */
        function applyWidgetPolling() {
          if (widgetPollRequested && widgetStripAllowed) {
            if (widgetPollActive) return;
            // A fresh chain has not answered yet, whatever the last one did:
            // an attach must wait for this run's answer, not a stale one from
            // before a disconnect (ADR-0133).
            widgetStripSettled = false;
            widgetPollActive = true;
            refreshWidgetsNow();
            return;
          }
          widgetPollActive = false;
          if (widgetPollTimer) {
            clearTimeout(widgetPollTimer);
            widgetPollTimer = null;
          }
          renderWidgetStrip(null);
        }

        function setWidgetStripAllowed(allowed) {
          widgetStripAllowed = allowed;
          saveWidgetStripAllowed(allowed);
          if (widgetStripToggle.checked !== allowed) widgetStripToggle.checked = allowed;
          applyWidgetPolling();
        }

        function renderNavigation(data) {
          // Keep every workspace's pane/workspace skip sets consistent before
          // drawing the drawer and header pressed states.
          reconcileWorkspaceSkips();
          renderNotificationPanel(data.notifications || [], data.unreadNotificationCount || 0);
          renderWorkspaceList(data.workspaces || []);
          renderDockList(data.docks || []);
          // Nav step keys gate on unread count — refresh their state and badge.
          updateKeyBarControls();
          updateHeaderPaneIdentity();
        }

        function renderDockList(docks) {
          dockListEl.innerHTML = "";
          const visibleDocks = docks.filter((dock) => dock.visible !== false);
          const terminalRows = visibleDocks.flatMap((dock) =>
            (dock.panes || [])
              .map((pane) => ({ dock, pane }))
              .filter(({ pane }) => pane.viewType === "TerminalView" && pane.terminalId)
          );
          dockBadge.hidden = terminalRows.length <= 0;
          if (terminalRows.length > 0) {
            dockBadge.textContent = String(terminalRows.length);
          }
          if (!terminalRows.length) {
            emptyNav(dockListEl, "No dock terminals.");
            return;
          }

          for (const dock of visibleDocks) {
            const panes = dock.panes || [];
            const terminalPanes = panes
              .map((pane) => ({ pane }))
              .filter(({ pane }) => pane.viewType === "TerminalView" && pane.terminalId);
            if (!terminalPanes.length) continue;

            const title = document.createElement("div");
            title.className = "dock-group-title";
            title.textContent = dock.position || "dock";
            dockListEl.append(title);

            terminalPanes.forEach(({ pane }) => {
              dockListEl.append(renderDockTerminalRow(dock, pane));
            });
          }
        }

        function renderDockTerminalRow(dock, pane) {
          const isTerminal = isTerminalPane(pane);
          const isActive = Boolean(isTerminal && (pane.terminalId === activeTerminalId || pane.isFocused));
          const canSelectTerminal = Boolean(leaseId && isTerminal);
          const row = document.createElement(canSelectTerminal ? "button" : "div");
          if (canSelectTerminal) row.type = "button";
          row.className = `dock-terminal-row${isActive ? " active" : ""}`;
          if (canSelectTerminal) {
            row.addEventListener("click", () => {
              selectTerminal(pane.terminalId, {
                focusHost: true,
                focusDockHost: true,
                refreshNavigation: true,
              }).catch((err) => setStatus(err.message, true));
            });
          }

          const position = document.createElement("span");
          position.className = "dock-position-badge";
          position.textContent = shortLabel(dock.position || "dock");
          row.append(position);

          const main = document.createElement("div");
          main.className = "pane-row-main";
          row.append(main);

          const env = document.createElement("span");
          env.className = "pane-env";
          env.textContent = shortLabel(pane.profile || pane.title || "TerminalView");
          main.append(env);

          const activity = activityLabel(pane.activity, pane.commandRunning);
          if (activity) {
            const activityEl = document.createElement("span");
            activityEl.className = `pane-activity ${activityClass(pane.activity)}`;
            activityEl.textContent = activity;
            main.append(activityEl);
          }

          if (pane.branch) {
            const branch = document.createElement("span");
            branch.className = "pane-branch";
            branch.textContent = pane.branch;
            main.append(branch);
          }

          const path = document.createElement("span");
          path.className = "pane-path";
          path.textContent = pane.cwd || pane.title || pane.terminalId;
          if (pathEllipsisMode() === "start") {
            path.style.direction = "rtl";
            path.style.textAlign = "left";
          }
          main.append(path);

          if ((pane.unreadCount || 0) > 0) {
            const unread = document.createElement("span");
            unread.className = "workspace-count-badge";
            fillCountBadge(unread, pane.unreadCount);
            main.append(unread);
          }

          return row;
        }

        function visibilityIcon(hidden, size = 14) {
          const slash = hidden
            ? '<path d="M2.5 11.5l9-9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>'
            : "";
          return `<svg width="${size}" height="${size}" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M1.5 7s2.4-3.8 5.5-3.8S12.5 7 12.5 7s-2.4 3.8-5.5 3.8S1.5 7 1.5 7Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><circle cx="7" cy="7" r="1.7" stroke="currentColor" stroke-width="1.2"/>${slash}</svg>`;
        }

        function renderHiddenWorkspaceShelf(workspaces) {
          hiddenWorkspaceShelf.innerHTML = "";
          hiddenWorkspaceCount = workspaces.length;
          hiddenWorkspaceToggle.hidden =
            drawerView !== "workspace" || hiddenWorkspaceCount === 0;
          hiddenWorkspaceToggle.classList.toggle(
            "status-indicator",
            hiddenWorkspaceCount > 0,
          );
          const label = `Open hidden workspaces (${hiddenWorkspaceCount})`;
          hiddenWorkspaceToggle.setAttribute("aria-label", label);
          hiddenWorkspaceToggle.title = label;
          if (hiddenWorkspaceCount === 0) {
            emptyNav(hiddenWorkspaceShelf, "No hidden workspaces.");
            if (drawerView === "hidden") setDrawerView("workspace");
            return;
          }

          workspaces.forEach((workspace, index) => {
            const row = document.createElement("div");
            row.className = "hidden-workspace-row";
            row.dataset.hiddenWorkspace = workspace.id;

            const primary = document.createElement("button");
            primary.type = "button";
            primary.className = "hidden-workspace-primary";
            primary.textContent = workspace.name || workspace.id || "Workspace";
            primary.disabled = !leaseId;
            primary.setAttribute(
              "aria-label",
              `Show and open ${workspace.name || workspace.id || "workspace"}`,
            );
            primary.addEventListener("click", async () => {
              primary.disabled = true;
              try {
                await setWorkspaceVisibility(workspace.id, false);
                await switchWorkspace(workspace.id);
              } catch (err) {
                setStatus(err.message || String(err), true);
              } finally {
                primary.disabled = !leaseId;
              }
            });
            row.append(primary);

            const restore = document.createElement("button");
            restore.type = "button";
            restore.className = "visibility-button";
            restore.dataset.hiddenWorkspaceRestore = workspace.id;
            restore.innerHTML = visibilityIcon(false, 12);
            restore.disabled = !leaseId;
            restore.setAttribute(
              "aria-label",
              `Show ${workspace.name || workspace.id || "workspace"}`,
            );
            restore.title = "Show in workspace list";
            keepInputSurfaceFocus(restore);
            restore.addEventListener("click", async (event) => {
              event.stopPropagation();
              restore.disabled = true;
              try {
                const adjacentWorkspace =
                  workspaces[index + 1] || workspaces[index - 1] || null;
                await setWorkspaceVisibility(workspace.id, false);
                if (drawerView === "hidden") {
                  const adjacentRestore = Array.from(
                    hiddenWorkspaceShelf.querySelectorAll(
                      "[data-hidden-workspace-restore]",
                    ),
                  ).find(
                    (button) =>
                      button.dataset.hiddenWorkspaceRestore ===
                      adjacentWorkspace?.id,
                  );
                  (adjacentRestore || drawerBackButton).focus();
                } else if (drawerView === "workspace") {
                  const restoredVisibility = Array.from(
                    workspaceListEl.querySelectorAll(
                      "[data-workspace-visibility]",
                    ),
                  ).find(
                    (button) =>
                      button.dataset.workspaceVisibility === workspace.id,
                  );
                  (restoredVisibility || newWorkspaceButton).focus();
                }
              } catch (err) {
                setStatus(err.message || String(err), true);
              } finally {
                restore.disabled = !leaseId;
              }
            });
            row.append(restore);
            hiddenWorkspaceShelf.append(row);
          });
        }

        function renderWorkspaceList(workspaces) {
          workspaceListEl.innerHTML = "";
          const hiddenWorkspaces = workspaces.filter(
            (workspace) => workspace.hidden === true,
          );
          const visibleWorkspaces = workspaces.filter(
            (workspace) => workspace.hidden !== true,
          );
          renderHiddenWorkspaceShelf(hiddenWorkspaces);
          if (!visibleWorkspaces.length) {
            emptyNav(workspaceListEl, "No workspaces.");
            return;
          }
          for (let index = 0; index < visibleWorkspaces.length; index += 1) {
            const workspace = visibleWorkspaces[index];
            const panes = workspace.panes || [];
            const canHideWorkspace =
              !workspace.isActive || visibleWorkspaces.length > 1;
            workspaceListEl.append(
              renderWorkspaceItem(workspace, index, panes, canHideWorkspace),
            );
          }
        }

        function renderWorkspaceItem(
          workspace,
          index,
          panes,
          canHideWorkspace,
        ) {
          const item = document.createElement("div");
          item.className = `workspace-item${workspace.isActive ? " active" : ""}`;
          item.dataset.workspaceItem = workspace.id;
          item.addEventListener("click", () => {
            if (!leaseId) return;
            switchWorkspace(workspace.id).catch((err) =>
              setStatus(err.message, true),
            );
          });

          const content = document.createElement("div");
          content.className = "workspace-item-content";
          item.append(content);

          const row = document.createElement("div");
          row.className = "workspace-row-primary";
          content.append(row);

          const left = document.createElement("span");
          left.className = "workspace-primary-left";
          row.append(left);

          const indexEl = document.createElement("span");
          indexEl.className = "workspace-index";
          indexEl.textContent = index < 9 ? String(index + 1) : "";
          left.append(indexEl);

          const nameEl = document.createElement("span");
          nameEl.className = "workspace-name";
          nameEl.textContent = workspace.name || workspace.id || "Workspace";
          left.append(nameEl);

          const selectorSummary = workspace.selectorSummary || {};
          if ((selectorSummary.terminalCount || 0) > 0) {
            const count = document.createElement("span");
            count.className = "workspace-terminal-count";
            count.textContent = String(selectorSummary.terminalCount);
            left.append(count);
          }

          const right = document.createElement("span");
          right.className = "workspace-primary-right";
          row.append(right);
          if ((workspace.unreadCount || 0) > 0) {
            const badge = document.createElement("span");
            badge.className = "workspace-count-badge";
            fillCountBadge(badge, workspace.unreadCount);
            right.append(badge);
          }
          const visibility = document.createElement("button");
          visibility.type = "button";
          visibility.className = "visibility-button";
          visibility.dataset.workspaceVisibility = workspace.id;
          visibility.innerHTML = visibilityIcon(false);
          visibility.disabled = !leaseId || !canHideWorkspace;
          visibility.setAttribute("aria-pressed", "false");
          const visibilityLabel = canHideWorkspace
            ? workspace.isActive
              ? "Hide workspace and move to the next visible workspace"
              : "Hide workspace from the list"
            : "The last visible workspace cannot be hidden";
          visibility.setAttribute("aria-label", visibilityLabel);
          visibility.title = visibilityLabel;
          keepInputSurfaceFocus(visibility);
          visibility.addEventListener("click", async (event) => {
            event.stopPropagation();
            visibility.disabled = true;
            try {
              await setWorkspaceVisibility(workspace.id, true);
            } catch (err) {
              setStatus(err.message || String(err), true);
            } finally {
              visibility.disabled = !leaseId || !canHideWorkspace;
            }
          });
          right.append(visibility);
          // Whole-workspace skip toggle (issue #507). Only meaningful for
          // workspaces that contribute terminal panes to the spatial cycle.
          if ((workspace.terminalPaneCount || 0) > 0) {
            right.append(renderWorkspaceSkipButton(workspace));
          }

          if (panes.length > 0) {
            const paneList = document.createElement("div");
            paneList.className = "workspace-pane-list";
            content.append(paneList);
            panes.forEach((pane) => {
              paneList.append(renderPaneRow(pane, panes, workspace.isActive));
            });
            if (workspaceLastInputMode() === "workspaceLatest") {
              const latestInput = latestWorkspaceInput(panes);
              const inputLine = document.createElement("div");
              inputLine.className = "workspace-last-input";
              inputLine.dataset.workspaceLastInput = workspace.id;
              inputLine.textContent = latestInput ? latestInput.text : "\u00a0";
              inputLine.title = latestInput ? latestInput.text : "";
              paneList.append(inputLine);
            }
          } else {
            const summary = document.createElement("div");
            summary.className = "workspace-summary-line";
            summary.textContent = metaText([selectorSummary.branch, selectorSummary.cwd]);
            content.append(summary);
          }

          return item;
        }

        function applyWorkspaceSkipState(button, workspaceId) {
          const excluded = spatialExcludedWorkspaceIds.has(workspaceId);
          button.setAttribute("aria-pressed", String(excluded));
          const label = excluded
            ? "Include this workspace in pane navigation"
            : "Exclude this workspace from pane navigation";
          button.setAttribute("aria-label", label);
          button.title = label;
        }

        function renderWorkspaceSkipButton(workspace) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "workspace-skip-button";
          button.dataset.workspaceSkip = workspace.id;
          button.innerHTML =
            '<svg data-icon="circle-minus" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M8 12h8"/></svg>';
          applyWorkspaceSkipState(button, workspace.id);
          // Keep the focused input surface/keyboard like every other remote
          // control button (#482); the click still toggles via the click path.
          keepInputSurfaceFocus(button);
          button.addEventListener("click", (event) => {
            // The row itself switches workspace on click — a skip toggle must
            // not also switch. Stop the bubble before it reaches the row.
            event.stopPropagation();
            const next = computeSkipStateAfterWorkspaceToggle({
              workspaceId: workspace.id,
              terminalPaneIds: workspaceTerminalPaneIds(workspace.id),
              excludedPaneIds: [...spatialExcludedPaneIds],
              excludedWorkspaceIds: [...spatialExcludedWorkspaceIds],
            });
            spatialExcludedPaneIds = new Set(next.paneIds);
            spatialExcludedWorkspaceIds = new Set(next.workspaceIds);
            saveSpatialExcludedPaneIds();
            saveSpatialExcludedWorkspaceIds();
            applyWorkspaceSkipState(button, workspace.id);
            updateHeaderPaneIdentity();
            const wsLabel = workspace.name || workspace.id || "Workspace";
            setStatus(
              next.willExclude
                ? `${wsLabel} excluded from pane navigation.`
                : `${wsLabel} included in pane navigation.`
            );
          });
          return button;
        }

        function renderPaneRow(pane, panes, workspaceActive) {
          const isTerminal = isTerminalPane(pane);
          const perPaneInput = workspaceLastInputMode() === "perPane";
          const isActive = Boolean(
            isTerminal && pane.terminalId === activeTerminalId,
          );
          const paneHidden = pane.hidden === true;
          const canSelectTerminal = Boolean(
            workspaceActive && leaseId && isTerminal && !paneHidden,
          );
          const entry = document.createElement("div");
          entry.className = "workspace-pane-entry";
          const row = document.createElement(
            canSelectTerminal ? "button" : "div",
          );
          if (canSelectTerminal) row.type = "button";
          row.className = `workspace-pane-row${!perPaneInput ? " compact" : ""}${isActive ? " active" : ""}${paneHidden ? " hidden-item" : ""}`;
          row.dataset.paneRow = pane.id;
          if (canSelectTerminal) {
            row.addEventListener("click", (event) => {
              event.stopPropagation();
              selectTerminal(pane.terminalId, {
                focusHost: true,
                refreshNavigation: true,
              }).catch((err) => setStatus(err.message, true));
            });
          }

          const display = workspaceDisplaySettings();
          if (display.minimap) {
            const minimap = paneMinimapElement(panes, pane.id);
            row.append(minimap);
          } else {
            row.style.paddingLeft = "18px";
          }

          const main = document.createElement("div");
          main.className = "pane-row-main";
          const primary = document.createElement("div");
          primary.className = "pane-row-primary";
          main.append(primary);
          row.append(main);
          entry.append(row);

          if (isTerminal) {
            const selectorDisplay = pane.selectorDisplay || {};
            if (display.environment) {
              const env = document.createElement("span");
              env.className = "pane-env";
              env.textContent =
                selectorDisplay.environment || shortLabel(pane.profile || pane.title || "TerminalView");
              primary.append(env);
            }

            const computedActivity = selectorDisplay.activity || null;
            const activity = computedActivity
              ? computedActivity.label
              : activityLabel(pane.activity, pane.commandRunning);
            if (display.activity && activity) {
              const activityEl = document.createElement("span");
              activityEl.className = `pane-activity ${activityClass(pane.activity)}`;
              activityEl.textContent = activity;
              if (computedActivity && computedActivity.color) {
                activityEl.style.color = computedActivity.color;
              }
              primary.append(activityEl);
            }

            if (display.path && pane.branch) {
              const branch = document.createElement("span");
              branch.className = "pane-branch";
              branch.textContent = pane.branch;
              primary.append(branch);
            }

            if (display.path && pane.cwd) {
              const path = document.createElement("span");
              path.className = "pane-path";
              path.textContent = selectorDisplay.cwd || pane.cwd;
              if (pathEllipsisMode() === "start") {
                path.style.direction = "rtl";
                path.style.textAlign = "left";
              }
              primary.append(path);
            }

            if (display.result && pane.selectorStatus && pane.selectorStatus.icon) {
              const status = document.createElement("span");
              status.className = `pane-command-status${(pane.unreadCount || 0) > 0 ? " unread" : ""}`;
              status.textContent = pane.selectorStatus.icon;
              if (pane.selectorStatus.color) status.style.color = pane.selectorStatus.color;
              status.title = pane.selectorStatus.text || pane.lastCommand || "";
              primary.append(status);
            } else if (display.result && (pane.unreadCount || 0) > 0) {
              const unread = document.createElement("span");
              unread.className = "pane-notification-dot";
              unread.setAttribute("aria-label", "Unread notification");
              primary.append(unread);
            }

            if (perPaneInput) {
              const lastInput = document.createElement("div");
              lastInput.className = "pane-last-input";
              lastInput.dataset.paneLastInput = pane.id;
              lastInput.textContent = selectorDisplay.lastInput || pane.lastCommand || "\u00a0";
              lastInput.title = selectorDisplay.lastInput || pane.lastCommand || "";
              main.append(lastInput);
            }
          } else {
            const label = document.createElement("span");
            label.className = "pane-view-label";
            label.textContent = shortLabel(pane.viewType);
            primary.append(label);
          }

          const visibility = document.createElement("button");
          visibility.type = "button";
          visibility.className = "visibility-button";
          visibility.dataset.paneVisibility = pane.id;
          visibility.innerHTML = visibilityIcon(paneHidden);
          visibility.disabled = !leaseId;
          visibility.setAttribute("aria-pressed", String(paneHidden));
          const visibilityLabel = paneHidden
            ? "Show pane in workspace list"
            : "Hide pane from workspace list";
          visibility.setAttribute("aria-label", visibilityLabel);
          visibility.title = visibilityLabel;
          keepInputSurfaceFocus(visibility);
          visibility.addEventListener("click", async (event) => {
            event.stopPropagation();
            visibility.disabled = true;
            try {
              await setPaneVisibility(pane.id, !paneHidden);
            } catch (err) {
              setStatus(err.message || String(err), true);
            } finally {
              visibility.disabled = !leaseId;
            }
          });
          entry.append(visibility);

          return entry;
        }

        function paneMinimapElement(panes, highlightPaneId) {
          const width = 18;
          const height = 12;
          const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
          svg.setAttribute("class", "pane-minimap");
          svg.setAttribute("width", String(width));
          svg.setAttribute("height", String(height));
          svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
          panes.forEach((pane) => {
            const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
            const highlighted = pane.id === highlightPaneId;
            rect.setAttribute("x", String((Number(pane.x) || 0) * width));
            rect.setAttribute("y", String((Number(pane.y) || 0) * height));
            rect.setAttribute("width", String((Number(pane.w) || 1) * width));
            rect.setAttribute("height", String((Number(pane.h) || 1) * height));
            rect.setAttribute("fill", highlighted ? "var(--accent)" : "var(--bg-surface)");
            rect.setAttribute("fill-opacity", highlighted ? "0.6" : "0.3");
            rect.setAttribute("stroke", "var(--border)");
            rect.setAttribute("stroke-width", "0.5");
            svg.append(rect);
          });
          const border = document.createElementNS("http://www.w3.org/2000/svg", "rect");
          border.setAttribute("x", "0");
          border.setAttribute("y", "0");
          border.setAttribute("width", String(width));
          border.setAttribute("height", String(height));
          border.setAttribute("fill", "none");
          border.setAttribute("stroke", "var(--text-secondary)");
          border.setAttribute("stroke-width", "1");
          border.setAttribute("rx", "1");
          svg.append(border);
          return svg;
        }

        function isDockTerminalId(terminalId) {
          if (!terminalId || !navigationState) return false;
          return (navigationState.docks || []).some((dock) =>
            (dock.panes || []).some((pane) => pane.terminalId === terminalId)
          );
        }

        function shortLabel(label) {
          if (!label) return "";
          const known = {
            PowerShell: "PS",
            WSL: "WSL",
            Ubuntu: "UBT",
            Debian: "DEB",
            Browser: "WEB",
            Empty: "---",
            EmptyView: "---",
          };
          return known[label] || String(label).slice(0, 3).toUpperCase();
        }

        function visibleDockItems(data) {
          return (data.docks || []).filter((dock) => dock.visible !== false);
        }

        // A pane is enterable because the desktop layout owns it as a terminal
        // pane, not because a PTY happens to exist right now. `terminalLive`
        // only reports the latter, and panes the desktop has not opened yet own
        // no session at all: workspaces mount lazily and terminal startup is
        // serialized behind one global slot. Gating selection on liveness made
        // those panes unreachable from Remote and dead-ended the page on "no
        // open terminal sessions" (issue #779) — the same trap ADR-0039 already
        // avoids for step navigation.
        function isTerminalPane(pane) {
          return Boolean(pane && pane.terminalId);
        }

        function isMainOutputTerminal(data, terminalId) {
          if (!terminalId) return false;
          const activePanes = (data.activeWorkspace && data.activeWorkspace.panes) || [];
          if (activePanes.some((pane) => pane.terminalId === terminalId)) {
            return true;
          }
          return visibleDockItems(data).some((dock) =>
            (dock.panes || []).some((pane) => pane.terminalId === terminalId)
          );
        }

        // Returns a terminal id, not a terminal info object: a queued pane has
        // no entry in `data.terminals` yet and must still be selectable.
        // Liveness stays a tie-breaker at every step — attaching to a running
        // session is instant, while a queued pane has to be opened first.
        function preferredTerminal(data, preferredTerminalId, options = {}) {
          if (preferredTerminalId && isMainOutputTerminal(data, preferredTerminalId)) {
            // A *remembered* selection resumes only onto a live session: after a
            // reconnect, a terminal that ended must fall back to a running pane
            // rather than be restarted behind the user's back. A pane the user
            // is entering right now is pinned instead, so the poll that waits
            // for it to open cannot drift onto another pane.
            const hintPane = paneByTerminalId(data, preferredTerminalId);
            if (options.pinned || (hintPane && hintPane.terminalLive)) return preferredTerminalId;
          }
          const activePanes = (data.activeWorkspace && data.activeWorkspace.panes) || [];
          const focusedNumber = data.activeWorkspace && data.activeWorkspace.focusedPaneNumber;
          const focusedPane = activePanes.find((pane) => pane.paneNumber === focusedNumber && isTerminalPane(pane));
          const activePane =
            focusedPane ||
            activePanes.find((pane) => isTerminalPane(pane) && pane.terminalLive) ||
            activePanes.find((pane) => isTerminalPane(pane));
          if (activePane) return activePane.terminalId;
          for (const dock of visibleDockItems(data)) {
            const dockPanes = dock.panes || [];
            const dockPane =
              dockPanes.find((pane) => isTerminalPane(pane) && pane.terminalLive) ||
              dockPanes.find((pane) => isTerminalPane(pane));
            if (dockPane) return dockPane.terminalId;
          }
          return null;
        }

        function paneByTerminalId(data, terminalId) {
          if (!data || !terminalId) return null;
          const activePanes = (data.activeWorkspace && data.activeWorkspace.panes) || [];
          const activePane = activePanes.find((pane) => pane.terminalId === terminalId);
          if (activePane) return activePane;
          for (const dock of visibleDockItems(data)) {
            const dockPane = (dock.panes || []).find((pane) => pane.terminalId === terminalId);
            if (dockPane) return dockPane;
          }
          return null;
        }

        function activeComposerAgentScrollOffset() {
          const agent = activeComposerAgentName();
          return agent ? composerAgentScrollOffset(agent) : null;
        }

        function activeComposerAgentName() {
          const activity = paneByTerminalId(navigationState, activeTerminalId)?.activity;
          if (activity?.type !== "interactiveApp") return null;
          return Number.isInteger(DEFAULT_COMPOSER_AGENT_SCROLL_OFFSETS[activity.name])
            ? activity.name
            : null;
        }

        // This is intentionally a one-time viewport adjustment at a user-visible
        // Composer transition or its initial user-directed snapshot attach. It
        // does not alter terminal geometry or output state, and automatic
        // reconnect/navigation refreshes never re-apply it, so a person's later
        // scroll position remains theirs.
        function offsetComposerForActiveAgent() {
          if (
            !composerAgentScrollOffsetEnabled ||
            currentInputMode() !== "composer" ||
            composerCollapsed ||
            !terminal
          ) {
            return;
          }
          const terminalId = activeTerminalId;
          const lines = activeComposerAgentScrollOffset();
          if (lines == null) return;
          requestAnimationFrame(() => {
            if (
              !composerAgentScrollOffsetEnabled ||
              currentInputMode() !== "composer" ||
              composerCollapsed ||
              !terminal ||
              activeTerminalId !== terminalId ||
              activeComposerAgentScrollOffset() !== lines
            ) {
              return;
            }
            terminal.scrollToBottom();
            terminal.scrollLines(-lines);
            updateScrollToBottomButton(terminal);
          });
        }

        // Pane summaries carry the same title/profile/cwd fields as terminal
        // infos, so a queued pane still gets a real header instead of a raw id.
        function terminalMetaLabel(data, terminalId) {
          const source = terminalInfoById.get(terminalId) || paneByTerminalId(data, terminalId);
          return source ? terminalLabel(source) : terminalId;
        }

        function installNavigationSnapshot(data, { render = true } = {}) {
          navigationState = data;
          const terminals = data.terminals || [];
          terminalInfoById = new Map(terminals.map((terminalInfo) => [terminalInfo.id, terminalInfo]));
          terminals.forEach((terminalInfo) => ensureRemoteFont(terminalInfo.appearance));
          if (render) {
            renderNavigation(data);
            if (activeTerminalId) {
              terminalMetaEl.textContent = terminalMetaLabel(data, activeTerminalId);
            }
          }
        }

        async function refreshNavigationView() {
          if (
            navigationViewRefreshInFlight ||
            !leaseId ||
            document.hidden ||
            !document.querySelector(".app").classList.contains("nav-open")
          ) return;
          const selectedLeaseId = leaseId;
          const selectionRevision = terminalSelectionRevision;
          navigationViewRefreshInFlight = true;
          try {
            const data = await remoteFetch("/remote/v1/navigation");
            if (
              leaseId !== selectedLeaseId ||
              terminalSelectionRevision !== selectionRevision
            ) return;
            installNavigationSnapshot(data);
          } finally {
            navigationViewRefreshInFlight = false;
          }
        }

        function stopNavigationViewPolling() {
          if (navigationViewRefreshTimer) {
            clearInterval(navigationViewRefreshTimer);
            navigationViewRefreshTimer = null;
          }
        }

        function startNavigationViewPolling() {
          stopNavigationViewPolling();
          if (!leaseId || document.hidden) return;
          refreshNavigationView().catch(() => {});
          navigationViewRefreshTimer = setInterval(() => {
            refreshNavigationView().catch(() => {});
          }, NAVIGATION_VIEW_REFRESH_MS);
        }

        async function loadNavigation(
          preferredTerminalId = activeTerminalId || lastSelectedTerminalId,
          options = {},
        ) {
          const selectionRevision = Number.isSafeInteger(options.selectionRevision)
            ? options.selectionRevision
            : ++terminalSelectionRevision;
          const data = await remoteFetch("/remote/v1/navigation");
          if (selectionRevision !== terminalSelectionRevision) return;
          installNavigationSnapshot(data, { render: false });
          const nextTerminalId = preferredTerminal(data, preferredTerminalId, {
            pinned: options.pinTerminal === true,
          });
          setActiveTerminal(nextTerminalId);
          renderNavigation(data);
          setConnected(Boolean(leaseId));
          if (activeTerminalId) {
            terminalMetaEl.textContent = terminalMetaLabel(data, activeTerminalId);
            if (options.openOutput !== false) {
              attachTerminal(activeTerminalId, {
                focusInput: options.focusInput !== false,
                preserveViewport: options.preserveViewport === true,
              });
            }
          } else {
            // Only reachable when the active workspace and every visible dock
            // own no terminal pane at all — a queued pane is opened on entry
            // instead of being reported as missing (issue #779).
            terminalMetaEl.textContent = "No terminal panes to open.";
            setStatus("No terminal panes to open.", true);
            stopSocket();
          }
        }

        async function activateWorkspace(workspaceId) {
          if (!leaseId || !workspaceId) return;
          await remoteFetch("/remote/v1/workspaces/active", {
            method: "POST",
            body: JSON.stringify({ leaseId, id: workspaceId }),
          });
        }

        function renderWorkspaceLayouts() {
          newWorkspacePanel.innerHTML = "";
          workspaceLayouts.forEach((layout) => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "new-workspace-layout";
            button.textContent = layout.name || layout.id;
            button.disabled = !leaseId;
            button.addEventListener("click", () => {
              createWorkspace(layout.id).catch((err) => setStatus(err.message || String(err), true));
            });
            newWorkspacePanel.append(button);
          });
        }

        async function loadWorkspaceLayouts() {
          const data = await remoteFetch("/remote/v1/layouts");
          workspaceLayouts = Array.isArray(data.layouts) ? data.layouts : [];
          renderWorkspaceLayouts();
        }

        async function createWorkspace(layoutId) {
          if (!leaseId || !layoutId) return;
          const selectedLeaseId = leaseId;
          newWorkspaceButton.disabled = true;
          setBusyStatus("Creating workspace…");
          try {
            await remoteFetch("/remote/v1/workspaces", {
              method: "POST",
              body: JSON.stringify({ leaseId: selectedLeaseId, layoutId }),
            });
            if (leaseId !== selectedLeaseId) return;
            await loadNavigation(activeTerminalId, { openOutput: false });
            // Land back on the workspace list, where the new workspace is.
            if (drawerView === "create") returnToWorkspaceView();
            setStatus("Workspace created.");
          } finally {
            newWorkspaceButton.disabled = !leaseId;
          }
        }

        async function setWorkspaceVisibility(workspaceId, hidden) {
          if (!leaseId || !workspaceId) return;
          const selectedLeaseId = leaseId;
          const result = await remoteFetch(
            `/remote/v1/workspaces/${encodeURIComponent(workspaceId)}/visibility`,
            {
              method: "POST",
              body: JSON.stringify({
                hidden: Boolean(hidden),
                leaseId: selectedLeaseId,
              }),
            },
          );
          if (leaseId !== selectedLeaseId) return;
          // The frontend bridge owns the active-workspace fallback decision.
          // Its response is authoritative even when this page rendered a stale
          // navigation snapshot while another surface changed the active item.
          const movesActiveWorkspace = Boolean(
            hidden && result.data && result.data.fallbackWorkspaceId,
          );
          await loadNavigation(activeTerminalId, {
            openOutput: movesActiveWorkspace,
          });
          setStatus(hidden ? "Workspace hidden." : "Workspace shown.");
        }

        async function setPaneVisibility(paneId, hidden) {
          if (!leaseId || !paneId) return;
          const selectedLeaseId = leaseId;
          await remoteFetch(
            `/remote/v1/panes/${encodeURIComponent(paneId)}/visibility`,
            {
              method: "POST",
              body: JSON.stringify({
                hidden: Boolean(hidden),
                leaseId: selectedLeaseId,
              }),
            },
          );
          if (leaseId !== selectedLeaseId) return;
          await loadNavigation(activeTerminalId, { openOutput: false });
          setStatus(
            hidden
              ? "Pane hidden from workspace list."
              : "Pane shown in workspace list.",
          );
        }

        async function switchWorkspace(workspaceId) {
          if (!leaseId || !workspaceId) return;
          setBusyStatus("Switching workspace…");
          await activateWorkspace(workspaceId);
          // Prefer the pane the user last stayed on in this workspace (issue
          // #508). preferredTerminal only restores it when the remembered
          // terminal is still a live pane of the now-active workspace; otherwise
          // it falls back to the host focused pane, then the first live pane.
          // A null hint (never visited) preserves the prior first-pane behavior.
          await loadNavigation(lastSelectedTerminalIdByWorkspace.get(workspaceId) || null);
          setNavigationOpen(false);
        }

        // --- Step navigation (issue #474, ADR-0039) ---
        const NAV_STEP_ENDPOINTS = {
          spatial: "/remote/v1/navigation/spatial",
          notification: "/remote/v1/navigation/notification",
        };
        const NAV_STEP_REASON_MESSAGES = {
          no_terminal_panes: "No terminal panes to navigate.",
          no_included_panes: "Every pane is excluded from pane navigation.",
          no_other_target: "No other pane to move to.",
          no_unread_notifications: "No unread notifications.",
        };
        let navStepChain = Promise.resolve();
        let navStepPending = 0;

        async function performNavStep(kind, direction) {
          if (!leaseId) return;
          const requestBody =
            kind === "spatial"
              ? {
                  leaseId,
                  direction,
                  excludedPaneIds: [...spatialExcludedPaneIds],
                  excludedWorkspaceIds: [...spatialExcludedWorkspaceIds],
                }
              : { leaseId, direction };
          const data = await remoteFetch(NAV_STEP_ENDPOINTS[kind], {
            method: "POST",
            body: JSON.stringify(requestBody),
          });
          if (!data || data.moved !== true || !data.target) {
            const reason = data && data.reason;
            setStatus(NAV_STEP_REASON_MESSAGES[reason] || "Nowhere to navigate.");
            return;
          }
          // Follow the landing: refresh navigation state and attach the
          // viewport to the reported target terminal.
          await loadNavigation(data.target.terminalId || null);
          // Landing indicator — socket reattach also sets this, but a step that
          // lands on the already-attached terminal never reopens the socket.
          const landingTitle = activeTerminalTitle();
          if (landingTitle) setStatus(landingTitle);
        }

        // Taps mutate host state sequentially, so they must not interleave:
        // serialize on a promise chain and cap the queue at one pending step
        // (rapid double-tap advances twice; anything faster is dropped).
        function enqueueNavStep(button, kind, direction) {
          if (!leaseId || navStepPending >= 2) return;
          navStepPending += 1;
          if (button) {
            // Per-button counter: a queued double-tap must not lose its busy
            // dim when the first step's finally fires.
            button.dataset.busyCount = String((Number(button.dataset.busyCount) || 0) + 1);
            button.classList.add("busy");
          }
          navStepChain = navStepChain
            .then(() => performNavStep(kind, direction))
            .catch((err) => setStatus(`Navigation failed: ${err.message || err}`, true))
            .finally(() => {
              navStepPending -= 1;
              if (button) {
                const remaining = (Number(button.dataset.busyCount) || 1) - 1;
                button.dataset.busyCount = String(remaining);
                if (remaining <= 0) button.classList.remove("busy");
              }
            });
        }

        async function markNotificationRead(notification) {
          if (!leaseId || !notification || !notification.id) return;
          await remoteFetch(`/remote/v1/notifications/${encodeURIComponent(notification.id)}/read`, {
            method: "POST",
            body: JSON.stringify({ leaseId }),
          });
        }

        async function markAllNotificationsRead() {
          if (!leaseId) return;
          setBusyStatus("Marking notifications read…");
          await remoteFetch("/remote/v1/notifications/mark-all-read", {
            method: "POST",
            body: JSON.stringify({ leaseId }),
          });
          await loadNavigation(activeTerminalId, { openOutput: false });
          setStatus("Notifications marked read.");
        }

        async function clearNotifications() {
          if (!leaseId) return;
          setBusyStatus("Clearing notifications…");
          await remoteFetch("/remote/v1/notifications", {
            method: "DELETE",
            body: JSON.stringify({ leaseId }),
          });
          await loadNavigation(activeTerminalId, { openOutput: false });
          setStatus("Notifications cleared.");
        }

        async function openNotification(notification) {
          if (!leaseId || !notification) return;
          setBusyStatus("Opening notification…");
          if (notification.terminalId) {
            try {
              await focusTerminalOnHost(notification.terminalId);
            } catch (err) {
              await markNotificationRead(notification).catch(() => {});
              await loadNavigation(activeTerminalId, { openOutput: false }).catch(() => {});
              throw err;
            }
            await loadNavigation(notification.terminalId);
            setNavigationOpen(false);
            return;
          }

          if (notification.workspaceId) {
            await activateWorkspace(notification.workspaceId);
          } else {
            await markNotificationRead(notification);
          }
          await loadNavigation(null);
          setNavigationOpen(false);
        }

        async function focusTerminalOnHost(terminalId) {
          if (!leaseId || !terminalId) return;
          await remoteFetch(`/remote/v1/terminals/${encodeURIComponent(terminalId)}/focus`, {
            method: "POST",
            body: JSON.stringify({ leaseId }),
          });
        }

        const TERMINAL_OPEN_POLL_MS = 400;
        // Mirrors the desktop's terminal readiness ceiling: a queued pane can
        // sit behind one 10-second startup-slot watchdog before its own start
        // even begins.
        const TERMINAL_OPEN_TIMEOUT_MS = 20000;

        // `data.terminals` is the host's list of live PTY sessions, so its keys
        // are exactly the terminal ids that can be attached right now.
        function terminalSessionLive(terminalId) {
          return Boolean(terminalId && terminalInfoById.has(terminalId));
        }

        // Ask the desktop to open a pane it has not started yet, then wait for
        // the session to exist. Focus *is* the request: it activates the pane's
        // workspace and makes the pane focused, which mounts it and lets its
        // terminal start through the host's startup slot. The focus response is
        // deliberately not the verdict — the host answers as soon as focus is
        // applied, without waiting for a session, so a success there says
        // nothing about whether a PTY exists yet. Navigation is polled until
        // the session shows up (issue #779).
        async function openTerminalOnHost(terminalId, selectionRevision) {
          focusTerminalOnHost(terminalId).catch(() => {});
          const deadline = Date.now() + TERMINAL_OPEN_TIMEOUT_MS;
          while (Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, TERMINAL_OPEN_POLL_MS));
            if (selectionRevision !== terminalSelectionRevision || activeTerminalId !== terminalId) return false;
            await loadNavigation(terminalId, {
              openOutput: false,
              selectionRevision,
              pinTerminal: true,
            }).catch(() => {});
            if (terminalSessionLive(terminalId)) return true;
          }
          return false;
        }

        // Single entry point for putting a terminal on the main output surface.
        // A live session attaches straight away; a queued pane is opened first,
        // because attaching to a terminal that has no PTY only yields a 404.
        async function attachTerminal(terminalId, options = {}) {
          if (!terminalId) return false;
          if (terminalSessionLive(terminalId)) {
            openOutput(terminalId, options);
            return true;
          }
          const selectionRevision = terminalSelectionRevision;
          setBusyStatus("Opening the pane on the desktop…");
          const opened = await openTerminalOnHost(terminalId, selectionRevision);
          if (selectionRevision !== terminalSelectionRevision || activeTerminalId !== terminalId) return false;
          if (!opened) {
            setStatus("The desktop has not opened this pane yet.", true);
            return false;
          }
          openOutput(terminalId, options);
          return true;
        }

        async function selectTerminal(terminalId, options = {}) {
          if (!terminalId) return;
          const selectionRevision = ++terminalSelectionRevision;
          const selectedLeaseId = leaseId;
          setActiveTerminal(terminalId);
          terminalMetaEl.textContent = terminalMetaLabel(navigationState, terminalId);
          setConnected(Boolean(leaseId));
          // Output attach begins immediately; host focus/navigation refreshes
          // are independent and must not leave the old socket active meanwhile.
          const live = terminalSessionLive(terminalId);
          attachTerminal(terminalId);
          setNavigationOpen(false);
          // A queued pane is focused by the attach path itself — that is how it
          // gets opened — so focusing here too would only duplicate the request.
          const canFocusHost =
            live && options.focusHost !== false && (options.focusDockHost === true || !isDockTerminalId(terminalId));
          if (canFocusHost) {
            await focusTerminalOnHost(terminalId).catch((err) => setStatus(`Focus failed: ${err.message}`, true));
          }
          if (
            selectionRevision !== terminalSelectionRevision ||
            activeTerminalId !== terminalId ||
            leaseId !== selectedLeaseId
          ) return;
          // The attach path already re-reads navigation while it waits for a
          // queued pane, so only a live selection needs its own refresh.
          if (live && options.refreshNavigation) {
            await loadNavigation(terminalId, { openOutput: false, selectionRevision }).catch((err) => setStatus(`Refresh failed: ${err.message}`, true));
          } else if (live && navigationState) {
            renderNavigation(navigationState);
          }
        }

        function wsBaseUrl() {
          const protocol = location.protocol === "https:" ? "wss:" : "ws:";
          return `${protocol}//${location.host}`;
        }

        function createOutputSocket(url) {
          return androidE2eMode ? new AndroidE2eOutputSocket(url) : new WebSocket(url);
        }

        function resetHistoryExpansion(terminalId) {
          outputHistoryTerminalId = terminalId;
          outputHistoryKib = 0;
          outputHistoryExhausted = false;
          outputSnapshotBytes = 0;
          lastTerminalViewportY = 0;
          // A gesture made on the previous pane must not vouch for a row-0
          // arrival that this pane's own attach fit produces.
          lastTerminalUserScrollAt = 0;
        }

        // The desktop budget is `max(owner setting, request)`, and the page
        // never learns the owner setting. Deriving the next request from the
        // screen the page actually holds keeps the request above that unknown
        // floor: a checkpoint of N bytes came from a budget of at least N, so
        // asking for a multiple of N always widens it until the supported
        // ceiling. A fixed ladder would silently no-op for every owner whose
        // `snapshotMaxKib` already sits above its first rung.
        // Returns the request to make, or why there is none: `atCeiling` means
        // the desktop may still hold older output that this client cannot ask
        // for, which is a different thing to tell the user than "the screen did
        // not grow, so there is nothing older".
        function nextHistoryExpansion() {
          const currentKib = Math.ceil(outputSnapshotBytes / 1024);
          const derivedKib = Math.max(
            HISTORY_EXPANSION_MIN_KIB,
            currentKib * HISTORY_EXPANSION_GROWTH
          );
          const kib = Math.min(HISTORY_EXPANSION_MAX_KIB, derivedKib);
          if (kib > outputHistoryKib) return { kib, atCeiling: false };
          // The ceiling only hides history when the budget was the binding
          // limit. A checkpoint that came back well under the budget that asked
          // for it means the desktop, not this client, ran out of scrollback.
          const budgetWasBinding =
            outputSnapshotBytes + HISTORY_EXPANSION_BUDGET_SLACK_BYTES >= outputHistoryKib * 1024;
          return {
            kib: null,
            atCeiling: derivedKib > HISTORY_EXPANSION_MAX_KIB && budgetWasBinding,
          };
        }

        function finishHistoryExpansion() {
          if (!historyExpansion) return null;
          clearTimeout(historyExpansion.timer);
          const request = historyExpansion;
          historyExpansion = null;
          return request;
        }

        // Releases a pending request that its own attach can no longer answer
        // (superseded attach, early return, timeout) without deciding anything
        // about how much history exists. The budget rolls back with it: no
        // screen ever arrived at the raised budget, so leaving it raised would
        // make the next pull compute the same request, find it not greater, and
        // declare the pane exhausted on transport evidence.
        function cancelHistoryExpansion() {
          const request = finishHistoryExpansion();
          if (!request) return;
          outputHistoryKib = request.previousKib;
          // Only the expansion's own busy line may be cleared. A failure that
          // closed the socket has already put its message on the status bar.
          if (statusTextEl.textContent === HISTORY_EXPANSION_BUSY_STATUS) {
            restoreStatusAfterHistoryExpansion();
          }
        }

        // Settles the pending expansion once its replacement screen is on the
        // surface. The comparison is on serialized snapshot bytes, not on
        // buffer rows: the replay runs at the checkpoint geometry and the fit
        // that follows reflows it, so row counts across the two attaches are
        // not comparable. A snapshot that is no bigger than the one it replaces
        // means the desktop has nothing older to give at this budget.
        function settleHistoryExpansion(terminalId, requestId, snapshotBytes) {
          // Only the attach this request started may settle it. A racing
          // reconnect attaches at the pre-expansion budget, so letting its
          // snapshot answer would mark the pane exhausted on false evidence.
          if (!historyExpansion || historyExpansion.id !== requestId) return;
          if (historyExpansion.terminalId !== terminalId) return;
          const request = finishHistoryExpansion();
          if (snapshotBytes > request.baselineSnapshotBytes) {
            restoreStatusAfterHistoryExpansion();
            return;
          }
          outputHistoryExhausted = true;
          reportHistoryExpansionLimit("No earlier output is available.");
        }

        // A transport interruption notice outranks anything this feature has to
        // say: it is describing the connection the user is waiting on.
        // Every "this is as far back as it goes" message goes through here so a
        // visible interruption notice — which describes the connection the user
        // is waiting on — is never replaced by a scrollback verdict.
        function reportHistoryExpansionLimit(message) {
          if (transientConnectionNoticeVisible) return;
          setStatus(message, false, true);
        }

        function restoreStatusAfterHistoryExpansion() {
          // A *visible* interruption notice outranks anything this feature has to
          // say, and its own recovery message replaces it. A notice that is only
          // scheduled has printed nothing yet, so the busy line must still go.
          if (transientConnectionNoticeVisible) return;
          setStatus(activeTerminalTitle() || "Connected.");
        }

        // Scrolling above the attached screen asks the desktop for a deeper
        // screen checkpoint and replays it at the same distance from the live
        // tail, so the rows the user was reading stay put and older rows appear
        // above them (ADR-0182).
        function requestOlderTerminalHistory() {
          const term = terminal;
          if (!term || !leaseId || !activeTerminalId || historyExpansion) return;
          // A connector that predates the history budget would drop the field
          // and re-attach at the same budget for nothing.
          if (androidE2eMode && !androidOutputHistorySupported()) return;
          // While the transport is visibly down, a re-attach cannot land and its
          // busy line would bury the reconnection notice the user is reading.
          if (transientConnectionNoticeVisible) return;
          // Reset/replay and viewport restoration move the viewport on their
          // own. Only scrolls the user caused may ask for more history.
          if (terminalReplayDepth > 0 || restoringTerminalViewport) return;
          if (renderedTerminalId !== activeTerminalId) return;
          if (outputHistoryTerminalId !== activeTerminalId) resetHistoryExpansion(activeTerminalId);
          if (outputHistoryExhausted) return;
          // Alternate-buffer and mouse-reporting apps own the screen: the same
          // predicate that decides whether a gesture scrolls the scrollback at
          // all decides whether more of it may be requested.
          if (!isNormalScrollbackMode(term)) return;
          const buffer = term.buffer && term.buffer.active;
          if (!buffer) return;
          if ((buffer.viewportY ?? 0) > 0) return;
          const { kib: nextKib, atCeiling } = nextHistoryExpansion();
          if (nextKib === null) {
            outputHistoryExhausted = true;
            reportHistoryExpansionLimit(
              atCeiling
                ? "Earlier output is beyond what Remote can load."
                : "No earlier output is available."
            );
            return;
          }
          const terminalId = activeTerminalId;
          const requestId = ++nextHistoryExpansionId;
          historyExpansion = {
            id: requestId,
            terminalId,
            kib: nextKib,
            previousKib: outputHistoryKib,
            baselineSnapshotBytes: outputSnapshotBytes,
            timer: setTimeout(() => {
              if (historyExpansion && historyExpansion.id === requestId) cancelHistoryExpansion();
            }, HISTORY_EXPANSION_TIMEOUT_MS),
          };
          setBusyStatus(HISTORY_EXPANSION_BUSY_STATUS);
          openOutput(terminalId, {
            reconnect: true,
            historyKib: nextKib,
            historyRequestId: requestId,
          });
        }

        function outputReconnectDelayMs(attempt) {
          return Math.min(
            OUTPUT_RECONNECT_MAX_DELAY_MS,
            OUTPUT_RECONNECT_INITIAL_DELAY_MS * Math.pow(2, attempt)
          );
        }

        function scheduleOutputReconnect(terminalId, outputLeaseId) {
          if (!outputLeaseId || leaseId !== outputLeaseId || activeTerminalId !== terminalId) return;
          if (outputReconnectTimer) return;
          const delayMs = outputReconnectDelayMs(outputReconnectAttempt);
          outputReconnectAttempt += 1;
          scheduleTransientConnectionNotice("output");
          outputReconnectTimer = setTimeout(() => {
            outputReconnectTimer = null;
            if (leaseId !== outputLeaseId || activeTerminalId !== terminalId) return;
            openOutput(terminalId, { reconnect: true });
          }, delayMs);
        }

        async function openOutput(terminalId, options = {}) {
          const historyRequestId = Number.isSafeInteger(options.historyRequestId)
            ? options.historyRequestId
            : null;
          // Any attach that is not this request's own supersedes it: that
          // snapshot arrives at the pre-expansion budget and must not be read
          // as evidence about how much history the desktop still has.
          if (historyExpansion && historyExpansion.id !== historyRequestId) {
            cancelHistoryExpansion();
          }
          // Every path out of this function below releases the request it owns;
          // only a delivered snapshot may settle it.
          const releaseOwnHistoryExpansion = () => {
            if (historyExpansion && historyExpansion.id === historyRequestId) {
              cancelHistoryExpansion();
            }
          };
          const terminalInfo = terminalInfoById.get(terminalId);
          ensureRemoteFont(terminalInfo && terminalInfo.appearance);
          const term = ensureTerminal(terminalInfo && terminalInfo.appearance);
          // One PTY geometry per attach: wait (bounded) for the font and the
          // widget strip before the fit below measures, so a late cell width or
          // a late chrome row does not turn into a second SIGWINCH the TUI has
          // to redraw from (ADR-0133). Ahead of `stopSocket` on purpose — the
          // previous pane keeps streaming while this resolves.
          const settleLeaseId = leaseId;
          attachGeometryHolds += 1;
          stopResizeFlush();
          try {
            await awaitAttachChromeSettled(terminalInfo && terminalInfo.appearance);
          } finally {
            attachGeometryHolds -= 1;
          }
          if (leaseId !== settleLeaseId || activeTerminalId !== terminalId) {
            releaseOwnHistoryExpansion();
            return;
          }
          const reconnecting = options.reconnect === true;
          // Transport recovery restores bytes and geometry only. It must not
          // turn a dismissed mobile keyboard back into an active input surface.
          // Initial/user-directed attaches opt in; automatic reconnects do not.
          const focusInputOnOpen = !reconnecting && options.focusInput !== false;
          const preserveViewportOnOpen = reconnecting || options.preserveViewport === true;
          const outputLeaseId = leaseId;
          if (!outputLeaseId) {
            cancelHistoryExpansion();
            setStatus("Remote control is not active.", true);
            return;
          }
          // A history attach whose request was cancelled while it waited above
          // (a reconnect timer that fired inside the settle await) must not
          // re-raise the budget it no longer owns. The chrome settle held this
          // surface's geometry publishing for its whole duration, so hand the
          // fit back before dropping out.
          if (historyRequestId !== null && historyExpansion?.id !== historyRequestId) {
            scheduleTerminalFit(true);
            return;
          }
          // A pane switch starts over at the desktop's own budget, and so does a
          // user-directed re-attach of the same pane — it lands at the live tail
          // anyway. Only automatic recovery keeps the history already paged in,
          // and only while the socket still opens.
          if (outputHistoryTerminalId !== terminalId) resetHistoryExpansion(terminalId);
          if (Number.isSafeInteger(options.historyKib)) {
            outputHistoryKib = options.historyKib;
          } else if (
            !reconnecting ||
            outputReconnectAttempt >= HISTORY_EXPANSION_MAX_FAILED_OPENS
          ) {
            outputHistoryKib = 0;
            // The owner budget is a fresh start: whatever "nothing older" meant
            // at the raised budget no longer applies.
            outputHistoryExhausted = false;
          }
          const historyKib = outputHistoryKib;
          stopSocket(!reconnecting);
          if (!reconnecting) {
            stopInputFlush();
            stopResizeFlush();
          }
          const outputGeneration = terminalOutputGeneration;
          applyTerminalAppearance(terminalInfo && terminalInfo.appearance);
          composerReady = false;
          renderInputSurface();
          updateTerminalControls();
          lastResizeKey = "";

          // Establish the Remote grid as the PTY geometry before asking the
          // desktop renderer for a checkpoint. resizeTerminal waits for the
          // physical resize, so a geometry-only reflow or the resulting TUI
          // redraw is sequenced ahead of the snapshot target in both Direct
          // and Cloud paths.
          fitTerminalForAttach();
          stopResizeFlush();
          const attachCols = term.cols;
          const attachRows = term.rows;
          outputAttachGeometryGeneration = outputGeneration;
          try {
            await resizeTerminal(terminalId, outputLeaseId, attachCols, attachRows);
          } catch (err) {
            if (
              outputGeneration === terminalOutputGeneration &&
              outputLeaseId === leaseId &&
              activeTerminalId === terminalId
            ) {
              outputAttachGeometryGeneration = null;
              if (err.status === 404) {
                setBusyStatus("Terminal session ended. Refreshing navigation…", true);
                loadNavigation(null, { focusInput: false }).catch((loadError) =>
                  setStatus(`Refresh failed: ${loadError.message}`, true)
                );
              } else {
                setStatus(`Resize before output attach failed: ${err.message}`, true);
                scheduleOutputReconnect(terminalId, outputLeaseId);
              }
            }
            releaseOwnHistoryExpansion();
            return;
          }
          if (
            outputGeneration !== terminalOutputGeneration ||
            outputLeaseId !== leaseId ||
            activeTerminalId !== terminalId
          ) {
            releaseOwnHistoryExpansion();
            return;
          }
          lastResizeKey = `${terminalId}:${attachCols}x${attachRows}`;
          const historyQuery = historyKib > 0 ? `&historyKib=${historyKib}` : "";
          const url = `${wsBaseUrl()}/remote/v1/terminals/${encodeURIComponent(terminalId)}/output?leaseId=${encodeURIComponent(outputLeaseId)}&token=${encodeURIComponent(token())}${historyQuery}`;
          const outputSocket = createOutputSocket(url);
          let outputTerminalMissing = false;
          // Keep the previous surface visible until the replacement snapshot
          // has actually arrived. A checkpoint bridge/reconnect delay must not
          // turn a workspace switch into an eagerly blank terminal.
          let resetOnNextPayload = true;
          let pendingOutputHeader = null;
          let outputPhase = "awaiting-snapshot";
          let expectedOutputSeq = null;
          let outputProtocolFailed = false;
          socket = outputSocket;
          outputSocket.binaryType = "arraybuffer";

          const failOutputProtocol = (message) => {
            if (outputProtocolFailed) return;
            outputProtocolFailed = true;
            outputPhase = "failed";
            composerReady = false;
            updateComposerControls();
            pendingOutputHeader = null;
            setStatus(`Output protocol error: ${message}`, true);
            outputSocket.close();
          };

          // `guardInput` marks replay writes (snapshot + synthetic mode) whose
          // onData replies must be swallowed rather than forwarded to the PTY.
          // Live deltas stay unguarded so real keystrokes typed during heavy
          // output are never dropped by a lingering replay window (issue #480).
          const queueTerminalWrite = (payload, guardInput = false) => {
            terminalOutputWriteChain = terminalOutputWriteChain.then(
              () =>
                new Promise((resolve) => {
                  if (
                    outputProtocolFailed ||
                    outputGeneration !== terminalOutputGeneration ||
                    socket !== outputSocket
                  ) {
                    resolve();
                    return;
                  }
                  if (guardInput) terminalReplayDepth += 1;
                  try {
                    term.write(payload, () => {
                      if (guardInput) terminalReplayDepth -= 1;
                      scheduleTerminalRefresh();
                      // ADR-0188: output invalidates the screen underlines and
                      // pushes the idle scan out; a still screen gets one scan.
                      // The other scopes survive output, so their text is
                      // re-checked rather than trusted.
                      revalidatePathLinkScopes();
                      schedulePathLinkIdleScan();
                      resolve();
                    });
                  } catch (_err) {
                    // A synchronous throw means the callback never fires; undo
                    // the guard and unblock the chain so input is not wedged.
                    if (guardInput) terminalReplayDepth -= 1;
                    resolve();
                  }
                })
            );
            return terminalOutputWriteChain;
          };

          const queueTerminalReset = () => {
            terminalOutputWriteChain = terminalOutputWriteChain.then(() => {
              if (
                !outputProtocolFailed &&
                outputGeneration === terminalOutputGeneration &&
                socket === outputSocket
              ) {
                // reset() only runs at attach/reconnect, never mid-stream, so
                // guarding it can't drop live keystrokes.
                clearPathLinkSelection();
                terminalReplayDepth += 1;
                try {
                  term.reset();
                } finally {
                  terminalReplayDepth -= 1;
                }
                scheduleTerminalRefresh();
              }
            });
            return terminalOutputWriteChain;
          };

          const queueTerminalGeometry = (geometry) => {
            terminalOutputWriteChain = terminalOutputWriteChain.then(() => {
              if (
                !outputProtocolFailed &&
                outputGeneration === terminalOutputGeneration &&
                socket === outputSocket &&
                (term.cols !== geometry.cols || term.rows !== geometry.rows)
              ) {
                term.resize(geometry.cols, geometry.rows);
              }
            });
            return terminalOutputWriteChain;
          };

          // Old hosts may still stream unsequenced bytes. Keep them viewable so
          // reconnect remains graceful, but never mark structured input ready:
          // paste and Composer stay fail-closed without authoritative state.
          const acceptLegacyOutput = (payload) => {
            const landingLegacySnapshot = resetOnNextPayload;
            const preservedViewportDistance =
              landingLegacySnapshot &&
              preserveViewportOnOpen &&
              renderedTerminalId === terminalId
                ? terminalViewportDistanceFromBottom(term)
                : 0;
            if (landingLegacySnapshot) {
              queueTerminalReset();
              resetOnNextPayload = false;
            }
            queueTerminalWrite(payload).then(() => {
              if (
                landingLegacySnapshot &&
                outputGeneration === terminalOutputGeneration &&
                socket === outputSocket &&
                leaseId === outputLeaseId &&
                activeTerminalId === terminalId
              ) {
                renderedTerminalId = terminalId;
                restoreTerminalViewport(term, preservedViewportDistance);
                updateScrollToBottomButton(term);
                if (!reconnecting && currentInputMode() === "composer") {
                  offsetComposerForActiveAgent();
                }
                // An unsequenced host has no screen checkpoint and ignores the
                // history budget, so this surface can never page older output.
                const askedForHistory = historyExpansion?.id === historyRequestId;
                releaseOwnHistoryExpansion();
                outputHistoryExhausted = true;
                if (askedForHistory) {
                  reportHistoryExpansionLimit("No earlier output is available.");
                }
              }
              if (outputAttachGeometryGeneration === outputGeneration) {
                outputAttachGeometryGeneration = null;
                scheduleTerminalFit(true);
              }
            });
          };

          const acceptOutputHeader = (header) => {
            if (
              !header ||
              header.type !== "terminal.output" ||
              header.version !== 1 ||
              (header.phase !== "snapshot" && header.phase !== "delta") ||
              !Number.isSafeInteger(header.seqStart) ||
              !Number.isSafeInteger(header.seqEnd) ||
              !Number.isSafeInteger(header.byteLength) ||
              header.seqStart < 0 ||
              header.seqEnd < header.seqStart ||
              header.byteLength !== header.seqEnd - header.seqStart
            ) {
              failOutputProtocol("invalid terminal.output v1 header");
              return;
            }
            if (pendingOutputHeader) {
              failOutputProtocol("header received before its binary payload");
              return;
            }

            if (header.phase === "snapshot") {
              const state = header.state;
              if (
                outputPhase !== "awaiting-snapshot" ||
                !state ||
                state.version !== 1 ||
                !Number.isSafeInteger(state.snapshotStartSeq) ||
                !Number.isSafeInteger(state.snapshotSeq) ||
                state.snapshotStartSeq !== header.seqStart ||
                state.snapshotSeq !== header.seqEnd ||
                !Number.isSafeInteger(state.protocolRevision) ||
                state.protocolRevision < 0 ||
                typeof state.modes?.bracketedPaste !== "boolean"
              ) {
                failOutputProtocol("invalid snapshot attach state");
                return;
              }
              // Extended state is mandatory for renderer checkpoints. Accept a
              // pre-extension raw V1 state only as the documented legacy path;
              // it replays at the geometry synchronously established above.
              const hasExtendedAttachState =
                state.generation !== undefined ||
                state.sourceStartSeq !== undefined ||
                state.sourceSeq !== undefined ||
                state.snapshotKind !== undefined ||
                state.geometry !== undefined;
              if (
                hasExtendedAttachState &&
                (
                  !Number.isSafeInteger(state.generation) ||
                  state.generation < 0 ||
                  !Number.isSafeInteger(state.sourceStartSeq) ||
                  !Number.isSafeInteger(state.sourceSeq) ||
                  state.sourceStartSeq < 0 ||
                  state.sourceSeq < state.sourceStartSeq ||
                  (state.snapshotKind !== "raw" && state.snapshotKind !== "screen") ||
                  !state.geometry ||
                  !Number.isSafeInteger(state.geometry.revision) ||
                  state.geometry.revision < 0 ||
                  !Number.isSafeInteger(state.geometry.cols) ||
                  state.geometry.cols <= 0 ||
                  !Number.isSafeInteger(state.geometry.rows) ||
                  state.geometry.rows <= 0
                )
              ) {
                failOutputProtocol("invalid extended snapshot attach state");
                return;
              }
              pendingOutputHeader = { ...header, trimPrefix: 0 };
              return;
            }

            if (outputPhase !== "attached" || expectedOutputSeq === null) {
              failOutputProtocol("delta received before snapshot");
              return;
            }
            if (header.state !== undefined) {
              failOutputProtocol("delta must not carry attach state");
              return;
            }
            if (header.seqStart > expectedOutputSeq) {
              failOutputProtocol("output sequence gap");
              return;
            }
            pendingOutputHeader = {
              ...header,
              trimPrefix: Math.min(header.byteLength, expectedOutputSeq - header.seqStart),
            };
          };

          const acceptOutputBinary = (payload) => {
            const header = pendingOutputHeader;
            pendingOutputHeader = null;
            if (!header || payload.byteLength !== header.byteLength) {
              failOutputProtocol("binary payload length mismatch");
              return Promise.resolve();
            }

            if (header.phase === "snapshot") {
              // The old surface intentionally remains interactive while the
              // replacement checkpoint is in flight. Capture its latest scroll
              // offset only now, immediately before reset/replay destroys it.
              const preservedViewportDistance =
                preserveViewportOnOpen && renderedTerminalId === terminalId
                  ? terminalViewportDistanceFromBottom(term)
                  : 0;
              outputPhase = "attached";
              expectedOutputSeq = header.seqEnd;
              // SerializeAddon output is geometry-sensitive: replay it only at
              // the exact grid that produced it. The pre-attach /resize should
              // already make these equal; this is the fail-safe for a racing
              // viewport or an older host.
              if (header.state.geometry) queueTerminalGeometry(header.state.geometry);
              if (resetOnNextPayload) {
                queueTerminalReset();
                resetOnNextPayload = false;
              }
              const syntheticMode = header.state.modes.bracketedPaste
                ? "\x1b[?2004h"
                : "\x1b[?2004l";
              return queueTerminalWrite(payload, true)
                .then(() => queueTerminalWrite(syntheticMode, true))
                .then(() => {
                if (
                  outputProtocolFailed ||
                  outputGeneration !== terminalOutputGeneration ||
                  socket !== outputSocket ||
                  leaseId !== outputLeaseId ||
                  activeTerminalId !== terminalId
                ) {
                  return;
                }
                renderedTerminalId = terminalId;
                // User-directed attaches land at the live tail. Same-terminal
                // transport/lease recovery restores the surface-local distance
                // from that tail instead of discarding a scrolled-up viewport.
                restoreTerminalViewport(term, preservedViewportDistance);
                updateScrollToBottomButton(term);
                if (!reconnecting && currentInputMode() === "composer") {
                  offsetComposerForActiveAgent();
                }
                settleHistoryExpansion(terminalId, historyRequestId, header.byteLength);
                outputSnapshotBytes = header.byteLength;
                if (outputAttachGeometryGeneration === outputGeneration) {
                  outputAttachGeometryGeneration = null;
                }
                composerReady = true;
                updateComposerControls();
                scheduleTerminalFit(true);
                });
            }

            const suffix = header.trimPrefix
              ? payload.subarray(header.trimPrefix)
              : payload;
            expectedOutputSeq = Math.max(expectedOutputSeq, header.seqEnd);
            return suffix.byteLength > 0
              ? queueTerminalWrite(suffix)
              : Promise.resolve();
          };

          outputSocket.onopen = () => {
            if (socket === outputSocket && leaseId === outputLeaseId && activeTerminalId === terminalId) {
              outputReconnectAttempt = 0;
              // Prefer the friendly "Workspace · Pane N" context title over the
              // raw terminal id (issue #474 header identity).
              const attachTitle =
                (terminalId === activeTerminalId && activeTerminalTitle()) ||
                `Connected to ${terminalId}`;
              clearTransientConnectionNotice("output", attachTitle);
              if (!reconnecting) setStatus(attachTitle);
              if (focusInputOnOpen) focusInputSurfaceAfterAwait();
              if (reconnecting) heartbeat().catch((err) => handleHeartbeatError(err));
            }
          };
          outputSocket.onmessage = (event) => {
            if (socket !== outputSocket || outputProtocolFailed) return;
            if (event.data instanceof ArrayBuffer) {
              const payload = new Uint8Array(event.data);
              let completion = Promise.resolve();
              if (pendingOutputHeader) {
                completion = acceptOutputBinary(payload);
              } else if (outputPhase === "attached") {
                failOutputProtocol("binary payload received without a header");
              } else {
                acceptLegacyOutput(payload);
              }
              if (typeof outputSocket.acknowledge === "function") {
                completion.finally(() => outputSocket.acknowledge());
              }
              return;
            }
            const payload = String(event.data);
            if (payload === "terminal session not found") {
              outputTerminalMissing = true;
              setBusyStatus("Terminal session ended. Refreshing navigation…", true);
              outputSocket.close();
              return;
            }
            let header;
            try {
              header = JSON.parse(payload);
            } catch (_) {
              if (outputPhase === "attached") {
                failOutputProtocol("non-JSON text frame");
              } else {
                acceptLegacyOutput(payload);
              }
              return;
            }
            acceptOutputHeader(header);
            if (typeof outputSocket.acknowledge === "function") {
              outputSocket.acknowledge();
            }
          };
          outputSocket.onclose = () => {
            if (socket === outputSocket) {
              socket = null;
              // A socket that dies before its snapshot cannot answer the
              // history request it was opened for.
              releaseOwnHistoryExpansion();
              if (outputAttachGeometryGeneration === outputGeneration) {
                outputAttachGeometryGeneration = null;
              }
              composerReady = false;
              updateComposerControls();
              if (outputTerminalMissing) {
                loadNavigation(null, { focusInput: false }).catch((err) =>
                  setStatus(`Refresh failed: ${err.message}`, true)
                );
                return;
              }
              scheduleOutputReconnect(terminalId, outputLeaseId);
            }
          };
          outputSocket.onerror = () => {
            if (socket === outputSocket) scheduleTransientConnectionNotice("output");
          };
        }

        async function claimRemoteControl(attemptRevision) {
          let claimReservationId = null;
          let reservationExpiresAt = null;
          while (attemptRevision === claimAttemptRevision) {
            try {
              // Presenting the resume capability lets the server replace this
              // tab's own zombie lease (or follow its release drain) after
              // back/reload instead of rejecting the claim with 409 until the
              // heartbeat timeout.
              return await remoteFetch("/remote/v1/session/claim", {
                method: "POST",
                body: JSON.stringify({
                  clientName: clientNameInput.value.trim() || "browser",
                  ...(resumeToken ? { resumeToken } : {}),
                  ...(claimReservationId ? { claimReservationId } : {}),
                }),
              });
            } catch (err) {
              const retryable =
                err.status === 409 &&
                err.code === "input_busy" &&
                typeof err.claimReservationId === "string" &&
                err.claimReservationId.length > 0;
              if (!retryable) throw err;
              if (claimReservationId && claimReservationId !== err.claimReservationId) {
                throw new Error("Remote control claim reservation changed unexpectedly.");
              }
              claimReservationId = err.claimReservationId;
              const now = Date.now();
              const ttlMs = Number(err.reservationTtlMs);
              const retryAfterMs = Math.max(10, Number(err.retryAfterMs) || 25);
              if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
                throw new Error("Remote control claim reservation expired.");
              }
              const reportedExpiry = now + ttlMs;
              reservationExpiresAt = reportedExpiry;
              if (now + retryAfterMs >= reservationExpiresAt) {
                throw new Error("Remote control claim reservation expired.");
              }
              setBusyStatus("Waiting for input…");
              await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
            }
          }
          throw new Error("Remote control claim was cancelled.");
        }

        // Reconnecting after a long background (issue #561). Leaving the page
        // releases the lease (ADR-0037 pagehide release) and a long absence expires
        // it anyway, so coming back always found a disconnected page and cost a
        // deliberate Connect tap. Arm the return trip instead: connecting once says
        // "I want this tab in control", pressing Release says the opposite.
        //
        // ADR-0027 refused to auto-claim after the server confirmed a loss, because a
        // hidden tab must not take control back from someone at the PC. That still
        // holds — every attempt here is tied to the document becoming *visible*, and
        // a definitive refusal (401/403/409: bad token, remote disabled, someone else
        // holds control, local reclaim lockout) disarms it until the user acts.
        function armAutoConnect() {
          autoConnectAttempt = 0;
          try {
            sessionStorage.setItem(autoConnectKey, "1");
          } catch (_) {}
        }

        function disarmAutoConnect() {
          cancelAutoConnectRetry();
          autoConnectAttempt = 0;
          try {
            sessionStorage.removeItem(autoConnectKey);
          } catch (_) {}
        }

        function autoConnectArmed() {
          try {
            return sessionStorage.getItem(autoConnectKey) === "1";
          } catch (_) {
            return false;
          }
        }

        function cancelAutoConnectRetry() {
          if (autoConnectTimer) {
            clearTimeout(autoConnectTimer);
            autoConnectTimer = null;
          }
        }

        function autoConnectRetryDelayMs() {
          const delay = AUTO_CONNECT_RETRY_BASE_MS * 2 ** Math.min(autoConnectAttempt, 4);
          return Math.min(delay, AUTO_CONNECT_RETRY_MAX_MS);
        }

        function maybeAutoConnect() {
          cancelAutoConnectRetry();
          // Visibility is the whole safety argument: never claim from the background.
          if (document.visibilityState !== "visible") return;
          if (leaseId || claimInFlight || !autoConnectArmed() || (!androidE2eMode && !token())) return;
          autoConnectWhenFree().catch(() => {});
        }

        // Reconnecting is not a takeover. Another tab, another device, or the host
        // may legitimately hold control now, and racing them turns the other
        // session into a 409 fight the user did not ask for. Ask first, and stay out
        // of the way — except when we hold the resume capability, which can only
        // replace the lease this tab itself owned (ADR-0037).
        async function autoConnectWhenFree() {
          try {
            const status = await remoteFetch("/remote/v1/session/status");
            if (status && status.active && !resumeToken) {
              setStatus("Another client has control.");
              return;
            }
          } catch (err) {
            // Only a bad token or remote access being off are answers on their own.
            // Everything else — including a 409, which ownership-wise this endpoint
            // has no business emitting — is advisory: the claim is what judges
            // ownership, so a failed pre-check must not block or disarm the reclaim.
            if (err && (err.status === 401 || err.status === 403)) {
              disarmAutoConnect();
              setStatus(err.message, true);
              return;
            }
          }
          if (document.visibilityState !== "visible" || leaseId) return;
          await connect({ auto: true });
        }

        function scheduleAutoConnectRetry() {
          if (autoConnectTimer || !autoConnectArmed()) return;
          if (document.visibilityState !== "visible") return;
          const delay = autoConnectRetryDelayMs();
          autoConnectAttempt += 1;
          autoConnectTimer = setTimeout(() => {
            autoConnectTimer = null;
            maybeAutoConnect();
          }, delay);
        }

        // `focusInput` defaults to manual-connect behavior. A boot-time
        // autoConnect claim runs outside any user gesture: focusing the input
        // there leaves DOM focus WITHOUT a soft keyboard (mobile browsers only
        // raise the IME for gesture-driven focus), and the Keyboard toggle then
        // reads that stray focus as "keyboard is up" — its first tap dismisses
        // instead of raising.
        async function connect({ auto = false, focusInput = !auto } = {}) {
          if (!androidE2eMode && !token()) {
            setStatus("Remote token is required.", true);
            return;
          }
          // One claim at a time. The automatic reconnect and a user tapping Connect
          // aim at the same lease: two claims meant the loser saw a 409 for a lease
          // its own tab had just taken, and `claimAttemptRevision` then released the
          // winner as stale — so both failed and the page waited for a backoff retry.
          // Whoever is already trying will report the outcome (issue #561).
          if (claimInFlight) {
            if (!auto) setBusyStatus("Claiming remote control…");
            return;
          }
          claimInFlight = true;
          const attemptRevision = ++claimAttemptRevision;
          connectButton.disabled = true;
          if (!androidE2eMode) localStorage.setItem(tokenKey, token());
          setBusyStatus(
            auto ? "Reconnecting…" : "Claiming remote control…",
            false,
            auto,
          );
          try {
            const status = await claimRemoteControl(attemptRevision);
            if (attemptRevision !== claimAttemptRevision) {
              if (status.leaseId) await releaseLease(status.leaseId).catch(() => {});
              return;
            }
            leaseId = status.leaseId;
            if (androidE2eMode) window.LaymuxNative.setRemoteLease(leaseId);
            armAutoConnect();
            // Memory only — never in storage while the document is alive.
            resumeToken = status.resumeToken || null;
            fileViewerToken = status.fileViewerToken || null;
            ensureTerminal();
            setConnected(true);
            startHeartbeat(status.heartbeatTimeoutSeconds || DEFAULT_HEARTBEAT_TIMEOUT_SECONDS);
            // The terminal list already carries the PC-owned terminal size in
            // its appearance. Refresh the narrow settings projection in the
            // background so composer size follows too without delaying the
            // first heartbeat or navigation attach.
            loadRemoteDisplaySettings({ reportErrors: false }).catch(() => {});
            // Widgets need the token, not the lease (ADR-0124): losing control
            // to the host later does not take the indicators away.
            startWidgetPolling();
            // `undefined`, not `null`: the parameter's default is the remembered
            // pane hint, and an explicit `null` opts out of it — a reconnect then
            // lands on the focused pane instead of the one this tab was on.
            await loadNavigation(undefined, {
              focusInput,
              preserveViewport: auto,
            });
            setNavigationOpen(false);
          } catch (err) {
            if (attemptRevision !== claimAttemptRevision) return;
            const failedLease = leaseId;
            disconnect(false);
            if (failedLease) await releaseLease(failedLease).catch(() => {});
            // A definitive refusal is an answer, not a hiccup: the host reclaimed,
            // another client holds control, remote access is off, or the token is
            // wrong. Retrying cannot change any of those, and quietly hammering the
            // host would be exactly the takeover ADR-0027 refused. Requires the user.
            // The claim is where ownership is settled. A `409` while the previous
            // owner handoff drains is a "not yet", not a "no" — everything else
            // (another controller holds it, the host reclaimed, bad token, remote off)
            // cannot be changed by trying again.
            const drainInProgress = err && err.status === 409 && err.transitioning === true;
            if (isFatalRemoteControlError(err) && !drainInProgress) {
              disarmAutoConnect();
              setStatus(err.message, true);
              return;
            }
            if (auto) {
              scheduleAutoConnectRetry();
              // Transient (offline, relay still down): keep the reason visible but
              // do not paint it as a failure the user has to act on.
              setBusyStatus(`Reconnecting… ${err.message}`, false, true);
              return;
            }
            setStatus(err.message, true);
          } finally {
            claimInFlight = false;
          }
        }

        async function writeToTerminal(terminalId, activeLeaseId, data) {
          await remoteFetch(`/remote/v1/terminals/${encodeURIComponent(terminalId)}/write`, {
            method: "POST",
            body: JSON.stringify({ leaseId: activeLeaseId, data }),
          });
        }

        async function writeTerminalInput(terminalId, activeLeaseId, text, submit, signal) {
          await remoteFetch(`/remote/v1/terminals/${encodeURIComponent(terminalId)}/input`, {
            method: "POST",
            body: JSON.stringify({ leaseId: activeLeaseId, text, submit }),
            signal,
          });
        }

        function attachmentSelectionSnapshot() {
          const terminalId = activeTerminalId;
          if (!terminalId || !leaseId) return null;
          const draft = composerDraft(terminalId);
          return {
            terminalId,
            leaseId,
            mode: currentInputMode(),
            revision: draft?.revision ?? 0,
            text: draft?.text ?? "",
            selectionStart: composerInput.selectionStart ?? draft?.text.length ?? 0,
            selectionEnd: composerInput.selectionEnd ?? draft?.text.length ?? 0,
          };
        }

        function clearAttachmentChooserRetryTimers() {
          for (const timer of attachmentChooserRetryTimers) window.clearTimeout(timer);
          attachmentChooserRetryTimers.clear();
        }

        function invalidateAttachmentChooser() {
          attachmentChooserRevision += 1;
          pendingAttachmentChooser = null;
          clearAttachmentChooserRetryTimers();
          attachmentInput.value = "";
        }

        function beginAttachmentChooser() {
          invalidateAttachmentChooser();
          const snapshot = attachmentSelectionSnapshot();
          if (!snapshot) return null;
          const chooser = {
            revision: attachmentChooserRevision,
            snapshot,
          };
          pendingAttachmentChooser = chooser;
          return chooser;
        }

        function attachmentChooserIsCurrent(chooser) {
          return (
            chooser &&
            pendingAttachmentChooser === chooser &&
            chooser.revision === attachmentChooserRevision &&
            chooser.snapshot.terminalId === activeTerminalId &&
            chooser.snapshot.leaseId === leaseId
          );
        }

        function formatAttachmentPath(path) {
          const normalized = String(path || "");
          if (!/\s/.test(normalized)) return normalized;
          return `"${normalized.replaceAll('"', '\\"')}"`;
        }

        function insertComposerAttachmentText(snapshot, insertion) {
          const draft = composerDraft(snapshot.terminalId);
          if (!draft) return;
          const snapshotStillCurrent =
            draft.revision === snapshot.revision && draft.text === snapshot.text;
          const start = snapshotStillCurrent
            ? Math.max(0, Math.min(snapshot.selectionStart, draft.text.length))
            : draft.text.length;
          const end = snapshotStillCurrent
            ? Math.max(start, Math.min(snapshot.selectionEnd, draft.text.length))
            : draft.text.length;
          const before = draft.text.slice(0, start);
          const after = draft.text.slice(end);
          const leadingSpace = before && !/\s$/.test(before) ? " " : "";
          const trailingSpace = after && !/^\s/.test(after) ? " " : "";
          draft.text = `${before}${leadingSpace}${insertion}${trailingSpace}${after}`;
          draft.revision += 1;
          if (activeTerminalId === snapshot.terminalId) {
            resetComposerSuggestions();
            renderInputSurface();
            const caret = before.length + leadingSpace.length + insertion.length;
            composerInput.setSelectionRange(caret, caret);
          }
        }

        function blobBase64(blob) {
          return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () =>
              reject(reader.error || new Error("Attachment could not be read."));
            reader.onload = () => {
              const result = String(reader.result || "");
              const separator = result.indexOf(",");
              if (separator < 0) {
                reject(new Error("Attachment encoding failed."));
                return;
              }
              resolve(result.slice(separator + 1));
            };
            reader.readAsDataURL(blob);
          });
        }

        async function uploadRemoteAttachment(snapshot, file, signal) {
          if (file.size > REMOTE_ATTACHMENT_MAX_BYTES) {
            throw new Error(`${file.name} exceeds the 1 MiB attachment limit.`);
          }
          const data = await blobBase64(file);
          return remoteFetch(
            `/remote/v1/terminals/${encodeURIComponent(snapshot.terminalId)}/attachments`,
            {
              method: "POST",
              signal,
              body: JSON.stringify({
                leaseId: snapshot.leaseId,
                fileName: file.name || "attachment.txt",
                mimeType: file.type || "application/octet-stream",
                data,
              }),
            },
          );
        }

        async function attachRemoteFiles(files, options = {}) {
          const snapshot = options.snapshot || attachmentSelectionSnapshot();
          if (
            !snapshot ||
            !composerReady ||
            attachmentUploadInFlight ||
            files.length === 0
          ) {
            return false;
          }
          const attempt = {
            token: Symbol("attachment-upload"),
            abortController: new AbortController(),
          };
          attachmentUploadAttempt = attempt;
          attachmentUploadInFlight = true;
          updateComposerControls();
          setBusyStatus(
            files.length === 1
              ? `Attaching ${files[0].name}…`
              : `Attaching ${files.length} files…`,
          );
          try {
            const paths = [];
            for (const file of files) {
              const response = await uploadRemoteAttachment(
                snapshot,
                file,
                attempt.abortController.signal,
              );
              if (attachmentUploadAttempt?.token !== attempt.token) return false;
              paths.push(formatAttachmentPath(response.path));
            }
            if (
              snapshot.terminalId !== activeTerminalId ||
              snapshot.leaseId !== leaseId
            ) {
              throw new Error("Terminal changed while the attachment was uploading.");
            }
            const insertion = paths.join(" ");
            if (snapshot.mode === "composer") {
              insertComposerAttachmentText(snapshot, insertion);
            } else {
              await writeTerminalInput(
                snapshot.terminalId,
                snapshot.leaseId,
                insertion,
                false,
                attempt.abortController.signal,
              );
              if (attachmentUploadAttempt?.token !== attempt.token) return false;
            }
            setStatus(
              files.length === 1
                ? `Attached ${files[0].name}.`
                : `Attached ${files.length} files.`,
            );
            return true;
          } catch (error) {
            if (
              attachmentUploadAttempt?.token !== attempt.token ||
              error?.name === "AbortError"
            ) {
              return false;
            }
            if (
              options.fallbackText &&
              snapshot.terminalId === activeTerminalId &&
              snapshot.leaseId === leaseId
            ) {
              try {
                if (snapshot.mode === "composer") {
                  insertComposerAttachmentText(snapshot, options.fallbackText);
                } else {
                  await writeTerminalInput(
                    snapshot.terminalId,
                    snapshot.leaseId,
                    options.fallbackText,
                    false,
                    attempt.abortController.signal,
                  );
                  if (attachmentUploadAttempt?.token !== attempt.token) return false;
                }
                setStatus(
                  `Attachment conversion failed; pasted the original text. ${error.message || error}`,
                  false,
                  true,
                );
                return false;
              } catch (fallbackError) {
                if (
                  attachmentUploadAttempt?.token !== attempt.token ||
                  fallbackError?.name === "AbortError"
                ) {
                  return false;
                }
                setStatus(`Paste failed: ${fallbackError.message || fallbackError}`, true);
                return false;
              }
            }
            setStatus(`Attachment failed: ${error.message || error}`, true);
            return false;
          } finally {
            if (attachmentUploadAttempt?.token === attempt.token) {
              attachmentUploadAttempt = null;
              attachmentUploadInFlight = false;
              attachmentInput.value = "";
              updateComposerControls();
              // Not gated on the pointer (ADR-0196 scopes the gate to attach):
              // this focus undoes a blur this flow caused itself — the editor is
              // disabled while the upload is in flight — and it lands one short
              // same-origin POST after the tap, not a multi-round-trip attach.
              focusCurrentInputSurface();
            }
          }
        }

        function cancelAttachmentUpload() {
          const attempt = attachmentUploadAttempt;
          if (!attempt) return;
          attachmentUploadAttempt = null;
          attachmentUploadInFlight = false;
          attempt.abortController.abort();
          attachmentInput.value = "";
          updateComposerControls();
        }

        function longTextAttachmentFile(text) {
          return new File([text], "pasted-text.txt", { type: "text/plain" });
        }

        function shouldConvertLongTextToAttachment(text) {
          return (
            attachmentTextByteLength(text) >
            REMOTE_LONG_TEXT_ATTACHMENT_THRESHOLD_BYTES
          );
        }

        function attachmentTextByteLength(text) {
          return attachmentTextEncoder.encode(text).byteLength;
        }

        function cancelComposerSubmissions() {
          for (const draft of composerDraftByTerminalId.values()) {
            draft.inFlight?.abortController?.abort();
            draft.inFlight = null;
          }
          updateComposerControls();
        }

        function commitComposer() {
          if (!leaseId || !activeTerminalId || !composerReady) return;
          const terminalId = activeTerminalId;
          const activeLeaseId = leaseId;
          const draft = composerDraft(terminalId);
          if (!draft || draft.inFlight) return;

          const submission = {
            token: Symbol("composer-submission"),
            terminalId,
            revision: draft.revision,
            text: draft.text,
            abortController: new AbortController(),
          };
          draft.inFlight = submission;
          updateComposerControls();

          writeTerminalInput(
            terminalId,
            activeLeaseId,
            submission.text,
            true,
            submission.abortController.signal
          )
            .then(() => {
              if (draft.inFlight !== submission) return;
              draft.inFlight = null;
              // Record the text that was actually sent for the recall popup /
              // autocomplete. Runtime Map only — never persisted (see the
              // composerHistoryByScopeKey declaration).
              pushComposerHistory(terminalId, submission.text);
              if (
                draft.revision === submission.revision &&
                draft.text === submission.text
              ) {
                draft.text = "";
                draft.revision += 1;
              }
              if (activeTerminalId === terminalId) {
                resetComposerSuggestions();
                renderInputSurface();
              }
            })
            .catch((err) => {
              if (draft.inFlight !== submission) return;
              draft.inFlight = null;
              if (activeTerminalId === terminalId) renderInputSurface();
              setStatus(`Input failed: ${err.message || err}`, true);
            });
        }

        function handleDirectTerminalPaste(event) {
          if (currentInputMode() !== "direct") return;
          event.preventDefault();
          event.stopImmediatePropagation();
          if (!leaseId || !activeTerminalId || !composerReady) {
            setStatus("Terminal input is not ready.", false, true);
            return;
          }
          const text = event.clipboardData?.getData("text/plain") || "";
          if (!text) return;
          const terminalId = activeTerminalId;
          const activeLeaseId = leaseId;
          if (shouldConvertLongTextToAttachment(text)) {
            if (attachmentTextByteLength(text) > REMOTE_ATTACHMENT_MAX_BYTES) {
              setStatus("Pasted text exceeds the 1 MiB attachment limit.", true);
              return;
            }
            if (attachmentUploadInFlight) {
              setStatus(
                "A long paste was rejected because an attachment upload is already in progress.",
                false,
                true,
              );
              return;
            }
            void attachRemoteFiles([longTextAttachmentFile(text)], {
              snapshot: {
                terminalId,
                leaseId: activeLeaseId,
                mode: "direct",
                revision: 0,
                text: "",
                selectionStart: 0,
                selectionEnd: 0,
              },
              fallbackText: text,
            });
            return;
          }
          writeTerminalInput(terminalId, activeLeaseId, text, false).catch((err) =>
            setStatus(`Paste failed: ${err.message || err}`, true)
          );
        }

        function queueInputWrite(data, inputTerminalId, inputLeaseId) {
          inputWriteChain = inputWriteChain
            .catch(() => {})
            .then(() => {
              if (inputTerminalId !== activeTerminalId || inputLeaseId !== leaseId) return;
              return writeToTerminal(inputTerminalId, inputLeaseId, data);
            })
            .catch((err) => setStatus(err.message, true));
        }

        function flushPendingInput() {
          if (inputFlushTimer) {
            clearTimeout(inputFlushTimer);
            inputFlushTimer = null;
          }
          const dataToSend = pendingInput;
          const inputTerminalId = pendingInputTerminalId;
          const inputLeaseId = pendingInputLeaseId;
          pendingInput = "";
          pendingInputTerminalId = null;
          pendingInputLeaseId = null;
          if (!dataToSend || !inputTerminalId || !inputLeaseId) return;
          queueInputWrite(dataToSend, inputTerminalId, inputLeaseId);
        }

        function enqueueInput(data) {
          if (!leaseId || !activeTerminalId) return;
          if (
            pendingInput &&
            (pendingInputTerminalId !== activeTerminalId || pendingInputLeaseId !== leaseId)
          ) {
            flushPendingInput();
          }
          pendingInputTerminalId = activeTerminalId;
          pendingInputLeaseId = leaseId;
          pendingInput += data;
          if (!inputFlushTimer) inputFlushTimer = setTimeout(flushPendingInput, 12);
        }

        function enqueueDiscreteInput(data, repeat = 1) {
          if (
            terminalReplayDepth > 0 ||
            !leaseId ||
            !activeTerminalId ||
            !data ||
            repeat < 1
          ) {
            return;
          }
          flushPendingInput();
          const inputTerminalId = activeTerminalId;
          const inputLeaseId = leaseId;
          for (let index = 0; index < repeat; index += 1) {
            queueInputWrite(data, inputTerminalId, inputLeaseId);
          }
        }

        // --- Special key toolbar (soft keys) ---
        // Each key sends a terminal control/escape sequence through the same
        // enqueueInput -> /remote/v1/terminals/{id}/write path as Ctrl+C. No new
        // Remote API surface. Cursor keys (arrows/Home/End) are DECCKM-aware.
        const KEY_DEFS = {
          // Step-navigation keys (issue #474, ADR-0039): controller actions on
          // the lease-gated /remote/v1/navigation endpoints, not byte writes.
          // `nav: [kind, direction]` feeds enqueueNavStep; navPad is a 4-way
          // flick (up/down = pane spatial step, left/right = alert step).
          navPad: { label: "P↕N↔", navFlick: true, navBadge: true },
          navPrev: { label: "P↑", nav: ["spatial", "prev"], hint: "Previous pane (spatial order)" },
          navNext: { label: "P↓", nav: ["spatial", "next"], hint: "Next pane (spatial order)" },
          notifRecent: { label: "N←", nav: ["notification", "recent"], navBadge: true, hint: "Most recent unread alert" },
          notifOldest: { label: "N→", nav: ["notification", "oldest"], navBadge: true, hint: "Oldest unread alert" },
          esc: { label: "Esc", seq: "\x1b" },
          tab: { label: "Tab", seq: "\t" },
          stab: { label: "⇧Tab", seq: "\x1b[Z" },
          dpad: { label: "↕↔", flick: true },
          enter: { label: "⏎", seq: "\r", hint: "Enter" },
          bksp: { label: "⌫", seq: "\x7f", hint: "Backspace" },
          up: { label: "↑", cursor: "A" },
          down: { label: "↓", cursor: "B" },
          right: { label: "→", cursor: "C" },
          left: { label: "←", cursor: "D" },
          home: { label: "Home", cursor: "H" },
          end: { label: "End", cursor: "F" },
          ins: { label: "Ins", seq: "\x1b[2~" },
          del: { label: "Del", seq: "\x1b[3~" },
          pgup: { label: "PgUp", seq: "\x1b[5~" },
          pgdn: { label: "PgDn", seq: "\x1b[6~" },
          "c-a": { label: "^A", seq: "\x01" },
          "c-c": { label: "^C", seq: "\x03" },
          "c-d": { label: "^D", seq: "\x04" },
          "c-e": { label: "^E", seq: "\x05" },
          "c-k": { label: "^K", seq: "\x0b" },
          "c-l": { label: "^L", seq: "\x0c" },
          "c-r": { label: "^R", seq: "\x12" },
          "c-t": { label: "^T", seq: "\x14" },
          "c-u": { label: "^U", seq: "\x15" },
          "c-w": { label: "^W", seq: "\x17" },
          "c-z": { label: "^Z", seq: "\x1a" },
          f1: { label: "F1", seq: "\x1bOP" },
          f2: { label: "F2", seq: "\x1bOQ" },
          f3: { label: "F3", seq: "\x1bOR" },
          f4: { label: "F4", seq: "\x1bOS" },
          f5: { label: "F5", seq: "\x1b[15~" },
          f6: { label: "F6", seq: "\x1b[17~" },
          f7: { label: "F7", seq: "\x1b[18~" },
          f8: { label: "F8", seq: "\x1b[19~" },
          f9: { label: "F9", seq: "\x1b[20~" },
          f10: { label: "F10", seq: "\x1b[21~" },
          f11: { label: "F11", seq: "\x1b[23~" },
          f12: { label: "F12", seq: "\x1b[24~" },
        };
        // Stable render order for both the toolbar and the custom-key palette.
        const KEY_ORDER = [
          "navPad", "navPrev", "navNext", "notifRecent", "notifOldest",
          "esc", "tab", "stab", "dpad", "up", "down", "left", "right", "home", "end",
          "enter", "bksp", "ins", "del", "pgup", "pgdn",
          "c-a", "c-c", "c-d", "c-e", "c-k", "c-l", "c-r", "c-t", "c-u", "c-w", "c-z",
          "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
        ];
        const KEY_ID_SET = new Set(KEY_ORDER);
        const KEY_SETS = [
          { id: "step", name: "Pane/Alert nav", desc: "Flick pad · P↑P↓ pane · N←N→ alerts", keys: ["navPad", "navPrev", "navNext", "notifRecent", "notifOldest"] },
          { id: "nav", name: "Navigation", desc: "Arrows · Flick pad · Tab · Esc", keys: ["esc", "tab", "stab", "dpad", "up", "down", "left", "right", "home", "end"] },
          { id: "edit", name: "Editing", desc: "Ins/Del/PgUp/PgDn", keys: ["ins", "del", "pgup", "pgdn", "bksp", "enter"] },
          { id: "ctrl", name: "Ctrl keys", desc: "^C ^D ^Z ^R …", keys: ["c-a", "c-c", "c-d", "c-e", "c-k", "c-l", "c-r", "c-t", "c-u", "c-w", "c-z"] },
          { id: "fn", name: "Function", desc: "F1–F12", keys: ["f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12"] },
        ];
        const INPUT_ACTION_ZONES = ["main", "expanded", "hidden"];
        const FIXED_INPUT_ACTION_IDS = [
          "ctrl-c",
          "keyboard",
          "keys",
          "send",
          "composer",
          "attachment",
        ];
        const INPUT_ACTION_LABELS = {
          "ctrl-c": "Ctrl+C",
          keyboard: "Keyboard",
          keys: "Keys",
          send: "Send",
          composer: "Composer",
          attachment: "Attach file",
        };
        const softInputActionId = (keyId) => `soft:${keyId}`;
        const softKeyIdFromAction = (actionId) =>
          typeof actionId === "string" && actionId.startsWith("soft:")
            ? actionId.slice(5)
            : "";
        const ALL_INPUT_ACTION_IDS = [
          ...FIXED_INPUT_ACTION_IDS,
          ...KEY_ORDER.map(softInputActionId),
        ];
        const DEFAULT_KEYBAR = {
          expanded: false,
          sets: ["step", "nav"],
          custom: [],
          usedCustom: [],
          order: KEY_ORDER,
          zones: {
            main: ["ctrl-c", "keyboard", "keys", "send"],
            expanded: ["composer", ...KEY_ORDER.map(softInputActionId)],
            hidden: ["attachment"],
          },
        };
        // 4-way nav flick mapping — mirrors the desktop shortcuts: vertical =
        // spatial pane step (Ctrl+Alt+Up/Down territory), horizontal = alert
        // step (Ctrl+Alt+Left/Right).
        const NAV_FLICK_TARGETS = {
          up: ["spatial", "prev"],
          down: ["spatial", "next"],
          left: ["notification", "recent"],
          right: ["notification", "oldest"],
        };
        const KEY_FLICK_THRESHOLD_PX = 18;
        const KEY_ORDER_HOLD_MS = 180;
        let selectedOrderKeyId = "";

        function defaultInputZones(softOrder = KEY_ORDER) {
          const normalizedSoftOrder = [
            ...new Set([
              ...softOrder.filter((id) => KEY_ID_SET.has(id)),
              ...KEY_ORDER,
            ]),
          ];
          return {
            main: [...DEFAULT_KEYBAR.zones.main],
            expanded: ["composer", ...normalizedSoftOrder.map(softInputActionId)],
            hidden: [...DEFAULT_KEYBAR.zones.hidden],
          };
        }

        function projectSoftKeyOrderFromZones(zones) {
          const seen = new Set();
          const projected = [];
          for (const zone of INPUT_ACTION_ZONES) {
            for (const actionId of zones[zone]) {
              const keyId = softKeyIdFromAction(actionId);
              if (!KEY_ID_SET.has(keyId) || seen.has(keyId)) continue;
              seen.add(keyId);
              projected.push(keyId);
            }
          }
          for (const keyId of KEY_ORDER) {
            if (seen.has(keyId)) continue;
            seen.add(keyId);
            projected.push(keyId);
          }
          return projected;
        }

        function normalizeInputLayoutConfig(raw) {
          const value = raw && typeof raw === "object" ? raw : {};
          const savedOrder = Array.isArray(value.order)
            ? value.order.filter((id) => KEY_ID_SET.has(id))
            : [];
          const order = [...new Set([...savedOrder, ...KEY_ORDER])];
          const defaults = defaultInputZones(order);
          const zones = { main: [], expanded: [], hidden: [] };
          const seen = new Set();
          const rawZones = value.zones && typeof value.zones === "object" ? value.zones : {};
          const rawZoneValues = INPUT_ACTION_ZONES.flatMap((zone) =>
            Array.isArray(rawZones[zone]) ? rawZones[zone] : [],
          );
          const rawZonesValid =
            INPUT_ACTION_ZONES.every((zone) => Array.isArray(rawZones[zone])) &&
            rawZoneValues.every(
              (actionId) =>
                typeof actionId === "string" && ALL_INPUT_ACTION_IDS.includes(actionId),
            ) &&
            new Set(rawZoneValues).size === rawZoneValues.length &&
            !rawZones.expanded.includes("keys");

          for (const zone of INPUT_ACTION_ZONES) {
            const candidates = rawZonesValid ? rawZones[zone] : [];
            for (const actionId of candidates) {
              if (
                typeof actionId !== "string" ||
                !ALL_INPUT_ACTION_IDS.includes(actionId) ||
                seen.has(actionId)
              ) {
                continue;
              }
              // Keys is the one structural toggle: it may be present in the
              // main row or hidden, never inside the row it opens.
              const targetZone = actionId === "keys" && zone === "expanded" ? "main" : zone;
              zones[targetZone].push(actionId);
              seen.add(actionId);
            }
          }
          for (const zone of INPUT_ACTION_ZONES) {
            for (const actionId of defaults[zone]) {
              if (seen.has(actionId)) continue;
              zones[zone].push(actionId);
              seen.add(actionId);
            }
          }

          const knownSetIds = new Set(KEY_SETS.map((set) => set.id));
          const sets =
            Array.isArray(value.sets) && value.sets.every((id) => knownSetIds.has(id))
              ? [...new Set(value.sets)]
              : [...DEFAULT_KEYBAR.sets];
          const custom = Array.isArray(value.custom)
            ? [...new Set(value.custom.filter((id) => KEY_ID_SET.has(id)))]
            : [];
          const usedCustom = Array.isArray(value.usedCustom)
            ? [...new Set(value.usedCustom.filter((id) => KEY_ID_SET.has(id)))]
            : [...custom];
          const expanded =
            typeof value.expanded === "boolean"
              ? value.expanded
              : typeof value.visible === "boolean"
                ? value.visible
                : DEFAULT_KEYBAR.expanded;
          return {
            expanded: expanded && zones.main.includes("keys"),
            sets,
            custom,
            usedCustom,
            order: projectSoftKeyOrderFromZones(zones),
            zones,
          };
        }

        function loadKeyBarConfig() {
          try {
            return normalizeInputLayoutConfig(
              JSON.parse(localStorage.getItem(keyBarKey) || "null"),
            );
          } catch (_) {
            return normalizeInputLayoutConfig(null);
          }
        }

        let keyBarConfig = loadKeyBarConfig();

        function saveKeyBarConfig() {
          try {
            localStorage.setItem(keyBarKey, JSON.stringify(keyBarConfig));
          } catch (_) {}
        }

        // Ordered union of every enabled set plus custom picks, deduped. The
        // complete key order is stored so disabling and re-enabling a set does
        // not discard the user's placement for its keys.
        function resolveKeyIds() {
          const enabled = new Set();
          for (const set of KEY_SETS) {
            if (keyBarConfig.sets.includes(set.id)) set.keys.forEach((id) => enabled.add(id));
          }
          keyBarConfig.custom.forEach((id) => enabled.add(id));
          return keyBarConfig.order.filter((id) => enabled.has(id));
        }

        function resolvePlacedKeyIds() {
          return ["main", "expanded"].flatMap(resolvePlacedKeyIdsInZone);
        }

        function resolvePlacedKeyIdsInZone(zone) {
          if (zone !== "main" && zone !== "expanded") return [];
          const enabled = new Set(resolveKeyIds());
          return keyBarConfig.zones[zone]
            .map(softKeyIdFromAction)
            .filter((id) => id && enabled.has(id));
        }

        function syncKeyOrderProjection() {
          keyBarConfig.order = projectSoftKeyOrderFromZones(keyBarConfig.zones);
        }

        function commitKeyOrder(order) {
          keyBarConfig.order = order;
          const rank = new Map(order.map((id, index) => [softInputActionId(id), index]));
          for (const zone of INPUT_ACTION_ZONES) {
            const fixedPositions = keyBarConfig.zones[zone]
              .map((actionId, index) => ({ actionId, index }))
              .filter(({ actionId }) => !softKeyIdFromAction(actionId));
            const soft = keyBarConfig.zones[zone]
              .filter((actionId) => softKeyIdFromAction(actionId))
              .sort((left, right) => (rank.get(left) ?? 0) - (rank.get(right) ?? 0));
            const merged = [...soft];
            for (const { actionId, index } of fixedPositions) {
              merged.splice(Math.min(index, merged.length), 0, actionId);
            }
            keyBarConfig.zones[zone] = merged;
          }
          syncKeyOrderProjection();
          saveKeyBarConfig();
          renderInputActionRows();
        }

        function reorderKey(id, targetId, afterTarget) {
          if (id === targetId) return;
          if (
            inputActionZone(softInputActionId(id)) !==
            inputActionZone(softInputActionId(targetId))
          ) {
            return;
          }
          const order = keyBarConfig.order.filter((keyId) => keyId !== id);
          const targetIndex = order.indexOf(targetId);
          if (targetIndex < 0) return;
          order.splice(targetIndex + (afterTarget ? 1 : 0), 0, id);
          commitKeyOrder(order);
        }

        function moveKey(id, offset) {
          const visibleIds = resolvePlacedKeyIdsInZone(
            inputActionZone(softInputActionId(id)),
          );
          const index = visibleIds.indexOf(id);
          const targetIndex = index + offset;
          if (index < 0 || targetIndex < 0 || targetIndex >= visibleIds.length) return;
          const targetId = visibleIds[targetIndex];
          const orderIndex = keyBarConfig.order.indexOf(id);
          const targetOrderIndex = keyBarConfig.order.indexOf(targetId);
          [keyBarConfig.order[orderIndex], keyBarConfig.order[targetOrderIndex]] = [
            keyBarConfig.order[targetOrderIndex],
            keyBarConfig.order[orderIndex],
          ];
          commitKeyOrder(keyBarConfig.order);
        }

        function moveKeyToEdge(id, toStart) {
          const visibleIds = resolvePlacedKeyIdsInZone(
            inputActionZone(softInputActionId(id)),
          );
          const index = visibleIds.indexOf(id);
          if (index < 0) return;
          const targetId = toStart ? visibleIds[0] : visibleIds[visibleIds.length - 1];
          if (targetId === id) return;
          reorderKey(id, targetId, !toStart);
        }

        function resetKeyOrder() {
          selectedOrderKeyId = "";
          commitKeyOrder([...KEY_ORDER]);
        }

        function appendKeyToVisibleEnd(id, visibleIds) {
          if (visibleIds.includes(id) || visibleIds.length === 0) return;
          // ADR-0040 puts a newly selected custom key at the end of the
          // visible Keys row. Preserve a user-selected main/hidden zone;
          // only reorder the default expanded placement.
          if (inputActionZone(softInputActionId(id)) === "expanded") {
            moveInputAction(softInputActionId(id), "expanded", false);
          }
          syncKeyOrderProjection();
        }

        function keySequence(def) {
          if (def.cursor) {
            const appMode = Boolean(terminal && terminal.modes && terminal.modes.applicationCursorKeysMode);
            return (appMode ? "\x1bO" : "\x1b[") + def.cursor;
          }
          return def.seq || "";
        }

        // Send only; do NOT focus the terminal — focusing raises the native soft
        // keyboard, which defeats the purpose of these no-keyboard helper keys.
        // Nav keys dispatch a step-navigation action instead of writing bytes.
        function sendKey(id, button = null) {
          const def = KEY_DEFS[id];
          if (!def) return;
          if (def.nav) {
            enqueueNavStep(button, def.nav[0], def.nav[1]);
            return;
          }
          const seq = keySequence(def);
          if (seq) enqueueInput(seq);
        }

        // A toolbar/key button must never pull focus off the active input
        // surface: blurring the composer or xterm helper textarea dismisses the
        // mobile soft keyboard (#482) and defeats these helper keys (ADR-0028).
        // WebKit/iOS only cancels the focus-moving default on `mousedown`
        // (`pointerdown` preventDefault is ignored there), so guard both. A
        // secondary button or non-primary pointer keeps native behavior, and
        // `click` still fires for pointer, keyboard, and assistive activation.
        function preventFocusSteal(event) {
          if (event.button !== 0 || event.isPrimary === false) return;
          event.preventDefault();
        }
        function keepInputSurfaceFocus(button) {
          button.addEventListener("mousedown", preventFocusSteal);
          button.addEventListener("pointerdown", preventFocusSteal);
        }

        function installSoftKey(button, id) {
          // Keep the focused input surface (and its open keyboard) while the key
          // is sent. Click remains the accessible activation path.
          keepInputSurfaceFocus(button);
          button.addEventListener("click", () => sendKey(id, button));
        }

        function directionFromFlick(deltaX, deltaY) {
          if (Math.hypot(deltaX, deltaY) < KEY_FLICK_THRESHOLD_PX) return "";
          if (Math.abs(deltaX) > Math.abs(deltaY)) {
            return deltaX > 0 ? "right" : "left";
          }
          return deltaY > 0 ? "down" : "up";
        }

        function showKeyFlickHint(button, direction = "") {
          const rect = button.getBoundingClientRect();
          const radius = 48;
          const margin = 4;
          const centerX = Math.min(
            window.innerWidth - radius - margin,
            Math.max(radius + margin, rect.left + rect.width / 2)
          );
          const centerY = Math.min(
            window.innerHeight - radius - margin,
            Math.max(radius + margin, rect.top + rect.height / 2)
          );
          keyFlickHint.style.left = `${centerX}px`;
          keyFlickHint.style.top = `${centerY}px`;
          keyFlickHint.dataset.direction = direction;
          for (const arrow of keyFlickHint.querySelectorAll("[data-flick-direction]")) {
            arrow.classList.toggle("active", arrow.dataset.flickDirection === direction);
          }
          keyFlickHint.hidden = false;
        }

        function hideKeyFlickHint() {
          keyFlickHint.hidden = true;
          keyFlickHint.dataset.direction = "";
          for (const arrow of keyFlickHint.querySelectorAll("[data-flick-direction]")) {
            arrow.classList.remove("active");
          }
        }

        function installDirectionalFlick(button, onDirection = (direction) => sendKey(direction)) {
          let gesture = null;

          // The gesture handler below cancels the pointerdown default; pair it
          // with the mousedown guard so WebKit/iOS also keeps the input surface
          // focused (#482) instead of dropping the keyboard on a flick key.
          button.addEventListener("mousedown", preventFocusSteal);

          button.addEventListener("pointerdown", (event) => {
            if (button.disabled || !event.isPrimary || event.button !== 0) return;
            event.preventDefault();
            gesture = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
            button.setPointerCapture(event.pointerId);
            button.classList.add("flicking");
            showKeyFlickHint(button);
          });

          button.addEventListener("pointermove", (event) => {
            if (!gesture || event.pointerId !== gesture.pointerId) return;
            event.preventDefault();
            const direction = directionFromFlick(
              event.clientX - gesture.x,
              event.clientY - gesture.y
            );
            showKeyFlickHint(button, direction);
          });

          const finishFlick = (event, shouldSend) => {
            if (!gesture || event.pointerId !== gesture.pointerId) return;
            event.preventDefault();
            const direction = directionFromFlick(
              event.clientX - gesture.x,
              event.clientY - gesture.y
            );
            gesture = null;
            button.classList.remove("flicking");
            hideKeyFlickHint();
            if (shouldSend && direction) onDirection(direction);
          };

          button.addEventListener("pointerup", (event) => finishFlick(event, true));
          button.addEventListener("pointercancel", (event) => finishFlick(event, false));
          button.addEventListener("contextmenu", (event) => event.preventDefault());
        }

        function updateKeyBarControls() {
          const canControl = Boolean(leaseId && activeTerminalId);
          const connected = Boolean(leaseId);
          const unread = unreadNotificationCount();
          if (!keyRowEl) return;
          for (const btn of document.querySelectorAll(
            "#mainActionRow button.key-btn, #keyRow button.key-btn",
          )) {
            const def = KEY_DEFS[btn.dataset.key] || {};
            if (def.nav || def.navFlick) {
              // Nav step keys need only a lease (they can navigate away from a
              // terminal-less workspace); alert keys idle at zero unread.
              const isAlertKey = def.nav && def.nav[0] === "notification";
              btn.disabled = !connected || (isAlertKey && unread <= 0);
            } else {
              btn.disabled = !canControl;
            }
          }
          updateNavKeyBadge(unread);
        }

        // Unread badge rides on the FIRST rendered badge-capable nav key
        // (flick pad or an alert key) so the count shows once, not per key.
        function updateNavKeyBadge(unread) {
          let assigned = false;
          for (const btn of document.querySelectorAll(
            "#mainActionRow button.key-btn, #keyRow button.key-btn",
          )) {
            const def = KEY_DEFS[btn.dataset.key] || {};
            let badge = btn.querySelector(".key-nav-badge");
            if (!def.navBadge) continue;
            const show = !assigned && unread > 0;
            if (show && !badge) {
              badge = document.createElement("span");
              badge.className = "workspace-count-badge key-nav-badge";
              btn.append(badge);
            }
            if (badge) {
              badge.hidden = !show;
              if (show) fillCountBadge(badge, unread);
            }
            if (show) assigned = true;
          }
        }

        function inputActionZone(actionId) {
          return (
            INPUT_ACTION_ZONES.find((zone) => keyBarConfig.zones[zone].includes(actionId)) ||
            "hidden"
          );
        }

        function moveInputAction(actionId, zone, commit = true) {
          if (!ALL_INPUT_ACTION_IDS.includes(actionId) || !INPUT_ACTION_ZONES.includes(zone)) {
            return;
          }
          if (actionId === "keys" && zone === "expanded") zone = "main";
          for (const candidate of INPUT_ACTION_ZONES) {
            keyBarConfig.zones[candidate] = keyBarConfig.zones[candidate].filter(
              (id) => id !== actionId,
            );
          }
          keyBarConfig.zones[zone].push(actionId);
          if (actionId === "keys" && zone === "hidden") {
            keyBarConfig.expanded = false;
          }
          syncKeyOrderProjection();
          if (!commit) return;
          saveKeyBarConfig();
          renderInputActionRows();
          renderInputSettingsPreservingScroll();
          scheduleTerminalFit();
        }

        function moveInputActionBy(actionId, offset) {
          const zone = inputActionZone(actionId);
          const actions = keyBarConfig.zones[zone];
          const enabled = enabledInputActionIds();
          const visible = actions.filter((id) => enabled.has(id));
          const visibleIndex = visible.indexOf(actionId);
          const targetVisibleIndex = visibleIndex + offset;
          if (
            visibleIndex < 0 ||
            targetVisibleIndex < 0 ||
            targetVisibleIndex >= visible.length
          ) {
            return;
          }
          const index = actions.indexOf(actionId);
          const target = actions.indexOf(visible[targetVisibleIndex]);
          [actions[index], actions[target]] = [actions[target], actions[index]];
          syncKeyOrderProjection();
          saveKeyBarConfig();
          renderInputActionRows();
          renderInputSettingsPreservingScroll();
        }

        function enabledInputActionIds() {
          return new Set([
            ...FIXED_INPUT_ACTION_IDS,
            ...resolveKeyIds().map(softInputActionId),
          ]);
        }

        function inputActionLabel(actionId) {
          const keyId = softKeyIdFromAction(actionId);
          return keyId ? KEY_DEFS[keyId]?.label || keyId : INPUT_ACTION_LABELS[actionId] || actionId;
        }

        function fixedInputActionElement(actionId) {
          return {
            "ctrl-c": ctrlCButton,
            keyboard: focusTerminalButton,
            keys: keyBarToggleButton,
            send: composerSendButton,
            composer: inputModeToggleButton,
            attachment: attachmentButton,
          }[actionId];
        }

        function createSoftKeyButton(id) {
          const def = KEY_DEFS[id];
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "key-btn";
          btn.dataset.key = id;
          btn.dataset.inputAction = softInputActionId(id);
          btn.textContent = def.label;
          btn.title = def.hint || def.label;
          if (def.flick) {
            btn.classList.add("key-flick-btn");
            btn.setAttribute("aria-label", "Flick for arrow key: up, right, down, or left");
            btn.title = "Flick up, right, down, or left";
            installDirectionalFlick(btn);
          } else if (def.navFlick) {
            btn.classList.add("key-flick-btn");
            btn.setAttribute(
              "aria-label",
              "Flick to navigate: up/down previous/next pane, left/right recent/oldest alert",
            );
            btn.title = "Flick: ↑ prev pane · ↓ next pane · ← recent alert · → oldest alert";
            installDirectionalFlick(btn, (direction) => {
              const target = NAV_FLICK_TARGETS[direction];
              if (target) enqueueNavStep(btn, target[0], target[1]);
            });
          } else {
            installSoftKey(btn, id);
          }
          return btn;
        }

        function syncExpandedRowEmptyState() {
          const enabled = enabledInputActionIds();
          const composerMode = currentInputMode() === "composer";
          const hasVisibleAction = keyBarConfig.zones.expanded.some(
            (actionId) =>
              enabled.has(actionId) && (actionId !== "send" || composerMode),
          );
          const current = keyRowEl.querySelector(":scope > .key-row-empty");
          if (hasVisibleAction) {
            current?.remove();
            return;
          }
          if (current) return;
          const empty = document.createElement("div");
          empty.className = "key-row-empty";
          empty.textContent = "No actions in the Keys row. Open Remote Settings to restore them.";
          keyRowEl.append(empty);
        }

        function syncInputActionVisibility() {
          if (!keyBarConfig) return;
          const composerMode = currentInputMode() === "composer";
          for (const actionId of FIXED_INPUT_ACTION_IDS) {
            const element = fixedInputActionElement(actionId);
            const placed = inputActionZone(actionId) !== "hidden";
            element.hidden = !placed || (actionId === "send" && !composerMode);
          }
          const keysVisible = inputActionZone("keys") === "main";
          if (!keysVisible && keyBarConfig.expanded) {
            keyBarConfig.expanded = false;
            saveKeyBarConfig();
          }
          keyBar.hidden = !keysVisible || !keyBarConfig.expanded;
          keyBarToggleButton.classList.toggle("active", !keyBar.hidden);
          keyBarToggleButton.setAttribute("aria-pressed", keyBar.hidden ? "false" : "true");
          syncExpandedRowEmptyState();
        }

        function renderInputActionRows() {
          hideKeyFlickHint();
          for (const item of document.querySelectorAll(
            "#mainActionRow .key-btn, #keyRow .key-btn, #keyRow .key-row-empty",
          )) {
            item.remove();
          }
          const enabled = enabledInputActionIds();
          for (const zone of ["main", "expanded"]) {
            const container = zone === "main" ? mainActionRow : keyRowEl;
            for (const actionId of keyBarConfig.zones[zone]) {
              if (!enabled.has(actionId)) continue;
              const keyId = softKeyIdFromAction(actionId);
              const element = keyId ? createSoftKeyButton(keyId) : fixedInputActionElement(actionId);
              element.dataset.inputAction = actionId;
              container.append(element);
            }
          }
          syncInputActionVisibility();
          updateKeyBarControls();
        }

        function renderKeyRow() {
          renderInputActionRows();
        }

        function clearKeyOrderDropMarkers() {
          for (const chip of keyPopoverBody.querySelectorAll(".key-order-chip")) {
            chip.classList.remove("drop-before", "drop-after");
          }
        }

        function inputSettingsScrollSurface() {
          return keyPopoverBody.closest(".drawer-view") || keyPopoverBody;
        }

        function renderInputSettingsPreservingScroll() {
          const scrollSurface = inputSettingsScrollSurface();
          const scrollTop = scrollSurface.scrollTop;
          renderKeyPopover();
          scrollSurface.scrollTop = scrollTop;
        }

        function installKeyOrderDrag(chip, id) {
          let gesture = null;
          let suppressClick = false;
          const sourceZone = chip.dataset.orderZone;

          const releaseCapture = (pointerId) => {
            if (chip.hasPointerCapture(pointerId)) chip.releasePointerCapture(pointerId);
          };

          chip.addEventListener("pointerdown", (event) => {
            if (event.button !== 0 || event.isPrimary === false) return;
            event.stopPropagation();
            gesture = {
              pointerId: event.pointerId,
              x: event.clientX,
              y: event.clientY,
              active: false,
              targetId: "",
              afterTarget: false,
              timer: 0,
            };
            chip.setPointerCapture(event.pointerId);
            gesture.timer = window.setTimeout(() => {
              if (!gesture || gesture.pointerId !== event.pointerId) return;
              gesture.active = true;
              suppressClick = true;
              chip.classList.add("dragging");
            }, KEY_ORDER_HOLD_MS);
          });

          chip.addEventListener("pointermove", (event) => {
            if (!gesture || event.pointerId !== gesture.pointerId) return;
            if (!gesture.active) {
              if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 8) {
                window.clearTimeout(gesture.timer);
                suppressClick = true;
                const pointerId = gesture.pointerId;
                gesture = null;
                releaseCapture(pointerId);
              }
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            clearKeyOrderDropMarkers();
            const target = document
              .elementFromPoint(event.clientX, event.clientY)
              ?.closest(".key-order-chip");
            const targetId =
              target?.dataset.orderZone === sourceZone ? target.dataset.orderKey || "" : "";
            gesture.targetId = targetId === id ? "" : targetId;
            gesture.afterTarget = false;
            if (gesture.targetId) {
              const rect = target.getBoundingClientRect();
              gesture.afterTarget = event.clientX >= rect.left + rect.width / 2;
              target.classList.add(gesture.afterTarget ? "drop-after" : "drop-before");
            }
            const scrollSurface = inputSettingsScrollSurface();
            const surfaceRect = scrollSurface.getBoundingClientRect();
            if (event.clientY < surfaceRect.top + 28) scrollSurface.scrollTop -= 10;
            if (event.clientY > surfaceRect.bottom - 28) scrollSurface.scrollTop += 10;
          });

          const finishDrag = (event, shouldCommit) => {
            if (!gesture || event.pointerId !== gesture.pointerId) return;
            window.clearTimeout(gesture.timer);
            const completed = gesture;
            gesture = null;
            chip.classList.remove("dragging");
            clearKeyOrderDropMarkers();
            releaseCapture(completed.pointerId);
            if (!completed.active) return;
            event.preventDefault();
            event.stopPropagation();
            suppressClick = true;
            if (shouldCommit && completed.targetId) {
              const scrollSurface = inputSettingsScrollSurface();
              const scrollTop = scrollSurface.scrollTop;
              reorderKey(id, completed.targetId, completed.afterTarget);
              renderKeyPopover();
              scrollSurface.scrollTop = scrollTop;
            }
          };

          chip.addEventListener("pointerup", (event) => finishDrag(event, true));
          chip.addEventListener("pointercancel", (event) => finishDrag(event, false));
          chip.addEventListener("click", (event) => {
            event.stopPropagation();
            if (suppressClick) {
              suppressClick = false;
              event.preventDefault();
              return;
            }
            const scrollSurface = inputSettingsScrollSurface();
            const scrollTop = scrollSurface.scrollTop;
            selectedOrderKeyId = selectedOrderKeyId === id ? "" : id;
            renderKeyPopover();
            scrollSurface.scrollTop = scrollTop;
          });
          chip.addEventListener("contextmenu", (event) => event.preventDefault());
        }

        function renderKeyOrderSection() {
          const visibleIds = resolvePlacedKeyIds();
          if (!visibleIds.includes(selectedOrderKeyId)) selectedOrderKeyId = "";
          const section = document.createElement("section");
          section.className = "key-order-section";

          const heading = document.createElement("div");
          heading.className = "key-order-heading";
          const title = document.createElement("div");
          title.className = "key-popover-title";
          title.textContent = "Key order";
          const reset = document.createElement("button");
          reset.type = "button";
          reset.className = "key-order-reset";
          reset.textContent = "Reset";
          reset.setAttribute("aria-label", "Reset key order");
          reset.addEventListener("click", (event) => {
            event.stopPropagation();
            resetKeyOrder();
            renderKeyPopover();
          });
          heading.append(title, reset);
          section.append(heading);

          const grid = document.createElement("div");
          grid.className = "key-order-grid";
          grid.setAttribute("aria-label", "Current key order");
          for (const zone of ["main", "expanded"]) {
            const zoneIds = resolvePlacedKeyIdsInZone(zone);
            if (zoneIds.length === 0) continue;
            const zoneLabel = document.createElement("div");
            zoneLabel.className = "key-order-zone-label";
            zoneLabel.id = zone === "main" ? "keyOrderZoneMain" : "keyOrderZoneExpanded";
            zoneLabel.dataset.orderZoneLabel = zone;
            zoneLabel.textContent = zone === "main" ? "Main row" : "Keys row";
            grid.append(zoneLabel);
            for (const id of zoneIds) {
              const def = KEY_DEFS[id];
              const chip = document.createElement("button");
              chip.type = "button";
              chip.className = "key-chip key-order-chip";
              chip.dataset.orderKey = id;
              chip.dataset.orderZone = zone;
              chip.textContent = def.label;
              chip.title = `${def.hint || def.label} — hold and drag to reorder`;
              chip.setAttribute("aria-describedby", zoneLabel.id);
              chip.setAttribute("aria-pressed", selectedOrderKeyId === id ? "true" : "false");
              chip.classList.toggle("selected", selectedOrderKeyId === id);
              installKeyOrderDrag(chip, id);
              grid.append(chip);
            }
          }
          if (visibleIds.length === 0) {
            const empty = document.createElement("div");
            empty.className = "key-row-empty";
            empty.textContent = "Choose a set or custom key first.";
            grid.append(empty);
          }
          section.append(grid);

          const help = document.createElement("div");
          help.className = "key-order-help";
          help.textContent = "Hold and drag to reorder · Tap a key for move controls";
          section.append(help);
          keyPopoverBody.append(section);

          if (!selectedOrderKeyId) return;
          const selectedZone = inputActionZone(softInputActionId(selectedOrderKeyId));
          const selectedZoneIds = resolvePlacedKeyIdsInZone(selectedZone);
          const selectedIndex = selectedZoneIds.indexOf(selectedOrderKeyId);
          const def = KEY_DEFS[selectedOrderKeyId];
          const accessibleName = def.hint || def.label;
          const actions = document.createElement("div");
          actions.className = "key-order-actions";
          actions.setAttribute("aria-label", "Selected key order actions");
          const selected = document.createElement("span");
          selected.className = "key-order-selected";
          selected.textContent = `Selected: ${def.label} (${selectedZone === "main" ? "Main row" : "Keys row"})`;
          actions.append(selected);
          const actionDefs = [
            ["First", `Move ${accessibleName} to start`, selectedIndex === 0, () => moveKeyToEdge(selectedOrderKeyId, true)],
            ["←", `Move ${accessibleName} left`, selectedIndex === 0, () => moveKey(selectedOrderKeyId, -1)],
            ["→", `Move ${accessibleName} right`, selectedIndex === selectedZoneIds.length - 1, () => moveKey(selectedOrderKeyId, 1)],
            ["Last", `Move ${accessibleName} to end`, selectedIndex === selectedZoneIds.length - 1, () => moveKeyToEdge(selectedOrderKeyId, false)],
          ];
          for (const [label, ariaLabel, disabled, action] of actionDefs) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "key-order-action";
            button.textContent = label;
            button.setAttribute("aria-label", ariaLabel);
            button.disabled = disabled;
            button.addEventListener("click", (event) => {
              event.stopPropagation();
              const scrollSurface = inputSettingsScrollSurface();
              const scrollTop = scrollSurface.scrollTop;
              action();
              renderKeyPopover();
              scrollSurface.scrollTop = scrollTop;
            });
            actions.append(button);
          }
          section.append(actions);
        }

        function resetInputActionLayout() {
          keyBarConfig.expanded = false;
          keyBarConfig.order = [...KEY_ORDER];
          keyBarConfig.zones = defaultInputZones();
          saveKeyBarConfig();
          renderInputActionRows();
          renderKeyPopover();
          scheduleTerminalFit();
        }

        function renderInputLayoutSection() {
          const heading = document.createElement("div");
          heading.className = "input-layout-heading";
          const title = document.createElement("div");
          title.className = "key-popover-title";
          title.textContent = "Action placement";
          const reset = document.createElement("button");
          reset.type = "button";
          reset.className = "key-order-reset";
          reset.textContent = "Reset";
          reset.setAttribute("aria-label", "Reset input action layout");
          reset.addEventListener("click", resetInputActionLayout);
          heading.append(title, reset);
          keyPopoverBody.append(heading);

          const enabled = enabledInputActionIds();
          for (const zone of INPUT_ACTION_ZONES) {
            const actionIds = keyBarConfig.zones[zone].filter((actionId) => enabled.has(actionId));
            for (const [index, actionId] of actionIds.entries()) {
              const row = document.createElement("div");
              row.className = "input-layout-row";
              row.dataset.layoutAction = actionId;

              const name = document.createElement("span");
              name.className = "input-layout-name";
              const label = inputActionLabel(actionId);
              name.textContent = label;

              const select = document.createElement("select");
              select.className = "input-layout-zone";
              select.setAttribute("aria-label", `Place ${label}`);
              const choices = actionId === "keys" ? ["main", "hidden"] : INPUT_ACTION_ZONES;
              for (const choice of choices) {
                const option = document.createElement("option");
                option.value = choice;
                option.textContent =
                  choice === "main" ? "Main" : choice === "expanded" ? "Keys" : "Hidden";
                select.append(option);
              }
              select.value = zone;
              select.addEventListener("change", () => moveInputAction(actionId, select.value));

              const controls = document.createElement("span");
              controls.className = "input-layout-order";
              for (const [text, offset, disabled] of [
                ["↑", -1, index === 0],
                ["↓", 1, index === actionIds.length - 1],
              ]) {
                const button = document.createElement("button");
                button.type = "button";
                button.textContent = text;
                button.disabled = disabled;
                button.setAttribute(
                  "aria-label",
                  `${offset < 0 ? "Move" : "Move"} ${label} ${offset < 0 ? "earlier" : "later"}`,
                );
                button.addEventListener("click", () => moveInputActionBy(actionId, offset));
                controls.append(button);
              }
              row.append(name, select, controls);
              keyPopoverBody.append(row);
            }
          }
        }

        // Composer recall feature toggles (issues #504 / #505) share the Remote
        // drawer Settings surface with the input layout. Only the on/off
        // booleans are persisted; the recall text itself remains runtime-only.
        function renderComposerPopoverSection() {
          const title = document.createElement("div");
          title.className = "key-popover-title";
          title.textContent = "Composer recall";
          keyPopoverBody.append(title);

          const makeToggle = (id, labelText, descText, enabled, onChange) => {
            const row = document.createElement("label");
            row.className = "key-set-row";
            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.id = id;
            cb.checked = enabled;
            cb.setAttribute("aria-label", labelText);
            cb.addEventListener("click", (event) => event.stopPropagation());
            cb.addEventListener("change", (event) => {
              event.stopPropagation();
              const scrollSurface = inputSettingsScrollSurface();
              const scrollTop = scrollSurface.scrollTop;
              onChange(cb.checked);
              renderKeyPopover();
              scrollSurface.scrollTop = scrollTop;
            });
            const name = document.createElement("span");
            name.className = "key-set-name";
            name.textContent = labelText;
            const desc = document.createElement("span");
            desc.className = "key-set-desc";
            desc.textContent = descText;
            row.append(cb, name, desc);
            keyPopoverBody.append(row);
          };

          // Scope picker (ADR-0055): which terminals share one recall bucket.
          const scopeRow = document.createElement("label");
          scopeRow.className = "key-set-row";
          const scopeName = document.createElement("span");
          scopeName.className = "key-set-name";
          scopeName.textContent = "History sharing";
          const scopeSelect = document.createElement("select");
          scopeSelect.className = "key-set-select";
          scopeSelect.id = "composerHistoryScopeSelect";
          scopeSelect.setAttribute("aria-label", "Composer history sharing scope");
          for (const [value, label] of [
            ["global", "All workspaces"],
            ["workspace", "This workspace"],
            ["pane", "This pane only"],
          ]) {
            const option = document.createElement("option");
            option.value = value;
            option.textContent = label;
            scopeSelect.append(option);
          }
          scopeSelect.value = composerHistoryScope;
          scopeSelect.addEventListener("click", (event) => event.stopPropagation());
          scopeSelect.addEventListener("change", (event) => {
            event.stopPropagation();
            const next = COMPOSER_HISTORY_SCOPES.includes(scopeSelect.value)
              ? scopeSelect.value
              : DEFAULT_COMPOSER_HISTORY_SCOPE;
            composerHistoryScope = next;
            saveComposerHistoryScope(next);
            // The visible bucket just changed; drop any open list so a stale
            // highlight cannot commit an entry from the previous bucket.
            resetComposerSuggestions();
            renderComposerSuggestions();
          });
          scopeRow.append(scopeName, scopeSelect);
          keyPopoverBody.append(scopeRow);

          makeToggle(
            "composerHistoryPopupToggle",
            "Tab history",
            "Tab shows past input",
            composerHistoryPopupEnabled,
            (checked) => {
              composerHistoryPopupEnabled = checked;
              saveComposerToggle(composerHistoryPopupKey, checked);
              if (!checked) composerHistoryOpen = false;
              renderComposerSuggestions();
            }
          );
          makeToggle(
            "composerAutocompleteToggle",
            "Autocomplete",
            "Suggest as you type",
            composerAutocompleteEnabled,
            (checked) => {
              composerAutocompleteEnabled = checked;
              saveComposerToggle(composerAutocompleteKey, checked);
              renderComposerSuggestions();
            }
          );
          makeToggle(
            "composerAgentScrollOffsetToggle",
            "Keep agent input visible",
            "Claude, Codex, and Grok",
            composerAgentScrollOffsetEnabled,
            (checked) => {
              composerAgentScrollOffsetEnabled = checked;
              saveComposerToggle(composerAgentScrollOffsetKey, checked);
              if (checked) offsetComposerForActiveAgent();
            }
          );
          for (const [agent, lines] of composerAgentScrollOffsetEntries()) {
            const row = document.createElement("label");
            row.className = "key-set-row";
            const name = document.createElement("span");
            name.className = "key-set-name";
            name.textContent = `${agent} input lines`;
            const input = document.createElement("input");
            input.type = "number";
            input.className = "key-set-select";
            input.id = `composerAgentScrollOffset${agent}`;
            input.min = String(COMPOSER_AGENT_SCROLL_OFFSET_MIN);
            input.max = String(COMPOSER_AGENT_SCROLL_OFFSET_MAX);
            input.step = "1";
            input.inputMode = "numeric";
            input.value = String(lines);
            input.disabled = !composerAgentScrollOffsetEnabled;
            input.setAttribute("aria-label", `${agent} Composer input lines`);
            input.addEventListener("click", (event) => event.stopPropagation());
            input.addEventListener("change", (event) => {
              event.stopPropagation();
              const next = setComposerAgentScrollOffset(agent, input.value);
              input.value = String(next);
              if (composerAgentScrollOffsetEnabled && activeComposerAgentName() === agent) {
                offsetComposerForActiveAgent();
              }
            });
            row.append(name, input);
            keyPopoverBody.append(row);
          }
        }

        function renderKeyPopover() {
          keyPopoverBody.textContent = "";
          renderInputLayoutSection();
          renderComposerPopoverSection();
          const setsTitle = document.createElement("div");
          setsTitle.className = "key-popover-title";
          setsTitle.textContent = "Key sets";
          keyPopoverBody.append(setsTitle);
          for (const set of KEY_SETS) {
            const row = document.createElement("label");
            row.className = "key-set-row";
            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.checked = keyBarConfig.sets.includes(set.id);
            cb.addEventListener("click", (event) => event.stopPropagation());
            cb.addEventListener("change", (event) => {
              event.stopPropagation();
              const scrollSurface = inputSettingsScrollSurface();
              const scrollTop = scrollSurface.scrollTop;
              if (cb.checked) {
                if (!keyBarConfig.sets.includes(set.id)) keyBarConfig.sets.push(set.id);
              } else {
                keyBarConfig.sets = keyBarConfig.sets.filter((id) => id !== set.id);
              }
              saveKeyBarConfig();
              renderKeyRow();
              renderKeyPopover();
              scrollSurface.scrollTop = scrollTop;
            });
            const name = document.createElement("span");
            name.className = "key-set-name";
            name.textContent = set.name;
            const desc = document.createElement("span");
            desc.className = "key-set-desc";
            desc.textContent = set.desc;
            row.append(cb, name, desc);
            keyPopoverBody.append(row);
          }
          const customTitle = document.createElement("div");
          customTitle.className = "key-popover-title";
          customTitle.textContent = "Custom keys";
          keyPopoverBody.append(customTitle);
          const grid = document.createElement("div");
          grid.className = "key-chip-grid";
          for (const id of KEY_ORDER) {
            const def = KEY_DEFS[id];
            const chip = document.createElement("button");
            chip.type = "button";
            chip.className = "key-chip";
            chip.textContent = def.label;
            chip.classList.toggle("selected", keyBarConfig.custom.includes(id));
            chip.addEventListener("click", (event) => {
              event.stopPropagation();
              const scrollSurface = inputSettingsScrollSurface();
              const scrollTop = scrollSurface.scrollTop;
              const visibleIds = resolveKeyIds();
              if (keyBarConfig.custom.includes(id)) {
                keyBarConfig.custom = keyBarConfig.custom.filter((k) => k !== id);
              } else {
                keyBarConfig.custom.push(id);
                if (!keyBarConfig.usedCustom.includes(id)) {
                  keyBarConfig.usedCustom.push(id);
                  appendKeyToVisibleEnd(id, visibleIds);
                }
              }
              saveKeyBarConfig();
              renderKeyRow();
              renderKeyPopover();
              scrollSurface.scrollTop = scrollTop;
            });
            grid.append(chip);
          }
          keyPopoverBody.append(grid);
          renderKeyOrderSection();
        }

        function setKeyBarVisible(visible, persist = true) {
          keyBarConfig.expanded = Boolean(visible) && inputActionZone("keys") === "main";
          syncInputActionVisibility();
          if (persist) saveKeyBarConfig();
          scheduleTerminalFit();
        }

        // Lowest row of the fitted screen that still carries live output: the
        // cursor row, or a lower non-blank row when a TUI draws below the
        // cursor (Claude Code's hint lines sit under its prompt). Everything
        // under it is blank filler, which only exists while the buffer has not
        // scrolled yet, so nothing above the screen is lost by cropping it out.
        function terminalTailRow(term, cursorRow) {
          const buffer = term.buffer?.active;
          if (!buffer || typeof buffer.getLine !== "function") return cursorRow;
          const viewportY = buffer.viewportY ?? 0;
          for (let row = term.rows - 1; row > cursorRow; row -= 1) {
            const line = buffer.getLine(viewportY + row);
            if (line && line.translateToString(true).trim() !== "") return row;
          }
          return cursorRow;
        }

        // A crop keeps the fitted (taller) screen inside a shorter host, so the
        // window has to pick which slice to show. Anchoring it at the screen
        // bottom strands short output above the window with blank rows filling
        // it, so anchor at the live tail instead and let the blank rows clip out
        // below. The cursor row also has to stay visible — right after `clear`
        // the prompt is on the top row — otherwise the IME/helper textarea is
        // stranded off-screen too. Without a crop the transform resets to
        // identity (ADR-0038, ADR-0056).
        function updateCropTransform() {
          if (!terminal || !terminalSizer) return;
          if (!cropActive) {
            if (terminalSizer.style.transform) terminalSizer.style.transform = "";
            return;
          }
          const hidden = terminalSizer.offsetHeight - terminalHost.clientHeight;
          if (hidden <= 1) {
            terminalSizer.style.transform = "";
            return;
          }
          const metrics = terminalMetrics(terminal);
          if (!metrics) return;
          // Both rects carry the current translate, so their difference is the
          // transform-independent layout offset of the screen inside the sizer.
          const screenTop = metrics.rect.top - terminalSizer.getBoundingClientRect().top;
          const cursorRow = Math.max(
            0,
            Math.min(terminal.rows - 1, terminal.buffer?.active?.cursorY ?? terminal.rows - 1),
          );
          const cursorTop = screenTop + cursorRow * metrics.cellHeight;
          // Rounding rows down leaves dead space under the screen, and .xterm
          // pads uniformly, so mirroring screenTop puts the tail row the same
          // distance above the host bottom that an uncropped surface has.
          const tailBottom = screenTop + (terminalTailRow(terminal, cursorRow) + 1) * metrics.cellHeight;
          const tailShift = terminalSizer.offsetHeight - screenTop - tailBottom;
          const shift = Math.round(Math.max(0, tailShift, hidden - cursorTop));
          terminalSizer.style.transform = shift > 0 ? `translateY(${shift}px)` : "";
        }

        // The tail moves with every render, not only with the cursor (output
        // below the cursor, scrollback scrolling), and the measurement forces
        // layout. Coalesce to one frame and stay free while no crop is active.
        function scheduleCropTransform() {
          if (!cropActive || cropTransformFrame !== null) return;
          cropTransformFrame = requestAnimationFrame(() => {
            cropTransformFrame = null;
            updateCropTransform();
          });
        }

        function fitTerminal(sendResize = true) {
          if (!terminal || !fitAddon) return;
          if (outputAttachGeometryGeneration !== null) return;
          const rect = terminalHost.getBoundingClientRect();
          if (rect.width < 20 || rect.height < 20) return;
          // PTY rows/cols are global state (ADR-0015) and Codex-class TUIs
          // reflow their entire scrollback on SIGWINCH, so every rows change
          // floods the output stream. Height-only shrinks (soft keyboard,
          // composer drag, URL bar) therefore stay surface-local: keep the
          // fitted geometry and crop the sizer bottom-anchored. Width changes
          // and height growth adopt the host geometry as before. Alternate
          // buffer has no scrollback to flood and full-screen apps need their
          // top rows, so it always adopts (ADR-0038).
          const widthChanged = Math.abs(rect.width - fittedHostWidth) >= 1;
          const normalBuffer = terminal.buffer?.active?.type !== "alternate";
          if (!widthChanged && normalBuffer && rect.height < fittedHostHeight - 0.5) {
            cropActive = true;
            terminalSizer.style.height = `${Math.round(fittedHostHeight)}px`;
            // Attach resets lastResizeKey, so even though fit is skipped the
            // preserved geometry must still reach the (possibly different or
            // externally resized) PTY of a fresh attach or terminal switch.
            if (sendResize && terminal.cols > 0 && terminal.rows > 0) {
              queueResize(terminal.cols, terminal.rows);
            }
            updateCropTransform();
            updateSelectionHandles(terminal);
            scheduleTerminalRefresh();
            return;
          }
          cropActive = false;
          fittedHostWidth = rect.width;
          fittedHostHeight = rect.height;
          terminalSizer.style.height = "100%";
          updateCropTransform();
          try {
            fitAddon.fit();
          } catch (err) {
            setStatus(`Fit failed: ${err.message}`, true);
            return;
          }
          if (sendResize && terminal.cols > 0 && terminal.rows > 0) {
            queueResize(terminal.cols, terminal.rows);
          }
          updateSelectionHandles(terminal);
          scheduleTerminalRefresh();
        }

        // xterm measures the cell once when the surface opens and then only when
        // it resizes. A surface opened before its font resolved therefore holds a
        // stale cell size, and the first fit proposes a grid from it — the fit's
        // own `resize()` is what re-measures, so the corrected grid only shows up
        // in the *next* fit, as a second PTY geometry right after attach. Fitting
        // until the proposal stops moving converges before attach publishes
        // anything (ADR-0133). Bounded: two passes is convergence, a third is a
        // fight between measurement and layout that one more pass will not win.
        function fitTerminalForAttach() {
          for (let pass = 0; pass < 3; pass += 1) {
            const cols = terminal.cols;
            const rows = terminal.rows;
            fitTerminal(false);
            if (terminal.cols === cols && terminal.rows === rows) return;
          }
        }

        // A chrome row appearing or disappearing is a permanent layout change,
        // not the transient height shrink the crop exists for: drop the fitted
        // baseline so the next fit adopts the real host instead of cropping to
        // a stale height (and so later refits are not suppressed by it).
        function rebaseTerminalFit() {
          fittedHostHeight = 0;
          cropActive = false;
          scheduleTerminalFit(Boolean(activeTerminalId));
        }

        function scheduleTerminalFit(sendResize = true) {
          if (!terminal || !fitAddon) return;
          requestAnimationFrame(() => {
            fitTerminal(sendResize);
            setTimeout(() => fitTerminal(sendResize), 160);
          });
        }

        function scheduleTerminalRefresh() {
          if (!terminal || terminal.rows <= 0 || terminalRefreshFrame !== null) return;
          terminalRefreshFrame = requestAnimationFrame(() => {
            terminalRefreshFrame = null;
            if (terminal && terminal.rows > 0) {
              terminal.refresh(0, terminal.rows - 1);
              updateSelectionHandles(terminal);
            }
          });
        }

        function queueResize(cols, rows) {
          if (outputAttachGeometryGeneration !== null || attachGeometryHolds > 0) return;
          if (!leaseId || !activeTerminalId || !Number.isFinite(cols) || !Number.isFinite(rows) || cols < 1 || rows < 1) return;
          const resizeTerminalId = activeTerminalId;
          const resizeLeaseId = leaseId;
          const resizeKey = `${resizeTerminalId}:${cols}x${rows}`;
          if (resizeKey === lastResizeKey) return;
          if (resizeTimer) clearTimeout(resizeTimer);
          resizeTimer = setTimeout(() => {
            resizeTimer = null;
            if (resizeTerminalId !== activeTerminalId || resizeLeaseId !== leaseId) {
              return;
            }
            // A hold that began after this was queued still owns the geometry.
            if (outputAttachGeometryGeneration !== null || attachGeometryHolds > 0) return;
            lastResizeKey = resizeKey;
            resizeTerminal(resizeTerminalId, resizeLeaseId, cols, rows).catch((err) => setStatus(`Resize failed: ${err.message}`, true));
          }, 120);
        }

        async function resizeTerminal(terminalId, activeLeaseId, cols, rows) {
          await remoteFetch(`/remote/v1/terminals/${encodeURIComponent(terminalId)}/resize`, {
            method: "POST",
            body: JSON.stringify({ leaseId: activeLeaseId, cols, rows, exact: false }),
          });
        }

        async function exitRemote() {
          // Leaving always withdraws the standing intent to hold control, even
          // when the connection has already failed and no lease remains.
          disarmAutoConnect();
          const currentLease = leaseId;
          disconnect(false);
          const exitRevision = claimAttemptRevision;
          stopWidgetPolling();
          if (currentLease) await releaseLease(currentLease).catch(() => {});
          // A manual reconnect supersedes this Exit while the old lease drains.
          // Never let its late continuation close or relabel the new surface.
          if (claimAttemptRevision !== exitRevision || leaseId) return;
          // Android's former Close button released this same lease and then
          // closed the native Remote surface. Exit is now the single path.
          if (androidE2eMode) {
            window.LaymuxNative.disconnectRemote();
            return;
          }
          if (localAppMode) {
            window.parent.postMessage({ type: "laymux:desktop-mode" }, "*");
            return;
          }
          setConnectionHint("Connect first to load workspaces and control the active terminal.", false);
          setStatus("Exited remote control.");
        }

        async function releaseLease(id) {
          await remoteFetch("/remote/v1/session/release", {
            method: "POST",
            body: JSON.stringify({ leaseId: id }),
          });
          if (id === leaseId || !leaseId) discardResumeToken();
        }

        // Best-effort release while the page is being torn down. Fired from
        // pagehide, so only sendBeacon (or a keepalive fetch fallback) can
        // outlive the document; auth rides the supported token query param
        // because a beacon cannot carry headers. The resume capability is
        // stashed for the successor document: if the beacon is lost the next
        // claim still takes the zombie over, and if it arrives the claim
        // follows the release drain through the server-side handoff.
        function releaseLeaseOnPageHide() {
          stashResumeTokenForUnload();
          clearPathLinkSelection();
          const currentLease = leaseId;
          if (androidE2eMode) {
            // Native performs the encrypted background transition. It reads
            // the current desktop setting atomically with retain/release, so
            // pagehide never makes a stale policy decision.
            return;
          }
          invalidateAttachmentChooser();
          cancelAttachmentUpload();
          if (!currentLease) return;
          const path = `/remote/v1/session/release?token=${encodeURIComponent(token())}`;
          const payload = JSON.stringify({ leaseId: currentLease });
          let sent = false;
          if (typeof navigator.sendBeacon === "function") {
            try {
              sent = navigator.sendBeacon(path, new Blob([payload], { type: "application/json" }));
            } catch (_) {}
          }
          if (!sent) {
            fetch(path, {
              method: "POST",
              headers: authHeaders(),
              body: payload,
              keepalive: true,
            }).catch(() => {});
          }
          // The server no longer considers this lease ours, so neither may we. A
          // bfcache restore brings the whole document back with its variables intact,
          // and a lingering `leaseId` reads as "we still hold control" — the auto
          // reconnect would skip its own return trip (issue #561). The stashed resume
          // capability above is what lets the reclaim follow the release drain.
          leaseId = null;
        }

        async function requestDesktopMode() {
          const currentLease = leaseId;
          let transitionRevision = null;
          if (currentLease) {
            disconnect(false);
            transitionRevision = claimAttemptRevision;
            await releaseLease(currentLease).catch(() => {});
            if (claimAttemptRevision !== transitionRevision || leaseId) return;
          }
          if (androidE2eMode) {
            window.LaymuxNative.disconnectRemote();
            return;
          }
          window.parent.postMessage({ type: "laymux:desktop-mode" }, "*");
        }

        function disconnect(clearStatus = true) {
          claimAttemptRevision += 1;
          invalidateAttachmentChooser();
          cancelAttachmentUpload();
          stopSocket();
          stopHeartbeat();
          stopInputFlush();
          stopResizeFlush();
          stopNavigationViewPolling();
          cancelComposerSubmissions();
          terminalSelectionRevision += 1;
          resetTransientConnectionNotice();
          // The next session must attach at the desktop's own budget, and a
          // pending request from this one can never be answered.
          finishHistoryExpansion();
          resetHistoryExpansion(null);
          leaseId = null;
          if (androidE2eMode) window.LaymuxNative.setRemoteLease(null);
          fileViewerToken = null;
          closeFileViewer();
          setActiveTerminal(null);
          setConnected(false);
          if (navigationState) renderNavigation(navigationState);
          if (clearStatus) {
            setConnectionHint("Connect first to load workspaces and control the active terminal.", false);
            setStatus("Disconnected.");
          }
        }

        function loseRemoteControl(message, { hostTookOver = false } = {}) {
          const lostLeaseId = leaseId;
          // Two very different losses arrive here. A definitive server answer means
          // someone at the host took control — the standing intent to reconnect is
          // over until the user says otherwise (ADR-0027). A heartbeat timeout means
          // *we* went away (backgrounded, radio asleep, relay down), which is the
          // case issue #561 is about: stay armed and take the lease back on return.
          // Deliberately not gated on visibility. Losing the lease while hidden is the
          // normal case — and painting the failure screen (red notice, navigation
          // menu popped open) into a page nobody is looking at only shows up as a
          // flash on the way back, right before the reconnect undoes it.
          // `maybeAutoConnect` keeps the "never claim from the background" rule; a
          // hidden document just waits for the visibilitychange to fire it.
          const reclaimingOurOwn = !hostTookOver && autoConnectArmed();
          if (hostTookOver) disarmAutoConnect();
          // The server confirmed the loss; the capability must not seed a takeover on
          // the next claim (ADR-0027: no auto reclaim after loss). Taking our own
          // lease back is the exception it was built for (ADR-0037) — the capability
          // can only replace the lease *this tab* owned, never one the host holds.
          if (!reclaimingOurOwn) discardResumeToken();
          disconnect(false);
          if (reclaimingOurOwn) {
            // Do not paint an expiry we are already undoing: the red notice used to
            // flash for the second before the reconnect replaced it. Skipping the
            // release matters too — it would add an unnecessary voluntary drain
            // before our next claim. A drain that outlives the server's bounded
            // wait now returns `transitioning: true` and keeps this intent armed,
            // but avoiding that round trip remains the fastest recovery path.
            setConnectionHint("Reconnecting...", false);
            setBusyStatus("Reconnecting…", false, true);
            // Leaves the navigation menu as the user had it: this is not a state that
            // needs their attention.
            maybeAutoConnect();
            return;
          }
          terminalMetaEl.textContent = "Host has control.";
          setConnectionHint("Host has control. Connect again to request control.", true);
          setStatus(message, true);
          setNavigationOpen(true);
          if (lostLeaseId) releaseLease(lostLeaseId).catch(() => {});
        }

        emptyNav(workspaceListEl, "Not connected.");
        emptyNav(dockListEl, "Not connected.");
        emptyNav(notificationListEl, "Not connected.");
        setDockPanelOpen(false);
        // The drawer is the landing surface when the user has to connect by hand — it
        // holds Connect and the "Not connected." hints. With the reconnect intent
        // armed — or an autoConnect=1 load that is about to claim on its own
        // (the Android E2E entry always is) — it would open only to slide shut a
        // moment later, so start closed.
        setNavigationOpen(!(autoConnectArmed() || (autoConnectMode && (androidE2eMode || token()))));
        renderInputSurface();
        renderKeyRow();
        setKeyBarVisible(keyBarConfig.expanded, false);
        renderKeyPopover();
        // The markup ships checked; the stored choice is what actually holds
        // (ADR-0132). Applied before the first connect so a device that turned
        // the row off never flashes it.
        widgetStripToggle.checked = widgetStripAllowed;

        widgetStripToggle.addEventListener("change", () => {
          setWidgetStripAllowed(widgetStripToggle.checked);
        });
        remoteTerminalFontSizeInput.addEventListener("change", () => {
          saveRemoteDisplaySettings().catch(() => {});
        });
        remoteComposerFontSizeInput.addEventListener("change", () => {
          saveRemoteDisplaySettings().catch(() => {});
        });
        remoteTouchScrollSensitivityInput.addEventListener("change", () => {
          saveRemoteDisplaySettings().catch(() => {});
        });
        remoteTwoFingerScrollSensitivityInput.addEventListener("change", () => {
          saveRemoteDisplaySettings().catch(() => {});
        });
        checkPcUpdateButton.addEventListener("click", () => {
          loadPcUpdateStatus({ check: true }).catch(() => {});
        });
        installPcUpdateButton.addEventListener("click", () => {
          installPcUpdate().catch(() => {});
        });
        navToggleButton.addEventListener("click", () => {
          const open = navToggleButton.getAttribute("aria-expanded") !== "true";
          setNavigationOpen(open);
        });
        hiddenWorkspaceToggle.addEventListener("click", () => {
          openDrawerSubview("hidden");
        });
        newWorkspaceButton.addEventListener("click", () => {
          // A drawer subview like notifications/connection/settings — the
          // layout list loads first so the view never opens empty.
          loadWorkspaceLayouts()
            .then(() => openDrawerSubview("create"))
            .catch((err) => setStatus(err.message || String(err), true));
        });
        dockToggleButton.addEventListener("click", () => {
          setDockPanelOpen(!dockPanelOpen);
        });
        markAllNotificationsReadButton.addEventListener("click", () => {
          markAllNotificationsRead().catch((err) => setStatus(`Mark read failed: ${err.message}`, true));
        });
        clearNotificationsButton.addEventListener("click", () => {
          clearNotifications().catch((err) => setStatus(`Clear failed: ${err.message}`, true));
        });
        navScrim.addEventListener("click", () => setNavigationOpen(false));
        drawerBackButton.addEventListener("click", returnToWorkspaceView);
        drawerNotificationsButton.addEventListener("click", () => openDrawerSubview("notifications"));
        drawerConnectionButton.addEventListener("click", () => openDrawerSubview("connection"));
        drawerSettingsButton.addEventListener("click", () => openDrawerSubview("settings"));
        connectButton.addEventListener("click", () => connect().catch((err) => setStatus(err.message, true)));
        exitButton.addEventListener("click", () => exitRemote());
        refreshButton.addEventListener("click", () => {
          setBusyStatus("Refreshing…");
          loadNavigation().catch((err) => setStatus(err.message, true));
        });
        fileViewerPathInput.addEventListener("input", () => {
          fileViewerPathRevision += 1;
          renderFileViewerState();
        });
        pullHostFileViewerPathButton.addEventListener("click", () => {
          pullHostFileViewerPath().catch((error) => {
            renderFileViewerState(error instanceof Error ? error.message : String(error), true);
          });
        });
        fileViewerPathInput.addEventListener("keydown", (event) => {
          if (
            event.key !== "Enter" ||
            event.isComposing ||
            event.keyCode === 229 ||
            openFileViewerButton.disabled
          ) return;
          event.preventDefault();
          openFileViewerOverlay(fileViewerPathInput.value.trim());
        });
        openFileViewerButton.addEventListener("click", () => {
          const path = fileViewerPathInput.value.trim();
          if (path) openFileViewerOverlay(path);
        });
        fileViewerCloseButton.addEventListener("click", closeFileViewer);
        fileViewerDownloadButton.addEventListener("click", downloadCurrentFileViewerFile);
        fileExplorerHeaderButton.addEventListener("click", () => {
          // Open where the user is working. Without an attached terminal the
          // bridge falls back to the host home directory.
          openFileExplorerOverlay(
            activeTerminalId
              ? { source: "terminalCwd", terminalId: activeTerminalId }
              : { source: "terminalCwd" },
          );
        });
        fileViewerBackButton.addEventListener("click", () => {
          // Back re-requests the listing rather than restoring a cache: the
          // directory may have changed while the file was open (ADR-0197).
          if (fileViewerExplorerReturnPath) {
            openFileExplorerOverlay({ path: fileViewerExplorerReturnPath });
          }
        });
        // Capture phase, and the event stops here: Escape otherwise reaches the
        // terminal and is written to the PTY as ESC while the user only meant to
        // dismiss the file they are reading.
        window.addEventListener(
          "keydown",
          (event) => {
            if (fileViewerOverlayElement.hidden || event.key !== "Escape") return;
            event.preventDefault();
            event.stopImmediatePropagation();
            closeFileViewer();
          },
          true,
        );
        fileViewerOverlayElement.addEventListener("click", (event) => {
          // Only the backdrop itself closes; a click inside the dialog is the
          // user reading, selecting or scrolling the file.
          if (event.target === fileViewerOverlayElement) closeFileViewer();
        });
        fileViewerZoomOutButton.addEventListener("click", () => adjustFileViewerZoom(-1));
        fileViewerZoomInButton.addEventListener("click", () => adjustFileViewerZoom(1));
        fileViewerZoomResetButton.addEventListener("click", () => {
          resetFileViewerZoom();
          applyFileViewerZoom();
        });
        fileViewerBodyElement.addEventListener("pointerdown", handleFileViewerPointerDown);
        fileViewerBodyElement.addEventListener("pointermove", handleFileViewerPointerMove);
        fileViewerBodyElement.addEventListener("pointerup", handleFileViewerPointerRelease);
        fileViewerBodyElement.addEventListener("pointercancel", handleFileViewerPointerRelease);
        // Not passive: the pinch and Ctrl+Wheel paths both call preventDefault
        // to stop the browser zooming the page instead of the file.
        fileViewerBodyElement.addEventListener("wheel", handleFileViewerWheel, { passive: false });
        terminalHost.addEventListener("pointerdown", handlePathLinkPointerDown, true);
        terminalHost.addEventListener("mousemove", handlePathLinkMouseMove);
        window.addEventListener("pointerup", handlePathLinkPointerUp, true);
        window.addEventListener("pointercancel", handlePathLinkPointerCancel, true);
        // xterm completes a mouse selection from a document-level mouseup handler.
        // Listen at the same boundary so releasing an outside-terminal drag still
        // schedules the copy after every listener for this event has run.
        document.addEventListener("mouseup", handleSelectionMouseupAfterInteraction);
        keepInputSurfaceFocus(scrollToBottomButton);
        scrollToBottomButton.addEventListener("click", () => {
          if (!terminal) return;
          terminal.scrollToBottom();
          updateScrollToBottomButton();
        });
        desktopModeHeaderButton.addEventListener("click", () => requestDesktopMode().catch((err) => setStatus(err.message, true)));
        desktopModeDrawerButton.addEventListener("click", () => requestDesktopMode().catch((err) => setStatus(err.message, true)));

        // --- Install affordance (ADR-0099) ---
        // The manifest (ADR-0091) makes installation possible; the browser hides
        // the path inside its own menu, so the drawer offers it. Whether it is
        // possible right now is the browser's judgement, not ours: Chromium says
        // so by firing `beforeinstallprompt`, and that event is also the only
        // handle to the prompt itself.
        let deferredInstallPrompt = null;
        const standaloneDisplay = window.matchMedia("(display-mode: standalone)");
        // iOS/iPadOS never fires the event and offers no programmatic install, so
        // the share sheet is the only route and an instruction is all we can give.
        const iosInstallOnly =
          !("onbeforeinstallprompt" in window) && /iphone|ipad|ipod/i.test(navigator.userAgent);

        function runningStandalone() {
          // `navigator.standalone` is iOS' pre-`display-mode` flag for a home
          // screen launch and is still what its older webviews report.
          return standaloneDisplay.matches || navigator.standalone === true;
        }

        function syncInstallSection() {
          // Direct Remote Mode is plain HTTP, so it is not a secure context and no
          // browser will install it. A button that cannot work is worse than none.
          const installable =
            window.isSecureContext &&
            !runningStandalone() &&
            (deferredInstallPrompt !== null || iosInstallOnly);
          installSection.hidden = !installable;
          if (!installable) installHint.hidden = true;
        }

        window.addEventListener("beforeinstallprompt", (event) => {
          // Letting it through spends Chromium's own mini-infobar and leaves the
          // drawer with nothing to trigger.
          event.preventDefault();
          deferredInstallPrompt = event;
          syncInstallSection();
        });
        window.addEventListener("appinstalled", () => {
          deferredInstallPrompt = null;
          syncInstallSection();
        });
        standaloneDisplay.addEventListener("change", syncInstallSection);

        installButton.addEventListener("click", () => {
          if (!deferredInstallPrompt) {
            installHint.hidden = !installHint.hidden;
            return;
          }
          const prompt = deferredInstallPrompt;
          // A prompt event cannot be replayed, so it is spent either way — drop it
          // before prompting so a second tap cannot reuse a dead handle.
          deferredInstallPrompt = null;
          prompt.prompt().catch(() => {});
          syncInstallSection();
        });

        syncInstallSection();
        // Ctrl+C sends like a soft key; keep it from blurring the input surface
        // and dismissing the keyboard (#482).
        keepInputSurfaceFocus(ctrlCButton);
        ctrlCButton.addEventListener("click", () => enqueueInput("\x03"));
        // Same contract as the soft keys: the toggle must read the surface's
        // real focus state on click, so the button must not steal focus first
        // (#482). keepInputSurfaceFocus guards mousedown + pointerdown.
        keepInputSurfaceFocus(focusTerminalButton);
        focusTerminalButton.addEventListener("click", () => toggleInputSurfaceFocus());
        keepInputSurfaceFocus(copyPaneIdButton);
        copyPaneIdButton.addEventListener("click", () => {
          const identifier = activePaneIdentifier();
          if (!identifier) return;
          writeClipboardText(identifier)
            .then(() => setStatus(`Copied ${identifier}`))
            .catch((err) => setStatus(`Copy failed: ${err.message || err}`, true));
        });
        keepInputSurfaceFocus(spatialExclusionButton);
        spatialExclusionButton.addEventListener("click", () => {
          const pane = activeWorkspacePane();
          if (!pane) return;
          const workspaceId = terminalInfoById.get(activeTerminalId)?.workspaceId || null;
          // Toggle this pane, then promote/demote the owning workspace so that
          // "every pane skipped" and "workspace skipped" stay in sync (#507).
          const next = computeSkipStateAfterPaneToggle({
            workspaceId,
            terminalPaneIds: workspaceTerminalPaneIds(workspaceId),
            paneId: pane.id,
            excludedPaneIds: [...spatialExcludedPaneIds],
            excludedWorkspaceIds: [...spatialExcludedWorkspaceIds],
          });
          spatialExcludedPaneIds = new Set(next.paneIds);
          spatialExcludedWorkspaceIds = new Set(next.workspaceIds);
          saveSpatialExcludedPaneIds();
          saveSpatialExcludedWorkspaceIds();
          updateHeaderPaneIdentity();
          // A promotion/demotion changes the drawer workspace toggle too.
          if (navigationState) renderWorkspaceList(navigationState.workspaces || []);
          const paneLabel = activeTerminalTitle() || "This pane";
          setStatus(
            next.willExclude
              ? `${paneLabel} excluded from pane navigation.`
              : `${paneLabel} included in pane navigation.`
          );
        });
        keepInputSurfaceFocus(attachmentButton);
        attachmentButton.addEventListener("click", () => {
          if (attachmentButton.disabled) return;
          if (!beginAttachmentChooser()) return;
          attachmentInput.click();
        });
        function uploadSelectedAttachmentFiles(chooser) {
          const files = Array.from(attachmentInput.files || []);
          if (files.length === 0) return false;
          if (!chooser || !attachmentChooserIsCurrent(chooser)) {
            if (pendingAttachmentChooser === chooser) invalidateAttachmentChooser();
            attachmentInput.value = "";
            return false;
          }
          pendingAttachmentChooser = null;
          clearAttachmentChooserRetryTimers();
          void attachRemoteFiles(files, { snapshot: chooser.snapshot });
          return true;
        }
        attachmentInput.addEventListener("change", () => {
          if (!uploadSelectedAttachmentFiles(pendingAttachmentChooser) && pendingAttachmentChooser) {
            invalidateAttachmentChooser();
          }
        });
        window.addEventListener("focus", () => {
          // Some older Android System WebView builds populate FileList after
          // the system picker returns but omit the input's change event.
          // The chooser identity pins retries to the lease and terminal that
          // opened it, so a late FileList can never cross a reconnect boundary.
          const chooser = pendingAttachmentChooser;
          if (!chooser) return;
          clearAttachmentChooserRetryTimers();
          for (const delay of [0, 250]) {
            const timer = window.setTimeout(() => {
              attachmentChooserRetryTimers.delete(timer);
              if (!attachmentChooserIsCurrent(chooser)) {
                if (pendingAttachmentChooser === chooser) invalidateAttachmentChooser();
                return;
              }
              const uploaded = uploadSelectedAttachmentFiles(chooser);
              if (!uploaded && delay === 250 && pendingAttachmentChooser === chooser) {
                invalidateAttachmentChooser();
              }
            }, delay);
            attachmentChooserRetryTimers.add(timer);
          }
        });
        inputModeToggleButton.addEventListener("click", () => {
          setInputMode(currentInputMode() === "composer" ? "direct" : "composer");
        });
        composerInput.addEventListener("input", () => {
          const draft = composerDraft();
          if (!draft || draft.text === composerInput.value) return;
          draft.text = composerInput.value;
          draft.revision += 1;
          // Manual editing closes the Tab recall popup and re-arms autocomplete
          // (undo a prior Escape), clearing any active selection so the fresh
          // suggestion list never steals the next Enter.
          if (composerHistoryOpen) composerHistoryOpen = false;
          if (composerAutocompleteDismissed) composerAutocompleteDismissed = false;
          if (composerAutocompleteIndex !== -1) composerAutocompleteIndex = -1;
          updateComposerControls();
          renderComposerSuggestions();
        });
        composerInput.addEventListener("paste", (event) => {
          if (currentInputMode() !== "composer") return;
          const text = event.clipboardData?.getData("text/plain") || "";
          if (!text || !shouldConvertLongTextToAttachment(text)) return;
          if (attachmentTextByteLength(text) > REMOTE_ATTACHMENT_MAX_BYTES) {
            setStatus(
              "Pasted text exceeds the 1 MiB attachment limit and was kept in the composer.",
              false,
              true,
            );
            return;
          }
          if (attachmentUploadInFlight) {
            event.preventDefault();
            event.stopImmediatePropagation();
            setStatus(
              "A long paste was rejected because an attachment upload is already in progress.",
              false,
              true,
            );
            return;
          }
          const snapshot = attachmentSelectionSnapshot();
          if (!snapshot || !composerReady) return;
          event.preventDefault();
          event.stopImmediatePropagation();
          void attachRemoteFiles([longTextAttachmentFile(text)], {
            snapshot,
            fallbackText: text,
          });
        });
        composerInput.addEventListener("compositionstart", () => {
          composerIsComposing = true;
        });
        composerInput.addEventListener("compositionend", () => {
          composerIsComposing = false;
        });
        // Leaving the editor (pane/mode switch, tapping away) closes both lists.
        // Recall items commit on mousedown+preventDefault, so a pick keeps focus
        // and this never fires mid-selection.
        composerInput.addEventListener("blur", () => {
          composerHistoryOpen = false;
          dismissComposerAutocomplete();
          renderComposerSuggestions();
        });
        // Touch path for the #504 recall popup: soft keyboards have no Tab
        // key, so tapping (or clicking) the EMPTY editor opens the same
        // history popup the Tab gesture opens on hardware keyboards. A
        // pointer tap is not a keyboard shortcut, so this stays outside the
        // keybinding rule (api-contracts §15.5). currentComposerHistoryEntries
        // already enforces the toggle, the empty draft, and a non-empty
        // history, so a tap with nothing to recall is a no-op.
        composerInput.addEventListener("click", () => {
          if (composerHistoryOpen) return;
          // Mirror the keydown guard: never surface the popup mid-IME
          // composition (a click can land before the preedit reaches the
          // draft, so the empty-draft check alone is not enough).
          if (composerIsComposing) return;
          const historyEntries = currentComposerHistoryEntries();
          if (historyEntries.length === 0) return;
          composerHistoryIndex = 0;
          composerHistoryOpen = true;
          renderComposerSuggestions();
        });
        // Enter behavior follows the layout (ADR-0036):
        //   - mobile layout: Enter inserts a newline. Sending is the dedicated
        //     Send button only, so the unreliable soft-keyboard Enter (keyCode
        //     229, IME/isComposing races) is never on the send path. No
        //     hardcoded keyboard send gesture — shortcuts outside the
        //     keybinding system are forbidden (api-contracts §15.5).
        //   - desktop layout: Enter sends, Shift+Enter is a newline. IME
        //     candidate confirmation (isComposing / keyCode 229) never submits.
        composerInput.addEventListener("keydown", (event) => {
          const composing =
            event.isComposing || composerIsComposing || event.keyCode === 229;
          // Recall navigation only owns unmodified keys; modifier combos stay
          // available as editor/app gestures.
          const plainKey =
            !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;

          const historyEntries = currentComposerHistoryEntries();
          const historyVisible = composerHistoryOpen && historyEntries.length > 0;
          const suggestions = currentComposerSuggestions();
          const autocompleteVisible =
            !composerAutocompleteDismissed && suggestions.length > 0;
          const activeAutocompleteIndex =
            composerAutocompleteIndex >= 0 && composerAutocompleteIndex < suggestions.length
              ? composerAutocompleteIndex
              : -1;

          // (1) While the Tab recall popup is open (empty draft, issue #504) it
          // owns navigation/commit keys so they never leak to Send.
          if (historyVisible && !composing) {
            if (event.key === "ArrowDown" || (event.key === "Tab" && !event.shiftKey)) {
              event.preventDefault();
              composerHistoryIndex = (composerHistoryIndex + 1) % historyEntries.length;
              renderComposerSuggestions();
              return;
            }
            if (event.key === "ArrowUp" || (event.key === "Tab" && event.shiftKey)) {
              event.preventDefault();
              composerHistoryIndex =
                (composerHistoryIndex - 1 + historyEntries.length) % historyEntries.length;
              renderComposerSuggestions();
              return;
            }
            if (event.key === "Enter") {
              event.preventDefault();
              commitComposerHistoryEntry(historyEntries[composerHistoryIndex]);
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              composerHistoryOpen = false;
              renderComposerSuggestions();
              return;
            }
          }

          // (2) While autocomplete is open (non-empty draft, issue #505) it owns
          // Tab/Escape and, once a suggestion is navigated to, Enter/arrows. With
          // no active selection it deliberately leaves Enter alone so plain Enter
          // still sends. This block sits BEFORE the Tab-open block so a non-empty
          // draft's Tab always accepts a suggestion, never opens the recall popup.
          if (autocompleteVisible && !composing && plainKey) {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              composerAutocompleteIndex = Math.min(
                composerAutocompleteIndex + 1,
                suggestions.length - 1
              );
              renderComposerSuggestions();
              return;
            }
            if (event.key === "ArrowUp" && activeAutocompleteIndex >= 0) {
              event.preventDefault();
              // Leaving the list at the top (0 → −1) keeps it open but reselects
              // the draft, restoring plain-Enter send.
              composerAutocompleteIndex = activeAutocompleteIndex - 1;
              renderComposerSuggestions();
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              dismissComposerAutocomplete();
              renderComposerSuggestions();
              return;
            }
            if (event.key === "Tab") {
              // Accept the active suggestion, or the top one if none is active —
              // the "type a prefix, Tab to complete" gesture.
              event.preventDefault();
              event.stopPropagation();
              commitComposerAutocompleteEntry(
                suggestions[activeAutocompleteIndex >= 0 ? activeAutocompleteIndex : 0]
              );
              return;
            }
            if (event.key === "Enter" && activeAutocompleteIndex >= 0) {
              event.preventDefault();
              commitComposerAutocompleteEntry(suggestions[activeAutocompleteIndex]);
              return;
            }
          }

          // (3) Tab on an empty, focused draft opens the recall popup instead of
          // forwarding \t (which has no text to complete). This is composer-local
          // UI navigation, not a global shortcut (api-contracts §15.5).
          if (
            !historyVisible &&
            !composing &&
            plainKey &&
            event.key === "Tab" &&
            historyEntries.length > 0
          ) {
            event.preventDefault();
            event.stopPropagation();
            composerHistoryIndex = 0;
            composerHistoryOpen = true;
            renderComposerSuggestions();
            return;
          }

          // (4) Existing Enter=Send gesture (ADR-0036, desktop layout only).
          if (event.key !== "Enter" || event.shiftKey) return;
          if (mobileLayout) return;
          if (event.isComposing || composerIsComposing || event.keyCode === 229) return;
          event.preventDefault();
          commitComposer();
        });
        composerSendButton.addEventListener("click", () => {
          commitComposer();
          focusCurrentInputSurface();
        });
        // Revealing the special-key toolbar must not blur the input surface and
        // drop the keyboard (#482) — showing keys should keep the keyboard up.
        keepInputSurfaceFocus(keyBarToggleButton);
        keyBarToggleButton.addEventListener("click", () => setKeyBarVisible(keyBar.hidden));
        // Auto-claim on load when autoConnect=1 is present. This is NOT gated on
        // localAppMode so the cloud dashboard flow (external browser) also grabs
        // control on connect — one fewer click. The remote-control enable toggle
        // still governs: if control is not allowed the claim fails and we stay an
        // observer with a status hint (no hard error). No input focus: this
        // claim runs outside a user gesture, so focusing would strand DOM focus
        // without a soft keyboard and flip the Keyboard toggle's first tap into
        // a dismiss.
        if (autoConnectMode && (androidE2eMode || token())) {
          setTimeout(
            () => connect({ focusInput: false }).catch((err) => setStatus(err.message, true)),
            0,
          );
        }
        // pagehide (not beforeunload) is the only teardown event mobile
        // browsers fire reliably, and it also covers bfcache entry.
        window.addEventListener("pagehide", releaseLeaseOnPageHide);
        // The mirror of the pagehide release: coming back re-claims. Three signals
        // for the same moment — a tab switch (visibilitychange), a bfcache restore
        // that fires no visibilitychange (pageshow), and a network that returns
        // while the page is already open (online).
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") {
            maybeAutoConnect();
            // The poll skipped every tick while hidden, so the first thing a
            // returning viewer would otherwise see is the capture it left.
            refreshWidgetsNow();
          } else cancelAutoConnectRetry();
        });
        window.addEventListener("pageshow", () => maybeAutoConnect());
        window.addEventListener("online", () => maybeAutoConnect());
        // A bfcache restore resumes this same document: reclaim the stashed
        // capability so it is back in memory only, out of any clone's reach.
        window.addEventListener("pageshow", (event) => {
          if (!event.persisted) return;
          const stashed = consumeStashedResumeToken();
          if (stashed) resumeToken = stashed;
        });
        window.addEventListener("beforeunload", () => {
          if (pcUpdatePollTimer) clearTimeout(pcUpdatePollTimer);
          cancelAttachmentUpload();
          stopSocket();
          stopHeartbeat();
          stopInputFlush();
          if (resizeObserver) resizeObserver.disconnect();
          window.removeEventListener("resize", syncRemoteViewportHeight);
          remoteVisualViewport?.removeEventListener("resize", syncRemoteViewportHeight);
          terminalHost.removeEventListener("pointerdown", handlePathLinkPointerDown, true);
          terminalHost.removeEventListener("mousemove", handlePathLinkMouseMove);
          window.removeEventListener("pointerup", handlePathLinkPointerUp, true);
          window.removeEventListener("pointercancel", handlePathLinkPointerCancel, true);
          clearPathLinkSelection();
          closeFileViewer();
        });
      })();
