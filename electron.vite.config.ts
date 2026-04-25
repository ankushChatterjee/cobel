import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    build: {
      // @opencode-ai/sdk is ESM-only (exports lack "require"); bundling inlines it so the CJS main bundle does not call require() on it.
      externalizeDeps: {
        exclude: ['@opencode-ai/sdk']
      }
    }
  },
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    worker: {
      format: 'es'
    },
    plugins: [react(), tailwindcss()]
  }
})
