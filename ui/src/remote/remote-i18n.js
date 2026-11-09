import { resolveLanguage } from "../i18n/resolve-language.ts";
import messages from "./remote-messages.json";
import { lifecycleCopy } from "../lib/lifecycle-progress.ts";

const sharedMessages = Object.fromEntries(
  Object.entries(lifecycleCopy.en).map(([key, en]) => [en, { en, ko: lifecycleCopy.ko[key] }]),
);

export const REMOTE_LANGUAGE_KEY = "laymux.remote.language";
let setting = "system";
let language = "en";
let deviceStorage;
let browserLocale;
const bindings = new WeakMap();

/** A product message, kept separate from ordinary user strings until the DOM boundary. */
class RemoteMessage extends String {
  constructor(key, values = []) {
    super(key);
    this.key = key;
    this.values = values;
  }
  toString() {
    const template = (messages[this.key] ?? sharedMessages[this.key])?.[language] ?? this.key;
    return template.replace(/\{(\w+)\}/g, (match, index) =>
      index in this.values ? String(this.values[index]) : match,
    );
  }
  [Symbol.toPrimitive]() {
    return this.toString();
  }
}

export const t = (key, values = []) => new RemoteMessage(key, values);
export const joinRemoteMessages = (values, separator = " · ") =>
  new RemoteMessage(values.map((_, index) => `{${index}}`).join(separator), values);
export function remoteError(message) {
  const error = new Error(String(message));
  // Keep our authored message until the display boundary; foreign errors stay strings.
  error.message = message;
  return error;
}
export function remoteAttributeMessage(element, attribute) {
  return (
    bindings.get(element)?.get(attribute) ??
    (element.hasAttribute(`data-remote-i18n-${attribute}`)
      ? t(element.getAttribute(`data-remote-i18n-${attribute}`))
      : element.getAttribute(attribute))
  );
}
export function tr(parts, ...values) {
  return new RemoteMessage(
    parts.reduce((key, part, index) => key + (index ? `{${index - 1}}` : "") + part, ""),
    values,
  );
}
export const remoteLanguage = () => language;
export const remoteLanguageSetting = () => setting;
const validSetting = (value) => ["system", "ko", "en"].includes(value);

export function initializeRemoteLanguage(options = {}) {
  browserLocale = options.locale ?? globalThis.navigator?.language;
  try {
    deviceStorage = options.storage ?? globalThis.localStorage;
  } catch {
    deviceStorage = undefined;
  }
  let stored;
  try {
    stored = JSON.parse(deviceStorage?.getItem(REMOTE_LANGUAGE_KEY) ?? "null");
  } catch {
    /* device storage may be unavailable */
  }
  setting = validSetting(stored) ? stored : "system";
  applyLanguage();
}

function applyLanguage() {
  language = resolveLanguage(setting, browserLocale);
  const document = globalThis.document;
  if (document) {
    document.documentElement.lang = language;
    translateRemoteShell(document);
    for (const element of document.querySelectorAll("[data-remote-message]")) {
      for (const [attribute, message] of bindings.get(element) ?? []) {
        if (attribute === "textContent") element.textContent = String(message);
        else element.setAttribute(attribute, String(message));
      }
    }
  }
}

export function setRemoteLanguage(value) {
  if (!validSetting(value)) return false;
  setting = value;
  let persisted = false;
  try {
    deviceStorage?.setItem(REMOTE_LANGUAGE_KEY, JSON.stringify(value));
    persisted = Boolean(deviceStorage);
  } catch {
    /* apply in this document even when persistence is blocked */
  }
  applyLanguage();
  return persisted;
}

function remember(element, attribute, value) {
  let attributes = bindings.get(element);
  if (value instanceof RemoteMessage) {
    if (!attributes) {
      attributes = new Map();
      bindings.set(element, attributes);
    }
    attributes.set(attribute, value);
    element.setAttribute("data-remote-message", "");
  } else {
    attributes?.delete(attribute);
    if (!attributes?.size) element.removeAttribute("data-remote-message");
  }
  // A later dynamic/user value replaces a static shell message at this boundary.
  element.removeAttribute(
    attribute === "textContent" ? "data-remote-i18n" : `data-remote-i18n-${attribute}`,
  );
}

export function setRemoteText(element, value) {
  remember(element, "textContent", value);
  element.textContent = value == null ? "" : String(value);
}
export function clearRemoteTextBinding(element) {
  remember(element, "textContent", undefined);
}
export function setRemoteAttribute(element, attribute, value) {
  remember(element, attribute, value);
  if (value == null) element.removeAttribute(attribute);
  else element.setAttribute(attribute, String(value));
}
export function setRemoteHtml(element, value) {
  clearRemoteTextBinding(element);
  element.innerHTML = value;
  translateRemoteShell(element);
}

/** Only author-marked product copy; never scan terminal, editor, or user text. */
export function translateRemoteShell(root) {
  const elements = [
    ...(root.matches?.(
      "[data-remote-i18n], [data-remote-i18n-title], [data-remote-i18n-aria-label], [data-remote-i18n-placeholder]",
    )
      ? [root]
      : []),
    ...root.querySelectorAll(
      "[data-remote-i18n], [data-remote-i18n-title], [data-remote-i18n-aria-label], [data-remote-i18n-placeholder]",
    ),
  ];
  for (const element of elements) {
    if (element.hasAttribute("data-remote-i18n"))
      element.textContent = String(t(element.dataset.remoteI18n));
    for (const attribute of ["title", "aria-label", "placeholder"]) {
      const key = element.getAttribute(`data-remote-i18n-${attribute}`);
      if (key !== null) element.setAttribute(attribute, String(t(key)));
    }
  }
}
