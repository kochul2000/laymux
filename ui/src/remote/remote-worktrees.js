/* global document, window */
import { worktreeBlockerLabel, worktreeBranchLabel } from "../lib/worktree-presentation.ts";
import { worktreeFolderName, worktreeRowStatus } from "../lib/worktree-display.ts";

/** Remote owns presentation only; the host owns Git inspection and removal protection. */
export function createRemoteWorktrees({
  api,
  getContext,
  copy,
  openFile,
  canOpenFile,
  focusUsage,
  beforeOpen,
  afterClose,
}) {
  const $ = (id) => document.getElementById(id);
  const overlay = $("worktreesOverlay");
  const list = $("worktreesList");
  const detail = $("worktreesDetail");
  const status = $("worktreesStatus");
  const content = list.parentElement;
  let generation = 0;
  let selectionRevision = 0;
  let context = null;
  let snapshot = null;
  let cwd = null;
  let inspections = new Map();
  let filter = "all";
  let selected = null;
  let inspection = null;
  let detailError = null;
  let error = null;
  let notice = null;
  let confirming = false;
  let removing = false;
  let loading = false;
  let suspended = false;
  let listScroll = 0;
  const isOpen = () => !overlay.hidden;
  const matchesContext = (value) => {
    const current = getContext();
    return (
      value &&
      value.leaseId === current.leaseId &&
      value.terminalId === current.terminalId &&
      value.cwd === current.cwd
    );
  };
  const valid = (request) =>
    request === generation && (isOpen() || suspended) && matchesContext(context);
  const message = (reason) => (reason instanceof Error ? reason.message : String(reason));
  const node = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  const button = (label, action, disabled = false) => {
    const element = node("button", label, "worktree-action");
    element.type = "button";
    element.disabled = disabled;
    element.addEventListener("click", action);
    return element;
  };
  const request = (suffix, body, owner = context) =>
    api(`/remote/v1/terminals/${encodeURIComponent(owner.terminalId)}/worktrees${suffix}`, {
      method: "POST",
      body: JSON.stringify({ leaseId: owner.leaseId, ...body }),
    });
  const counts = (value) =>
    `변경 ${value.trackedChanges} · 미추적 ${value.untrackedFiles} · 무시 ${value.ignoredFiles}`;

  function renderList() {
    const focusedPath = list.contains(document.activeElement)
      ? document.activeElement.dataset.worktreePath
      : null;
    const entries = snapshot?.worktrees || [];
    const candidates = entries.filter((entry) => inspections.get(entry.path)?.value?.canRemove);
    const pending = error ? 0 : entries.length - inspections.size;
    $("worktreesAll").textContent = `전체 ${entries.length}`;
    $("worktreesCandidates").textContent =
      `정리 후보 ${loading || pending ? "· 검사 중" : candidates.length}`;
    for (const [id, value] of [
      ["worktreesAll", "all"],
      ["worktreesCandidates", "candidates"],
    ]) {
      $(id).classList.toggle("active", filter === value);
      $(id).setAttribute("aria-selected", String(filter === value));
    }
    $("worktreesRepo").textContent = worktreeFolderName(snapshot?.repositoryPath || "");
    $("worktreesRepo").title = snapshot?.repositoryPath || "";
    $("worktreesRefresh").disabled = removing || loading;
    status.classList.toggle("error", Boolean(error));
    status.textContent =
      error ||
      notice ||
      (loading
        ? "워크트리 목록을 읽고 있습니다…"
        : pending
          ? `내용 검사 중 · ${inspections.size}/${entries.length}`
          : "");
    if (snapshot?.usageWarnings?.length)
      status.textContent += ` ${snapshot.usageWarnings.join(" · ")}`;
    list.replaceChildren();
    list.hidden = Boolean(selected);
    const visible = filter === "all" ? entries : candidates;
    for (const entry of visible) {
      const result = inspections.get(entry.path);
      const value = result?.value;
      const row = button("", () => void choose(entry));
      row.className = "worktree-row";
      row.dataset.worktreePath = entry.path;
      row.setAttribute("aria-expanded", String(selected?.path === entry.path));
      row.append(node("strong", worktreeFolderName(entry.path)));
      const path = node(
        "span",
        `${worktreeBranchLabel(entry.branch)}${entry.isMain ? " · 기본" : ""}`,
        "worktree-path",
      );
      path.title = entry.path;
      row.append(path);
      const summary = error
        ? "목록 갱신 실패"
        : result?.error
          ? `검사 실패: ${result.error}`
          : worktreeRowStatus(entry, value);
      row.append(node("span", summary, "worktree-meta"));
      list.append(row);
    }
    if (snapshot && !visible.length)
      list.append(
        node(
          "p",
          pending ? "검사가 끝난 정리 후보부터 표시합니다." : "현재 정리 후보가 없습니다.",
          "github-status",
        ),
      );
    if (focusedPath && !selected)
      [...list.querySelectorAll("button")]
        .find((row) => row.dataset.worktreePath === focusedPath)
        ?.focus({ preventScroll: true });
  }

  function renderDetail() {
    const focusedLabel = detail.contains(document.activeElement)
      ? document.activeElement.textContent
      : null;
    detail.replaceChildren();
    detail.hidden = !selected;
    if (!selected) return;
    const heading = node("div", undefined, "worktree-detail-heading");
    heading.append(
      node(
        "strong",
        `${worktreeFolderName(selected.path)} · ${worktreeBranchLabel(selected.branch)}`,
      ),
      button("상세 닫기", clearSelection, removing),
    );
    detail.append(heading, node("p", selected.path, "worktree-detail-path"));
    const actions = node("div", undefined, "worktree-actions");
    const selectedPath = selected.path;
    actions.append(
      button("경로 복사", () => {
        const revision = selectionRevision;
        copy(selectedPath).catch((reason) => {
          if (isOpen() && revision === selectionRevision) {
            detailError = message(reason);
            renderDetail();
          }
        });
      }),
    );
    detail.append(actions);
    if (detailError) detail.append(node("p", detailError, "worktree-error"));
    if (!inspection) {
      if (!detailError) detail.append(node("p", error || "최신 상태를 검사하고 있습니다…"));
      return;
    }
    detail.append(
      node("p", counts(inspection)),
      node("p", `HEAD ${inspection.worktree.head.slice(0, 12)}`, "worktree-meta"),
    );
    detail.append(
      node(
        "p",
        inspection.upstream
          ? `${inspection.upstream} · 앞섬 ${inspection.ahead ?? "?"} / 뒤처짐 ${inspection.behind ?? "?"}`
          : "추적 브랜치 없음",
        "worktree-meta",
      ),
    );
    for (const usage of inspection.usage || []) {
      const state =
        usage.kind === "saved" ? "저장된 세션" : usage.kind === "daemon" ? "연결 대기" : "실행 중";
      const move = button(
        `${usage.workspaceName || "터미널"} · ${usage.agentType || "터미널"} · ${state}`,
        async () => {
          if (!matchesContext(context)) {
            syncContext();
            return;
          }
          const revision = selectionRevision;
          const current = generation;
          try {
            await focusUsage(usage);
            if (valid(current)) close();
          } catch (reason) {
            if (isOpen() && revision === selectionRevision) {
              detailError = message(reason);
              renderDetail();
            }
          }
        },
        !usage.terminalId || !usage.paneId || removing,
      );
      move.title = usage.paneId ? usage.cwd : "이 터미널은 이동할 pane에 연결되어 있지 않습니다";
      detail.append(move);
    }
    for (const warning of inspection.usageWarnings || [])
      detail.append(node("p", warning, "worktree-warning"));
    if (inspection.blockers.length)
      detail.append(
        node(
          "p",
          `보존: ${inspection.blockers.map(worktreeBlockerLabel).join(" · ")}`,
          "worktree-warning",
        ),
      );
    if (inspection.files.length) {
      const files = node("details");
      files.append(
        node(
          "summary",
          `변경 파일 목록 (${inspection.files.length}${inspection.filesTruncated ? "+" : ""})`,
        ),
      );
      const items = node("div", undefined, "worktree-files");
      for (const file of inspection.files) {
        const kind =
          file.kind === "tracked" ? "변경" : file.kind === "untracked" ? "미추적" : "무시";
        const path = `${selected.path.replace(/\/$/, "")}/${file.path}`;
        const fileButton = button(
          `${kind} · ${file.path}`,
          () => openFile(path),
          !canOpenFile() || removing,
        );
        fileButton.title = canOpenFile()
          ? "파일 뷰어에서 내용을 확인합니다"
          : "파일 뷰어에 다시 연결해 주세요";
        items.append(fileButton);
      }
      files.append(items);
      detail.append(files);
    }
    detail.append(
      node(
        "p",
        "정리 후보는 파일 변경과 laymux 사용 여부 기준입니다. 병합 여부와 로컬 커밋은 별도로 확인하세요.",
        "worktree-meta",
      ),
    );
    if (confirming) {
      const confirmation = node("div", undefined, "worktree-confirmation");
      confirmation.append(node("p", `${selected.path} 폴더를 제거합니다. 브랜치는 유지됩니다.`));
      confirmation.append(
        button(removing ? "제거 중…" : "제거 확인", () => void remove(), removing),
        button(
          "취소",
          () => {
            confirming = false;
            renderDetail();
          },
          removing,
        ),
      );
      detail.append(confirmation);
    } else {
      const removeButton = button(
        "워크트리 제거",
        () => {
          confirming = true;
          renderDetail();
        },
        !inspection.canRemove || removing,
      );
      removeButton.title = inspection.canRemove
        ? "제거할 경로를 확인합니다"
        : inspection.blockers.map(worktreeBlockerLabel).join(" · ");
      detail.append(removeButton);
    }
    if (focusedLabel && isOpen())
      [...detail.querySelectorAll("button")]
        .find((element) => element.textContent === focusedLabel)
        ?.focus({ preventScroll: true });
  }

  function clearSelection() {
    const restoreFocus = detail.contains(document.activeElement) ? selected?.path : null;
    selectionRevision += 1;
    selected = null;
    inspection = null;
    detailError = null;
    confirming = false;
    renderList();
    renderDetail();
    if (restoreFocus)
      [...list.querySelectorAll("button")]
        .find((row) => row.dataset.worktreePath === restoreFocus)
        ?.focus({ preventScroll: true });
    content.scrollTop = listScroll;
  }

  async function choose(entry) {
    if (removing) return;
    if (!matchesContext(context)) {
      syncContext();
      return;
    }
    if (selected?.path === entry.path) {
      clearSelection();
      return;
    }
    if (!selected) listScroll = content.scrollTop;
    clearSelection();
    selected = entry;
    const revision = selectionRevision;
    const current = generation;
    renderList();
    renderDetail();
    content.scrollTop = 0;
    detail.querySelector("button")?.focus({ preventScroll: true });
    await inspectSelected(entry, current, revision);
  }

  async function inspectSelected(entry, current, revision) {
    try {
      const result = await request("/inspect", { cwd, path: entry.path });
      if (!valid(current) || revision !== selectionRevision) return;
      inspection = result.data;
    } catch (reason) {
      if (!valid(current) || revision !== selectionRevision) return;
      detailError = message(reason);
    }
    renderDetail();
  }

  async function refresh() {
    const next = getContext();
    if (!next.leaseId || !next.terminalId) {
      close();
      return;
    }
    const sameTarget = matchesContext(context);
    if (!sameTarget) {
      snapshot = null;
      cwd = null;
      selected = null;
      listScroll = 0;
    }
    context = { ...next };
    const current = ++generation;
    const revision = ++selectionRevision;
    inspection = null;
    confirming = false;
    detailError = null;
    loading = true;
    inspections = new Map();
    error = null;
    removing = false;
    renderList();
    renderDetail();
    try {
      const result = await request("", {});
      if (!valid(current)) return;
      snapshot = result.data;
      cwd = result.cwd;
      loading = false;
      selected = snapshot.worktrees.find((entry) => entry.path === selected?.path) || null;
      renderList();
      renderDetail();
      const selectedRequest = selected
        ? inspectSelected(selected, current, revision)
        : Promise.resolve();
      let nextIndex = 0;
      const entries = snapshot.worktrees;
      const inspectNext = async () => {
        while (valid(current) && nextIndex < entries.length) {
          const entry = entries[nextIndex++];
          let result;
          try {
            result = { value: (await request("/inspect", { cwd, path: entry.path })).data };
          } catch (reason) {
            result = { error: message(reason) };
          }
          if (!valid(current)) return;
          inspections.set(entry.path, result);
          renderList();
        }
      };
      await Promise.all([
        selectedRequest,
        ...Array.from({ length: Math.min(3, entries.length) }, inspectNext),
      ]);
    } catch (reason) {
      if (!valid(current)) return;
      error = message(reason);
      loading = false;
      renderList();
      renderDetail();
    }
  }

  async function remove() {
    if (!confirming || !inspection?.canRemove || removing) return;
    if (!matchesContext(context)) {
      syncContext();
      return;
    }
    const current = generation;
    const revision = selectionRevision;
    const path = selected.path;
    const expectedHead = inspection.worktree.head;
    removing = true;
    detailError = null;
    renderDetail();
    renderList();
    try {
      await request("/remove", { cwd, path, expectedHead });
      if (!valid(current) || revision !== selectionRevision) return;
      notice = `제거 완료: ${path}`;
      await refresh();
    } catch (reason) {
      if (!valid(current) || revision !== selectionRevision) return;
      detailError = message(reason);
      confirming = false;
      inspection = null;
      inspections.set(path, { error: detailError });
      removing = false;
      renderList();
      renderDetail();
    }
  }

  function open() {
    const next = getContext();
    if (!next.leaseId || !next.terminalId) return;
    beforeOpen();
    suspended = false;
    overlay.hidden = false;
    filter = "all";
    notice = null;
    void refresh();
  }
  function close() {
    generation += 1;
    selectionRevision += 1;
    overlay.hidden = true;
    suspended = false;
    context = null;
    snapshot = null;
    inspection = null;
    selected = null;
    confirming = false;
    removing = false;
    afterClose();
  }
  function syncContext() {
    if ((!isOpen() && !suspended) || matchesContext(context)) return;
    const next = getContext();
    if (
      !next.leaseId ||
      next.leaseId !== context?.leaseId ||
      next.terminalId !== context?.terminalId
    )
      close();
    else if (suspended) close();
    else {
      notice = null;
      void refresh();
    }
  }
  for (const [id, value] of [
    ["worktreesAll", "all"],
    ["worktreesCandidates", "candidates"],
  ]) {
    $(id).addEventListener("click", () => {
      if (!removing) {
        filter = value;
        clearSelection();
      }
    });
  }
  $("worktreesRefresh").addEventListener("click", () => {
    if (!removing) {
      notice = null;
      void refresh();
    }
  });
  $("worktreesClose").addEventListener("click", close);
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
  function suspend() {
    if (!isOpen() || !matchesContext(context)) return;
    suspended = true;
    overlay.hidden = true;
  }
  function resume() {
    if (!suspended) return false;
    if (!matchesContext(context)) {
      close();
      return false;
    }
    suspended = false;
    overlay.hidden = false;
    detail.querySelector("button")?.focus({ preventScroll: true });
    return true;
  }
  return { open, close, isOpen, syncContext, suspend, resume, isSuspended: () => suspended };
}
