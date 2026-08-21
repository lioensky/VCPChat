import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    fs: {
      allow: [resolve(__dirname, '../..')],
    },
  },
})
