import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// During dev, proxy API calls to the Express server on :3001.
// The production build is emitted to client/dist and served by Express.
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // We ship our own service worker (src/sw.ts) so we can handle `push`
      // events; Workbox still precaches the built assets via injectManifest.
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      registerType: "autoUpdate",
      injectRegister: "auto",
      devOptions: {
        enabled: true,
        type: "module",
      },
      manifest: {
        name: "פלוטו — סטטוס הכלב",
        short_name: "פלוטו",
        description: "מעקב אחר הסטטוס של הכלב המשפחתי פלוטו",
        lang: "he",
        dir: "rtl",
        display: "standalone",
        orientation: "portrait",
        start_url: "/",
        scope: "/",
        theme_color: "#16a34a",
        background_color: "#16a34a",
        icons: [
          {
            src: "/web-app-manifest-192x192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "/web-app-manifest-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "/web-app-manifest-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
  },
});
