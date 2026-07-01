/// <reference types="vitest/config" />
import { defineConfig } from "vitest/config"
import react from "@vitejs/plugin-react"

// The web client is a plain SPA that speaks the v1 protocol over a native
// browser WebSocket. Tests run in jsdom with globals so RTL auto-cleanup works.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
  },
})
