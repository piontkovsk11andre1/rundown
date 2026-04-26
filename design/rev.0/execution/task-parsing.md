# Task parsing

[src/domain/parser.ts](../../implementation/src/domain/parser.ts) extracts `Task[]` from a Markdown source using `mdast-util-from-markdown` plus the GFM task list item extensions.

## Accepted forms

```markdown
- [ ] task            ← unchecked
* [x] task            ← checked, asterisk bullet
+ [ ] task            ← plus bullet
  - [ ] nested task   ← child of the parent above
    - sub-instruction ← non-checkbox bullet (sub-item)
```

All three GFM bullet markers (`-`, `*`, `+`) are accepted. Indentation uses spaces only; tabs are not part of the canonical contract.

## `Task` shape

```ts
interface Task {
  text: string;          // raw line, e.g. "- [ ] verify: tests pass"
  checked: boolean;
  index: number;         // position in flat list (used in artifact paths and validation sidecars)
  line: number;          // 1-based line in source
  column: number;        // checkbox column offset
  offsetStart: number;   // byte offsets for in-place edits
  offsetEnd: number;
  depth: number;         // 0 for top-level checkbox
  children: Task[];      // nested checkbox children
  subItems: SubItem[];   // nested non-checkbox bullets (carry instructions, profiles, vars)
  isInlineCli: boolean;  // text starts with "cli:"
  intent?: TaskIntent;
  directiveProfile?: string; // inherited from a parent directive list item
  taskProfile?: string;      // from a `profile=name` sub-item
}
```

## Sub-items

A non-checkbox bullet nested directly under a checkbox is a **sub-item**. Sub-items carry:

- inline instructions (free text used in prompts),
- `profile=name` modifiers (only valid in frontmatter or directive parents — see [../workers/resolution-order.md](../workers/resolution-order.md)),
- `vars-file=…` redirects,
- per-task overrides used by certain tools (`for:`, `verify:`).

## Frontmatter

YAML frontmatter is recognized at the top of a source file. Fields used by rundown:

```yaml
---
profile: fast
rundown:
  profiles:
    local-model: ["opencode", "run", "--model", "local/gpt", "$bootstrap"]
---
```

`profile` is the file-level default profile. The nested `rundown.profiles` map is local-only; it does not bleed into `.rundown/config.json`.

## Directive list items

A list item with no checkbox that is the parent of one or more checkboxes is a **directive**. Directives carry profile and tool prefixes that apply to all checkbox children:

```markdown
- profile=thinking
  - [ ] task A
  - [ ] task B
```

This is equivalent to placing `profile=thinking` as a sub-item under each child.

## What parsing does **not** do

- It does not validate worker availability or template variables.
- It does not classify intents — that is done lazily in [task-intent.ts](../../implementation/src/domain/task-intent.ts) at iteration time.
- It does not normalize whitespace beyond what mdast does. Round-tripping `text` is byte-exact through `offsetStart`/`offsetEnd`.
