import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: {
      cli: "src/presentation/cli.ts",
      mcp: "src/presentation/mcp.ts",
      rndn: "src/presentation/rndn.ts",
    },
    format: ["esm"],
    target: "node20",
    clean: true,
    sourcemap: true,
    splitting: false,
    banner: {
      js: "#!/usr/bin/env node",
    },
  },
  {
    entry: { "presentation/tui/index": "src/presentation/tui/index.ts" },
    format: ["esm"],
    target: "node20",
    sourcemap: true,
    splitting: false,
  },
  {
    entry: { index: "src/index.ts" },
    format: ["esm"],
    target: "node20",
    dts: true,
    sourcemap: true,
    splitting: false,
  },
]);
