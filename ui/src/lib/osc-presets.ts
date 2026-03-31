import type { OscHook } from "./osc-parser";

export type OscPresetName =
  | "sync-cwd"
  | "sync-branch"
  | "notify-on-fail"
  | "notify-on-complete"
  | "set-title-cwd"
  | "set-wsl-distro"
  | "notify-osc9"
  | "notify-osc99"
  | "notify-osc777"
  | "track-command"
  | "track-command-result"
  | "track-command-start";

const presets: Record<OscPresetName, OscHook[]> = {
  "sync-cwd": [
    {
      osc: 7,
      run: "lx sync-cwd $path",
    },
  ],
  "set-wsl-distro": [
    {
      osc: 9,
      when: "message.startsWith('9;')",
      run: "lx set-wsl-distro $path",
    },
  ],
  "sync-branch": [
    {
      osc: 133,
      param: "E",
      when: "command.startsWith('git switch') || command.startsWith('git checkout')",
      run: "lx sync-branch $branch",
    },
  ],
  "notify-on-fail": [
    {
      osc: 133,
      param: "D",
      when: "exitCode !== '0'",
      run: "lx notify --level error 'Command failed (exit $exitCode)'",
    },
  ],
  "notify-on-complete": [
    {
      osc: 133,
      param: "D",
      when: "exitCode === '0'",
      run: "lx notify --level success 'Command completed'",
    },
  ],
  "set-title-cwd": [
    {
      osc: 7,
      run: "lx set-tab-title $path",
    },
    {
      osc: 9,
      when: "message.startsWith('9;')",
      run: "lx set-tab-title $path",
    },
  ],
  "notify-osc9": [
    {
      osc: 9,
      when: "!message.startsWith('9;')",
      run: "lx notify $message",
    },
  ],
  "notify-osc99": [
    {
      osc: 99,
      run: "lx notify $message",
    },
  ],
  "notify-osc777": [
    {
      osc: 777,
      run: "lx notify $message",
    },
  ],
  "track-command": [
    {
      osc: 133,
      param: "E",
      run: 'lx set-command-status --command "$command"',
    },
  ],
  "track-command-result": [
    {
      osc: 133,
      param: "D",
      run: "lx set-command-status --exit-code $exitCode",
    },
  ],
  "track-command-start": [
    {
      osc: 133,
      param: "C",
      run: "lx set-command-status --command __preexec__",
    },
  ],
};

export function getPresetHooks(name: OscPresetName): OscHook[] {
  return presets[name] ?? [];
}
