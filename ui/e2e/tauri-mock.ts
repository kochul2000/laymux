/**
 * Tauri IPC mock for Playwright e2e tests.
 * Injected via page.addInitScript() before the app loads.
 * Simulates __TAURI_INTERNALS__ so @tauri-apps/api works without the Rust backend.
 */
export const TAURI_MOCK_SCRIPT = `
(function() {
  var cbId = 0;
  var callbacks = {};
  var eventListeners = {};

  // Mock for @tauri-apps/api/event internals (used by _unlisten)
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: function(_event, _eventId) {
      // no-op: event cleanup handled by invoke('plugin:event|unlisten')
    }
  };

  window.__TAURI_INTERNALS__ = {
    transformCallback: function(callback, once) {
      var id = ++cbId;
      callbacks[id] = function(payload) {
        callback(payload);
        if (once) delete callbacks[id];
      };
      return id;
    },

    unregisterCallback: function(id) {
      delete callbacks[id];
    },

    invoke: function(cmd, args, options) {
      // Event system
      if (cmd === 'plugin:event|listen') {
        var event = args.event;
        var handler = args.handler;
        if (!eventListeners[event]) eventListeners[event] = [];
        if (callbacks[handler]) {
          eventListeners[event].push({ id: handler, fn: callbacks[handler] });
        }
        return Promise.resolve(handler);
      }
      if (cmd === 'plugin:event|unlisten') {
        var ev = args.event;
        var eid = args.eventId;
        if (eventListeners[ev]) {
          eventListeners[ev] = eventListeners[ev].filter(function(l) { return l.id !== eid; });
        }
        return Promise.resolve();
      }
      if (cmd === 'plugin:event|emit' || cmd === 'plugin:event|emit_to') {
        return Promise.resolve();
      }

      // App commands
      switch (cmd) {
        case 'load_settings':
          return Promise.resolve({
            font: { face: 'Consolas', size: 14 },
            defaultProfile: 'PowerShell',
            profiles: [
              { name: 'PowerShell', commandLine: 'powershell.exe', colorScheme: '', startingDirectory: '', hidden: false },
              { name: 'WSL', commandLine: 'wsl.exe', colorScheme: '', startingDirectory: '', hidden: false },
            ],
            colorSchemes: [],
            keybindings: [],
            layouts: [
              {
                id: 'default-layout',
                name: 'Default',
                panes: [{ x: 0, y: 0, w: 1, h: 1, viewType: 'TerminalView' }],
              },
              {
                id: 'dev-split',
                name: 'Dev Split',
                panes: [
                  { x: 0, y: 0, w: 1, h: 0.6, viewType: 'TerminalView' },
                  { x: 0, y: 0.6, w: 0.5, h: 0.4, viewType: 'TerminalView' },
                  { x: 0.5, y: 0.6, w: 0.5, h: 0.4, viewType: 'TerminalView' },
                ],
              },
            ],
            workspaces: [
              {
                id: 'ws-default',
                name: 'Default',

                panes: [
                  { id: 'pane-e2e-1', x: 0, y: 0, w: 1, h: 1, view: { type: 'TerminalView', profile: 'PowerShell', syncGroup: 'ws-default' } },
                ],
              },
            ],
            docks: [
              { position: 'left', activeView: 'WorkspaceSelectorView', views: ['WorkspaceSelectorView', 'SettingsView'], visible: true },
              { position: 'right', activeView: null, views: [], visible: true },
              { position: 'top', activeView: null, views: [], visible: true },
              { position: 'bottom', activeView: null, views: [], visible: true },
            ],
          });

        case 'save_settings':
          return Promise.resolve(undefined);

        case 'create_terminal_session':
          return Promise.resolve({
            id: (args && args.id) || 'mock-terminal',
            title: 'Mock Terminal',
            config: {
              profile: (args && args.profile) || 'PowerShell',
              cols: 80, rows: 24,
              sync_group: (args && args.syncGroup) || '',
              env: [],
            },
          });

        case 'write_to_terminal':
        case 'resize_terminal':
        case 'close_terminal_session':
        case 'send_os_notification':
          return Promise.resolve(undefined);

        case 'get_sync_group_terminals':
          return Promise.resolve([]);

        case 'handle_ide_message':
          return Promise.resolve({ success: true, data: null, error: null });

        case 'get_listening_ports':
          return Promise.resolve([
            { port: 3000, pid: 1234, process_name: 'node' },
            { port: 8080, pid: 5678, process_name: 'java' },
          ]);

        case 'get_git_branch':
          return Promise.resolve('main');

        case 'load_terminal_output_cache':
          // Return test cache data if configured, otherwise empty
          return Promise.resolve(window.__testCacheData || '');

        case 'save_terminal_output_cache':
        case 'clean_terminal_output_cache':
        case 'load_window_geometry':
        case 'save_window_geometry':
        case 'load_memo':
          return Promise.resolve('');
        case 'mark_claude_terminal':
        case 'mark_notifications_read':
        case 'get_terminal_cwds':
        case 'get_terminal_states':
        case 'set_terminal_cwd_receive':
        case 'update_terminal_sync_group':
          return Promise.resolve(null);

        default:
          console.warn('[tauri-mock] Unknown command:', cmd, args);
          return Promise.resolve(null);
      }
    },

    convertFileSrc: function(filePath) { return filePath; },
    metadata: { currentWebview: { label: 'main' }, currentWindow: { label: 'main' } },
  };

  // Expose emit function for tests to simulate backend events
  window.__tauriMockEmit = function(eventName, payload) {
    var listeners = eventListeners[eventName] || [];
    for (var i = 0; i < listeners.length; i++) {
      listeners[i].fn({ event: eventName, id: listeners[i].id, payload: payload });
    }
  };
})();
`;
