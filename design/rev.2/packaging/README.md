# Packaging

How rundown is built, packaged, tested, and shipped as a Node CLI + library.

## Files

| File | Topic |
|---|---|
| [npm-package.md](npm-package.md) | `package.json` shape — bins, exports, files, dependencies |
| [typescript-and-build.md](typescript-and-build.md) | `tsconfig.json` + `tsup.config.ts` — dual bundle |
| [testing.md](testing.md) | `vitest.config.ts` + `__tests__/` layout |
| [public-api.md](public-api.md) | Library entry — what `import { … } from "@p10i/rundown"` exposes |
