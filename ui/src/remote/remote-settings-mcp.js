import schema from "./remote-settings-schema.json";

function validateValue(field, value, key) {
  const validType =
    field.type === "integer"
      ? Number.isInteger(value)
      : field.type === "number"
        ? typeof value === "number" && Number.isFinite(value)
        : field.type === "array"
          ? Array.isArray(value)
          : field.type === "object"
            ? value !== null && typeof value === "object" && !Array.isArray(value)
            : typeof value === field.type;
  if (
    !validType ||
    (field.enum && !field.enum.includes(value)) ||
    (field.minimum !== undefined && value < field.minimum) ||
    (field.maximum !== undefined && value > field.maximum) ||
    (field.minLength !== undefined && value.length < field.minLength) ||
    (field.maxLength !== undefined && value.length > field.maxLength) ||
    (field.pattern && !new RegExp(field.pattern).test(value)) ||
    (field.maxItems !== undefined && value.length > field.maxItems) ||
    (field.uniqueItems && new Set(value).size !== value.length)
  ) {
    throw new Error(`허용되지 않는 Remote 설정값: ${key}; ${JSON.stringify(field)}`);
  }
  if (field.type === "array")
    value.forEach((item, index) => validateValue(field.items, item, `${key}/${index}`));
  if (field.type === "object") {
    for (const required of field.required || []) {
      if (!Object.hasOwn(value, required)) throw new Error(`필수 Remote 설정: ${key}/${required}`);
    }
    for (const [child, item] of Object.entries(value)) {
      if (!Object.hasOwn(field.properties, child))
        throw new Error(`알 수 없는 Remote 설정: ${key}/${child}`);
      validateValue(field.properties[child], item, `${key}/${child}`);
    }
  }
}

export function validateRemoteSettings(current, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error("설정 patch는 JSON object여야 합니다.");
  }
  for (const [key, value] of Object.entries(patch)) {
    const field = Object.hasOwn(schema.properties, key) ? schema.properties[key] : null;
    if (!field) throw new Error(`알 수 없는 Remote 기기 설정: ${key}`);
    validateValue(field, value, key);
  }
  const candidate = { ...current, ...patch };
  const userKeys = candidate.inputBarUserKeys || [];
  const actions = new Set([...schema.actionCatalog, ...userKeys.map((key) => `soft:${key.id}`)]);
  if (
    new Set(userKeys.map((key) => key.id)).size !== userKeys.length ||
    userKeys.some((key) => key.label.trim() !== key.label)
  ) {
    throw new Error("사용자 키 ID는 고유해야 하며 라벨 양끝 공백은 허용하지 않습니다.");
  }
  const placed = new Set();
  for (const [row, segments] of Object.entries(candidate.inputBarZones || {})) {
    for (const ids of Object.values(segments))
      for (const id of ids) {
        if (!actions.has(id) || placed.has(id) || (id === "keys" && row !== "main"))
          throw new Error(`입력바 액션 배치 오류: ${id}`);
        placed.add(id);
      }
  }
  const buttons = candidate.floatingButtons || [];
  if (
    new Set(buttons.map((button) => button.id)).size !== buttons.length ||
    buttons.some(
      (button) =>
        !actions.has(button.actionId) || ["soft:dpad", "soft:navPad"].includes(button.actionId),
    )
  ) {
    throw new Error("플로팅 버튼 ID·액션이 올바르지 않습니다. 패드는 전용 설정을 사용하세요.");
  }
  if (
    candidate.composerIdleOpacity > candidate.composerFocusedOpacity ||
    candidate.composerFocusedOpacity > candidate.composerActiveOpacity
  ) {
    throw new Error("입력창 불투명도는 idle ≤ focused ≤ active여야 합니다.");
  }
  return candidate;
}

// The device owns values. Heartbeats only carry this explicit, non-secret projection.
export function createRemoteSettingsBridge(readSettings, applySettings, clientId) {
  let serial = 0;
  let previous = "";
  let result;
  function snapshot() {
    const all = readSettings();
    const settings = Object.fromEntries(
      Object.keys(schema.properties).map((key) => [key, all[key]]),
    );
    const encoded = JSON.stringify(settings);
    if (encoded !== previous) {
      previous = encoded;
      serial += 1;
    }
    return { clientId, revision: `${clientId}:${serial}`, settings, ...(result ? { result } : {}) };
  }
  function receive(command, leaseId, requestStartedAt) {
    if (!command || command.clientId !== clientId || command.leaseId !== leaseId) return false;
    if (result?.requestId === command.requestId) return true;
    try {
      if (globalThis.performance.now() - requestStartedAt >= command.validForMs) {
        throw new Error("설정 변경 요청이 만료됐습니다. 최신 값을 조회하세요.");
      }
      const current = snapshot();
      if (current.revision !== command.expectedRevision) {
        throw new Error("Remote 설정 revision 충돌입니다. 최신 값을 조회하세요.");
      }
      const candidate = validateRemoteSettings(current.settings, command.patch);
      applySettings(candidate, command.patch);
      result = { requestId: command.requestId, success: true };
    } catch (error) {
      result = { requestId: command.requestId, success: false, error: String(error) };
    }
    return true;
  }
  return { snapshot, receive };
}

export { schema as remoteSettingsSchema };
