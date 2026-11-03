import { invoke } from "@tauri-apps/api/core";

export interface AutomationServerStatus {
  phase: "starting" | "running" | "failed";
  port: number;
  error: string | null;
  revision: number;
}

export const getAutomationServerStatus = () =>
  invoke<AutomationServerStatus>("get_automation_server_status");
export const retryAutomationServer = () =>
  invoke<AutomationServerStatus>("retry_automation_server");
