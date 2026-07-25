import { Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";

describe("probe3: does xterm rewrite helper style during composition?", () => {
  it("observes style writes on the helper textarea", async () => {
    if (!window.matchMedia) {
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        value: () => ({
          matches: false,
          media: "",
          addEventListener: () => {},
          removeEventListener: () => {},
          addListener: () => {},
          removeListener: () => {},
          onchange: null,
          dispatchEvent: () => false,
        }),
      });
    }
    const host = document.createElement("div");
    Object.defineProperty(host, "clientWidth", { value: 800, configurable: true });
    Object.defineProperty(host, "clientHeight", { value: 400, configurable: true });
    document.body.appendChild(host);
    const terminal = new Terminal({ allowProposedApi: true, cols: 80, rows: 25 });
    terminal.open(host);
    const helper = host.querySelector(".xterm-helper-textarea") as HTMLTextAreaElement;

    const writes: string[] = [];
    const obs = new MutationObserver((records) => {
      for (const r of records)
        if (r.attributeName === "style") writes.push(`${helper.style.left}|${helper.style.top}`);
    });
    obs.observe(helper, { attributes: true, attributeFilter: ["style"] });

    helper.focus();
    helper.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
    helper.value = "가";
    helper.selectionStart = 1;
    helper.selectionEnd = 1;
    helper.dispatchEvent(new CompositionEvent("compositionupdate", { data: "가" }));
    // Our anchor write, as TerminalView would do it.
    helper.style.left = "123px";
    helper.style.top = "456px";
    await new Promise((r) => setTimeout(r, 20));
    console.log("PROBE3 style writes seen:", JSON.stringify(writes));
    console.log("PROBE3 final left|top:", helper.style.left + "|" + helper.style.top);
    obs.disconnect();
    terminal.dispose();
    expect(true).toBe(true);
  });
});
