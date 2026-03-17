# TUI Mode

This example is meant to be run in interactive TUI mode with `opencode`.

```bash
md-todo run examples/08-tui/Tasks.md --mode tui -- opencode
```

`md-todo` will:

1. Select the next unchecked task
2. Render the prompt
3. Launch `opencode` in TUI mode with the prepared context
4. You inspect, steer, and work inside the TUI
5. You quit with `/q`
6. `md-todo` resumes and optionally validates

## Tasks

- [ ] Refactor the main module to use async/await instead of callbacks
- [ ] Review the error messages and make them more user-friendly
- [ ] Add a `--verbose` flag that prints detailed execution logs
