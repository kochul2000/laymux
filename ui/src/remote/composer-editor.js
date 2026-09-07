// Native editing owns text, selection and composition. This boundary only maps
// non-editable attachment nodes to the existing raw-path draft (ADR-0236).
export function createComposerEditor(element) {
  const document = element.ownerDocument;
  const window = document.defaultView;
  const { Node, InputEvent } = window;
  const chips = new WeakMap();

  function read() {
    let text = "";
    const attachments = [];
    const positions = new Map();
    function visit(node) {
      const start = text.length;
      const attachment = chips.get(node);
      if (attachment) {
        text += attachment.path;
        attachments.push({ ...attachment, start, end: text.length });
      } else if (node.nodeType === Node.TEXT_NODE) {
        text += node.data;
      } else if (node.nodeName === "BR") {
        if (!node.hasAttribute("data-composer-end")) text += "\n";
      } else {
        for (const child of node.childNodes) visit(child);
      }
      positions.set(node, { start, end: text.length });
    }
    visit(element);
    return { text, attachments, positions };
  }

  function offsetAt(node, offset, state, edge) {
    if (!element.contains(node)) return state.text.length;
    let chip = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    chip = chip?.closest(".composer-attachment");
    if (chip && chips.has(chip)) return state.positions.get(chip)[edge];
    const position = state.positions.get(node);
    if (!position) return state.text.length;
    if (node.nodeType === Node.TEXT_NODE) return position.start + offset;
    return offset < node.childNodes.length
      ? (state.positions.get(node.childNodes[offset])?.start ?? position.end)
      : position.end;
  }

  function selection() {
    const state = read();
    const selected = window.getSelection();
    if (!selected?.rangeCount) return { start: state.text.length, end: state.text.length };
    const range = selected.getRangeAt(0);
    return {
      start: offsetAt(
        range.startContainer,
        range.startOffset,
        state,
        range.collapsed ? "end" : "start",
      ),
      end: offsetAt(range.endContainer, range.endOffset, state, "end"),
    };
  }

  function pointAt(offset, state) {
    for (const [node, position] of state.positions) {
      if (offset < position.start || offset > position.end) continue;
      if (node.nodeType === Node.TEXT_NODE) return [node, offset - position.start];
      if (chips.has(node) || node.nodeName === "BR") {
        const index = Array.prototype.indexOf.call(node.parentNode.childNodes, node);
        return [node.parentNode, index + (offset > position.start ? 1 : 0)];
      }
    }
    return [element, element.childNodes.length];
  }

  function setSelectionRange(start, end = start) {
    const state = read();
    const range = document.createRange();
    range.setStart(...pointAt(start, state));
    range.setEnd(...pointAt(end, state));
    const selected = window.getSelection();
    selected.removeAllRanges();
    selected.addRange(range);
  }

  function expandSelection(start, end) {
    for (const attachment of read().attachments) {
      if (start < attachment.end && end > attachment.start) {
        start = Math.min(start, attachment.start);
        end = Math.max(end, attachment.end);
      }
    }
    return { start, end };
  }

  function replaceSelection(text) {
    if (editor.disabled) return;
    const selected = selection();
    const { start, end } = expandSelection(selected.start, selected.end);
    setSelectionRange(start, end);
    const range = window.getSelection().getRangeAt(0);
    range.deleteContents();
    if (text) range.insertNode(document.createTextNode(text.replace(/\r\n?/g, "\n")));
    setSelectionRange(start + text.replace(/\r\n?/g, "\n").length);
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  }

  function setDraft(draft) {
    const current = read();
    const attachments = draft?.attachments ?? [];
    const text = draft?.text ?? "";
    if (
      current.text === text &&
      JSON.stringify(current.attachments) === JSON.stringify(attachments)
    )
      return;
    const nodes = [];
    let offset = 0;
    let imageIndex = 0;
    const imageCount = attachments.filter((item) => item.image).length;
    for (const attachment of attachments) {
      nodes.push(document.createTextNode(text.slice(offset, attachment.start)));
      const chip = document.createElement("span");
      chip.className = "composer-attachment";
      chip.contentEditable = "false";
      chip.title = `${attachment.name}\n${attachment.path}`;
      chip.setAttribute("aria-label", attachment.name);
      if (attachment.image) {
        chip.textContent = `Image${imageCount > 1 ? ` ${++imageIndex}` : ""}`;
      } else {
        const dot = attachment.name.lastIndexOf(".");
        const name = document.createElement("span");
        name.className = "composer-attachment-name";
        name.textContent = dot > 0 ? attachment.name.slice(0, dot) : attachment.name;
        chip.append(name, dot > 0 ? attachment.name.slice(dot) : "");
      }
      chips.set(chip, attachment);
      nodes.push(chip);
      offset = attachment.end;
    }
    nodes.push(document.createTextNode(text.slice(offset)));
    // A zero-length line box keeps the caret visible after a trailing newline.
    const end = document.createElement("br");
    end.setAttribute("data-composer-end", "");
    nodes.push(end);
    element.replaceChildren(...nodes);
  }

  element.addEventListener("beforeinput", (event) => {
    if (event.isComposing || editor.disabled) return;
    if (event.inputType === "insertParagraph" || event.inputType === "insertLineBreak") {
      event.preventDefault();
      replaceSelection("\n");
      return;
    }
    if (!event.inputType.startsWith("delete")) return;
    const selected = selection();
    let { start, end } = selected;
    if (start === end) {
      if (event.inputType.endsWith("Backward")) start = Math.max(0, start - 1);
      else if (event.inputType.endsWith("Forward")) end += 1;
      else return;
    }
    const expanded = expandSelection(start, end);
    if (!read().attachments.some((item) => expanded.start < item.end && expanded.end > item.start))
      return;
    event.preventDefault();
    setSelectionRange(expanded.start, expanded.end);
    replaceSelection("");
  });

  element.addEventListener("keydown", (event) => {
    if (
      event.isComposing ||
      event.keyCode === 229 ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey ||
      event.shiftKey
    )
      return;
    const { start, end } = selection();
    if (start !== end) return;
    const attachment = read().attachments.find((item) =>
      event.key === "ArrowLeft"
        ? item.end === start
        : event.key === "ArrowRight" && item.start === start,
    );
    if (!attachment) return;
    event.preventDefault();
    setSelectionRange(event.key === "ArrowLeft" ? attachment.start : attachment.end);
  });

  // Copy/cut exports actual paths; pasted HTML can never forge an attachment.
  for (const type of ["copy", "cut"]) {
    element.addEventListener(type, (event) => {
      const selected = selection();
      const { start, end } = expandSelection(selected.start, selected.end);
      if (start === end || !event.clipboardData) return;
      event.preventDefault();
      event.clipboardData.setData("text/plain", read().text.slice(start, end));
      if (type === "cut") {
        setSelectionRange(start, end);
        replaceSelection("");
      }
    });
  }
  element.addEventListener("drop", (event) => event.preventDefault());

  const editor = {
    get value() {
      return read().text;
    },
    get attachments() {
      return read().attachments;
    },
    get selectionStart() {
      return selection().start;
    },
    get selectionEnd() {
      return selection().end;
    },
    get disabled() {
      return element.getAttribute("aria-disabled") === "true";
    },
    set disabled(value) {
      const editable = value ? "false" : "true";
      if (element.contentEditable !== editable) element.contentEditable = editable;
      element.setAttribute("aria-disabled", String(value));
    },
    setDraft,
    setSelectionRange,
    replaceSelection,
  };
  return editor;
}
