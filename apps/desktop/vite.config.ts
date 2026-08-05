import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Tauri expects a fixed port and its own build output dir.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  build: { outDir: "dist", target: "es2022" },
  // @cash-money/core is a TS-source workspace package; let Vite transform it
  // directly instead of pre-bundling.
  optimizeDeps: { exclude: ["@cash-money/core"] },
});
