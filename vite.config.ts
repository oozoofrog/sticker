import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist/client",
    target: ["chrome107", "edge107", "firefox104", "safari16"],
  },
  server: { proxy: { "/api": "http://127.0.0.1:8787" } },
});
