import { useCallback, useState } from "react";
import i18n from "@/i18n";
import { openInOs } from "@/lib/tauri-api";
import { needsOsHandoffConfirm, osHandoffConfirmKey, type OsHandoffMode } from "@/lib/os-handoff";
import { useSettingsStore } from "@/stores/settings-store";

/**
 * "이 경로를 호스트 OS 에 넘겨라" 요청 하나의 배선
 * ([ADR-0191](../../../docs/adr/0191-viewer-os-handoff-buttons.md)).
 *
 * 정책(확인 여부·문구 선택)은 `lib/os-handoff.ts` 의 순수 함수가, 실행은 Rust
 * `open_in_os` 가 소유한다. 훅은 그 둘 사이의 세 가지 부수효과만 갖는다 —
 * 설정 읽기, 네이티브 확인 대화상자, 실패 표시.
 *
 * 실패는 조용히 삼키지 않는다. `open_in_os` 는 spawn 실패만 reject 하므로(그
 * 이후는 OS 소관) 여기 도달하는 오류는 "프로그램을 띄우지도 못했다"는 뜻이고,
 * 사용자는 버튼을 눌렀는데 아무 일도 없는 것처럼 본다. 터미널 path-link 는
 * 알림 스토어를 쓰지만 그것은 pane 단위 표시라 pane 이 아닌 뷰어 오버레이에서는
 * 보이지 않는다. 그래서 호출한 표면이 직접 그릴 수 있게 실패를 상태로 돌려준다.
 */
export interface OsHandoffFailure {
  /** 실패한 요청의 대상 경로. */
  path: string;
  /** 사용자에게 보여줄 완성된 메시지(i18n 적용). */
  message: string;
}

export interface OsHandoffApi {
  /**
   * 확인 게이트를 통과하면 호스트 OS 로 넘긴다. 사용자가 확인을 취소하면
   * 아무 일도 일어나지 않는다.
   *
   * `isDirectory` 는 확인 정책에만 쓰인다(디렉토리 열기는 파일 관리자를 띄울
   * 뿐이라 확인하지 않는다). 뷰어는 파일만 표시하므로 기본값이 `false` 다.
   */
  request: (path: string, mode: OsHandoffMode, options?: { isDirectory?: boolean }) => void;
  /**
   * 그 경로에 대한 마지막 실패 메시지(없으면 null). 경로로 스코프하므로 다른
   * 파일로 이동하면 남은 오류가 따라붙지 않는다 — effect 로 상태를 지우지 않기
   * 위한 형태다(`react-hooks/set-state-in-effect`).
   */
  failureFor: (path: string) => string | null;
}

export function useOsHandoff(): OsHandoffApi {
  // ADR-0191: 확인 정책은 트리거와 무관한 위험 정책이므로 터미널 path-link 와
  // 같은 키를 읽는다. 반면 `pathLinkOsOpenEnabled` 는 읽지 않는다 — 그 키는
  // xterm 과 나눠 갖는 수정자 클릭의 소유권 스위치이고, 버튼에는 그 충돌이
  // 없다.
  const confirmAlways = useSettingsStore((s) => s.terminal.pathLinkOsOpenConfirm);
  const [failure, setFailure] = useState<OsHandoffFailure | null>(null);

  const request = useCallback(
    (path: string, mode: OsHandoffMode, options?: { isDirectory?: boolean }) => {
      if (!path) return;
      const isDirectory = options?.isDirectory ?? false;
      if (needsOsHandoffConfirm({ mode, path, isDirectory, confirmAlways })) {
        const proceed = window.confirm(i18n.t(osHandoffConfirmKey(path), { ns: "common", path }));
        if (!proceed) return;
      }
      setFailure(null);
      openInOs(path, mode).catch((err) => {
        console.warn(`[osHandoff] OS ${mode} 실패:`, err);
        setFailure({
          path,
          message: i18n.t("osHandoff.failed", { ns: "common", message: String(err) }),
        });
      });
    },
    [confirmAlways],
  );

  const failureFor = useCallback(
    (path: string) => (failure && failure.path === path ? failure.message : null),
    [failure],
  );

  return { request, failureFor };
}
