# CLI: `test`

Verify assertion specs in either materialized or prediction mode.

By default, `test` validates assertions against the materialized workspace and explicitly excludes prediction inputs (`design/`, `specs/`, `migrations/`) from test context.

When `--future` is set, `test` switches to prediction mode and validates assertions using design + migration context only.

Synopsis:

```bash
rundown test [action] [options] -- <command>
rundown test [action] [options] --worker <pattern>
```

Actions:

- omitted: verify all specs in the specs directory
- `new <assertion>`: create a new assertion spec file

Options:

| Option | Description | Default |
|---|---|---|
| `--dir <path>` | Specs directory. | `./specs` |
| `--future [n]` | Prediction mode. Without `n`, uses latest prediction (`latest snapshot + migrations`). With `n`, uses targeted prediction (`previous snapshot + migrations up to n`). | off |
| `--run` | For `test new`, create then immediately verify the new spec. | off |
| `--mode <tui|wait>` | For `test new`, choose interactive or non-interactive assertion authoring mode. | `wait` |
| `--worker <pattern>` | Worker pattern override (alternative to `-- <command>`). | unset |

Template resolution:

- Materialized mode (`test` without `--future`): `.rundown/test-materialized.md` -> `.rundown/test-verify.md` -> built-in default
- Prediction mode (`test --future`): `.rundown/test-future.md` -> `.rundown/test-verify.md` -> built-in default

Harness/environment hints:

- `RUNDOWN_TEST_MODE` = `materialized` or `future`
- `RUNDOWN_TEST_FUTURE_TARGET` = migration target when `--future` is used
- `RUNDOWN_TEST_INCLUDED_DIRECTORIES` = JSON array of included directories
- `RUNDOWN_TEST_EXCLUDED_DIRECTORIES` = JSON array of excluded directories
