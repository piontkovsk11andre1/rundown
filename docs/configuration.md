# Configuration

`rundown` supports layered worker configuration from `.rundown/config.json`.

This lets you:

- define a default worker so you do not need `--worker` on every command,
- set per-command worker overrides (`run`, `plan`, `discuss`, `research`, `reverify`, `verify`, `memory`, `tools.<toolName>`),
- define named profiles (for model or other worker args),
- apply profiles from file frontmatter or directive parent list items,
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
  }
}
```

Section behavior:

- `defaults`: global baseline for all commands.
- `commands.<name>`: override/extend defaults for one command (for example `plan`, `verify`, or `memory`).
- `commands.tools.<toolName>`: override/extend defaults for one tool-expansion prefix task (for example `tools.post-on-gitea`).
- `profiles.<name>`: named reusable profile values, selected from frontmatter or directives.

## Resolution cascade

Worker resolution applies this precedence (lowest to highest):

1. `config.defaults`
2. `config.commands.<command>`
3. file frontmatter `profile: <name>`
4. directive parent `profile: <name>`
5. CLI `--worker` / `-- <command>`

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

## Tool templates

Custom tool prefixes are discovered from Markdown templates in `<config-dir>/tools/`.

Layout:

```text
<config-dir>/
  config.json
  tools/
    post-on-gitea.md
    summarize.md
```

A task that starts with `<tool-name>:` is treated as a tool-expansion task when the matching template file exists.

```markdown
- [ ] post-on-gitea: open an issue for failed login callback handling
```

Template variables:

- Standard task variables are available (`{{task}}`, `{{file}}`, `{{context}}`, `{{source}}`, etc.).
- `{{payload}}` is the text after the first `:` in the task.

Resolution and precedence:

- Built-in prefixes are evaluated first (`verify:`/`confirm:`/`check:`, memory aliases, `cli:`, `rundown:`).
- Tool names are resolved against `<config-dir>/tools/<name>.md`.
- Unknown prefixes do not error; they fall back to normal task execution.
- Empty tool payload is invalid and fails fast.

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
