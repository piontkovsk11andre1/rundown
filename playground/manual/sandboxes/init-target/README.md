# Init sandbox

Use this directory to manually verify `rundown init`.

Expected behavior:

- the first run creates `.rundown/execute.md`, `.rundown/verify.md`, `.rundown/repair.md`, `.rundown/plan.md`, and `.rundown/vars.json`
- the second run should keep the existing files and report that they already exist
