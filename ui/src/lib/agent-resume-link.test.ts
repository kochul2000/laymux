import { describe, expect, it } from "vitest";
import { parseAgentResumeHint, buildAgentResumeCommand } from "./agent-resume-link";

const id = "01a0ed7f-460f-74d0-bfca-2fa6b336a8a5";

describe("종료 안내의 세션 복원 명령", () => {
  it.each([
    ["codex", `  codex resume ${id}  `],
    ["claude", `claude --resume ${id}`],
    ["grok", `grok --resume ${id}`],
  ])("%s의 세션 ID만 추출한다", (provider, text) => {
    expect(parseAgentResumeHint(text)).toEqual({ provider, sessionId: id });
  });

  it.each([
    `codex resume ${id}; whoami`,
    `codex resume ${id} --yolo`,
    `echo codex resume ${id}`,
    `PS> claude --resume ${id}`,
    "claude --resume $(whoami)",
    "codex resume ../session",
    `codex resume ${id}\nwhoami`,
    `codex resume ${id}x`,
    "grok --resume latest",
  ])("명령 전체를 실행할 수 있는 원문은 거부한다: %s", (text) => {
    expect(parseAgentResumeHint(text)).toBeNull();
  });

  it("설정에 저장된 실행 옵션을 적용한다", () => {
    expect(
      buildAgentResumeCommand(
        { provider: "codex", sessionId: id },
        {
          codex: { command: "codex --yolo --no-daemon" },
        },
      ),
    ).toBe(`codex --yolo --no-daemon resume ${id}`);
    expect(
      buildAgentResumeCommand(
        { provider: "claude", sessionId: id },
        {
          claude: { command: "claude --dangerously-skip-permissions" },
        },
      ),
    ).toBe(`claude --dangerously-skip-permissions --resume ${id}`);
  });

  it("실행 직전에 식별자와 설정 문법을 다시 검증한다", () => {
    expect(buildAgentResumeCommand({ provider: "codex", sessionId: "x;whoami" }, {})).toBeNull();
    expect(
      buildAgentResumeCommand(
        { provider: "grok", sessionId: id },
        {
          grok: { command: "grok;whoami" },
        },
      ),
    ).toBe(`grok --resume ${id}`);
  });

  it("UUID 뒤의 개행을 허용하지 않는다", () => {
    expect(parseAgentResumeHint(`codex resume ${id}\n`)).toBeNull();
    expect(buildAgentResumeCommand({ provider: "codex", sessionId: `${id}\n` }, {})).toBeNull();
  });
});
