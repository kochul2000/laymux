import { test, expect } from "@playwright/test";
import { TAURI_MOCK_SCRIPT } from "./tauri-mock";

for (const surface of ["workspace", "dock"] as const) {
  for (const provider of ["claude", "codex", "grok"] as const) {
    test(`${surface} Restart View resumes the current ${provider} session after close`, async ({
      page,
    }) => {
      const paneId = surface === "workspace" ? "pane-e2e-1" : "restart-dock";
      const terminalId = `terminal-${paneId}`;
      const sessionId = "019ffa7f-b8c1-7511-872f-911e8dc8d179";
      await page.addInitScript(
        TAURI_MOCK_SCRIPT +
          `
        const original = window.__TAURI_INTERNALS__.invoke;
        const calls = window.__restartCalls = [];
        let generation = 0;
        window.__TAURI_INTERNALS__.invoke = async (command, args, options) => {
          if (command === 'plugin:event|listen' && args.event === 'session-checkpoint-requested') window.__restartListenerReady = true;
          if (command === 'get_terminal_cwds') return { ${JSON.stringify(terminalId)}: '/current' };
          if (command === 'get_terminal_session_attributions') return {
            ${JSON.stringify(terminalId)}: { generation, state: 'identified', provider: '${provider}', sessionId: '${sessionId}' }
          };
          if (command === 'checkpoint_and_close_terminal_for_restart') {
            // Emulate Rust's checkpoint request/ACK before the native close.
            await new Promise((resolve, reject) => {
              window.__restartCheckpointAck = (error) => error ? reject(new Error(error)) : resolve();
              window.__tauriMockEmit('session-checkpoint-requested', {
                requestId: 42, reason: 'restart', requireConclusive: true, terminalIds: [args.id]
              });
            });
            calls.push({ command: 'close_terminal_session', args });
            await new Promise(resolve => { window.__finishRestartClose = resolve; });
            window.__holdRestartClose = false;
            return;
          }
          if (command === 'acknowledge_session_checkpoint' && args.requestId === 42) {
            window.__restartCheckpointAck(args.error);
            return;
          }
          if (command === 'create_terminal_session' && args.id === '${terminalId}') {
            calls.push({ command, args });
            generation++;
          }
          if (command === 'close_terminal_session' && args.id === '${terminalId}') {
            calls.push({ command, args });
            if (window.__holdRestartClose) return new Promise(resolve => { window.__finishRestartClose = resolve; });
          }
          if (command === 'save_session_checkpoint') calls.push({ command, args });
          const result = await original(command, args, options);
          if (command === 'load_settings_validated') {
            const settings = result.settings;
            settings.language = 'en';
            settings.confirmDestructiveActions = false;
            settings.controlBar.defaultMode = 'pinned';
            settings.claude = { command: 'claude --dangerously-skip-permissions', restoreSession: true };
            settings.codex = { command: 'codex --yolo', restoreSession: true };
            settings.grok = { command: 'grok --yolo', restoreSession: true };
            if ('${surface}' === 'dock') {
              settings.workspaces[0].panes[0].view = { type: 'MemoView' };
              settings.docks.find(dock => dock.position === 'bottom').panes = [{
                id: '${paneId}', x: 0, y: 0, w: 1, h: 1,
                view: { type: 'TerminalView', profile: 'PowerShell' }
              }];
              settings.docks.find(dock => dock.position === 'bottom').activeView = 'TerminalView';
            }
          }
          return result;
        };
      `,
      );
      await page.goto("/");
      const pane =
        surface === "workspace"
          ? page.getByTestId("workspace-pane-0")
          : page.getByTestId("dock-bottom");
      await expect(pane.getByTestId(`terminal-view-${terminalId}`)).toBeVisible();
      await page.waitForFunction(
        () =>
          (window as unknown as { __restartListenerReady?: boolean }).__restartListenerReady ===
          true,
      );
      await page.waitForFunction(async (id) => {
        // Include StrictMode's initial create/close/create in the readiness wait.
        const modulePath = "/src/stores/terminal-store.ts";
        const { useTerminalStore } = await import(modulePath);
        return useTerminalStore
          .getState()
          .instances.some(
            (item: { id: string; sessionReady?: boolean }) =>
              item.id === id && item.sessionReady === true,
          );
      }, terminalId);
      const initialCreates = await page.evaluate(() => {
        const state = window as unknown as {
          __holdRestartClose: boolean;
          __restartCalls: { command: string }[];
        };
        state.__holdRestartClose = true;
        return state.__restartCalls.filter((call) => call.command === "create_terminal_session")
          .length;
      });
      const restart = pane.getByTestId("pane-control-restart");
      await restart.click();
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              typeof (window as unknown as { __finishRestartClose?: unknown }).__finishRestartClose,
          ),
        )
        .toBe("function");
      const calls = () =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __restartCalls: { command: string; args: Record<string, unknown> }[];
              }
            ).__restartCalls,
        );
      const beforeClose = await calls();
      expect(beforeClose.filter((call) => call.command === "create_terminal_session")).toHaveLength(
        initialCreates,
      );
      const checkpoint = beforeClose.findLast((call) => call.command === "save_session_checkpoint");
      expect(checkpoint).toBeDefined();
      expect(beforeClose.indexOf(checkpoint!)).toBeLessThan(
        beforeClose.findLastIndex((call) => call.command === "close_terminal_session"),
      );
      await page.evaluate(() =>
        (window as unknown as { __finishRestartClose: () => void }).__finishRestartClose(),
      );
      await expect
        .poll(
          async () =>
            (await calls()).filter((call) => call.command === "create_terminal_session").length,
        )
        .toBeGreaterThan(initialCreates);
      const last = (await calls()).findLast((call) => call.command === "create_terminal_session")!;
      const command =
        provider === "claude"
          ? "claude --dangerously-skip-permissions --resume"
          : provider === "codex"
            ? "codex --yolo resume"
            : "grok --yolo --resume";
      expect(last.args).toMatchObject({
        cwd: "/current",
        startupCommandOverride: `${command} ${sessionId}`,
      });
    });
  }
}
