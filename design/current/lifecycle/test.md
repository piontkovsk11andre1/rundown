# Test

`rundown test [source]` verifies assertion specs against the current workspace.

## Materialized mode

```text
rundown test specs/
```

- Reads specs from the source argument (default: `specs/`).
- Evaluates each assertion against the implementation as it exists on disk now.
- Used as a quality gate after `materialize`.
- Pass means the implementation satisfies the spec right now.

## Spec format

Specs are Markdown files of checkbox-style assertions. Each assertion is a verify-only task that reads workspace context and returns `OK` or a failure reason on stdout, using the same verification contract as the run loop.

Future-mode testing is no longer part of rundown.
