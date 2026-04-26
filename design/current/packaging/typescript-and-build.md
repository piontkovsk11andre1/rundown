# TypeScript and build

How source becomes shippable artifacts. Configs:

- [implementation/tsconfig.json](../../implementation/tsconfig.json) — TypeScript compiler settings (used for type checking).
- [implementation/tsup.config.ts](../../implementation/tsup.config.ts) — bundler config for the published artifact.

## TypeScript

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "**/*.test.ts"]
}
```

Key choices:

| Option | Why |
|---|---|
| `target: ES2022` | matches Node 18+; no down-compilation needed |
| `module: ESNext` + `moduleResolution: bundler` | tsup handles the bundling; TS just type-checks |
| `strict: true` | non-negotiable across the codebase |
| `isolatedModules: true` | compatible with bundler-only emission |
| `declaration` / `declarationMap` | shipped via tsup's `dts: true` for the library entry |
| `forceConsistentCasingInFileNames` | prevents Windows/Linux drift |

`tsc` is used **only** for type checking (`npm run lint`). It does not emit to `dist/`; tsup does.

## tsup — dual bundle

Two entries, two outputs:

```ts
defineConfig([
  // 1. CLI bundle
  {
    entry:    { cli: "src/presentation/cli.ts" },
    format:   ["esm"],
    target:   "node18",
    clean:    true,
    sourcemap: true,
    splitting: false,
    banner:   { js: "#!/usr/bin/env node" },
  },
  // 2. Library bundle
  {
    entry:    { index: "src/index.ts" },
    format:   ["esm"],
    target:   "node18",
    dts:      true,
    sourcemap: true,
    splitting: false,
  },
]);
```

Output layout:

```
dist/
├── cli.js          # CLI bundle, with shebang
├── cli.js.map
├── index.js        # library bundle
├── index.js.map
├── index.d.ts      # type declarations (library only)
└── index.d.ts.map
```

`splitting: false` keeps each entry self-contained — dead-code elimination is per-entry, no shared chunks. Slightly larger total size, but predictable runtime cost and easier debugging.

`clean: true` on the CLI bundle wipes `dist/` before each build; the library bundle then writes alongside.

## Why tsup over `tsc --build`

- One step produces ESM + types + sourcemaps for both entries.
- Bundles are self-contained — no hop through `package.json` exports for internal modules.
- `--watch` mode is fast enough for development.
- The `banner` option emits the shebang into the CLI bundle declaratively.

## Why no CJS

ESM-only cuts the matrix in half. Node 18+ supports ESM packages without flags. Consumers who need CJS can wrap the library entry; the CLI is a binary, not an importable module.

## Source map handling

Source maps are shipped (`sourcemap: true`). They reference paths relative to `dist/`, so stack traces in workers point back to source files even from the published package.

## Type declarations

Only the library entry emits `.d.ts`. The CLI bundle is invoked, not imported, so type declarations would be dead weight there.

## Build determinism

`npm ci` + locked dependencies + tsup with explicit target = byte-stable output for a given commit. CI verifies this by running `npm run build` on every PR; published versions are built fresh in `release.yml`.
