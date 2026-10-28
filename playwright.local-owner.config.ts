import { defineConfig } from "@playwright/test";
import base from "./playwright.config.js";
export default defineConfig({
  ...base,
  testDir: "./tests/local-owner-browser",
  outputDir: "test-results-local-owner",
  use: { ...base.use, baseURL: "http://127.0.0.1:8790" },
  webServer: {
    command: "node --import tsx tests/local-owner-ui-server.ts",
    url: "http://127.0.0.1:8790/healthz",
    reuseExistingServer: false,
    timeout: 20000,
  },
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report-local-owner", open: "never" }],
  ],
});
