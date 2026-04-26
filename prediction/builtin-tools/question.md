# `question:`

Handler in [src/domain/builtin-tools/question.ts](../../implementation/src/domain/builtin-tools/question.ts), registered dynamically (it depends on the `InteractiveInputPort`) by [tool-resolver-adapter.ts](../../implementation/src/infrastructure/adapters/tool-resolver-adapter.ts).

Registration flags:

```ts
{ kind: "handler", frontmatter: { skipExecution: true, shouldVerify: false } }
```

The handler is constructed via `createQuestionHandler(interactiveInput)` so that the interactive adapter is injected at composition time rather than imported by the domain layer.

## Behavior

- Reads the prompt from the task payload (the text after `question:`).
- If a `- answer: <value>` sub-item already exists under the task, the handler **reuses it** without prompting and emits an info event (`tool.question.reusing-answer`). The task is auto-completed (no execution, no verification).
- Otherwise it asks the injected `InteractiveInputPort` to prompt the user:
  - If the task has `- option: <value>` sub-items, a `select` prompt is shown listing those options.
  - Otherwise a free-text `text` prompt is shown.
- The collected answer is normalized (CR/LF collapsed to spaces, trimmed) and persisted as a `- answer: <value>` sub-item directly in the source Markdown file.
- The task auto-completes after the answer is captured (`skipExecution: true`, `shouldVerify: false`).

## Options and defaults

Options are immediate child sub-items of the form `- option: <value>`. A single option may be marked as default by appending `(default)`:

```markdown
- [ ] question: Which bounded context should we prioritize?
  - option: authentication
  - option: billing (default)
  - option: notifications
```

Trailing `(default)` (case-insensitive) is stripped from the stored value.

## Non-interactive mode

When the interactive input port reports `isTTY() === false` (piped stdin, CI, etc.):

- If a default option is marked, that value is used and an info event (`tool.question.default-selected`) is emitted.
- If options exist but none is marked default, the handler fails with: *"Question cannot be answered in non-interactive mode because no default option is marked."*
- If there are no options at all, the handler fails with: *"Question cannot be answered in non-interactive mode because it has no options and no default answer."*

## Persistence

Answers are stored as sub-items in the source Markdown file itself, making them:

- Diff-friendly and version-controllable.
- Reusable on re-runs (cached unless the `- answer:` line is removed).
- Inserted immediately after the last `- option:` sub-item if any, otherwise as the first child of the task.

## Failure modes

- Empty payload &rarr; exit code 1, *"Question tool requires prompt text payload."*
- No `InteractiveInputPort` available &rarr; exit code 1, *"Question tool requires interactive input adapter."*
- User interrupts the prompt (Ctrl+C / abort) &rarr; exit code 130, *"Question prompt interrupted by user."*
- Empty answer from prompt &rarr; exit code 1, *"Question answer cannot be empty."*

## Example

```markdown
- [ ] question: Which bounded context should we prioritize?
  - option: authentication
  - option: billing (default)
```

After the user picks `authentication`:

```markdown
- [x] question: Which bounded context should we prioritize?
  - option: authentication
  - option: billing (default)
  - answer: authentication
```
