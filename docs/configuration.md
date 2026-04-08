# Configuration

`rundown` supports layered worker configuration from `.rundown/config.json`.

This lets you:

- define a default worker so you do not need `--worker` on every command,
- set per-command worker overrides (`run`, `plan`, `discuss`, `help`, `research`, `reverify`, `verify`, `memory`, `tools.<toolName>`),
- define named profiles (for model or other worker args),
- configure inline task trace statistics written under completed TODOs,
- apply profiles from file frontmatter, directive parent list items, or `profile:` prefix modifiers,
- override everything from the CLI when needed.

## Config file

Path: `<config-dir>/config.json` (typically `.rundown/config.json`).

When created by `rundown init`, this file starts as an empty JSON object (`{}`).

That means no default worker is configured until you add one. Worker-required commands (`run`, `plan`, `discuss`, `research`, `reverify`) must receive a worker explicitly via `--worker <command...>` or `-- <command>` when config is empty.

Example:

```json
{
  "defaults": {
    "worker": ["opencode", "run"]
  },
  "commands": {
    "plan": {
      "worker": ["opencode", "run"],
      "workerArgs": ["--model", "opus-4.6"]
    },
    "discuss": {
      "worker": ["opencode"]
    },
    "research": {
      "worker": ["opencode", "run"],
      "workerArgs": ["--model", "opus-4.6"]
    },
    "verify": {
      "worker": ["opencode", "run"],
      "workerArgs": ["--model", "gpt-5.3-codex"]
    },
    "memory": {
      "worker": ["opencode", "run"],
      "workerArgs": ["--model", "gpt-5.3-codex"]
    },
    "tools.post-on-gitea": {
      "worker": ["opencode", "run"],
      "workerArgs": ["--model", "gpt-5.3-codex", "--tools", "web-search"]
    }
  },
  "profiles": {
    "complex": {
      "workerArgs": ["--model", "opus-4.6"]
    },
    "fast": {
      "workerArgs": ["--model", "gpt-5.3-codex"]
    }
  }
}
```

## Schema

All command arrays and arg arrays must be JSON arrays of strings.

```json
{
  "defaults": {
    "worker": ["string", "..."],
    "workerArgs": ["string", "..."]
  },
  "commands": {
    "<commandName>": {
      "worker": ["string", "..."],
      "workerArgs": ["string", "..."]
    }
  },
  "profiles": {
    "<profileName>": {
      "worker": ["string", "..."],
      "workerArgs": ["string", "..."]
    }
  },
  "traceStatistics": {
    "enabled": true,
    "fields": ["total_time", "tokens_estimated"]
  }
}
```

Section behavior:

- `defaults`: global baseline for all commands.
- `commands.<name>`: override/extend defaults for one command (for example `plan`, `verify`, or `memory`).
- `commands.tools.<toolName>`: override/extend defaults for one tool-expansion prefix task (for example `tools.post-on-gitea`).
- `profiles.<name>`: named reusable profile values, selected from frontmatter, directives, or prefix modifiers.
- `traceStatistics`: controls optional inline trace summary lines written below completed checkbox tasks.

## Trace statistics

`traceStatistics` config controls whether rundown inserts human-readable execution statistics under tasks it marks complete.

Example:

```json
{
  "traceStatistics": {
    "enabled": true,
    "fields": [
      "total_time",
      "execution_time",
      "verify_time",
      "repair_time",
      "idle_time",
      "tokens_estimated",
      "phases_count",
      "verify_attempts",
      "repair_attempts"
    ]
  }
}
```

Behavior:

- `enabled`: turns inline trace statistics insertion on or off.
- `fields`: ordered list of metric field names to render.
- unknown field names are rejected at config-load time.

Defaults:

- if `traceStatistics` is omitted, rundown keeps statistics disabled by default.
- if `--trace` or `--trace-stats` is used and `traceStatistics` is omitted, rundown enables statistics with default fields:
  - `total_time`
  - `tokens_estimated`
- if `traceStatistics.fields` is omitted while `enabled` is true, rundown uses the same default field list.

Available field names:

- `total_time`: total task duration.
- `execution_time`: execution phase duration.
- `verify_time`: verification phase duration.
- `repair_time`: repair phase duration.
- `idle_time`: idle/wait time from waterfall timing.
- `tokens_estimated`: estimated prompt tokens used.
- `phases_count`: number of phases completed.
- `verify_attempts`: verification attempts used.
- `repair_attempts`: repair attempts used.

Rendered output shape:

```markdown
- [x] Implement feature X
    - total time: 522s
        - execution: 5s
        - verify: 12s
    - tokens estimated: 429391
```

Notes:

- statistics are inserted only when a task is actually completed by `run`.
- existing statistics are de-duplicated, and stale ones are cleaned during redo/reset flows.

## Resolution cascade

Worker resolution applies this precedence (lowest to highest):

1. `config.defaults`
2. `config.commands.<command>`
3. file frontmatter `profile: <name>`
4. directive parent `profile: <name>`
5. prefix modifier `profile: <name>`
6. CLI `--worker` / `-- <command>`

Notes:

- CLI worker command always wins.
- Referencing an unknown profile name is an error.
- If no worker is resolved from CLI or config, worker-required commands fail with guidance to configure `.rundown/config.json`.

