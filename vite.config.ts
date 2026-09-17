import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
// @ts-expect-error - plain ESM helper, no types needed for a config file
import { renderHeaders } from "./scripts/render-headers.mjs";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: 8080,
    hmr: {
      overlay: false,
    },
  },
  // `vite preview` serves the production response headers, read from
  // render.yaml so there is one source of truth. A Content Security Policy
  // that silently blocks the dictation WebSocket or the web fonts is worse
  // than no policy, and the only way to find that out is to load the built
  // app with the policy applied. The dev server deliberately does not get
  // them: it needs inline scripts for hot reload, which production forbids.
  preview: {
    port: 8085,
    headers: renderHeaders() as Record<string, string>,
  },
  plugins: [react()].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
}));
