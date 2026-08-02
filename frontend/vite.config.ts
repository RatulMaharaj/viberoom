import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 7666, // ROOM on a phone keypad
    proxy: {
      '/api': 'http://127.0.0.1:8423', // VIBE
    },
  },
})
