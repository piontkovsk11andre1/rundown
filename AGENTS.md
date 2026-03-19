# AGENTS.md

## Mission

Build `rundown` as a serious, polished, publishable open source product.

This repository is not a toy demo. It should become a professional CLI and an agentic framework for executing work directly from Markdown TODOs.

The core idea:

- scan Markdown from a file, directory, or glob,
- find the next unchecked task,
- build a structured prompt from Markdown context,
- run a worker command or inline CLI task,
- validate the result,
- optionally correct it,
- and only then mark the task complete.

## Product understanding

`rundown` is a Markdown-native task runtime.

It is more than a todo parser and more than a wrapper around an AI CLI. It is a small agentic framework with three distinct phases:

1. execution,
2. validation,
3. correction.

The framework is driven by Markdown templates stored in project-local files:

- `.rundown/execute.md`
- `.rundown/verify.md`
- `.rundown/repair.md`
- `.rundown/plan.md`

The behavior and concepts in [PROMPT.md](PROMPT.md) are the source product definition. Keep implementation aligned with that document unless the user explicitly changes direction.

## Non-negotiable quality bar

Everything in this repository should feel deliberate, elegant, and release-ready.

Priorities:

- clear product concept,
- excellent CLI ergonomics,
- deterministic behavior,
- safe and understandable execution,
- strong documentation,
- clean architecture,
- professional naming,
- excellent repository presentation.

Avoid hacky solutions, accidental complexity, and vague behavior.

## Repository standard

Shape the repository like a polished public package that could be noticed immediately on GitHub, npm, and package indexes.

The repository should feel:

- minimal,
- crisp,
- modern,
- well-structured,
- and confidently documented.

Expected traits:

- concise root layout,
- obvious entry points,
- readable source organization,
- good defaults,
- high-quality examples,
- tests for core behavior,
- tidy release metadata,
- no junk files,
- no confusing scaffolding.

## README standard

The README is product surface, not an afterthought.

It must look strong from the first screen.

It should quickly communicate:

- what `rundown` is,
- why it is different,
- why it matters,
- how it works,
- and how to use it in under a minute.

The README should present `rundown` as an agentic framework for Markdown workflows.

It should feel catchy, professional, and credible.

Recommended README flow:

1. sharp one-line value proposition,
2. short conceptual description,
3. minimal example,
4. why this exists,
5. key features,
6. how the task / validate / correct loop works,
7. template-driven workflow,
8. examples with real commands such as `opencode`,
9. installation,
10. CLI overview,
11. project structure,
12. roadmap or future ideas.

Use examples that are realistic and attractive.

## Product language

Use language that is:

- precise,
- calm,
- confident,
- modern,
- technically serious.

Avoid:

- hype with no substance,
- vague AI buzzwords,
- sloppy CLI terminology,
- overly cute naming.

Good framing:

- Markdown-native
- task runtime
- agentic workflow
- template-driven execution
- validation loop
- correction loop
- deterministic task selection

## Implementation principles

When developing the product:

- preserve deterministic behavior,
- prefer explicit concepts over hidden magic,
- keep the CLI small but extensible,
- make Windows behavior reliable,
- assume large prompts and quoting edge cases,
- prefer file-based prompt transport when robustness matters,
- design for real publishing, not prototype-only usage.

When there is a tradeoff, choose the version that improves clarity, durability, and user trust.

## CLI principles

The CLI should feel clean and unsurprising.

Target qualities:

- easy to explain from memory,
- strong defaults,
- explicit modes when behavior changes,
- stable output,
- good errors,
- sensible exit codes,
- predictable ordering.

The user should feel that the tool is dependable in automation and pleasant in manual use.

## Documentation principles

Every important behavior should be documented clearly:

- task detection,
- file selection,
- sorting,
- runner modes,
- prompt transport,
- inline CLI tasks,
- validation sidecar files,
- correction retries,
- template files.

If a behavior would surprise a new user, document it.

## Engineering principles

Prefer:

- small composable modules,
- good naming,
- shallow abstractions,
- pure logic where possible,
- isolated side effects,
- testable parsing and selection logic,
- focused integration layers for process execution and file updates.

Core logic that should remain easy to test:

- Markdown task detection,
- task indexing,
- source expansion,
- sorting,
- prompt rendering,
- validation file naming,
- checkbox updates,
- retry logic.

## Release mindset

Build as if this will be published broadly and judged immediately.

That means:

- package metadata should be polished,
- command help should read well,
- examples should be copyable,
- versioned releases should be clean,
- the repository should be visually trustworthy,
- first-run experience should be good.

## What success looks like

A successful version of `rundown` should make a technically strong first impression:

- the idea is instantly understandable,
- the README is memorable,
- the CLI looks elegant,
- the repository feels mature,
- the implementation matches the concept,
- and advanced users can immediately see how it fits into agentic tooling.

## Agent behavior for this repository

When making decisions:

- keep the product aligned with [PROMPT.md](PROMPT.md),
- improve clarity before adding complexity,
- protect the quality bar,
- write docs as carefully as code,
- and prefer professional finish over fast but messy output.

If a choice affects public perception of the project, choose the more polished option.
