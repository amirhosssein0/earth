import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: '/earth/',
  resolve: { alias: { tinyqueue: 'tinyqueue/tinyqueue.js' } },
  optimizeDeps: { esbuildOptions: { alias: { tinyqueue: 'tinyqueue/tinyqueue.js' } } },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['earth-topology.png', 'night-sky.png', 'apple-touch-icon-180x180.png'],
      manifest: {
        name: 'Swim Globe',
        short_name: 'SwimGlobe',
        description: 'Find the sea route between any two places on Earth',
        theme_color: '#050816',
        background_color: '#050816',
        display: 'standalone',
        icons: [
          { src: 'pwa-64x64.png', sizes: '64x64', type: 'image/png' },
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,ico}'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
      },
    }),
  ],
});