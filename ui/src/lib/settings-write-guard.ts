let settingsWritesBlocked = false;

export function setBlockPersist(blocked: boolean): void {
  settingsWritesBlocked = blocked;
}

export function assertSettingsWriteAllowed(): void {
  if (settingsWritesBlocked) {
    throw new Error("Settings persistence is blocked until recovery is acknowledged");
  }
}

export function isSettingsWriteBlocked(): boolean {
  return settingsWritesBlocked;
}
