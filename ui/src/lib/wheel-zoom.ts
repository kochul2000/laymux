/**
 * Ctrl+Wheel 줌 처리 유틸리티
 *
 * 터미널 컨테이너에 bubbling 단계로 wheel 리스너를 등록하면 xterm.js의
 * viewport가 이벤트를 먼저 소비하여 스크롤백이 존재할 때만 Ctrl+Wheel 줌이
 * 먹히고, 스크롤이 끝에 도달했을 때만 줌이 동작하는 버그(#211)가 발생한다.
 *
 * 해결: capture 단계에서 먼저 가로채고, Ctrl이 눌린 경우에만
 * `preventDefault`/`stopPropagation`으로 xterm에 이벤트가 전달되지 않게 한다.
 * Ctrl이 눌리지 않았으면 아무 일도 하지 않고 터미널 스크롤이 정상 동작한다.
 */

/** Ctrl+Wheel 줌 계산 결과 (테스트 가능한 순수 로직). */
export interface WheelZoomDecision {
  /** 이벤트를 가로챌지 여부. `true`이면 preventDefault + stopPropagation 필요. */
  intercept: boolean;
  /** 새로 적용할 폰트 크기. `null`이면 변경 없음 (범위 한계 도달 등). */
  newSize: number | null;
}

/** 폰트 크기 허용 범위 (px). */
export const WHEEL_ZOOM_MIN_SIZE = 6;
export const WHEEL_ZOOM_MAX_SIZE = 72;

/**
 * Ctrl+Wheel 이벤트를 처리할지 계산한다.
 *
 * @param event 수신한 wheel 이벤트 (의 일부 속성)
 * @param currentSize 현재 폰트 크기 (px)
 */
export function computeWheelZoom(
  event: Pick<WheelEvent, "ctrlKey" | "deltaY">,
  currentSize: number,
): WheelZoomDecision {
  if (!event.ctrlKey) {
    return { intercept: false, newSize: null };
  }

  // deltaY < 0: 위로 스크롤 → 확대, deltaY > 0: 아래로 스크롤 → 축소.
  // deltaY === 0: 의도가 불분명 → 가로채되 크기는 유지.
  const delta = event.deltaY < 0 ? 1 : event.deltaY > 0 ? -1 : 0;
  const clamped = Math.max(WHEEL_ZOOM_MIN_SIZE, Math.min(WHEEL_ZOOM_MAX_SIZE, currentSize + delta));
  const newSize = clamped === currentSize ? null : clamped;
  return { intercept: true, newSize };
}
