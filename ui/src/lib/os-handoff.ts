/**
 * 대상을 **호스트 데스크톱(OS)** 에 넘기는 동작의 표면 독립 정책
 * ([ADR-0100](../../../docs/adr/0100-path-link-host-os-open-modifier-contract.md),
 * [ADR-0193](../../../docs/adr/0193-viewer-os-handoff-buttons.md)).
 *
 * 트리거는 여러 개다 — 터미널 path-link 의 Ctrl/Ctrl+Shift 클릭과 FileViewer 의
 * 명시적 버튼. 그러나 "실행으로 이어지는 경로는 확인을 받는다"는 위험 정책은
 * 하나여야 하므로, 트리거와 무관한 부분만 여기에 둔다. 어떤 입력이 어떤 액션인지
 * (수정자 소유권)는 트리거 쪽 모듈이 소유한다 — `path-link-os-open.ts`.
 *
 * 여기서는 fs·설정 스토어·DOM 에 접근하지 않으므로 단위 테스트로 전부 덮인다.
 * 실행(Tauri `open_in_os` 호출)은 `useOsHandoff` 훅이, 호스트 경로 산출은 Rust 가
 * 담당한다.
 */

import { fileExtension } from "./file-viewer";

/** 호스트 OS 위임 모드(백엔드 `open_in_os` 의 `mode` 인자와 같은 값). */
export type OsHandoffMode = "open" | "reveal";

/**
 * 사용자 설정과 무관하게 **항상** 확인을 받는 확장자(ADR-0100 Decision 3 의
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

/** `needsOsHandoffConfirm` 입력. */
export interface OsHandoffConfirmInput {
  mode: OsHandoffMode;
  path: string;
  isDirectory: boolean;
  /** 설정 `terminal.pathLinkOsOpenConfirm`. 트리거와 무관한 위험 정책이다. */
  confirmAlways: boolean;
}

/**
 * 실행 경로에서 확인 대화상자를 띄워야 하는지 판정한다.
 *
 * - `open` 이면서 파일일 때만 대상이다. `reveal` 과 디렉토리 `open` 은
 *   파일 관리자를 띄울 뿐 대상을 실행하지 않으므로 확인하지 않는다.
 * - `confirmAlways` 가 켜져 있으면 확장자와 무관하게 확인한다(기본값).
 * - 꺼져 있으면 하드 클래스 확장자만 확인한다.
 */
export function needsOsHandoffConfirm(input: OsHandoffConfirmInput): boolean {
  if (input.mode !== "open") return false;
  if (input.isDirectory) return false;
  if (input.confirmAlways) return true;
  return requiresHardConfirm(input.path);
}

/**
 * 확인 대화상자 문구의 i18n 키. 하드 클래스는 "이 확장자는 열면 실행된다"는
 * 경고 문구를, 나머지는 일반 문구를 쓴다. 키 선택이 트리거마다 갈리면 같은
 * 파일이 터미널에서는 경고, 뷰어에서는 일반 문구가 되므로 여기서 한 번만 정한다.
 */
export function osHandoffConfirmKey(path: string): string {
  return requiresHardConfirm(path) ? "osHandoff.confirmExecutable" : "osHandoff.confirm";
}
