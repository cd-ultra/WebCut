import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * WebCut — Vite configuration.
 *
 * - host 0.0.0.0 so the dev server is reachable from outside the Docker container.
 * - COOP/COEP headers enable cross-origin isolation, which unlocks
 *   SharedArrayBuffer for onnxruntime-web's multithreaded WASM backend.
 * - onnxruntime-web is excluded from dependency pre-bundling: it resolves its
 *   own .wasm / .mjs artifacts at runtime and esbuild pre-bundling breaks those paths.
 * - base "./" emits relative asset URLs so the static build works under any path,
 *   including a GitHub Pages project subpath (e.g. <user>.github.io/webcut/).
 */
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
    watch: {
      // Docker-on-Windows bind mounts do not propagate inotify events reliably.
      usePolling: true,
      interval: 250,
    },
  },
  preview: {
    host: "0.0.0.0",
    port: 5173,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  optimizeDeps: {
    exclude: ["onnxruntime-web"],
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
  worker: {
    format: "es",
  },
});
