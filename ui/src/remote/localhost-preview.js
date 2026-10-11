/* global document, window, atob, navigator, URL, AbortController */
const MAX_BYTES = 64 * 1024 * 1024;

export function localhostPreviewUrl(value) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "http:" ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      !url.port ||
      Number(url.port) < 1024 ||
      [19280, 19281].includes(Number(url.port)) ||
      url.username ||
      url.password
    )
      return null;
    return url;
  } catch {
    return null;
  }
}

export async function readPreviewResource(api, session, value, signal) {
  const base = new URL(session.url);
  const url = new URL(value, base);
  if (url.origin !== base.origin || url.username || url.password)
    throw new Error("다른 서버의 자원은 열 수 없습니다.");
  const parts = [];
  let offset = 0;
  let total = null;
  let contentType;
  let status;
  do {
    const chunk = await api("/remote/v1/localhost-preview/resource", {
      method: "POST",
      fileViewerToken: session.fileViewerToken,
      signal,
      body: JSON.stringify({
        sessionId: session.sessionId,
        leaseId: session.leaseId,
        pathAndQuery: url.pathname + url.search,
        offset,
      }),
    });
    const raw = atob(chunk.body);
    const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
    if (
      !Number.isSafeInteger(chunk.totalBytes) ||
      chunk.totalBytes < 0 ||
      chunk.totalBytes > MAX_BYTES ||
      chunk.offset !== offset ||
      chunk.nextOffset !== offset + bytes.length ||
      chunk.nextOffset > chunk.totalBytes ||
      (total !== null && total !== chunk.totalBytes) ||
      (bytes.length === 0 && offset !== chunk.totalBytes)
    )
      throw new Error("프리뷰 자원 전송이 중단되었습니다.");
    total = chunk.totalBytes;
    offset = chunk.nextOffset;
    parts.push(bytes);
    contentType = chunk.contentType;
    status = chunk.status;
  } while (offset < total);
  const bytes = new Uint8Array(total);
  let position = 0;
  for (const part of parts) {
    bytes.set(part, position);
    position += part.length;
  }
  return { bytes, contentType, status };
}

/** The trusted controller owns credentials; the sandbox only requests read-only resources. */
export function createLocalhostPreview({ api, getLease, getToken, isAndroid }) {
  const ko = (navigator.language || "en").toLowerCase().startsWith("ko");
  const overlay = document.createElement("div");
  overlay.className = "localhost-preview-overlay";
  overlay.hidden = true;
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-label", ko ? "PC 웹 프리뷰" : "PC web preview");
  const bar = document.createElement("div");
  bar.className = "localhost-preview-bar";
  const title = document.createElement("span");
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.textContent = ko ? "닫기" : "Close";
  const status = document.createElement("div");
  status.className = "localhost-preview-status";
  bar.append(title, closeButton);
  overlay.append(bar, status);
  document.body.append(overlay);
  let revision = 0;
  let session = null;
  let frame = null;
  let abort = null;
  let pending = 0;

  function close() {
    revision += 1;
    abort?.abort();
    abort = null;
    frame?.remove();
    frame = null;
    overlay.hidden = true;
    const old = session;
    session = null;
    if (old && old.leaseId === getLease()) {
      api("/remote/v1/localhost-preview/close", {
        method: "POST",
        fileViewerToken: old.fileViewerToken,
        body: JSON.stringify({ sessionId: old.sessionId, leaseId: old.leaseId }),
      }).catch(() => {});
    }
  }
  closeButton.addEventListener("click", close);

  async function open(url) {
    close();
    const leaseId = getLease();
    const fileViewerToken = getToken();
    if (!leaseId || !fileViewerToken) return;
    const current = revision;
    abort = new AbortController();
    title.textContent = url.href;
    status.textContent = ko ? "PC 웹 앱에 연결 중…" : "Connecting to the PC web app…";
    status.hidden = false;
    overlay.hidden = false;
    try {
      if (isAndroid() && typeof window.LaymuxNative?.openLocalhostPreview !== "function") {
        throw new Error(
          ko
            ? "웹 프리뷰를 사용하려면 Android 앱을 업데이트해 주세요."
            : "Update the Android app to use web preview.",
        );
      }
      const result = await api("/remote/v1/localhost-preview/begin", {
        method: "POST",
        fileViewerToken,
        signal: abort.signal,
        body: JSON.stringify({ url: url.href, leaseId }),
      });
      if (revision !== current || getLease() !== leaseId || getToken() !== fileViewerToken) return;
      session = { ...result, leaseId, fileViewerToken };
      if (isAndroid()) {
        window.LaymuxNative.openLocalhostPreview(
          session.sessionId,
          session.url,
          leaseId,
          fileViewerToken,
        );
        overlay.hidden = true;
        return;
      }
      frame = document.createElement("iframe");
      frame.title = ko ? "PC 웹 앱" : "PC web app";
      frame.setAttribute("sandbox", "allow-scripts allow-pointer-lock");
      frame.setAttribute("allow", "autoplay; fullscreen; gamepad");
      frame.src = "/remote/localhost-preview/";
      frame.addEventListener("load", () => {
        if (revision === current && frame && session)
          frame.contentWindow.postMessage({ type: "laymux.preview.init", url: session.url }, "*");
      });
      overlay.append(frame);
    } catch (error) {
      if (revision === current) status.textContent = String(error.message || error);
    }
  }

  window.addEventListener("message", async (event) => {
    if (!frame || event.source !== frame.contentWindow || !session || overlay.hidden) return;
    const data = event.data;
    if (data?.type === "laymux.preview.ready") {
      status.hidden = true;
      return;
    }
    if (data?.type === "laymux.preview.error") {
      status.hidden = false;
      status.textContent = String(data.error).slice(0, 1000);
      return;
    }
    if (
      data?.type !== "laymux.preview.read" ||
      !Number.isSafeInteger(data.id) ||
      typeof data.url !== "string" ||
      pending >= 8
    )
      return;
    const target = frame.contentWindow;
    const current = revision;
    const active = session;
    pending += 1;
    try {
      if (active.leaseId !== getLease() || active.fileViewerToken !== getToken())
        throw new Error("프리뷰 연결이 바뀌었습니다.");
      const result = await readPreviewResource(api, active, data.url, abort.signal);
      if (revision !== current) return;
      target.postMessage({ type: "laymux.preview.resource", id: data.id, ...result }, "*", [
        result.bytes.buffer,
      ]);
    } catch (error) {
      if (revision === current)
        target.postMessage(
          { type: "laymux.preview.resource", id: data.id, error: String(error.message || error) },
          "*",
        );
    } finally {
      pending -= 1;
    }
  });
  return { open, close, isOpen: () => !overlay.hidden };
}
