/* global document, window */
import { MemoDocument } from "../lib/memo-document.ts";

/** Remote adapter only: storage and draft conflict semantics are shared with Desktop. */
export function createRemoteMemo({ api, getLease, getNavigation, copy, beforeOpen, afterClose }) {
  const $ = (id) => document.getElementById(id);
  const overlay = $("memoOverlay");
  const select = $("memoSelect");
  const textarea = $("memoText");
  const status = $("memoStatus");
  const documents = new Map();
  let currentKey = null;
  let unsubscribe = null;
  let generation = 0;
  const current = () => documents.get(currentKey);
  const isOpen = () => !overlay.hidden;

  async function list() {
    const lease = getLease();
    if (!lease) throw new Error("Connect to read PC memos.");
    const result = await api(`/remote/v1/memos?leaseId=${encodeURIComponent(lease)}`);
    if (lease !== getLease()) throw new Error("Connection changed. Reopen memos.");
    return new Map((result.memos || []).map((memo) => [memo.key, memo.content]));
  }

  function render() {
    const state = current()?.getSnapshot();
    if (textarea.value !== (state?.text || "")) textarea.value = state?.text || "";
    textarea.disabled = !state?.loaded || !getLease();
    $("memoSave").disabled = !getLease() || !state?.dirty || state.busy;
    $("memoSave").textContent = state?.busy ? "Saving…" : "Save";
    $("memoSave").title = !getLease()
      ? "Connect before saving"
      : state?.busy
        ? "Saving to PC"
        : !state?.dirty
          ? "No unsaved changes"
          : "Save to PC";
    $("memoReload").disabled = !getLease() || state?.busy;
    $("memoReload").title = !getLease()
      ? "Connect before reloading"
      : state?.busy
        ? "Wait for the save to finish"
        : "Reload from PC";
    status.classList.toggle("error", Boolean(state?.error));
    status.textContent =
      state?.error ||
      (!state
        ? "No PC memos. Add a Memo view on the PC first."
        : !state.loaded
          ? "Loading…"
          : state.dirty
            ? "Unsaved changes · shared with PC"
            : "Saved on PC");
  }

  function choose(key) {
    currentKey = key;
    unsubscribe?.();
    if (!documents.has(key)) {
      documents.set(
        key,
        new MemoDocument(
          async () => (await list()).get(key) || "",
          async (content, expectedContent) => {
            const leaseId = getLease();
            if (!leaseId) throw new Error("Reconnect before saving your draft.");
            await api("/remote/v1/memos", {
              method: "POST",
              body: JSON.stringify({ leaseId, key, content, expectedContent }),
            });
          },
        ),
      );
    }
    unsubscribe = current().subscribe(render);
    select.value = key;
    render();
    void current().refresh();
  }

  async function open() {
    if (!getLease()) return;
    beforeOpen();
    overlay.hidden = false;
    const request = ++generation;
    status.textContent = "Loading PC memos…";
    try {
      const memos = await list();
      if (request !== generation || !isOpen()) return;
      const labels = new Map();
      const navigation = getNavigation();
      for (const owner of [...(navigation?.workspaces || []), ...(navigation?.docks || [])]) {
        for (const pane of owner.panes || []) {
          if (pane.viewType === "MemoView") {
            const key = `memo-${pane.id}`;
            labels.set(
              key,
              `${owner.name || owner.position || owner.id} · ${pane.title || "Memo"}`,
            );
            if (!memos.has(key)) memos.set(key, "");
          }
        }
      }
      // Drafts survive closing, selection changes and temporary disconnects.
      for (const [key, memo] of documents) {
        if (memo.getSnapshot().dirty && !memos.has(key)) memos.set(key, "");
      }
      select.replaceChildren();
      for (const [key, content] of memos) {
        const option = document.createElement("option");
        option.value = key;
        option.textContent =
          labels.get(key) ||
          content
            .split("\n")
            .find((line) => line.trim())
            ?.slice(0, 60) ||
          key;
        option.title = key;
        select.appendChild(option);
      }
      if (memos.size) choose(memos.has(currentKey) ? currentKey : memos.keys().next().value);
      else {
        currentKey = null;
        render();
      }
    } catch (error) {
      if (request !== generation || !isOpen()) return;
      render();
      status.textContent = String(error.message || error);
      status.classList.add("error");
    }
  }

  function close() {
    generation += 1;
    overlay.hidden = true;
    afterClose();
  }

  textarea.addEventListener("input", () => current()?.edit(textarea.value));
  select.addEventListener("change", () => choose(select.value));
  $("memoSave").addEventListener("click", () => {
    void current()?.save();
  });
  $("memoReload").addEventListener("click", () => {
    if (!current()) {
      void open();
      return;
    }
    if (
      !current().getSnapshot().dirty ||
      window.confirm("Discard your draft and reload the PC memo?")
    ) {
      void current().refresh(true);
    }
  });
  $("memoCopy").addEventListener("click", () => {
    copy(textarea.value).catch((error) => {
      status.textContent = `Could not copy: ${error.message || error}`;
      status.classList.add("error");
    });
  });
  $("memoClose").addEventListener("click", close);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });
  window.addEventListener(
    "keydown",
    (event) => {
      if (!isOpen() || event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    },
    true,
  );
  window.addEventListener("beforeunload", (event) => {
    if (![...documents.values()].some((memo) => memo.getSnapshot().dirty)) return;
    event.preventDefault();
    event.returnValue = "";
  });
  return { open, close, isOpen };
}
