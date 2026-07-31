/**
 * path-link 선택을 **호스트 데스크톱 맥락**에서 여는 동작의 순수 로직
 * (issue #687, [ADR-0099](../../../docs/adr/0099-path-link-host-os-open-modifier-contract.md)).
 *
 * 책임은 두 가지뿐이다.
 *   1. 수정자 키 + 대상 종류(파일/디렉토리)를 클릭 액션으로 매핑한다.
 *   2. 그 액션이 사용자 확인을 받아야 하는지 판정한다.
 *
 * 실제 실행(Tauri 커맨드 호출)과 이벤트 소유권 처리는 `TerminalView` 가,
 * 호스트 경로 산출은 Rust 가 담당한다. 여기서는 fs·설정 스토어·DOM 에
 * 접근하지 않으므로 단위 테스트로 전부 덮인다.
 */

import { fileExtension } from "./file-viewer";

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
 * 호스트 OS 로 위임하는 액션인지. `TerminalView` 는 이 값이 참일 때만 클릭
 * 이벤트를 가로챈다(ADR-0099 Decision 2 의 소유권 불변식).
 */
export function isOsHandoffAction(action: PathLinkClickAction): boolean {
  return action === "osOpen" || action === "osReveal";
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
 * 사용자 설정과 무관하게 **항상** 확인을 받는 확장자(ADR-0099 Decision 3 의
 * 하드 클래스). 호스트에서 곧바로 실행·설치·시스템 변경으로 이어지는 것들이다.
 *
 * 기준은 "확장자가 실행 파일처럼 보이는가"가 아니라 **"연결 프로그램에 넘기면
 * 그 자체가 실행되는가"** 다. 그래서 다음이 함께 들어간다.
 *   - `.js`/`.jse`/`.vbs`/`.wsf` — Windows 는 편집기가 아니라 Windows Script
 *     Host 로 **실행**한다. node 프로젝트에서 소스를 열려던 클릭이 스크립트
 *     실행이 되는 대형 함정이다.
 *   - `.py`/`.pyw` — 연결 프로그램이 python.exe 면 즉시 실행된다.
 *   - `.sh`/`.desktop`/`.appimage`/`.run` — Linux 의 `xdg-open` 이 실행한다.
 *   - `.reg`/`.msi`/`.msu`/`.lnk`/`.url` — 실행은 아니어도 시스템 변경이나
 *     임의 대상 실행으로 이어진다.
 *
 * 설정 키로 노출하지 않는다. 목록을 비울 수 있게 만들면 "직접 실행 파일은
 * 경고한다"는 계약이 설정 하나로 사라진다.
 */
export const HARD_CONFIRM_EXTENSIONS: readonly string[] = [
  ".appimage",
  ".appref-ms",
  ".appx",
  ".bat",
  ".chm",
  ".cmd",
  ".com",
  ".cpl",
  ".desktop",
  ".exe",
  ".hlp",
  ".hta",
  ".inf",
  ".jar",
  ".js",
  ".jse",
  ".lnk",
  ".msc",
  ".msi",
  ".msp",
  ".msu",
  ".pif",
  ".ps1",
  ".psm1",
  ".py",
  ".pyw",
  ".reg",
  ".run",
  ".scf",
  ".scr",
  ".sct",
  ".sh",
  ".url",
  ".vb",
  ".vbe",
  ".vbs",
  ".ws",
  ".wsc",
  ".wsf",
  ".wsh",
];

const HARD_CONFIRM_SET = new Set(HARD_CONFIRM_EXTENSIONS);

/** 경로의 확장자가 하드 클래스(항상 확인)인지. */
export function requiresHardConfirm(path: string): boolean {
  return HARD_CONFIRM_SET.has(fileExtension(path));
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

/** `needsOsOpenConfirm` 입력. */
export interface OsOpenConfirmInput {
  action: PathLinkClickAction;
  path: string;
  isDirectory: boolean;
  /** 설정 `terminal.pathLinkOsOpenConfirm`. */
  confirmAlways: boolean;
}

/**
 * 실행 경로에서 확인 대화상자를 띄워야 하는지 판정한다.
 *
 * - `osOpen` 이면서 파일일 때만 대상이다. `osReveal` 과 디렉토리 `osOpen` 은
 *   파일 관리자를 띄울 뿐 대상을 실행하지 않으므로 확인하지 않는다.
 * - `confirmAlways` 가 켜져 있으면 확장자와 무관하게 확인한다(기본값).
 * - 꺼져 있으면 하드 클래스 확장자만 확인한다.
 */
export function needsOsOpenConfirm(input: OsOpenConfirmInput): boolean {
  if (input.action !== "osOpen") return false;
  if (input.isDirectory) return false;
  if (input.confirmAlways) return true;
  return requiresHardConfirm(input.path);
}
