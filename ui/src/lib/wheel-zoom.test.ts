import { describe, it, expect } from "vitest";
import { computeWheelZoom, WHEEL_ZOOM_MIN_SIZE, WHEEL_ZOOM_MAX_SIZE } from "./wheel-zoom";

describe("computeWheelZoom", () => {
  it("Ctrl 키가 눌리지 않았으면 가로채지 않는다 (스크롤 허용)", () => {
    const result = computeWheelZoom({ ctrlKey: false, deltaY: -100 }, 14);
    expect(result.intercept).toBe(false);
    expect(result.newSize).toBeNull();
  });

  it("Ctrl 키가 눌리지 않았으면 아래로 스크롤해도 가로채지 않는다", () => {
    const result = computeWheelZoom({ ctrlKey: false, deltaY: 100 }, 14);
    expect(result.intercept).toBe(false);
    expect(result.newSize).toBeNull();
  });

  it("Ctrl+위로 스크롤: 폰트 크기 증가, intercept=true", () => {
    const result = computeWheelZoom({ ctrlKey: true, deltaY: -100 }, 14);
    expect(result.intercept).toBe(true);
    expect(result.newSize).toBe(15);
  });

  it("Ctrl+아래로 스크롤: 폰트 크기 감소, intercept=true", () => {
    const result = computeWheelZoom({ ctrlKey: true, deltaY: 100 }, 14);
    expect(result.intercept).toBe(true);
    expect(result.newSize).toBe(13);
  });

  it("최대 크기에서 Ctrl+위로 스크롤: intercept=true, newSize=null (변경 없음)", () => {
    const result = computeWheelZoom({ ctrlKey: true, deltaY: -100 }, WHEEL_ZOOM_MAX_SIZE);
    expect(result.intercept).toBe(true);
    expect(result.newSize).toBeNull();
  });

  it("최소 크기에서 Ctrl+아래로 스크롤: intercept=true, newSize=null (변경 없음)", () => {
    const result = computeWheelZoom({ ctrlKey: true, deltaY: 100 }, WHEEL_ZOOM_MIN_SIZE);
    expect(result.intercept).toBe(true);
    expect(result.newSize).toBeNull();
  });

  it("최대 크기 근처에서 Ctrl+위: 최대 값으로 clamp", () => {
    const result = computeWheelZoom({ ctrlKey: true, deltaY: -100 }, WHEEL_ZOOM_MAX_SIZE - 1);
    expect(result.intercept).toBe(true);
    expect(result.newSize).toBe(WHEEL_ZOOM_MAX_SIZE);
  });

  it("최소 크기 근처에서 Ctrl+아래: 최소 값으로 clamp", () => {
    const result = computeWheelZoom({ ctrlKey: true, deltaY: 100 }, WHEEL_ZOOM_MIN_SIZE + 1);
    expect(result.intercept).toBe(true);
    expect(result.newSize).toBe(WHEEL_ZOOM_MIN_SIZE);
  });

  it("Ctrl + deltaY=0: 가로채되 크기는 유지 (null)", () => {
    const result = computeWheelZoom({ ctrlKey: true, deltaY: 0 }, 14);
    expect(result.intercept).toBe(true);
    expect(result.newSize).toBeNull();
  });
});

/**
 * DOM 통합 테스트: capture 단계 리스너가 bubbling 단계보다 먼저 실행되는지
 * 검증한다. xterm.js의 viewport가 wheel을 소비하기 전에 Ctrl+Wheel을
 * 가로채기 위해서는 반드시 capture 단계 등록이 필요하다.
 */
describe("wheel capture phase integration", () => {
  it("capture 단계 리스너가 bubbling 리스너보다 먼저 실행된다", () => {
    const outer = document.createElement("div");
    const inner = document.createElement("div");
    outer.appendChild(inner);
    document.body.appendChild(outer);

    const order: string[] = [];

    // xterm viewport를 모방: bubbling 단계에서 이벤트를 소비한다.
    inner.addEventListener("wheel", (e) => {
      order.push("inner-bubbling");
      e.stopPropagation();
    });

    // 우리 핸들러: capture 단계로 등록하면 inner 리스너보다 먼저 실행되어야 한다.
    outer.addEventListener(
      "wheel",
      (e) => {
        order.push("outer-capture");
        if ((e as WheelEvent).ctrlKey) {
          e.preventDefault();
          e.stopPropagation();
        }
      },
      { capture: true, passive: false },
    );

    const event = new WheelEvent("wheel", {
      ctrlKey: true,
      deltaY: -100,
      bubbles: true,
      cancelable: true,
    });
    inner.dispatchEvent(event);

    // capture가 먼저 실행되고, Ctrl이 눌린 경우 stopPropagation으로 inner는 호출되지 않는다.
    expect(order).toEqual(["outer-capture"]);

    document.body.removeChild(outer);
  });

  it("Ctrl이 없으면 capture에서 가로채지 않아 bubbling으로 전달된다", () => {
    const outer = document.createElement("div");
    const inner = document.createElement("div");
    outer.appendChild(inner);
    document.body.appendChild(outer);

    const order: string[] = [];

    inner.addEventListener("wheel", () => {
      order.push("inner-bubbling");
    });

    outer.addEventListener(
      "wheel",
      (e) => {
        order.push("outer-capture");
        if ((e as WheelEvent).ctrlKey) {
          e.preventDefault();
          e.stopPropagation();
        }
      },
      { capture: true, passive: false },
    );

    const event = new WheelEvent("wheel", {
      ctrlKey: false,
      deltaY: -100,
      bubbles: true,
      cancelable: true,
    });
    inner.dispatchEvent(event);

    expect(order).toEqual(["outer-capture", "inner-bubbling"]);

    document.body.removeChild(outer);
  });
});
