"use strict";

(() => {
  const dismissLayer = document.getElementById("dismissLayer");
  const connectionSheet = document.getElementById("connectionSheet");
  const stateBadge = document.getElementById("stateBadge");
  const stateTitle = document.getElementById("stateTitle");
  const stateDescription = document.getElementById("stateDescription");
  const pairingCount = document.getElementById("pairingCount");
  const pairingList = document.getElementById("pairingList");
  const pairingListEmpty = document.getElementById("pairingListEmpty");
  const biometricToggle = document.getElementById("biometricToggle");
  const biometricHint = document.getElementById("biometricHint");
  const errorMessage = document.getElementById("errorMessage");
  const noticeMessage = document.getElementById("noticeMessage");
  const scanButton = document.getElementById("scanButton");
  const cloudButton = document.getElementById("cloudButton");
  const remoteSection = document.getElementById("remoteSection");
  const remoteBadge = document.getElementById("remoteBadge");
  const remoteTitle = document.getElementById("remoteTitle");
  const remoteDescription = document.getElementById("remoteDescription");
  const connectButton = document.getElementById("connectButton");
  const disconnectButton = document.getElementById("disconnectButton");
  const nativeBridge = window.LaymuxNative;
  const exitAnimationMilliseconds = 200;
  let dismissing = false;

  function actionButton(label, action, instanceId, deviceName) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "compact";
    button.textContent = label;
    button.dataset.action = action;
    button.dataset.instanceId = instanceId;
    button.setAttribute("aria-label", `${deviceName}: ${label}`);
    return button;
  }

  function renderPairings(status, biometricRequired, biometricAvailable) {
    const pairings = Array.isArray(status.pairings) ? status.pairings : [];
    pairingCount.textContent = String(pairings.length);
    pairingListEmpty.hidden = pairings.length !== 0;
    pairingList.replaceChildren();
    pairings.forEach((pairing) => {
      const row = document.createElement("article");
      row.className = "pairing-row";
      row.classList.toggle(
        "selected",
        pairing.instanceId === status.selectedInstanceId,
      );

      const heading = document.createElement("div");
      heading.className = "pairing-row-heading";
      const label = document.createElement("strong");
      label.textContent = pairing.label || pairing.instanceId;
      const state = document.createElement("span");
      state.className = "pairing-state";
      const pending = pairing.confirmedAt == null;
      state.classList.toggle("pending", pending);
      state.textContent = pending ? "확인 대기" : "확인됨";
      heading.append(label, state);

      const id = document.createElement("code");
      id.textContent = pairing.instanceId;
      const endpoint = document.createElement("small");
      endpoint.textContent = pairing.endpoint;
      const actions = document.createElement("div");
      actions.className = "pairing-actions";
      if (pending) {
        const confirm = actionButton(
          "확인 재시도",
          "confirm",
          pairing.instanceId,
          pairing.label || pairing.instanceId,
        );
        confirm.disabled = biometricRequired && !biometricAvailable;
        actions.append(confirm);
      }
      if (biometricRequired) {
        const verify = actionButton(
          "키 보호 확인",
          "verify",
          pairing.instanceId,
          pairing.label || pairing.instanceId,
        );
        verify.disabled = !biometricAvailable;
        actions.append(verify);
      }
      actions.append(
        actionButton(
          "삭제",
          "forget",
          pairing.instanceId,
          pairing.label || pairing.instanceId,
        ),
      );
      row.append(heading, id, endpoint, actions);
      pairingList.append(row);
    });
  }

  function render(statusValue) {
    const status = statusValue || {};
    const paired = status.paired === true;
    const confirmed = status.confirmed === true;
    const confirmationPending = status.confirmationPending === true;
    const biometricRequired = status.biometricRequired !== false;
    const biometricAvailable = status.biometricAvailable === true;
    const remoteConnected = status.remoteConnected === true;
    const remoteConnecting = status.remoteConnecting === true;
    const pairingTotal = Array.isArray(status.pairings)
      ? status.pairings.length
      : 0;

    stateBadge.textContent = confirmed
      ? "페어링 확인됨"
      : confirmationPending
        ? "데스크톱 확인 대기"
        : pairingTotal > 0
          ? `저장된 PC ${pairingTotal}대`
          : "페어링 필요";
    stateBadge.classList.toggle("paired", confirmed);
    stateTitle.textContent = confirmed
      ? "데스크톱과 키를 서로 확인했습니다"
      : confirmationPending
        ? "키는 저장됐고 데스크톱 확인이 남았습니다"
        : status.selectedInstanceId
          ? "선택한 데스크톱 QR을 스캔하세요"
          : "Cloud에서 연결할 PC를 선택하세요";
    if (confirmed && biometricRequired) {
      stateDescription.textContent =
        "암호키는 Android Keystore와 강한 생체 인증으로 보호되며 웹 화면에는 노출되지 않습니다.";
    } else if (confirmed) {
      stateDescription.textContent =
        "암호키는 Android Keystore로 보호됩니다. 생체 인증은 명시적으로 꺼져 있습니다.";
    } else if (confirmationPending) {
      stateDescription.textContent =
        "Relay 연결이 가능해지면 생체 인증 후 같은 키로 데스크톱 확인을 다시 시도할 수 있습니다.";
    } else if (status.selectedInstanceId) {
      stateDescription.textContent =
        "Laymux 데스크톱이 표시하는 페어링 QR을 스캔합니다.";
    } else if (pairingTotal > 0) {
      stateDescription.textContent =
        "저장된 PC의 키 보호 상태를 확인하거나 개별 페어링을 삭제할 수 있습니다.";
    } else {
      stateDescription.textContent =
        "내 PC 목록으로 돌아가 연결할 PC를 선택하세요.";
    }

    scanButton.hidden = !status.selectedInstanceId;
    scanButton.textContent = paired
      ? "선택한 PC 다시 페어링"
      : "선택한 PC QR 스캔";
    renderPairings(status, biometricRequired, biometricAvailable);

    biometricToggle.checked = biometricRequired;
    biometricToggle.disabled = false;
    if (biometricRequired && !biometricAvailable) {
      biometricHint.textContent =
        status.biometricStatusMessage || "강한 생체 인증을 사용할 수 없습니다.";
      biometricHint.classList.add("unavailable");
    } else if (biometricRequired) {
      biometricHint.textContent =
        "기본값 · PIN이나 패턴으로 자동 대체하지 않습니다.";
      biometricHint.classList.remove("unavailable");
    } else {
      biometricHint.textContent = "꺼짐 · 앱 전용 Keystore 키만 사용합니다.";
      biometricHint.classList.remove("unavailable");
    }

    errorMessage.hidden = !status.error;
    errorMessage.textContent = status.error || "";
    noticeMessage.hidden = !status.notice;
    noticeMessage.textContent = status.notice || "";
    scanButton.disabled = biometricRequired && !biometricAvailable;

    remoteSection.hidden = !confirmed;
    connectButton.hidden = remoteConnected;
    connectButton.disabled =
      remoteConnecting || (biometricRequired && !biometricAvailable);
    connectButton.textContent = remoteConnecting
      ? "보안 세션 여는 중…"
      : "보안 세션 열기";
    disconnectButton.hidden = !remoteConnected;
    remoteBadge.textContent = remoteConnected ? "E2E 연결됨" : "E2E 잠김";
    remoteBadge.classList.toggle("connected", remoteConnected);
    remoteTitle.textContent = remoteConnected
      ? "Laymux Remote"
      : "암호화 원격 연결";
    remoteDescription.textContent = remoteConnected
      ? "백그라운드에서는 통신을 멈추고 키를 최대 15분간 보존합니다. 돌아오면 자동으로 다시 연결합니다."
      : "생체 인증 후 세션을 엽니다. 사용 중에는 유지되고 15분 비활성 시 잠깁니다.";
  }

  function readInitialStatus() {
    if (!nativeBridge || typeof nativeBridge.getPairingStatus !== "function") {
      render({
        paired: false,
        biometricRequired: true,
        biometricAvailable: false,
        error: "네이티브 보안 기능을 불러오지 못했습니다.",
      });
      scanButton.disabled = true;
      biometricToggle.disabled = true;
      return;
    }
    try {
      render(JSON.parse(nativeBridge.getPairingStatus()));
    } catch (_error) {
      render({
        paired: false,
        biometricRequired: true,
        biometricAvailable: false,
        error: "페어링 상태 응답이 올바르지 않습니다.",
      });
    }
  }

  scanButton.addEventListener("click", () => {
    scanButton.disabled = true;
    errorMessage.hidden = true;
    noticeMessage.hidden = true;
    nativeBridge.scanPairingQr();
  });

  biometricToggle.addEventListener("change", () => {
    const required = biometricToggle.checked;
    biometricToggle.disabled = true;
    errorMessage.hidden = true;
    noticeMessage.hidden = true;
    nativeBridge.setBiometricRequired(required);
  });

  pairingList.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button || !pairingList.contains(button)) return;
    const instanceId = button.dataset.instanceId;
    if (!instanceId) return;
    button.disabled = true;
    errorMessage.hidden = true;
    noticeMessage.hidden = true;
    if (button.dataset.action === "confirm") {
      nativeBridge.retryPairingConfirmation(instanceId);
    } else if (button.dataset.action === "verify") {
      nativeBridge.verifyPairingProtection(instanceId);
    } else if (button.dataset.action === "forget") {
      nativeBridge.forgetPairing(instanceId);
    }
  });

  connectButton.addEventListener("click", () => {
    connectButton.disabled = true;
    errorMessage.hidden = true;
    noticeMessage.hidden = true;
    nativeBridge.connectRemote();
  });

  disconnectButton.addEventListener("click", () => {
    nativeBridge.disconnectRemote();
  });

  function dismissConnectionEntry() {
    if (dismissing) return;
    dismissing = true;
    dismissLayer.disabled = true;
    connectionSheet.classList.add("is-closing");
    connectionSheet.setAttribute("aria-hidden", "true");
    window.setTimeout(() => {
      nativeBridge.showCloudDashboard();
    }, exitAnimationMilliseconds);
  }

  dismissLayer.addEventListener("click", dismissConnectionEntry);
  cloudButton.addEventListener("click", dismissConnectionEntry);

  window.laymuxNative = Object.freeze({
    onPairingChanged(statusJson) {
      try {
        render(JSON.parse(statusJson));
      } catch (_error) {
        render({
          paired: false,
          biometricRequired: true,
          biometricAvailable: false,
          error: "페어링 상태 응답이 올바르지 않습니다.",
        });
      }
    },
  });

  readInitialStatus();
})();
