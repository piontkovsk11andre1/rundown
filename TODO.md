## Feature: Re-verify the previous task

<details>
<summary>Context</summary>

`rundown run --only-verify` currently verifies the next selected unchecked task.

We need a dedicated command to re-run verification for the **previously completed task** (typically the last successful task in the current repo), without advancing task selection.

Why this matters:
- Verification templates can evolve after a task was checked.
- A user may want a quick confidence check before release/push.
- This should be deterministic and auditable, not based on fuzzy task matching.

Relevant current behavior and implementation anchors:
- Runtime artifacts already persist task metadata (`file`, `line`, `text`, `index`, `source`) in `.rundown/runs/*/run.json`.
- Artifacts are sorted by `startedAt` and can resolve `latest`.
- Verification logic is implemented in `run-task` via the existing verify/repair loop and templates.

Proposed product behavior:
- Add a new command: `rundown reverify`.
- Default target: latest completed task from saved run artifacts in current working directory.
- Re-run verify (and optional repair retries) against that exact task context.
- Do **not** check/uncheck any checkbox during reverify.
- Return non-zero on verification failure.

Suggested initial CLI options:
- `--run <id|latest>`: choose artifact run (default `latest`).
- `--retries <n>` / `--no-repair`: reuse repair policy semantics.
- `--print-prompt`, `--dry-run`, `--worker <command...>`, `--transport <...>`, `--keep-artifacts`.

Out of scope for first iteration:
- Bulk re-verify of multiple historical tasks.
- Mutating task state during reverify.

</details>

## TODO

- [x] Define command UX and help text in CLI docs (`rundown reverify`, options, examples, exit codes).
- [x] Add `reverify` command wiring in `src/presentation/cli.ts`.
- [x] Add application use case (e.g. `src/application/reverify-task.ts`) that:
- [x] Loads target run metadata (`latest`/explicit run id) from `ArtifactStore`.
- [x] Validates run/task metadata presence and emits clear actionable errors.
- [x] Resolves the task in the current Markdown file using persisted metadata (line/index/text fallback strategy).
- [x] Reconstructs template vars/context needed by verify/repair prompts.
- [x] Executes verify/repair loop using existing ports and retry policy.
- [x] Ensures no checkbox mutation occurs in reverify flow.
- [x] Persists runtime artifacts for the reverify command with explicit status values (e.g. `reverify-completed`, `reverify-failed`).
- [x] Update docs: `README.md` and `docs/cli.md` with command purpose and examples.
- [x] Add unit tests for target resolution and metadata mismatch scenarios.
- [ ] Add integration tests for CLI behavior and exit codes:
- [ ] success path (verification passes),
- [ ] failure path (verification fails),
- [ ] missing artifacts,
- [ ] stale task reference (task moved/edited),
- [ ] invalid run id.
- [ ] Add tests to confirm reverify does not modify Markdown checkboxes.
- [ ] Add tests for `--dry-run` and `--print-prompt` behavior.
- [ ] Document residual edge cases and follow-up work (e.g., handling heavily edited files).

## Acceptance criteria

- [ ] `rundown reverify` can verify the latest completed task deterministically.
- [ ] Verification result is clearly surfaced with stable exit codes.
- [ ] No task selection advance and no checkbox mutation occurs.
- [ ] Command is documented and covered by tests.
