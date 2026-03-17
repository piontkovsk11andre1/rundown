# Examples

This directory contains example Markdown files that demonstrate different `md-todo` use cases.

Each subdirectory is a self-contained scenario you can try with the CLI.

## Quick start

```bash
# See what tasks are pending
md-todo list examples/

# Show the next task
md-todo next examples/

# Run with a worker
md-todo run examples/01-basic/ -- opencode run

# Dry run to preview
md-todo run examples/ --dry-run --worker opencode run

# Print the rendered prompt
md-todo run examples/01-basic/ --print-prompt --worker opencode run
```
