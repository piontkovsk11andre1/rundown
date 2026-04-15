# CLI: `config`

Manage rundown configuration without editing JSON files manually.

Scope model:

- `local`: project config file at `<config-dir>/config.json`.
- `global`: user-level defaults file (cross-workspace baseline).
- `effective`: merged read view (`built-in defaults -> global -> local -> CLI overrides`).

Global path conventions:

- Linux: `$XDG_CONFIG_HOME/rundown/config.json` (fallback: `~/.config/rundown/config.json`)
- macOS: `~/Library/Application Support/rundown/config.json` (discovery also checks `$XDG_CONFIG_HOME/rundown/config.json` then `~/.config/rundown/config.json`)
- Windows: `%APPDATA%\rundown\config.json` (discovery also checks `%LOCALAPPDATA%\rundown\config.json`, `%USERPROFILE%\AppData\Roaming\rundown\config.json`, then `~/.config/rundown/config.json`)

Discovery behavior:

- `config path --scope global` prints the canonical path for the current platform.
- Global/effective reads use deterministic ordered discovery and load the first existing file.
- If no global file exists, global scope is treated as empty.

Layer merge semantics (`global` -> `local`):

- Object sections merge by key so local can override only the keys it sets.
- Array-valued fields are replace-by-value (no concatenation): local replaces global when present.
- Map entries (`commands.<name>`, `profiles.<name>`) are replace-by-entry: same key in local replaces global key.
- Nested health policy objects deep-merge by key (`cooldownSecondsByFailureClass`, `unavailableReevaluation`).

Edge-case behavior:

- Missing sections do not clear lower-priority values; only explicitly provided keys override.
- Empty nested objects (for example `{}`) do not erase lower-priority nested values.
- Invalid JSON or schema at the discovered global path fails fast with a path-specific error before applying local merges.
- If both global and local omit a section, that section is omitted from effective output.

Scope defaults:

- read operations (`get`, `list`): `effective`
- write operations (`set`, `unset`): `local`

`effective` is read-only.

Synopsis:

```bash
rundown config get <key> [options]
rundown config list [options]
rundown config set <key> <value> [options]
rundown config unset <key> [options]
rundown config path [options]
```

Subcommands:

| Subcommand | Description |
|---|---|
| `get <key>` | Read one config value by dotted path (for example `workers.default`). |
| `list` | Print all keys/values for a scope. |
| `set <key> <value>` | Set a value at key path in writable scope (`local` or `global`). |
| `unset <key>` | Remove a key from writable scope (`local` or `global`). |
| `path` | Print resolved config file path for a scope. |

Common options:

| Option | Description | Applies to |
|---|---|---|
| `--scope <effective|local|global>` | Select config scope. | all subcommands |
| `--json` | Emit JSON output (stable machine format). | `get`, `list` |
| `--show-source` | Include source attribution for `effective` reads (`built-in`, `global`, `local`, `flag`). | `get`, `list` |
| `--type <auto|string|number|boolean|json>` | Parse mode for `<value>`. | `set` |

Behavior notes:

- `set`/`unset` fail fast when `--scope effective` is requested.
- `set --type auto` parses JSON literals (`true`, `42`, `{"k":1}`, `[...]`) and falls back to string.
- `set --type json` requires `<value>` to be valid JSON.
- `get` exits non-zero when key is missing in selected scope.
- `list --scope effective --show-source` includes per-key attribution where practical.

Examples:

```bash
# Read merged value (global + local + defaults)
rundown config get workers.default

# Inspect local-only override
rundown config get workers.default --scope local

# Set project-local default worker
rundown config set workers.default '["opencode","run","--file","$file","$bootstrap"]' --type json --scope local

# Set user-level global command override
rundown config set commands.plan '["opencode","run","--file","$file","$bootstrap","--model","gpt-5.3-codex"]' --type json --scope global

# Remove a local command override so global/default can apply
rundown config unset commands.plan --scope local

# List merged config with attribution
rundown config list --scope effective --show-source --json

# Show where global config is stored on this machine
rundown config path --scope global
```

## Worker command forms

`rundown` separates the source to scan from the worker command that performs the task.

Preferred forms:

```bash
rundown run <source> -- <command>
rundown run <source> --worker <pattern>
```

If both are provided, `--worker` takes precedence.

`--worker` is optional when rundown can resolve a worker from `.rundown/config.json`.

