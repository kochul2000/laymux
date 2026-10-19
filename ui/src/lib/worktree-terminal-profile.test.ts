import { describe, expect, it } from "vitest";
import { worktreeTerminalProfile } from "./worktree-terminal-profile";

const profiles = [
  { name: "PowerShell", commandLine: "pwsh.exe" },
  { name: "WSL", commandLine: "wsl.exe" },
  { name: "Debian", commandLine: 'C:\\Windows\\System32\\wsl.exe -d "Debian"' },
];
describe("worktree terminal profile", () => {
  it("네이티브 경로는 기본 프로필을 유지한다", () => {
    expect(worktreeTerminalProfile("D:/worktree", profiles, "PowerShell", [])).toBe("PowerShell");
  });
  it("WSL UNC 경로는 정확히 같은 배포판을 지정한 프로필로 연다", () => {
    expect(
      worktreeTerminalProfile("\\\\wsl.localhost\\Debian\\home\\repo", profiles, "PowerShell", []),
    ).toBe("Debian");
  });
  it("기본 WSL 프로필의 배포판이 알려졌을 때만 기존 터미널을 근거로 사용한다", () => {
    expect(
      worktreeTerminalProfile("//wsl$/Ubuntu/home/repo", profiles, "PowerShell", [
        { cwd: "//wsl.localhost/Ubuntu/home/user", profile: "WSL" },
      ]),
    ).toBe("WSL");
    expect(
      worktreeTerminalProfile("//wsl$/Ubuntu/home/repo", profiles, "PowerShell", []),
    ).toBeUndefined();
  });
});
