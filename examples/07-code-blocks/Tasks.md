# Code Blocks Should Be Ignored

This file tests that tasks inside fenced code blocks are **not** detected.

## Real tasks

- [x] This is a real task that should be found
- [x] This was already completed

## Example in documentation

Here is how you write a task list in Markdown:

```markdown
- [ ] This is inside a code block and should NOT be detected
- [ ] Neither should this one
- [x] Or this checked one
```

Another real task:

- [x] This is another real task outside the code block

## Inline code

Mentioning `- [ ] task syntax` inline should also not create a task.
