import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 4200,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 4201,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    // CodeMirror is the heaviest dep by far — keep it in its own chunk so
    // the startup bundle (used before any editor mounts) stays lean. The
    // chunk is only reachable through the lazily-imported EditorPanel
    // (see shell/AppShell.tsx); importing CodeMirror statically from the
    // entry graph would make Vite modulepreload it in index.html again.
    rollupOptions: {
      output: {
        manualChunks: {
          codemirror: [
            "codemirror",
            "@codemirror/commands",
            "@codemirror/lang-markdown",
            "@codemirror/language",
            "@codemirror/state",
            "@codemirror/view",
          ],
          react: ["react", "react-dom"],
        },
      },
    },
  },
}));
