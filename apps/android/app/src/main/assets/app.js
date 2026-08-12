"use strict";

(() => {
  const stateBadge = document.getElementById("stateBadge");
  const stateTitle = document.getElementById("stateTitle");
  const stateDescription = document.getElementById("stateDescription");
  const pairingDetails = document.getElementById("pairingDetails");
  const deviceLabel = document.getElementById("deviceLabel");
  const instanceId = document.getElementById("instanceId");
  const endpoint = document.getElementById("endpoint");
  const biometricToggle = document.getElementById("biometricToggle");
  const biometricHint = document.getElementById("biometricHint");
  const errorMessage = document.getElementById("errorMessage");
  const noticeMessage = document.getElementById("noticeMessage");
  const scanButton = document.getElementById("scanButton");
  const confirmButton = document.getElementById("confirmButton");
  const verifyButton = document.getElementById("verifyButton");
  const forgetButton = document.getElementById("forgetButton");
  const remoteSection = document.getElementById("remoteSection");
  const remoteBadge = document.getElementById("remoteBadge");
  const remoteTitle = document.getElementById("remoteTitle");
  const remoteDescription = document.getElementById("remoteDescription");
  const connectButton = document.getElementById("connectButton");
  const disconnectButton = document.getElementById("disconnectButton");
  const terminalShell = document.getElementById("terminalShell");
  const terminalElement = document.getElementById("terminal");

  const nativeBridge = window.LaymuxNative;
  const TerminalCtor = window.Terminal;
  const FitAddonCtor = window.FitAddon && window.FitAddon.FitAddon;
  let terminal = null;
  let fitAddon = null;
  let resizeTimer = null;

  function ensureTerminal() {
    if (terminal || !TerminalCtor || !FitAddonCtor) return terminal;
    terminal = new TerminalCtor({
      cursorBlink: true,
      convertEol: false,
      fontFamily: '"Cascadia Mono", "D2Coding", monospace',
      fontSize: 13,
      scrollback: 5000,
      theme: {
        background: "#11111b",
        foreground: "#cdd6f4",
        cursor: "#f5e0dc",
        selectionBackground: "#585b70aa",
      },
    });
    fitAddon = new FitAddonCtor();
    terminal.loadAddon(fitAddon);
    terminal.open(terminalElement);
    terminal.onData((data) => nativeBridge.sendRemoteInput(data));
    terminal.onResize(({ cols, rows }) => {
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        nativeBridge.resizeRemoteTerminal(cols, rows);
      }, 80);
    });
    return terminal;
  }

  function fitTerminal() {
    if (!fitAddon) return;
    window.requestAnimationFrame(() => fitAddon.fit());
  }

  function decodeBase64Url(value) {
    const padding = "=".repeat((4 - (value.length % 4)) % 4);
    const binary = window.atob(value.replace(/-/g, "+").replace(/_/g, "/") + padding);
    const output = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      output[index] = binary.charCodeAt(index);
    }
    return output;
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

    stateBadge.textContent = confirmed
      ? "페어링 확인됨"
      : confirmationPending
        ? "데스크톱 확인 대기"
        : "페어링 필요";
    stateBadge.classList.toggle("paired", confirmed);
    stateTitle.textContent = confirmed
      ? "데스크톱과 키를 서로 확인했습니다"
      : confirmationPending
        ? "키는 저장됐고 데스크톱 확인이 남았습니다"
      : "데스크톱 QR을 스캔하세요";
    if (confirmed && biometricRequired) {
      stateDescription.textContent =
        "암호키는 Android Keystore와 강한 생체 인증으로 보호되며 웹 화면에는 노출되지 않습니다.";
    } else if (confirmed) {
      stateDescription.textContent =
        "암호키는 Android Keystore로 보호됩니다. 생체 인증은 명시적으로 꺼져 있습니다.";
    } else if (confirmationPending) {
      stateDescription.textContent =
        "Relay 연결이 가능해지면 생체 인증 후 같은 키로 데스크톱 확인을 다시 시도할 수 있습니다.";
    } else {
      stateDescription.textContent =
        "Laymux 데스크톱이 표시하는 페어링 QR을 스캔합니다.";
    }

    pairingDetails.hidden = !paired;
    forgetButton.hidden = !paired;
    confirmButton.hidden = !confirmationPending;
    verifyButton.hidden = !paired || !biometricRequired;
    scanButton.textContent = paired ? "다른 기기 페어링" : "QR로 페어링";
    if (paired) {
      deviceLabel.textContent = status.label || status.instanceId;
      instanceId.textContent = status.instanceId;
      endpoint.textContent = status.endpoint;
    }

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
    verifyButton.disabled = biometricRequired && !biometricAvailable;
    confirmButton.disabled = biometricRequired && !biometricAvailable;

    remoteSection.hidden = !confirmed;
    connectButton.hidden = remoteConnected;
    connectButton.disabled = remoteConnecting || (biometricRequired && !biometricAvailable);
    connectButton.textContent = remoteConnecting ? "보안 세션 여는 중…" : "보안 세션 열기";
    disconnectButton.hidden = !remoteConnected;
    terminalShell.hidden = !remoteConnected;
    remoteBadge.textContent = remoteConnected ? "E2E 연결됨" : "E2E 잠김";
    remoteBadge.classList.toggle("connected", remoteConnected);
    remoteTitle.textContent = remoteConnected
      ? status.remoteTerminalTitle || "암호화 터미널"
      : "암호화 터미널";
    remoteDescription.textContent = remoteConnected
      ? "백그라운드에서는 통신을 멈추고 키를 최대 15분간 보존합니다. 돌아오면 자동으로 다시 연결합니다."
      : "생체 인증 후 세션을 엽니다. 사용 중에는 유지되고 15분 비활성 시 잠깁니다.";
    if (remoteConnected) {
      ensureTerminal();
      fitTerminal();
    } else if (terminal) {
      terminal.reset();
      terminal.clear();
    }
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

  verifyButton.addEventListener("click", () => {
    verifyButton.disabled = true;
    errorMessage.hidden = true;
    noticeMessage.hidden = true;
    nativeBridge.verifyPairingProtection();
  });

  confirmButton.addEventListener("click", () => {
    confirmButton.disabled = true;
    errorMessage.hidden = true;
    noticeMessage.hidden = true;
    nativeBridge.retryPairingConfirmation();
  });

  forgetButton.addEventListener("click", () => {
    nativeBridge.forgetPairing();
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

  window.addEventListener("resize", fitTerminal);

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
    onRemoteOutput(data, reset, cols, rows, bracketedPaste) {
      const current = ensureTerminal();
      if (!current) return;
      terminalShell.hidden = false;
      if (reset) current.reset();
      if (Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0) {
        current.resize(cols, rows);
      }
      current.write(decodeBase64Url(data), () => {
        if (reset && typeof bracketedPaste === "boolean") {
          current.write(bracketedPaste ? "\x1b[?2004h" : "\x1b[?2004l");
        }
        fitTerminal();
      });
    },
  });

  readInitialStatus();
})();
