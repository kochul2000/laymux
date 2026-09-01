/**
 * 링크 실행 게이트의 순수 매핑 ([ADR-0224](../../../docs/adr/0224-link-activation-chip-gate.md)).
 *
 * 책임은 하나다 — **(activation 모드 × 대상 종류 × surface × 수정자) → 실행 결과**.
 * "결과"는 셋 중 하나다.
 *
 *   - `open-direct` — 즉시 실행할 액션 하나(현행 `immediate` 동작, 또는 수정자 바이패스)
 *   - `show-chip`   — 실행하지 않고 액션 칩을 띄운다(액션 목록 포함)
 *   - `none`        — 아무것도 하지 않는다(표현할 액션이 없는 방어 경로)
 *
 * 발견(파싱·밑줄)은 이 모듈의 범위가 아니다 — 어떤 모드에서도 게이트하지
 * 않는다(ADR-0224 Decision 1). 실행·라우팅·DOM·설정 스토어 접근이 전혀 없으므로
 * 모드×대상×수정자 조합 전부를 단위 테스트로 덮는다.
 */

import type { PathLinkClickModifiers } from "./path-link-os-open";
import { decidePathLinkClickAction } from "./path-link-os-open";

/** `terminal.urlLinkActivation` / `terminal.pathLinkActivation` 의 값. */
export type LinkActivationMode = "immediate" | "chip";

/** 설정 스키마와 UI 가 공유하는 값 목록. */
export const LINK_ACTIVATION_MODES: readonly LinkActivationMode[] = ["immediate", "chip"];

/** 기본값 — 기존 사용자 동작 무변(ADR-0224 Decision 2). */
export const DEFAULT_LINK_ACTIVATION: LinkActivationMode = "immediate";

/** 신뢰할 수 없는 입력(설정 파일·원격 patch)을 모드로 정규화한다. */
export function normalizeLinkActivation(value: unknown): LinkActivationMode {
  return value === "chip" ? "chip" : DEFAULT_LINK_ACTIVATION;
}

/** 실행 대상의 종류. `url` 은 `urlLinkActivation`, 나머지는 `pathLinkActivation` 이 게이트한다. */
export type LinkTargetKind = "url" | "file" | "directory";

/** 링크가 사는 표면. 권한 경계가 다르다(ADR-0045). */
export type LinkSurface = "desktop" | "remote";

/**
 * 실행 액션. 칩 버튼 하나가 액션 하나다.
 *
 * - `viewer` — 통합 뷰어로 파일 열기(desktop·Remote)
 * - `changeDir` — 디렉터리를 새 cwd 로 전파(**desktop 전용**)
 * - `explorer` — Remote File Explorer 오버레이 열기(**Remote 전용**, ADR-0198)
 * - `osOpen` / `osReveal` — 호스트 OS 위임(**desktop 전용**, ADR-0100)
 * - `browser` — OS 브라우저로 URL 열기
 * - `copy` — 대상 문자열(경로 또는 URL) 클립보드 복사
 */
export type LinkAction =
  | "viewer"
  | "changeDir"
  | "explorer"
  | "osOpen"
  | "osReveal"
  | "browser"
  | "copy";

/**
 * 칩 버튼이 될 수 있는 액션. `osReveal`(Ctrl+Shift 의 "파일 관리자에서 선택
 * 표시")은 **수정자 바이패스 전용**이라 칩에 오르지 않는다 — 칩 대상의 액션
 * 목록은 대상 종류가 정하고, 디렉터리의 "파일 관리자에서 열기"는 `osOpen` 이
 * 디렉터리에 적용된 결과다(ADR-0100 Decision 2). 타입으로 못박아 두면 라벨
 * 매핑에 죽은 문구가 생기지 않는다.
 */
export type LinkChipAction = Exclude<LinkAction, "osReveal">;

export interface LinkActivationInput {
  /** 대상에 해당하는 activation 설정값. */
  mode: LinkActivationMode;
  surface: LinkSurface;
  target: LinkTargetKind;
  /**
   * 실행 제스처의 수정자. 터치(Remote)에는 수정자가 없으므로 생략한다.
   * desktop path 는 ADR-0100 의 Ctrl 계열, desktop URL 은 #352 Shift/Alt 를 본다.
   */
  modifiers?: PathLinkClickModifiers;
  /** `terminal.pathLinkOsOpenEnabled`(desktop 전용). 꺼져 있으면 OS 액션이 없다. */
  osOpenEnabled?: boolean;
}

export type LinkActivationResult =
  /** 즉시 실행. `bypass` 는 "모드와 무관한 수정자 직행"인지. */
  | { kind: "open-direct"; action: LinkAction; bypass: boolean }
  /** 실행하지 않고 칩을 띄운다. 최소 하나의 액션을 담는다. */
  | { kind: "show-chip"; actions: readonly LinkChipAction[] }
  /** 표현할 액션이 없다. */
  | { kind: "none" };

