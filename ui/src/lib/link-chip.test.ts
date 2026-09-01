import { describe, it, expect, beforeEach, vi } from "vitest";
import { createLinkChip } from "./link-chip";

function makeHost() {
  const host = document.createElement("div");
  host.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 800, bottom: 400, width: 800, height: 400 }) as DOMRect;
  document.body.appendChild(host);
  return host;
}

/** jsdom 은 offsetWidth/Height 가 0 이므로 칩 크기를 명시적으로 준다. */
function stubChipSize(host: HTMLElement, width: number, height: number) {
  const el = host.querySelector<HTMLElement>(".terminal-link-chip")!;
  Object.defineProperty(el, "offsetWidth", { value: width, configurable: true });
  Object.defineProperty(el, "offsetHeight", { value: height, configurable: true });
  return el;
}

const ITEMS = [
  { action: "viewer" as const, label: "뷰어 열기" },
  { action: "copy" as const, label: "경로 복사" },
];

describe("createLinkChip", () => {
  let host: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = "";
    host = makeHost();
  });

  it("starts hidden", () => {
    const chip = createLinkChip(host);
    const el = host.querySelector<HTMLElement>(".terminal-link-chip")!;
    expect(el.hidden).toBe(true);
    expect(chip.isOpen()).toBe(false);
  });

  it("renders one button per action and reports the selected one", () => {
    const chip = createLinkChip(host);
    const onSelect = vi.fn();
    chip.onSelect(onSelect);
    stubChipSize(host, 160, 24);
    chip.show({ left: 100, right: 200, top: 100, bottom: 116 }, ITEMS);

    const buttons = host.querySelectorAll<HTMLButtonElement>("[data-link-chip-action]");
    expect([...buttons].map((b) => b.textContent)).toEqual(["뷰어 열기", "경로 복사"]);
    expect(chip.isOpen()).toBe(true);

    buttons[1].click();
    expect(onSelect).toHaveBeenCalledWith("copy");
  });

  it("replaces the buttons when reopened for another target", () => {
    const chip = createLinkChip(host);
    stubChipSize(host, 160, 24);
    chip.show({ left: 0, right: 10, top: 0, bottom: 10 }, ITEMS);
    chip.show({ left: 0, right: 10, top: 0, bottom: 10 }, [
      { action: "browser", label: "브라우저 열기" },
    ]);
    const buttons = host.querySelectorAll("[data-link-chip-action]");
    expect(buttons).toHaveLength(1);
    expect(buttons[0].textContent).toBe("브라우저 열기");
  });

  it("sits below the link and flips above when there is no room", () => {
    const chip = createLinkChip(host);
    const el = stubChipSize(host, 160, 24);

    chip.show({ left: 100, right: 200, top: 100, bottom: 116 }, ITEMS);
    expect(el.style.top).toBe("122px");

    // host 높이 400 — 아래로 나가면 위로 뒤집는다.
    chip.show({ left: 100, right: 200, top: 380, bottom: 396 }, ITEMS);
    expect(el.style.top).toBe("350px");
  });

  it("clamps inside the host horizontally", () => {
    const chip = createLinkChip(host);
    const el = stubChipSize(host, 160, 24);
    chip.show({ left: 790, right: 800, top: 10, bottom: 26 }, ITEMS);
    expect(el.style.left).toBe("636px");

    chip.show({ left: -50, right: 10, top: 10, bottom: 26 }, ITEMS);
    expect(el.style.left).toBe("4px");
  });

  it("knows which nodes are its own (outside-click judgment)", () => {
    const chip = createLinkChip(host);
    stubChipSize(host, 160, 24);
    chip.show({ left: 0, right: 10, top: 0, bottom: 10 }, ITEMS);
    const button = host.querySelector("[data-link-chip-action]")!;
    expect(chip.contains(button)).toBe(true);
    expect(chip.contains(host)).toBe(false);
    expect(chip.contains(null)).toBe(false);
  });

  it("hides and disposes", () => {
    const chip = createLinkChip(host);
    stubChipSize(host, 160, 24);
    chip.show({ left: 0, right: 10, top: 0, bottom: 10 }, ITEMS);
    chip.hide();
    expect(chip.isOpen()).toBe(false);
    chip.dispose();
    expect(host.querySelector(".terminal-link-chip")).toBeNull();
  });

  it("is a no-op without a host", () => {
    const chip = createLinkChip(null);
    expect(() => {
      chip.show({ left: 0, right: 0, top: 0, bottom: 0 }, ITEMS);
      chip.hide();
      chip.dispose();
    }).not.toThrow();
    expect(chip.isOpen()).toBe(false);
    expect(chip.contains(document.body)).toBe(false);
  });
});