With a freshly initialized empty config (`{}`), no worker is resolved by default. In that case, provide one explicitly using either `--worker <pattern>` or `-- <command>`.

Worker resolution cascade (lowest to highest priority):

- `workers.default` in `.rundown/config.json` (or `workers.tui` when mode is `tui`)
- `commands.<command>` in `.rundown/config.json` (`run`, `plan`, `discuss`, `help`, `research`, `reverify`, `verify`, `memory`)
- `commands.tools.<toolName>` in `.rundown/config.json` for tool-prefix-specific worker overrides (for example `tools.post-on-gitea`)
- Markdown frontmatter `profile: <name>`
- Parent directive item `- profile=<name>` for child checkbox tasks
- Parent directive item `- cli-args: <args>` for child `cli:` checkbox tasks (appends `<args>` to each child inline CLI command)
- Prefix modifier `profile=<name>` on the selected checkbox task
- CLI `--worker` or separator form `-- <command>`

Profile behavior:

- Named profiles are defined under `profiles` in `.rundown/config.json`.
- A resolved profile contributes a full worker command array and replaces the current command at its precedence level.

## Unified tool prefixes

Checkbox task prefixes resolve through one tool pipeline.

Task form:

```md
- [ ] <tool-name>: <payload>
```

Built-in handler aliases:

- Verify-only: `verify:`, `confirm:`, `check:`
- Memory capture: `memory:`, `memorize:`, `remember:`, `inventory:`
- Fast execution (skip verification): `fast:`, `raw:`, `quick:`
- Conditional control flow (skip remaining siblings when condition is true): `optional:`, `skip:`, `end:`, `return:`, `quit:`, `break:`
- Include markdown file execution: `include:`
- Outer retry wrapper: `force:`

`optional:` is the canonical control-flow prefix in v1, with `skip:` as the preferred concise alias.
Compatibility aliases `end:`, `return:`, `break:`, and `quit:` remain supported in v1 for backward compatibility.
All listed control-flow aliases resolve to the same handler and behavior.

Built-in modifier:

- `profile=`

Composition examples:

```md
- [ ] verify: docs are up to date
- [ ] profile=fast, verify: tests pass
- [ ] profile=complex; memory: capture architecture decisions
```

Composition rules:

- Prefix segments split on `, ` or `; ` only when the next segment starts with a known tool name.
- Modifier tools apply left-to-right and patch execution context.
- Handler tools are terminal and run task behavior.
- Modifier-only chains still run default execution/verification with the patched context.

Intent prefix notes:

- `fast:`, `raw:`, and `quick:` are aliases that force execution without verification for that task (the inverse of `verify:`).
- `fast:` / `raw:` / `quick:` can also be used as directive parents (`- fast:` / `- raw:` / `- quick:`) so child checkbox tasks inherit fast-execution intent.
- `cli-args:` can be used as a directive parent (`- cli-args: <args>`) so child `cli:` checkbox tasks inherit appended CLI arguments.
- Prefix detection is case-insensitive and allows whitespace around `:`.
- For mixed intent prefixes, the first explicit prefix in task text wins (for example `verify: fast: ...` stays verify-only, `fast: verify: ...` stays fast-execution).

## Memory capture prefixes

If a selected task starts with a memory prefix, rundown treats it as a memory-capture tool task.

Supported aliases:

- `memory:`
- `memorize:`
- `remember:`
- `inventory:`

Prefix parsing rules:

- Matching is case-insensitive.
- Whitespace around `:` is allowed.
- The payload is everything after the first matched prefix.
- Empty payload fails with exit code `1`.

Execution behavior:

- Rundown executes the normalized payload as the worker prompt.
- On successful worker output, rundown appends the captured content to source-local memory.
- Memory-capture tasks still follow normal run lifecycle behavior (verification/repair/checkbox handling) unless overridden by flags.

Storage layout (source-local):

- Memory body file: `<source-dir>/.rundown/<source-basename>.memory.md`
- Memory index file: `<source-dir>/.rundown/memory-index.json`

Index metadata is keyed by canonical absolute source path and stores a compact summary for each source (plus diagnostic metadata such as update time).

Example:

```md
- [ ] memory: capture release checklist assumptions and deployment caveats
```

## Custom tool prefixes

You can define custom task prefixes by adding `.js` handlers or `.md` templates under configured tool directories (`toolDirs` in `config.json`, default `<config-dir>/tools/`).

