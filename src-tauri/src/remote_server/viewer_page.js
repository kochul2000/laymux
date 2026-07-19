(() => {
  "use strict";

  const statusElement = document.getElementById("status");
  const pathElement = document.getElementById("path");
  const textElement = document.getElementById("text");
  const imageElement = document.getElementById("image");
  const previewElement = document.getElementById("preview");
  const binaryElement = document.getElementById("binary");
  let acceptedSession = false;

  function setStatus(message, isError = false) {
    statusElement.textContent = message;
    statusElement.classList.toggle("error", isError);
    statusElement.hidden = false;
  }

  function hideContent() {
    textElement.hidden = true;
    imageElement.hidden = true;
    previewElement.hidden = true;
    binaryElement.hidden = true;
    imageElement.removeAttribute("src");
    previewElement.removeAttribute("srcdoc");
  }

  function formatBytes(value) {
    if (!Number.isFinite(value) || value < 0) return "Unknown size";
    if (value < 1024) return `${value} B`;
    const units = ["KiB", "MiB", "GiB"];
    let size = value / 1024;
    let unit = units[0];
    for (let index = 1; index < units.length && size >= 1024; index += 1) {
      size /= 1024;
      unit = units[index];
    }
    return `${size.toFixed(size >= 10 ? 1 : 2)} ${unit}`;
  }

  function render(payload) {
    hideContent();
    statusElement.hidden = true;
    pathElement.textContent = payload.path || "";
    pathElement.title = payload.path || "";
    document.title = payload.path
      ? `${payload.path} — Laymux`
      : "Laymux File Viewer";

    if (payload.kind === "text" && payload.previewDocument) {
      previewElement.setAttribute("sandbox", "");
      previewElement.srcdoc = payload.previewDocument;
      previewElement.hidden = false;
      return;
    }
    if (payload.kind === "text") {
      textElement.textContent = payload.content || "";
      textElement.hidden = false;
      if (payload.truncated)
        setStatus("Preview truncated at the Remote viewer limit.");
      return;
    }
    if (
      payload.kind === "image" &&
      /^data:image\//i.test(payload.dataUrl || "")
    ) {
      imageElement.src = payload.dataUrl;
      imageElement.hidden = false;
      return;
    }
    if (payload.kind === "binary") {
      binaryElement.textContent = `Binary or unsupported file · ${formatBytes(payload.size)}`;
      binaryElement.hidden = false;
      return;
    }
    throw new Error("Unsupported viewer response");
  }

  async function loadSession(session) {
    const body = { source: session.source };
    if (session.source === "path") body.path = session.path;
    const response = await fetch("/remote/v1/file-viewer/render", {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.token}`,
        "content-type": "application/json",
        "x-laymux-remote-lease": session.leaseId,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(
        body.error || `${response.status} ${response.statusText}`,
      );
    }
    render(await response.json());
  }

  window.addEventListener("message", (event) => {
    if (
      acceptedSession ||
      event.origin !== window.location.origin ||
      event.source !== window.opener
    ) {
      return;
    }
    const session = event.data;
    if (
      !session ||
      session.type !== "laymux:file-viewer-session" ||
      typeof session.token !== "string" ||
      !session.token ||
      typeof session.leaseId !== "string" ||
      !session.leaseId ||
      (session.source !== "current" && session.source !== "path") ||
      (session.source === "path" &&
        (typeof session.path !== "string" || !session.path.trim()))
    ) {
      return;
    }

    acceptedSession = true;
    window.opener = null;
    setStatus("Loading file…");
    loadSession(session).catch((error) => {
      hideContent();
      setStatus(error instanceof Error ? error.message : String(error), true);
    });
  });

  if (!window.opener) {
    setStatus("Open this viewer from a connected Laymux Remote page.", true);
    return;
  }
  window.opener.postMessage(
    { type: "laymux:file-viewer-ready" },
    window.location.origin,
  );
})();
