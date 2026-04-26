# Built-in tools

Tool prefixes are recognized at the start of a task's text. Most built-ins are statically registered in [src/domain/builtin-tools/index.ts](../../implementation/src/domain/builtin-tools/index.ts); built-ins that need composition-time dependencies (`memory:` needs the memory writer, `question:` needs the interactive input port) are registered as **dynamic built-ins** in [src/infrastructure/adapters/tool-resolver-adapter.ts](../../implementation/src/infrastructure/adapters/tool-resolver-adapter.ts), which also extends the registry with project-level tools (`.md` template files or `.js` modules under `<config-dir>/tools/`).

## Files

| File | Topic |
|---|---|
| [registry.md](registry.md) | How resolution works and what `kind: handler|modifier` means |
| [verify.md](verify.md) | `verify:` / `confirm:` / `check:` |
| [memory.md](memory.md) | `memory:` / `memorize:` / `remember:` / `inventory:` |
| [for-loop.md](for-loop.md) | `for:` / `each:` / `foreach:` |
| [parallel.md](parallel.md) | `parallel:` / `concurrent:` / `par:` |
| [include.md](include.md) | `include:` — nested rundown delegation |
| [end-and-skip.md](end-and-skip.md) | `optional:`, `skip:`, terminal `end:`/`exit:`/`return:`/`quit:`/`break:` |
| [profile-and-force.md](profile-and-force.md) | The two modifiers: `profile=name` and `force:` |
| [get.md](get.md) | `get:` extraction handler |
| [question.md](question.md) | `question:` — interactive user-input capture |
