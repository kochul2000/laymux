import { beforeEach, describe, expect, it } from "vitest";
import {
  initializeRemoteLanguage,
  remoteLanguage,
  setRemoteLanguage,
  setRemoteText,
  setRemoteAttribute,
  t,
  tr,
  translateRemoteShell,
  remoteError,
} from "./remote-i18n.js";
import { setRemoteIcon } from "./remote-icons.js";
import { MemoDocument } from "../lib/memo-document";
import { formatWorktreeBlockerLabel } from "../lib/worktree-presentation";

describe("Remote 기기 언어", () => {
  it("워크트리 사용 미확인의 제거 보류 문구도 선택 언어로 표시한다", () => {
    initializeRemoteLanguage({ locale: "en" });
    expect(String(formatWorktreeBlockerLabel("usage_unknown", t))).toBe(
      "Usage unknown · Removal blocked",
    );
    setRemoteLanguage("ko");
    expect(String(formatWorktreeBlockerLabel("usage_unknown", t))).toBe(
      "사용 상태 미확인 · 제거 보류",
    );
  });
  it("메모의 제품 오류도 문서 상태를 잃지 않고 새 언어로 표시한다", async () => {
    initializeRemoteLanguage({ locale: "en" });
    const memo = new MemoDocument(
      async () => {
        throw remoteError(t("Connect to read PC memos."));
      },
      async () => {},
    );
    await memo.refresh();
    const status = document.createElement("p");
    document.body.append(status);
    setRemoteText(status, memo.getSnapshot().error);
    setRemoteLanguage("ko");
    expect(status.textContent).toBe("PC 메모를 읽으려면 연결하세요.");
    expect(memo.getSnapshot().loaded).toBe(false);
  });
  it("아이콘으로 바꾼 제품 버튼은 언어 전환 뒤에도 아이콘을 유지한다", () => {
    document.body.innerHTML = "<button></button>";
    const button = document.querySelector("button")!;
    setRemoteText(button, t("Clear pane"));
    setRemoteIcon(button, "BrushCleaning");
    setRemoteLanguage("ko");
    expect(button.querySelector("svg")).not.toBeNull();
    expect(button.textContent).toBe("");
  });
  beforeEach(() => {
    localStorage.clear();
    document.body.replaceChildren();
  });
  it("브라우저 언어를 기본으로 해석하고 기기 선택을 복원한다", () => {
    initializeRemoteLanguage({ locale: "ko-KR" });
    expect(remoteLanguage()).toBe("ko");
    expect(document.documentElement.lang).toBe("ko");
    expect(String(t("Settings"))).toBe("설정");
    expect(setRemoteLanguage("en")).toBe(true);
    initializeRemoteLanguage({ locale: "ko-KR" });
    expect(remoteLanguage()).toBe("en");
    localStorage.setItem("laymux.remote.language", '"invalid"');
    initializeRemoteLanguage({ locale: "fr-FR" });
    expect(remoteLanguage()).toBe("en");
  });
  it("저장소를 읽고 쓸 수 없어도 현재 언어로 동작한다", () => {
    const storage = {
      getItem: () => {
        throw Error("blocked");
      },
      setItem: () => {
        throw Error("blocked");
      },
    };
    initializeRemoteLanguage({ locale: "ko", storage });
    expect(String(t("Settings"))).toBe("설정");
    expect(setRemoteLanguage("en")).toBe(false);
  });
  it("보간한 사용자 문자열을 그대로 둔다", () => {
    initializeRemoteLanguage({ locale: "ko" });
    expect(String(tr`Copied ${"Settings <script>"}`)).toBe("Settings <script> 복사됨");
  });
  it("열린 DOM의 제품 토큰만 재적용하고 같은 내용의 사용자 값과 초안을 보존한다", () => {
    initializeRemoteLanguage({ locale: "en" });
    document.body.innerHTML = "<button></button><div></div><textarea>Open settings</textarea>";
    const button = document.querySelector("button")!;
    const user = document.querySelector("div")!;
    setRemoteText(button, tr`Manage ${"Connection"}`);
    setRemoteAttribute(button, "title", t("Open settings"));
    setRemoteText(user, "Open settings");
    const draft = document.querySelector("textarea")!;
    draft.focus();
    draft.setSelectionRange(2, 4);
    setRemoteLanguage("ko");
    expect(button.textContent).toBe("Connection 관리");
    expect(button.title).toBe("설정 열기");
    expect(user.textContent).toBe("Open settings");
    expect(draft.value).toBe("Open settings");
    expect(draft.selectionStart).toBe(2);
    expect(document.activeElement).toBe(draft);
    setRemoteText(button, "Connection");
    setRemoteLanguage("en");
    expect(button.textContent).toBe("Connection");
    expect(button.title).toBe("Open settings");
  });
  it("명시된 제품 문구와 접근성 속성만 번역한다", () => {
    document.body.innerHTML =
      '<button data-remote-i18n="Settings" data-remote-i18n-title="Open settings" title="Open settings">Settings</button><div id="terminal">Settings</div><textarea>Settings</textarea><span data-user-name>Settings</span>';
    initializeRemoteLanguage({ locale: "ko" });
    translateRemoteShell(document);
    expect(document.querySelector("button")?.textContent).toBe("설정");
    expect(document.querySelector("button")?.title).toBe("설정 열기");
    expect(document.querySelector("#terminal")?.textContent).toBe("Settings");
    expect(document.querySelector("textarea")?.value).toBe("Settings");
    expect(document.querySelector("[data-user-name]")?.textContent).toBe("Settings");
  });
});
