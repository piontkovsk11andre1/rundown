# Resumable document build

This non-AI example composes programmable Markdown, do-md generation/editing,
bounded script execution and durable recovery. Copy the directory before running
it; the plan and work directory are application data and will be updated.

From that copy, with Rundown installed locally:

```sh
rundown --check
rundown build
rundown build
```

The first run creates Work.md, Artifact.md and Receipt.md under each stable job
ID, verifies the artifact digest and marks the row done. The second run reports
an empty completed list and changes no artifacts.

## Interrupt between effects and the completion marker

Start with the original pending plan, then run:

```sh
rundown build --pause-after alpha
```

After the `Checkpoint ready` log, press Ctrl+C. The artifact and its verified
receipt already exist, while the parent completion checkbox is not yet committed.
Run `rundown build` again. Alpha is verified/reused (`built: false`) and beta is
built normally. The old artifact and receipt are not overwritten or rebuilt.

The test suite performs this interruption with a real child CLI and checks file
contents, modification time, completion markers and a subsequent no-op run.

## Contracts

- Plan rows have stable IDs, explicit status, a consistent checkbox and owner token.
- A live local owner blocks another runner. A dead or released owner can be reclaimed.
  Claims and completion use fresh Editors and revision-checked saves.
- Work generation is deterministic. Differing existing work/artifacts are conflicts,
  not overwrite targets. Output publication uses no-overwrite atomic file creation.
- Receipt verification precedes the plan completion save. Multi-file state is not
  presented as a transaction, and subprocess execution is not retried automatically.
- Cooperative cleanup records interruption; abrupt exit may leave a dead owner.
  This is a local-runner example. Multi-host ownership, PID reuse and external
  deployment reconciliation need application-specific policies.
- Completed rows are authoritative checkpoints. After changing completed inputs,
  review/reset the row and its generated work explicitly. This is not an automatic
  dependency-invalidation build system or an exactly-once deployment engine.

To incorporate the recipe into an existing project, copy the `automation` contents
into a distinct directory such as `workflows/pipeline`, copy/author a plan, and run
`rundown --connect workflows/pipeline/commands.md`. Resolve any command-name conflicts
before connecting. Native package imports require the dependencies in the consuming
project, just as ordinary JavaScript modules do.
