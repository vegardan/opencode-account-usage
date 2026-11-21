import { defineConfig } from "vite"
import solid from "vite-plugin-solid"
import { fileURLToPath } from "node:url"

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [solid()],
  server: { host: "127.0.0.1", port: 4173, strictPort: true },
})
