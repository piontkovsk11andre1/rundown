# Tool registry

Tools are resolved at iteration time from a tiered registry.

## Tiers (highest priority first)

1. **Project-level `.md` tools** — files under `<config-dir>/tools/<name>.md` are template-style tools. The handler in [src/domain/builtin-tools/template-tool.ts](../../implementation/src/domain/builtin-tools/template-tool.ts) renders the template with task context and runs it as the prompt.
2. **Project-level `.js` tools** — ESM modules under `<config-dir>/tools/<name>.js` exporting a handler. They run in-process and have access to the ports passed in.
3. **Built-in dynamic registrations** — currently `memory:` (and aliases), registered by the resolver adapter because it depends on `MemoryWriterPort`.
4. **Built-in static registrations** — entries in [src/domain/builtin-tools/index.ts](../../implementation/src/domain/builtin-tools/index.ts).

The first match wins. Project-level tools can shadow built-ins, which is intentional: it lets users override a built-in behavior locally.

## Handler vs modifier

Each registration has a `kind`:

- **`handler`** — owns dispatch for the task. The handler decides whether to run worker execution, whether to verify, and what completion looks like.
- **`modifier`** — wraps the underlying intent without taking over dispatch. Modifiers can adjust the resolved profile, force flags, etc., then yield to the next prefix.

Handler frontmatter flags (declared in the registration):

| Flag | Effect |
|---|---|
| `skipExecution` | suppress the standard worker-execute phase |
| `shouldVerify` | run verification after the handler returns |
| `autoComplete` | the handler is responsible for completion (skips standard checkbox flow) |

## Prefix chaining

Multiple prefixes can be stacked:

```
- [ ] profile=fast force: verify: spec passes
```

Resolution walks left-to-right ([src/domain/prefix-chain.ts](../../implementation/src/domain/prefix-chain.ts)):

- modifiers attach metadata,
- the first **handler** prefix wins; remaining prefixes are passed to the handler as context.

In the example above: `profile=fast` (modifier) sets the profile, `force:` (modifier) disables repair, `verify:` (handler) runs verify-only with the assembled config.

## Frontmatter recognition

Project `.md` tools may declare frontmatter that influences dispatch flags:

```yaml
---
skipExecution: true
shouldVerify: true
---
Tool template body…
```

This mirrors the static registration shape so user-authored tools have the same expressive power.

## Tool name resolution

Names are case-insensitive (lowercased before lookup). Aliases are explicit registrations (e.g. `confirm` → `verify`'s handler). The framework deliberately avoids implicit aliasing such as one-letter shortcuts (`g`) to reduce collisions with project-defined names.