## Worker and workerArgs merging

`worker` and `workerArgs` are merged across layers.

- `worker` is replaced by higher-priority layers when provided.
- `workerArgs` are appended in cascade order.

Example:

- base worker: `["opencode", "run"]`
- profile args: `["--model", "opus-4.6"]`
- resolved command: `opencode run --model opus-4.6`

## Frontmatter profile

Use Markdown frontmatter to set a file-level profile:

```markdown
---
profile: complex
---

- [ ] Task A
- [ ] Task B
```

All tasks in the file inherit this profile unless a higher-precedence layer overrides it.

## Directive parent syntax

A plain (non-checkbox) list item can provide context to child checkbox tasks.

Supported directive parents:

- `profile: <name>`: children inherit that profile.
- `verify:` / `confirm:` / `check:`: children are treated as verify-only tasks.
- `fast:` / `raw:`: children execute with verification suppressed.

Example:

```markdown
- profile: fast
  - [ ] Quick task A
  - [ ] Quick task B

- check:
  - [ ] All tests pass
  - [ ] Linting clean
```

Colon prefixes on checkbox text are also supported for verify-only intent:

```markdown
- [ ] verify: docs are up to date
```

Fast execution aliases are also supported on checkbox text:

```markdown
- [ ] fast: update changelog headings
- [ ] raw: regenerate API docs summary
```

## Unified prefix tool chain

Checkbox task prefixes now resolve through one tool pipeline.

General form:

```markdown
- [ ] <tool-name>: <payload>
```

Prefix chains compose modifiers and a terminal handler:

```markdown
- [ ] profile: fast, verify: release checks pass
- [ ] profile: complex; memory: capture migration constraints
```

Composition rules:

- segments split on `, ` or `; ` only when the next segment starts with a known tool prefix,
- modifier tools apply left-to-right and patch context,
- handler tools are terminal and execute the task behavior,
- when a chain has only modifiers (for example `profile: fast`), rundown runs default execute+verify with modified context.

Built-in handler aliases:

- verify-only: `verify:`, `confirm:`, `check:`
- memory capture: `memory:`, `memorize:`, `remember:`, `inventory:`
- fast execution (skip verification): `fast:`, `raw:`
- end control flow (skip remaining siblings when condition is true): `end:`, `return:`, `skip:`, `quit:`
- include task file: `include:`

Decision: `return:`, `skip:`, and `quit:` are aliases of `end:` in v1.
All four prefixes resolve to the same handler and semantics; no alias has distinct behavior.

Built-in modifier:

- `profile:`

## Tool templates

Custom tool prefixes are discovered from configured tool directories.

Layout:

```text
<config-dir>/
  config.json
  tools/
    post-on-gitea.md
    summarize.md
```

You can customize lookup locations with `toolDirs` in `config.json`.
Directories are resolved relative to `<config-dir>` unless absolute, and are searched in listed order.

```json
{
  "toolDirs": ["tools", "shared-tools"]
}
```

A task that starts with `<tool-name>:` resolves as a tool when a matching `.js` or `.md` tool exists.

```markdown
- [ ] post-on-gitea: open an issue for failed login callback handling
```

Template variables:

- Standard task variables are available (`{{task}}`, `{{file}}`, `{{context}}`, `{{source}}`, etc.).
- `{{payload}}` is the text after the first `:` in the task.

Resolution and precedence:

- Project `.js` tools in `toolDirs` are checked first and can override built-ins.
- Built-in tools are checked next (`verify:`/`confirm:`/`check:`, memory aliases, fast/raw aliases, `include:`, `profile:`).
- Project `.md` tools are checked after built-ins (for non-built-in tool names).
- Unknown prefixes do not error; they fall back to normal task execution.
- Empty payload for handler tools is invalid and fails fast.

Intent precedence notes:

- Explicit text prefixes are classified in this order: verify -> memory -> fast/raw -> tool-expansion -> default execute+verify.
- For mixed explicit prefixes, the first prefix in task text wins (`verify: fast: ...` remains verify-only; `fast: verify: ...` remains fast-execution).

Special parser-level prefixes:

- `cli:` and `rundown:` are handled directly by rundown and do not go through tool resolution.

Bracket prefixes (`[verify]`, `[confirm]`, `[check]`) are not supported.

## Template vars in shell environments

Values provided with `--var key=value` (and via `--vars-file`) are also exported to shell processes as environment variables.

Naming format:

- `RUNDOWN_VAR_<NAME>` where `<NAME>` is the variable key uppercased.
- Example: `--var db_host=localhost` -> `RUNDOWN_VAR_DB_HOST=localhost`

These variables are available in all rundown shell execution contexts:

- fenced `cli` blocks,
- `cli:` inline tasks,
- worker command execution,
- lifecycle hooks.

## Unsupported profile sub-item form

`profile: <name>` as a direct sub-item under a checkbox task is ignored.

Example (ignored profile directive):

```markdown
- [ ] Parent task
  - profile: fast
```

When this pattern is detected, rundown emits:

`"profile: X" as a task sub-item is not supported — use it as a parent list item or in file frontmatter.`

Use one of these supported forms instead:

- file frontmatter `profile: <name>`, or
- a plain parent list item `- profile: <name>` with child checkboxes.
