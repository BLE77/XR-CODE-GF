import fs from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { iwsdkDev } from "@iwsdk/vite-plugin-dev";

const httpsKeyPath = process.env.XR_METAQUEST_HTTPS_KEY;
const httpsCertPath = process.env.XR_METAQUEST_HTTPS_CERT;
const backendTarget = process.env.XR_METAQUEST_BACKEND_TARGET || "ws://127.0.0.1:8765";
// Keep IWSDK emulation local-only so `localhost` gets the Quest 3 simulator,
// while Quest Browser on the LAN IP still exercises real headset behavior.
const localIwsdkEmulator = {
  device: "metaQuest3",
  environment: "office_large",
  activation: "localhost",
} as const;
const httpsConfig =
  httpsKeyPath && httpsCertPath
    ? {
        key: fs.readFileSync(httpsKeyPath),
        cert: fs.readFileSync(httpsCertPath),
      }
    : undefined;

function yukiAssetHeaders() {
  const setAssetHeaders = (url: string, response: { setHeader(name: string, value: string): void }) => {
    if (url.endsWith(".vrm") || url.endsWith(".glb")) {
      response.setHeader("Content-Type", "model/gltf-binary");
      response.setHeader("Cache-Control", "public, max-age=3600");
    }
  };

  return {
    name: "yuki-asset-headers",
    configureServer(server: {
      middlewares: {
        use(handler: (request: { url?: string }, response: { setHeader(name: string, value: string): void }, next: () => void) => void): void;
      };
    }) {
      server.middlewares.use((request, response, next) => {
        setAssetHeaders(request.url ?? "", response);
        next();
      });
    },
    configurePreviewServer(server: {
      middlewares: {
        use(handler: (request: { url?: string }, response: { setHeader(name: string, value: string): void }, next: () => void) => void): void;
      };
    }) {
      server.middlewares.use((request, response, next) => {
        setAssetHeaders(request.url ?? "", response);
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    iwsdkDev({ emulator: localIwsdkEmulator }),
    yukiAssetHeaders(),
  ],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          "three-vendor": ["three"],
          "vrm-vendor": ["@pixiv/three-vrm", "three/examples/jsm/loaders/GLTFLoader.js"],
        },
      },
    },
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    allowedHosts: true,
    https: httpsConfig,
    proxy: {
      "/xr-agent-events": {
        target: backendTarget,
        ws: true,
        changeOrigin: true,
      },
    },
  },
  preview: {
    host: "0.0.0.0",
    port: 4173,
    https: httpsConfig,
  },
});
