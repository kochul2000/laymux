import type { HostCandidate } from "@/lib/tauri-api";

export const LOOPBACK_ALLOWED_IPS = ["127.0.0.1/32", "::1/128"];
export const TAILSCALE_ALLOWED_IPS = ["100.64.0.0/10", "fd7a:115c:a1e0::/48"];
export const LOCAL_MOBILE_CLIENT_NAME = "laymux-mobile";
export const REMOTE_LAST_HOST_KEY = "laymux-remote-last-host";

export interface RemoteHostOption {
  kind: HostCandidate["kind"] | "custom";
  host: string;
  label: string;
}

export function generateRemoteToken(): string {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function parseAllowedIps(value: string): string[] {
  const seen = new Set<string>();
  return value
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .filter((entry) => {
      if (seen.has(entry)) return false;
      seen.add(entry);
      return true;
    });
}

export function formatAllowedIps(allowedIps: string[]): string {
  return allowedIps.join("\n");
}

export function appendAllowedIps(current: string, entries: string[]): string {
  return formatAllowedIps(parseAllowedIps([...parseAllowedIps(current), ...entries].join("\n")));
}

export function sameAllowedIps(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

export function normalizeAutoMobileWidth(value: string | number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor(parsed));
}

export function normalizeCustomHosts(hosts: string[]): string[] {
  const seen = new Set<string>();
  return hosts
    .map((host) => host.trim())
    .filter((host) => host.length > 0)
    .filter((host) => {
      if (seen.has(host)) return false;
      seen.add(host);
      return true;
    });
}

export function buildRemoteHostOptions(
  detected: HostCandidate[],
  customHosts: string[],
): RemoteHostOption[] {
  const seen = new Set<string>();
  const options: RemoteHostOption[] = [];
  const push = (option: RemoteHostOption) => {
    const host = option.host.trim();
    if (!host || seen.has(host)) return;
    seen.add(host);
    options.push({ ...option, host });
  };

  detected.forEach((candidate) => push(candidate));
  normalizeCustomHosts(customHosts).forEach((host) => push({ kind: "custom", host, label: host }));
  return options;
}

export function chooseRemoteHost(
  options: RemoteHostOption[],
  preferredHost: string,
  lastHost = "",
): string {
  const preferred = preferredHost.trim();
  if (preferred && options.some((option) => option.host === preferred)) return preferred;
  const last = lastHost.trim();
  if (last && options.some((option) => option.host === last)) return last;
  return options[0]?.host ?? "";
}

export function readLastRemoteHost(): string {
  try {
    return localStorage.getItem(REMOTE_LAST_HOST_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

export function writeLastRemoteHost(host: string): void {
  const trimmed = host.trim();
  try {
    if (trimmed) {
      localStorage.setItem(REMOTE_LAST_HOST_KEY, trimmed);
    } else {
      localStorage.removeItem(REMOTE_LAST_HOST_KEY);
    }
  } catch {
    /* ignore */
  }
}

export function formatHostForUrl(host: string): string {
  const trimmed = host.trim();
  if (trimmed.startsWith("[") && trimmed.includes("]")) return trimmed;
  if (trimmed.includes(":") && !trimmed.includes("://")) return `[${trimmed}]`;
  return trimmed;
}

export function buildRemoteUrlWithToken(
  host: string,
  port: number | string,
  token: string,
): string {
  return `http://${formatHostForUrl(host)}:${port}/remote/#token=${encodeURIComponent(token)}`;
}

export function buildLocalMobileModeUrl(port: number, token: string): string {
  const params = new URLSearchParams({
    localApp: "1",
    autoConnect: "1",
    clientName: LOCAL_MOBILE_CLIENT_NAME,
  });
  return `http://127.0.0.1:${port}/remote/?${params.toString()}#token=${encodeURIComponent(token)}`;
}
