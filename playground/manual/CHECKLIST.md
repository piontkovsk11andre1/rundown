# Manual verification checklist

Use this as a client-facing acceptance checklist for `md-todo`.

Unless noted otherwise, commands below assume you are already in `playground/manual`.

Choose one CLI prefix and use it consistently:

- in this repo: `node ../../dist/cli.js`
- in a copied playground: `md-todo`

The commands below use `md-todo` for readability.

## 0. Reset and confirm setup

- [ ] Run `node scripts/reset.mjs`
- [ ] Confirm `.md-todo/execute.md`, `.md-todo/verify.md`, `.md-todo/repair.md`, `.md-todo/plan.md`, and `.md-todo/vars.json` exist
- [ ] Confirm `outputs/` is empty except for `.gitkeep`

## 1. Inspect next-task and list behavior

- [ ] Run `md-todo next tasks/01-happy-path.md`
- [ ] Confirm the selected task is the only unchecked task in `tasks/01-happy-path.md`
- [ ] Run `md-todo list tasks`
- [ ] Confirm unchecked tasks are listed across the scenario files
- [ ] Run `md-todo next tasks/02-nested.md`
- [ ] Confirm the selected task is the child task, not the parent task

## 2. Standard execute → verify → check flow

- [ ] Run `md-todo run tasks/01-happy-path.md --worker opencode run`
- [ ] Confirm `tasks/01-happy-path.md` is now checked
- [ ] Confirm `outputs/happy-path.txt` exists
- [ ] Confirm `outputs/happy-path.txt` contains exactly two lines:
  1. `md-todo manual run: success`
  2. `mode=execute-verify`
- [ ] Confirm no `tasks/01-happy-path.md.1.validation` file remains after success

## 3. Child-before-parent task execution

- [ ] Run `md-todo run tasks/02-nested.md --worker opencode run`
- [ ] Confirm the child task is checked and the parent task remains unchecked
- [ ] Confirm `outputs/nested-selection.txt` contains exactly one line: `child-first`
- [ ] Run `md-todo next tasks/02-nested.md`
- [ ] Confirm the parent task is now the next runnable task
- [ ] Run `md-todo run tasks/02-nested.md --worker opencode run`
- [ ] Confirm the parent task is checked
- [ ] Confirm `outputs/nested-selection.txt` now has a second line: `parent-ready`

## 4. Verify-only failure without repair

- [ ] Run `md-todo run tasks/03-verify-repair.md --only-verify --worker opencode run`
- [ ] Confirm the command fails verification and the task remains unchecked
- [ ] Confirm `tasks/03-verify-repair.md.1.validation` exists
- [ ] Confirm the validation file explains that `outputs/verify-repair.txt` is missing or incorrect

## 5. Repair retry after failed verification

- [ ] Replace `outputs/verify-repair.txt` with incorrect content such as `broken`
- [ ] Run `md-todo run tasks/03-verify-repair.md --only-verify --retries 1 --worker opencode run`
- [ ] Confirm the repair flow fixes the output and verification passes
- [ ] Confirm `tasks/03-verify-repair.md` is now checked
- [ ] Confirm `outputs/verify-repair.txt` contains exactly `repaired-and-verified`
- [ ] Confirm the validation sidecar is removed after success

## 6. Inline CLI task

- [ ] Run `md-todo run tasks/05-inline-cli.md --no-verify`
- [ ] Confirm `tasks/05-inline-cli.md` is checked
- [ ] Confirm `outputs/inline-cli.txt` exists
- [ ] Confirm `outputs/inline-cli.txt` contains exactly two lines:
  1. `inline-cli: success`
  2. `transport=direct-shell`

Optional verification pass with a worker command:

- [ ] Reset the playground
- [ ] Run `md-todo run tasks/05-inline-cli.md --worker opencode run`
- [ ] Confirm the inline task executes and then verifies successfully

## 7. Planner flow

- [ ] Run `md-todo plan tasks/04-plan.md --worker opencode run`
- [ ] Confirm new unchecked child tasks were inserted directly below the parent task
- [ ] Confirm the inserted items use Markdown task syntax (`- [ ]`)
- [ ] Run `md-todo next tasks/04-plan.md`
- [ ] Confirm one of the new child tasks is selected instead of the parent task

## 8. Directory, glob, and sorting modes

- [ ] Run `md-todo next tasks/sorting --sort name-sort`
- [ ] Confirm `tasks/sorting/10-alpha.md` is selected before `tasks/sorting/20-beta.md`
- [ ] Run `md-todo list "tasks/glob/**/*.md" --all`
- [ ] Confirm both glob scenario files are discovered
- [ ] Run `md-todo next "tasks/glob/**/*.md" --sort name-sort`
- [ ] Confirm `tasks/glob/a/10-glob-a.md` is selected first
- [ ] Run `node scripts/create-newer-sort-file.mjs`
- [ ] Run `md-todo next tasks/sorting --sort new-first`
- [ ] Confirm `tasks/sorting/99-generated-newer.md` is selected first
- [ ] Run `md-todo next tasks/sorting --sort old-first`
- [ ] Confirm one of the original seeded files is selected before the generated newer file

## 9. Runtime artifacts

- [ ] Run `node scripts/reset.mjs`
- [ ] Run `md-todo run tasks/01-happy-path.md --keep-artifacts --worker opencode run`
- [ ] Run `md-todo artifacts`
- [ ] Confirm at least one saved run appears
- [ ] Run `md-todo artifacts --json`
- [ ] Confirm JSON output includes the run id and command metadata
- [ ] Run `md-todo artifacts --failed`
- [ ] Confirm failed runs are filtered correctly if any exist
- [ ] Run `md-todo artifacts --clean`
- [ ] Confirm `.md-todo/runs` is empty afterward

## 10. Init command

- [ ] Run `node scripts/reset.mjs`
- [ ] Change into `sandboxes/init-target`
- [ ] Run `md-todo init`
- [ ] Confirm `.md-todo/execute.md`, `.md-todo/verify.md`, `.md-todo/repair.md`, `.md-todo/plan.md`, and `.md-todo/vars.json` were created
- [ ] Confirm the generated files are readable defaults and the command does not overwrite existing files on a second run

## 11. Exit-code spot checks

- [ ] Confirm successful commands return exit code `0`
- [ ] Confirm a verification failure returns exit code `2`
- [ ] Confirm a no-target case returns exit code `3`, for example after all tasks in a file are checked

## Done

- [ ] Record which worker command and shell were used during verification
- [ ] Record any flow that behaved differently from the expected results above