Each tool file name becomes a runnable prefix:

- `.rundown/tools/post-on-gitea.js` -> `post-on-gitea:`
- `.rundown/tools/summarize.md` -> `summarize:`

Task form:

```md
- [ ] <tool-name>: <payload>
```

Execution behavior for `.md` tools:

- Rundown resolves `<tool-name>` to `<config-dir>/tools/<tool-name>.md`.
- The tool template is rendered with standard task template vars plus `{{payload}}`.
- The rendered prompt is sent to the worker.
- Worker output is parsed for unchecked TODO items (`- [ ] ...`) and inserted as child tasks.
- The tool task is treated as structural expansion and does not run verification itself.

Resolution rules:

- Project `.js` tools are resolved first and can override built-ins.
- Built-in tools are resolved next (`verify:`/`confirm:`/`check:`, memory aliases, fast/raw/quick aliases, `optional:`/`skip:` control-flow aliases, `include:`, `profile=`, `force:`).
- Project `.md` tools are resolved after built-ins (for non-built-in names).
- Tool matching is case-insensitive and checks the text before the first `:`.
- Unknown prefixes fall back to normal `execute-and-verify` behavior.
- Empty tool payload fails with exit code `1`.

`cli:` and `rundown:` are parser-level task forms and are not resolved through the tool pipeline.

Example:

```md
- [ ] post-on-gitea: open an issue for the broken auth callback flow
```

With `.rundown/tools/post-on-gitea.md` present, rundown runs that template and expands the task into child TODO items.

## Common options

### Verification and repair

- `--no-verify` — skip verification
- `--only-verify` — verify without executing first
- verify-only task text auto-skips execute phase (for example `verify: ...`, `confirm: ...`, `check: ...`)
- fast-execution task text auto-skips verification (for example `fast: ...`, `raw: ...`, `quick: ...`), even when global `--verify` is enabled
- `--force-execute` — override verify-only auto-skip and run execute phase anyway
- `force: <task>` — wrap a task in an outer retry loop that reruns the full iteration on retryable failure
- `force: <attempts>, <task>` — same as above with per-task retry limit override
- `--force-attempts <n>` — default outer retry attempts for `force:` tasks when count is omitted
- `--force-execute` and `force:` are independent: `--force-execute` decides whether verify-only text still runs execution, while `force:` decides whether a failed iteration is retried
- `force:` is a no-op in `--mode detached`: detached task dispatch returns immediate success (`continueLoop: false`, `exitCode: 0`), so outer retries never trigger
- `--repair-attempts <n>` — retry repair up to `n` times
- `--no-repair` — disable repair explicitly

When verification fails, rundown surfaces the failure reason in user-visible output at each stage:

- Initial failure before repair: `Verification failed: <reason>. Running repair (N attempt(s))...`
- After each failed repair attempt: `Repair attempt N failed: <reason>`
- Final failure (including immediate `--no-repair`): `Last validation error: <reason>`

If the worker does not provide details, rundown prints fallback reasons (for example `Verification worker exited with code N.` or `Verification failed (no details).`).

### Execution mode

- `--mode wait` — start the worker and wait
- `--mode tui` — start an interactive terminal session and continue after exit
- `--mode detached` — start the worker without waiting

### Worker patterns and prompt delivery

Rundown always writes the rendered task prompt to a runtime file and supports worker pattern placeholders:

- `$file` — replaced with the prompt file path on disk
- `$bootstrap` — replaced with a short instruction telling the worker to read the prompt file

If neither `$file` nor `$bootstrap` appears in the worker pattern, rundown appends `$file` as the final argument (backward-compatible default).

Important: `$file` and `$bootstrap` are pure string substitutions inside the command line. They do not imply any particular CLI semantics for the target worker. For example, `--file $file` passes the prompt file path via the worker's `--file` flag, but if that worker also requires a separate message or prompt argument, you must supply one (for example, by adding `$bootstrap` as a positional argument).

Examples:

```bash
# Attach prompt file and provide a bootstrap message for the worker
rundown run roadmap.md --worker 'opencode run --file $file $bootstrap'

# Worker receives bootstrap text as its prompt flag
rundown run roadmap.md --worker 'opencode run --prompt "$bootstrap" --file $file'

# No placeholder used -> rundown appends $file automatically
rundown run roadmap.md --worker 'opencode run'
```
