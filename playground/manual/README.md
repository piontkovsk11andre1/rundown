# rundown manual playground

This directory is a copyable manual verification playground for `rundown`.

Use it to walk through the full CLI surface with a real worker command, verify expected file changes by hand, and hand the same directory to a client as a structured acceptance checklist.

## What this covers

- standard `run` execution and verification
- `next` and `list`
- child-before-parent task selection
- `--only-verify`
- repair retries with `--retries`
- inline `cli:` tasks
- `plan`
- glob and directory sources
- sorting modes
- runtime artifacts
- `init`

## Quick start

Inside this repository:

1. Run `npm install`
2. Run `npm run build`
3. Change into this directory
4. Use `node ../../dist/cli.js` as the CLI prefix

If you copy this playground into another repository where `rundown` is already installed, replace `node ../../dist/cli.js` with `rundown`.

## Recommended worker commands

Examples in the checklist use `opencode run`, but any compatible worker command is fine.

PowerShell 5.1 users should prefer:

```powershell
node ../../dist/cli.js run tasks/01-happy-path.md --worker opencode run
```

Other shells can use:

```bash
node ../../dist/cli.js run tasks/01-happy-path.md -- opencode run
```

## Resetting the playground

Run this before a new verification pass:

```bash
node scripts/reset.mjs
```

That script restores the Markdown task files, removes generated outputs, clears validation sidecars, removes `.rundown/runs`, and resets the `init` sandbox.

## Sorting helper

To create a newer file for `--new-first` and `--old-first` checks:

```bash
node scripts/create-newer-sort-file.mjs
```

Reset afterward with `node scripts/reset.mjs`.

## Files

- `CHECKLIST.md` — step-by-step client-facing manual verification
- `.rundown/` — playground templates and variables
- `tasks/` — scenario files
- `scripts/` — helper scripts for reset and sorting demos
- `sandboxes/init-target/` — safe directory for `rundown init`
