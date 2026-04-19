import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['src/main/**/*.{test,spec}.ts', 'src/shared/**/*.{test,spec}.ts']
  }
})
