import { describe, expect, it } from "vitest";
import {
  DEFAULT_REMOTE_KEYBOARD_SETTINGS,
  remoteKeyboardVisibility,
  resolveRemoteNavigationKey,
  readPhysicalKeyboardConnected,
} from "./remote-keyboard.js";

const defaults = DEFAULT_REMOTE_KEYBOARD_SETTINGS;
const key = (overrides: Partial<KeyboardEvent> = {}) => ({
  key: "ArrowUp",
  altKey: true,
  ctrlKey: false,
  shiftKey: false,
  metaKey: false,
  isComposing: false,
  getModifierState: () => false,
  ...overrides,
});

describe("Remote 물리 키보드 표시", () => {
  it.each([false, null, undefined])("미연결·미지원(%s)은 자동 숨김을 하지 않는다", (connected) => {
    expect(remoteKeyboardVisibility(connected, defaults)).toEqual({ floating: true, keys: true });
  });
  it("연결 시 두 숨김 설정을 독립적으로 적용한다", () => {
    expect(remoteKeyboardVisibility(true, defaults)).toEqual({ floating: false, keys: false });
    expect(
      remoteKeyboardVisibility(true, { ...defaults, hideFloatingWithKeyboard: false }),
    ).toEqual({ floating: true, keys: false });
    expect(remoteKeyboardVisibility(true, { ...defaults, hideKeysWithKeyboard: false })).toEqual({
      floating: false,
      keys: true,
    });
  });
  it("지원 기능의 boolean만 신뢰하고 구형 bridge·실패는 미지원으로 둔다", () => {
    expect(readPhysicalKeyboardConnected({ isPhysicalKeyboardConnected: () => true })).toBe(true);
    expect(readPhysicalKeyboardConnected({ isPhysicalKeyboardConnected: () => false })).toBe(false);
    expect(
      readPhysicalKeyboardConnected({ isPhysicalKeyboardConnected: () => "false" }),
    ).toBeNull();
    expect(
      readPhysicalKeyboardConnected({
        isPhysicalKeyboardConnected: () => {
          throw Error();
        },
      }),
    ).toBeNull();
    expect(readPhysicalKeyboardConnected({})).toBeNull();
    expect(readPhysicalKeyboardConnected(null)).toBeNull();
  });
});

describe("Remote Nav 키바인딩", () => {
  it.each([
    ["ArrowUp", "spatial", "prev"],
    ["ArrowDown", "spatial", "next"],
    ["ArrowLeft", "notification", "recent"],
    ["ArrowRight", "notification", "oldest"],
  ])("%s는 기존 Nav 패드 액션을 사용한다", (name, kind, direction) => {
    expect(resolveRemoteNavigationKey(key({ key: name }), defaults)).toEqual({ kind, direction });
  });
  it.each([
    ["alt", { altKey: true }],
    ["ctrlAlt", { altKey: true, ctrlKey: true }],
    ["altShift", { altKey: true, shiftKey: true }],
    ["ctrlShift", { altKey: false, ctrlKey: true, shiftKey: true }],
  ])("보조키 %s를 다시 할당할 수 있다", (modifiers, fields) => {
    expect(
      resolveRemoteNavigationKey(key(fields), {
        ...defaults,
        remoteNavigationModifiers: modifiers,
      }),
    ).toEqual({ kind: "spatial", direction: "prev" });
  });
  it("활성 시 선택하지 않은 PC용 Alt/Ctrl+Alt 조합은 소비만 한다", () => {
    expect(resolveRemoteNavigationKey(key({ ctrlKey: true }), defaults)).toEqual({ blocked: true });
    expect(
      resolveRemoteNavigationKey(key(), { ...defaults, remoteNavigationModifiers: "ctrlAlt" }),
    ).toEqual({ blocked: true });
  });
  it.each([
    { isComposing: true },
    { metaKey: true },
    { shiftKey: true },
    { key: "x" },
    { altKey: false },
    { getModifierState: () => true },
  ])("다른 입력·조합은 가로채지 않는다: %j", (fields) => {
    expect(resolveRemoteNavigationKey(key(fields), defaults)).toBeNull();
  });
  it("끄면 기존 조합도 기존 경로로 전달한다", () => {
    const settings = { ...defaults, useRemoteNavigationKeys: false };
    expect(resolveRemoteNavigationKey(key(), settings)).toBeNull();
    expect(resolveRemoteNavigationKey(key({ ctrlKey: true }), settings)).toBeNull();
  });
});
