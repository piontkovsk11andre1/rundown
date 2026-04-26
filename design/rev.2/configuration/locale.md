# Locale

`rundown` supports per-project locale messages so CLI-facing strings can be localized. Implemented via [src/infrastructure/adapters/locale-adapter.ts](../../implementation/src/infrastructure/adapters/locale-adapter.ts) (port: `LocaleConfigPort`). Domain helpers in [src/domain/locale.ts](../../implementation/src/domain/locale.ts) and message catalog in [src/domain/messages.ts](../../implementation/src/domain/messages.ts).

## Files

| File | Purpose |
|---|---|
| `<config-dir>/locale.json` | Locale config: chosen locale, message overrides, aliases |
| `<config-dir>/locales/<locale>.json` | Optional per-locale message catalog |

## Resolution

At app construction:

1. `LocaleConfigPort.load(configDir)` reads `locale.json` if present.
2. Messages are extracted via `extractLocaleMessages(localeConfig)`.
3. The result is cached on the `AppPorts` bag as `localeMessages`.
4. Frontmatter `locale:` on a source overrides the chosen locale for that source's CLI output.

If no locale config exists, the built-in English messages from [src/domain/messages.ts](../../implementation/src/domain/messages.ts) are used.

## Application command — `localize-project`

[src/application/localize-project.ts](../../implementation/src/application/localize-project.ts).

A use case that walks built-in messages and emits a translation scaffold for the requested locale. Used by `init --locale <code>` and the dedicated `translate` command.

## Translate use case

[src/application/translate-task.ts](../../implementation/src/application/translate-task.ts) is the worker-driven translator that powers `localize-project` and the standalone `translate` CLI subcommand. See [../cli/planning-commands.md](../cli/planning-commands.md).

## What is localized

- All CLI-facing messages: errors, status lines, confirmations.
- The `AGENTS.md` template emitted by `start`.
- The locale-aware prompt fragments inserted into templates (e.g. "Verify the following…").

What is **not** localized:

- Trace event types (these are stable schema strings).
- Config keys.
- Worker patterns and arguments.
- Markdown task syntax — checkbox markers and prefixes are universal.

## Aliases

`locale.json` may declare aliases:

```json
{
  "locale": "ru",
  "aliases": { "ru-RU": "ru", "russian": "ru" }
}
```

Aliases are normalized at load time so users can write any of the configured forms.
