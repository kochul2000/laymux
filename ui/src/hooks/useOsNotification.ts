import { sendOsNotification } from "@/lib/tauri-api";

/**
 * Send an OS-level desktop notification.
 * Wraps the Tauri backend command with error handling.
 */
export async function sendDesktopNotification(
  title: string,
  body: string,
): Promise<void> {
  try {
    await sendOsNotification(title, body);
  } catch {
    // OS notification not available — fail silently
  }
}
