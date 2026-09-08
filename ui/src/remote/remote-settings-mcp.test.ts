import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  createRemoteSettingsBridge,
  remoteSettingsSchema,
  validateRemoteSettings,
} from "./remote-settings-mcp.js";

const defaults = Object.fromEntries(
  Object.entries(remoteSettingsSchema.properties).map(([key, field]) => [key, field.default]),
);

describe("Remote 설정 MCP 기기 적용", () => {
  it("모든 노출 기본값은 검증되며 실제 액션 레지스트리와 목록이 일치한다", () => {
    expect(validateRemoteSettings({}, defaults)).toEqual(defaults);
    const source = readFileSync("../src-tauri/src/remote_server/assets/remote-app.js", "utf8");
    const ids = (name: string) =>
      Array.from(
        source.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`))![1].matchAll(/"([^"]+)"/g),
        (match) => match[1],
      );
    expect(remoteSettingsSchema.actionCatalog).toEqual([
      ...ids("FIXED_INPUT_ACTION_IDS"),
      ...ids("KEY_ORDER").map((id) => `soft:${id}`),
    ]);
    const display = source.match(
      /const DEFAULT_REMOTE_DISPLAY_SETTINGS = Object.freeze\(\{([\s\S]*?)\}\)/,
    )![1];
    for (const [, key, value] of display.matchAll(/(\w+):\s*(false|true|[\d.]+)/g)) {
      expect(remoteSettingsSchema.properties[key]?.default, key).toEqual(JSON.parse(value));
    }
  });
  it("Remote 저장 키를 빠짐없이 설정 또는 내부 상태로 분류한다", () => {
    const source = readFileSync("../src-tauri/src/remote_server/assets/remote-app.js", "utf8");
    const keys = Array.from(
      source.matchAll(/const \w+(?:Key|StorageKey) = "laymux\.remote\.([^"]+)"/g),
      (match) => match[1],
    );
    const settings = [
      "displaySettings",
      "keybar",
      "inputMode",
      "composerHistoryPopup",
      "composerAutocomplete",
      "composerHideAgentInput",
      "composerHiddenAgentInputLines",
      "composerHistoryScope",
      "widgetStrip",
      "edgeSwipeDrawers",
      "swipeCloseDrawers",
      "spatialExcludedPaneIds",
      "spatialExcludedWorkspaceIds",
    ];
    const internal = ["token", "resumeToken", "autoConnect", "settingsPanel"];
    expect(keys.sort()).toEqual([...settings, ...internal].sort());
    for (const field of Object.values(remoteSettingsSchema.properties)) {
      expect(field.description).not.toMatch(/\?{3,}/);
      expect(field.description.length).toBeGreaterThan(5);
    }
  });
  it.each([
    { inputBarZones: {} },
    {
      floatingButtons: [
        { id: "f-x", actionId: "menu", enabled: true, size: 999, opacity: 1, x: 0, y: 0 },
      ],
    },
    { inputBarUserKeys: [{ id: "u-x", label: " X ", seq: "x" }] },
    { spatialExcludedPaneIds: ["p", "p"] },
    { composerHiddenClaudeLines: 25 },
    { mainButtonScale: 115 },
    { keysButtonScale: 115 },
  ])("중첩 설정도 알 수 없는 값·범위·형식을 거부한다: %j", (patch) => {
    expect(() => validateRemoteSettings(defaults, patch)).toThrow();
  });
  it("사용자 키 참조·중복 배치·플로팅 액션을 함께 검증한다", () => {
    const zones = structuredClone(defaults.inputBarZones);
    zones.main.center = ["keys"];
    expect(() => validateRemoteSettings(defaults, { inputBarZones: zones })).toThrow();
    const candidate = validateRemoteSettings(defaults, {
      inputBarUserKeys: [{ id: "u-x", label: "X", seq: "\t", submit: true }],
      floatingButtons: [
        { id: "f-x", actionId: "soft:u-x", enabled: true, size: 64, opacity: 0.5, x: 0.5, y: 0.5 },
      ],
    });
    expect(candidate.inputBarZones).toEqual(defaults.inputBarZones);
    expect(() => validateRemoteSettings(candidate, { inputBarUserKeys: [] })).toThrow();
  });
  it("범위·타입·미지원 키·불투명도 순서를 거부하고 기존 값을 보존한다", () => {
    for (const patch of [
      { terminalFontSize: 99 },
      { terminalFontSize: "18" },
      { authToken: "secret" },
      { composerIdleOpacity: 100 },
    ]) {
      expect(() => validateRemoteSettings(defaults, patch)).toThrow();
    }
    expect(validateRemoteSettings(defaults, { terminalFontSize: 18 }).composerFontSize).toBe(16);
  });
  it("다른 기기·lease·만료·충돌은 적용하지 않고 성공은 한 번만 적용한다", () => {
    let settings = { ...defaults };
    const apply = vi.fn((candidate) => {
      settings = candidate;
    });
    const bridge = createRemoteSettingsBridge(() => settings, apply, "device-1");
    const initial = bridge.snapshot();
    const command = {
      requestId: "r1",
      clientId: initial.clientId,
      leaseId: "lease",
      expectedRevision: initial.revision,
      validForMs: 1000,
      patch: { terminalFontSize: 18 },
    };
    bridge.receive(command, "other", performance.now());
    expect(apply).not.toHaveBeenCalled();
    bridge.receive({ ...command, clientId: "other" }, "lease", performance.now());
    expect(apply).not.toHaveBeenCalled();
    bridge.receive(command, "lease", performance.now() - 2000);
    expect(bridge.snapshot().result.success).toBe(false);
    bridge.receive({ ...command, requestId: "r2" }, "lease", performance.now());
    bridge.receive({ ...command, requestId: "r2" }, "lease", performance.now());
    expect(apply).toHaveBeenCalledTimes(1);
    expect(bridge.snapshot().settings.terminalFontSize).toBe(18);
    bridge.receive({ ...command, requestId: "r3" }, "lease", performance.now());
    expect(bridge.snapshot().result.success).toBe(false);
    expect(apply).toHaveBeenCalledTimes(1);
  });
  it("저장 실패를 성공으로 보고하지 않는다", () => {
    const bridge = createRemoteSettingsBridge(
      () => defaults,
      () => {
        throw new Error("storage full");
      },
      "device-1",
    );
    const initial = bridge.snapshot();
    bridge.receive(
      {
        requestId: "r1",
        clientId: initial.clientId,
        leaseId: "lease",
        expectedRevision: initial.revision,
        validForMs: 1000,
        patch: { menuFontSize: 18 },
      },
      "lease",
      performance.now(),
    );
    expect(bridge.snapshot().result).toMatchObject({
      success: false,
      error: expect.stringContaining("storage full"),
    });
  });
});
