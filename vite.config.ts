import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig({
  plugins: [viteSingleFile()],
  build: {
    outDir: "dist/shell",
    rollupOptions: {
      input: "src/shell/view-shell.html",
    },
  },
});
