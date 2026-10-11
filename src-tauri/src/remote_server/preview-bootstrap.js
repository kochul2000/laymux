/* global window, document, DOMParser, Blob, URL, Uint8Array, Response, parent */
// Runs only in the opaque-origin sandbox, without Remote credentials.
(() => {
  let base;
  let nextId = 0;
  const pending = new Map();
  const blobs = [];
  function request(value) {
    const url = new URL(value, base);
    if (url.origin !== new URL(base).origin) return Promise.reject(new Error("Preview resources must stay on the registered localhost server."));
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      if (pending.size >= 8) { reject(new Error("Too many preview requests.")); return; }
      const timer = setTimeout(() => {pending.delete(id); reject(new Error("Preview request timed out."));}, 120000);
      pending.set(id, {resolve, reject, timer});
      parent.postMessage({type:"laymux.preview.read", id, url:url.href}, "*");
    });
  }
  window.fetch = async (value, options = {}) => {
    if (options.method && options.method.toUpperCase() !== "GET") throw new Error("Preview supports GET resources only.");
    const result = await request(typeof value === "string" || value instanceof URL ? value : value.url);
    return new Response(result.bytes, {status:result.status, headers:{"content-type":result.contentType}});
  };
  async function blobUrl(value) {
    const result = await request(value);
    if (result.status >= 400) throw new Error(`Preview resource failed (${result.status}): ${value}`);
    const url = URL.createObjectURL(new Blob([result.bytes], {type:result.contentType}));
    blobs.push(url);
    return url;
  }
  // Godot's single-thread export loads its audio worklet outside window.fetch.
  // Keep that module on the same bounded resource bridge as WASM and game data.
  if (typeof AudioWorklet !== "undefined") {
    const addModule = AudioWorklet.prototype.addModule;
    AudioWorklet.prototype.addModule = async function(value, options) {
      return addModule.call(this, await blobUrl(value), options);
    };
  }
  async function install() {
    const result = await request(base);
    if (result.status >= 400) throw new Error(`PC web server returned ${result.status}.`);
    const html = new TextDecoder().decode(result.bytes);
    const parsed = new DOMParser().parseFromString(html, "text/html");
    const scripts = [...parsed.querySelectorAll("script")].map((script) => ({src:script.getAttribute("src"), text:script.textContent, type:script.type}));
    parsed.querySelectorAll("script,base,iframe,object,embed,meta[http-equiv]").forEach((node) => node.remove());
    for (const node of parsed.querySelectorAll("[src],link[href]")) {
      const attribute = node.hasAttribute("src") ? "src" : "href";
      const value = node.getAttribute(attribute);
      if (!value || value.startsWith("data:")) continue;
      node.setAttribute(attribute, await blobUrl(value));
    }
    document.head.replaceChildren(...parsed.head.childNodes);
    document.body.replaceChildren(...parsed.body.childNodes);
    for (const source of scripts) {
      const script = document.createElement("script");
      if (source.type) script.type = source.type;
      if (source.src) {
        script.src = await blobUrl(source.src);
        await new Promise((resolve, reject) => {script.onload = resolve; script.onerror = reject; document.body.append(script);});
      } else { script.textContent = source.text; document.body.append(script); }
    }
    parent.postMessage({type:"laymux.preview.ready"}, "*");
  }
  window.addEventListener("message", (event) => {
    if (event.source !== parent) return;
    if (event.data?.type === "laymux.preview.init" && !base) {
      base = event.data.url;
      install().catch((error) => parent.postMessage({type:"laymux.preview.error", error:String(error.message || error)}, "*"));
    }
    if (event.data?.type === "laymux.preview.resource") {
      const entry = pending.get(event.data.id);
      if (!entry) return;
      pending.delete(event.data.id);
      clearTimeout(entry.timer);
      if (event.data.error) entry.reject(new Error(event.data.error));
      else entry.resolve({...event.data, bytes:new Uint8Array(event.data.bytes)});
    }
  });
})();
