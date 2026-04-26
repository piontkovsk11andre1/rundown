# Architecture

`rundown` follows a strict hexagonal (port/adapter) architecture. Domain logic is pure and framework-independent; all I/O is mediated by ports; infrastructure adapters provide concrete implementations; the CLI layer is the only presentation surface.

## Files

| File | Topic |
|---|---|
| [layers.md](layers.md) | The four layers (`domain`, `application`, `infrastructure`, `presentation`) and what belongs in each |
| [ports-and-adapters.md](ports-and-adapters.md) | Full port → adapter mapping and contract conventions |
| [composition-root.md](composition-root.md) | How [src/create-app.ts](../../implementation/src/create-app.ts) wires everything together |
| [dependency-rules.md](dependency-rules.md) | Direction-of-dependency rules and what is allowed to import what |
| [module-map.md](module-map.md) | One-line description of every file in [src/](../../implementation/src/) |
