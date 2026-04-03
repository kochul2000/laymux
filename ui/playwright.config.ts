import { defineConfig } from "@playwright/test";
import os from "os";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30000,
  fullyParallel: true,
  workers: os.cpus().length,
  use: {
    baseURL: "http://localhost:1420",
    headless: true,
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run dev",
    port: 1420,
    reuseExistingServer: true,
    timeout: 15000,
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
});
