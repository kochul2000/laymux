import { describe, it, expect, beforeEach } from "vitest";
import { createPathLinkHint } from "./path-link-hint";

function makeHost() {
  const host = document.createElement("div");
  host.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 800, bottom: 400, width: 800, height: 400 }) as DOMRect;
  document.body.appendChild(host);
  return host;
}

/** jsdom 은 offsetWidth/Height 가 0 이므로 라벨 크기를 명시적으로 준다. */
function stubLabelSize(host: HTMLElement, width: number, height: number) {
  const el = host.querySelector<HTMLElement>(".terminal-path-link-hint")!;
  Object.defineProperty(el, "offsetWidth", { value: width, configurable: true });
  Object.defineProperty(el, "offsetHeight", { value: height, configurable: true });
  return el;
}

describe("createPathLinkHint", () => {
  let host: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = "";
    host = makeHost();
  });

  it("starts hidden and does not intercept clicks", () => {
    createPathLinkHint(host);
    const el = host.querySelector<HTMLElement>(".terminal-path-link-hint")!;
    expect(el).toBeTruthy();
    expect(el.hidden).toBe(true);
    expect(el.dataset.testid).toBe("path-link-hint");
  });

  it("shows the text above the underline", () => {
    const hint = createPathLinkHint(host);
    const el = stubLabelSize(host, 200, 20);
    hint.show({ left: 100, right: 300, top: 200, bottom: 216 }, "Ctrl: open");

    expect(el.hidden).toBe(false);
    expect(el.textContent).toBe("Ctrl: open");
    expect(el.style.left).toBe("100px");
    // 200(top) - 20(height) - 6(gap)
    expect(el.style.top).toBe("174px");
  });

  it("flips below the underline when there is no room above", () => {
    const hint = createPathLinkHint(host);
    const el = stubLabelSize(host, 200, 20);
    hint.show({ left: 40, right: 240, top: 10, bottom: 26 }, "Ctrl: open");
    // 26(bottom) + 6(gap)
    expect(el.style.top).toBe("32px");
  });

  it("clamps to the host so a right-edge underline stays visible", () => {
    const hint = createPathLinkHint(host);
    const el = stubLabelSize(host, 300, 20);
    hint.show({ left: 760, right: 790, top: 200, bottom: 216 }, "Ctrl: open");
    // 800(host width) - 300(label) - 4(margin)
    expect(el.style.left).toBe("496px");
  });

  it("hides on an empty text and on hide()", () => {
    const hint = createPathLinkHint(host);
    const el = stubLabelSize(host, 100, 20);
    hint.show({ left: 10, right: 60, top: 100, bottom: 116 }, "x");
    expect(el.hidden).toBe(false);

    hint.show({ left: 10, right: 60, top: 100, bottom: 116 }, "");
    expect(el.hidden).toBe(true);

    hint.show({ left: 10, right: 60, top: 100, bottom: 116 }, "x");
    hint.hide();
    expect(el.hidden).toBe(true);
  });

  it("dispose removes the element", () => {
    const hint = createPathLinkHint(host);
    hint.dispose();
    expect(host.querySelector(".terminal-path-link-hint")).toBeNull();
  });
});
