import type { Profile } from "@/stores/settings-store";

function wslPath(path: string): { distro: string; cwd: string } | undefined {
  // Forward-slash guest paths may contain literal Linux backslashes.
  const normalized = path.startsWith("\\\\") ? path.replace(/\\/g, "/") : path;
  const match = normalized.match(/^\/\/(?:wsl\.localhost|wsl\$)\/([^/]+)(\/.*)?$/i);
  return match ? { distro: match[1], cwd: match[2] || "/" } : undefined;
}

/** Call after matching the profile to the source distribution. */
export function worktreeTerminalCwd(path: string): string {
  return wslPath(path)?.cwd ?? path;
}

/** A WSL UNC path must never start in a native shell or a different distribution. */
export function worktreeTerminalProfile(
  path: string,
  profiles: Pick<Profile, "name" | "commandLine">[],
  defaultProfile: string,
  terminals: { cwd?: string; profile: string }[],
): string | undefined {
  const distro = wslPath(path)?.distro;
  if (!distro) return defaultProfile || profiles[0]?.name;
  const sameDistro = (value?: string) => value?.toLowerCase() === distro.toLowerCase();
  const wslProfiles = profiles.filter((profile) =>
    /(?:^|[\\/\s"])wsl(?:\.exe)?(?:["\s]|$)/i.test(profile.commandLine),
  );
  const liveProfile = terminals.find(
    (terminal) =>
      sameDistro(terminal.cwd ? wslPath(terminal.cwd)?.distro : undefined) &&
      wslProfiles.some((profile) => profile.name === terminal.profile),
  );
  if (liveProfile) return liveProfile.profile;
  return wslProfiles.find((profile) => {
    const distribution = profile.commandLine.match(
      /(?:^|\s)(?:-d|--distribution)(?:\s+|=)(?:"([^"]+)"|'([^']+)'|([^\s]+))/i,
    );
    return sameDistro(distribution?.[1] ?? distribution?.[2] ?? distribution?.[3]);
  })?.name;
}
