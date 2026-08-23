import { useTranslation } from "react-i18next";
import { useOsHandoff } from "@/hooks/useOsHandoff";

/**
 * "이 파일을 이 PC 에서 열기 / 위치 보기" 버튼 한 쌍
 * ([ADR-0193](../../../../docs/adr/0193-viewer-os-handoff-buttons.md)).
 *
 * 터미널 path-link 의 `Ctrl`(열기) / `Ctrl+Shift`(위치 보기) 클릭과 **같은 두
 * 동작**을 뷰어에서 버튼으로 노출한다. 수정자 클릭은 스스로를 알리지 못하므로
 * 뷰어에서는 눌 수 있는 것으로 만든다.
 *
 * 확인 게이트와 실패 표시는 `useOsHandoff` 가 소유하고, 이 컴포넌트는 배치만
 * 고른다 — `toolbar` 는 뷰어 헤더의 글리프 버튼, `cta` 는 미리보기가 없는
 * 콘텐츠 자리에서 행동을 유도하는 라벨 버튼이다.
 */
export interface OsHandoffActionsProps {
  /** 대상 파일의 절대 경로. 비어 있으면 아무것도 그리지 않는다. */
  path: string;
  variant: "toolbar" | "cta";
  /** 테스트·계측용 접두사. `${testIdPrefix}-open` / `-reveal` 로 쓰인다. */
  testIdPrefix: string;
}

export function OsHandoffActions({ path, variant, testIdPrefix }: OsHandoffActionsProps) {
  const { t } = useTranslation("common");
  const { request, failureFor } = useOsHandoff();
  const failure = failureFor(path);

  if (!path) return null;

  const isCta = variant === "cta";
  const buttonClass = isCta
    ? "hover-bg-strong rounded px-3 py-1.5 text-xs"
    : "hover-bg-strong flex h-6 items-center justify-center rounded px-2 text-xs";

  return (
    <div className={isCta ? "flex flex-col items-center gap-1" : "flex flex-col"}>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => request(path, "open")}
          className={buttonClass}
          style={{
            background: isCta ? "var(--accent-20)" : "transparent",
            color: isCta ? "var(--text-primary)" : "var(--text-secondary)",
            border: isCta ? "1px solid var(--border)" : "none",
            cursor: "pointer",
          }}
          title={t("osHandoff.openTitle")}
          aria-label={t("osHandoff.open")}
          data-testid={`${testIdPrefix}-open`}
        >
          {isCta ? t("osHandoff.open") : "↗"}
        </button>
        <button
          type="button"
          onClick={() => request(path, "reveal")}
          className={buttonClass}
          style={{
            background: "transparent",
            color: isCta ? "var(--text-primary)" : "var(--text-secondary)",
            border: isCta ? "1px solid var(--border)" : "none",
            cursor: "pointer",
          }}
          title={t("osHandoff.revealTitle")}
          aria-label={t("osHandoff.reveal")}
          data-testid={`${testIdPrefix}-reveal`}
        >
          {isCta ? t("osHandoff.reveal") : "🗀"}
        </button>
      </div>
      {failure && (
        <div
          className="break-words text-xs"
          style={{ color: "var(--red)", maxWidth: 320 }}
          data-testid={`${testIdPrefix}-error`}
        >
          {failure}
        </div>
      )}
    </div>
  );
}
