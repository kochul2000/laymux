/**
 * path-link 선택을 **호스트 데스크톱 맥락**에서 여는 동작의 순수 로직
 * (issue #687, [ADR-0100](../../../docs/adr/0100-path-link-host-os-open-modifier-contract.md)).
 *
 * 책임은 하나다 — **수정자 키 + 대상 종류를 클릭 액션으로 매핑**한다. 즉 이
 * 모듈은 path-link 라는 *트리거* 의 입력 계약만 소유한다. 확인 게이트처럼
 * 트리거와 무관한 위험 정책은 `os-handoff.ts` 가 소유한다(ADR-0193 — FileViewer
 * 버튼도 같은 정책을 쓴다).
 *
 * 실제 실행(Tauri 커맨드 호출)과 이벤트 소유권 처리는 `TerminalView` 가,
 * 호스트 경로 산출은 Rust 가 담당한다. 여기서는 fs·설정 스토어·DOM 에
 * 접근하지 않으므로 단위 테스트로 전부 덮인다.
 */

import type { OsHandoffMode } from "./os-handoff";

/** 검증된 path-link 밑줄을 클릭했을 때 수행할 동작. */
export type PathLinkClickAction =
  /** 파일을 통합 뷰어로 연다(기존 동작). */
  | "viewer"
  /** 디렉토리를 새 cwd 로 전파한다(기존 동작). */
  | "changeDir"
  /** 호스트 OS 에 열기를 위임한다(파일=연결 프로그램, 디렉토리=파일 관리자). */
  | "osOpen"
  /** 호스트 파일 관리자에서 대상을 선택 표시한다. */
  | "osReveal";

/** 클릭 이벤트에서 읽는 수정자 상태(테스트 편의를 위해 MouseEvent 대신 최소 형태). */
export interface PathLinkClickModifiers {
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey?: boolean;
}

/**
 * 액션이 호스트 OS 로 위임하는 것이면 그 위임 모드, 아니면 null. 모드는 백엔드
 * `open_in_os` 의 인자이자 확인 정책(`needsOsHandoffConfirm`)의 입력이라,
 * 액션→모드 변환을 호출부마다 다시 쓰지 않게 여기서 한 번만 정한다.
 */
export function osHandoffModeForAction(action: PathLinkClickAction): OsHandoffMode | null {
  if (action === "osOpen") return "open";
  if (action === "osReveal") return "reveal";
  return null;
}

/**
 * 호스트 OS 로 위임하는 액션인지. `TerminalView` 는 이 값이 참일 때만 클릭
 * 이벤트를 가로챈다(ADR-0100 Decision 2 의 소유권 불변식).
 */
export function isOsHandoffAction(action: PathLinkClickAction): boolean {
  return osHandoffModeForAction(action) !== null;
}

/**
 * 수정자 조합과 대상 종류로 클릭 액션을 정한다.
 *
 * - 수정자 없음 → 기존 동작(파일=뷰어, 디렉토리=cwd 전파).
 * - `Ctrl` → `osOpen`.
 * - `Ctrl+Shift` → `osReveal`.
 * - `Alt` 나 `Meta`(Windows 키)가 끼면 path-link 가 소유하지 않는다(#352 TUI
 *   우회와 xterm·OS 가 쓴다) → 기존 동작으로 떨어진다. 정확히 `Ctrl` 과
 *   `Ctrl+Shift` 두 조합만 소유한다.
 * - `osOpenEnabled` 가 꺼져 있으면 Ctrl 조합도 기존 동작이다.
 */
export function decidePathLinkClickAction(
  mods: PathLinkClickModifiers,
  isDirectory: boolean,
  osOpenEnabled: boolean,
): PathLinkClickAction {
  const plain: PathLinkClickAction = isDirectory ? "changeDir" : "viewer";
  if (!osOpenEnabled) return plain;
  if (!mods.ctrlKey || mods.altKey || mods.metaKey) return plain;
  return mods.shiftKey ? "osReveal" : "osOpen";
}

/**
 * 밑줄 hover 힌트에 쓸 i18n 키. 수정자 클릭은 발견성이 없으므로 밑줄 위에서
 * "Ctrl / Ctrl+Shift 로 무엇을 할 수 있는지" 를 알린다. 기능이 꺼져 있으면
 * 알릴 것이 없으므로 null(라벨 표시 안 함).
 */
export function pathLinkHintKey(isDirectory: boolean, osOpenEnabled: boolean): string | null {
  if (!osOpenEnabled) return null;
  return isDirectory ? "terminal.pathLinkHintDir" : "terminal.pathLinkHintFile";
}
