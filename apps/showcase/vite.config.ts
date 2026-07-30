import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const resolve = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  base: "./",
  resolve: {
    alias: {
      "@gamespace/core": resolve("../../packages/core/src/index.ts"),
      "@gamespace/ui-web": resolve("../../packages/ui-web/src/index.ts"),
      "@gamespace/games": resolve("../../packages/games/src/index.ts"),
      "@gamespace/protocol": resolve("../../packages/protocol/src/index.ts"),
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
