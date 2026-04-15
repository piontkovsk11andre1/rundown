# CLI: `list`

List unchecked tasks across the source.

Use `--all` to include checked tasks in the output.

Nested checkbox tasks and non-checkable list items are rendered under their parent task with indentation, preserving source order.

Example:

```bash
rundown list .
rundown list roadmap.md --all
```

Example hierarchical output:

```text
TODO.md:1 [#0] Release prep (blocked — has unchecked subtasks)
  TODO.md:2 - Confirm target branch
  TODO.md:3 [#1] Rewrite README opening
    TODO.md:4 [#2] Capture before/after screenshots
```

In this example, `Confirm target branch` is a non-checkable detail item, and the checkbox children are shown as nested task lines.