/**
 * `immediate` 모드의 액션 — 현행 동작 그대로.
 * 파일=뷰어, 디렉터리=desktop 은 cwd 전파·Remote 는 탐색기, URL=브라우저.
 */
function immediateAction(target: LinkTargetKind, surface: LinkSurface): LinkChipAction {
  if (target === "url") return "browser";
  if (target === "file") return "viewer";
  return surface === "desktop" ? "changeDir" : "explorer";
}

/**
 * `chip` 모드의 액션 목록(ADR-0224 Decision 3 표).
 *
 * 칩은 **기존 액션의 표시 방식일 뿐 새 실행 표면을 만들지 않는다** — Remote 칩에
 * OS 열기·cwd 전파가 없는 이유이고(ADR-0045), desktop 에서 `pathLinkOsOpenEnabled`
 * 가 꺼져 있으면 OS 액션이 목록에서 빠지는 이유다(그 기능 자체가 꺼진 상태다).
 */
function chipActions(
  target: LinkTargetKind,
  surface: LinkSurface,
  osOpenEnabled: boolean,
): LinkChipAction[] {
  if (target === "url") return ["browser", "copy"];
  const actions: LinkChipAction[] = [immediateAction(target, surface)];
  if (surface === "desktop" && osOpenEnabled) actions.push("osOpen");
  actions.push("copy");
  return actions;
}

/**
 * 실행 제스처 하나의 결과를 정한다.
 *
 * 판정 순서가 계약이다(ADR-0224 Decision 4 — 제스처 소유권 재배치 없음).
 *
 *   1. **수정자 바이패스가 모드보다 앞선다.** desktop path 밑줄의 Ctrl /
 *      Ctrl+Shift 는 ADR-0100 대로 칩 없이 직행하고, desktop URL 의 #352
 *      Shift/Alt 우회도 즉발이다. 수정자 자체가 명시적 제스처이므로 `chip`
 *      모드가 이를 다시 게이트하지 않는다.
 *   2. `immediate` → 현행 동작 하나를 즉시 실행.
 *   3. `chip` → 실행하지 않고 액션 목록을 칩으로.
 */
export function decideLinkActivation(input: LinkActivationInput): LinkActivationResult {
  const { mode, surface, target } = input;
  const osOpenEnabled = input.osOpenEnabled ?? false;
  const mods = input.modifiers;

  // 1) 수정자 바이패스 — 모드 무관.
  if (surface === "desktop" && mods) {
    if (target === "url") {
      // #352 TUI 우회: Ctrl 없는 Shift/Alt 좌클릭. Ctrl 조합은 path-link 소유.
      if (!mods.ctrlKey && (mods.shiftKey || mods.altKey)) {
        return { kind: "open-direct", action: "browser", bypass: true };
      }
    } else {
      // ADR-0100: 정확히 Ctrl / Ctrl+Shift 두 조합만 OS 위임을 소유한다.
      const action = decidePathLinkClickAction(mods, target === "directory", osOpenEnabled);
      if (action === "osOpen" || action === "osReveal") {
        return { kind: "open-direct", action, bypass: true };
      }
    }
  }

  // 2) immediate — 현행 동작과 동일.
  if (mode !== "chip") {
    return { kind: "open-direct", action: immediateAction(target, surface), bypass: false };
  }

  // 3) chip — 실행하지 않고 액션 목록을 띄운다.
  const actions = chipActions(target, surface, osOpenEnabled);
  if (actions.length === 0) return { kind: "none" };
  return { kind: "show-chip", actions };
}

/**
 * 칩 버튼 라벨의 i18n 키. 액션 하나가 대상 종류에 따라 다른 문구를 쓰는 경우가
 * 있어(디렉터리의 `osOpen` = 폴더를 파일 관리자로 열기, `copy` = 경로/URL) 매핑을
 * 여기 한 곳에 둔다. 네임스페이스는 `common`.
 *
 * `osReveal`(선택 표시)은 칩에 오르지 않으므로(`LinkChipAction`) 여기에도 없다 —
 * 소비자 없는 문구가 로케일에 남지 않게 타입이 강제한다.
 */
export function linkChipLabelKey(action: LinkChipAction, target: LinkTargetKind): string {
  switch (action) {
    case "viewer":
      return "terminal.linkChipViewer";
    case "changeDir":
      return "terminal.linkChipChangeDir";
    case "explorer":
      return "terminal.linkChipExplorer";
    case "osOpen":
      // 디렉터리를 OS 로 여는 것은 곧 파일 관리자로 그 폴더를 여는 것이다.
      return target === "directory" ? "terminal.linkChipOsOpenDir" : "terminal.linkChipOsOpen";
    case "browser":
      return "terminal.linkChipBrowser";
    case "copy":
      return target === "url" ? "terminal.linkChipCopyUrl" : "terminal.linkChipCopyPath";
  }
}
