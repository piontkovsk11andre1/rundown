# Prediction Reconciliation

This document defines when downstream predicted migrations/snapshots are considered stale and must be reconciled.

## Scope

- Completed migrations are immutable historical fact and are never rewritten by reconciliation.
- Reconciliation only replaces or regenerates pending predicted items from the first stale point forward.
- Staleness detection compares the current migration/TODO inputs to the baseline captured when predictions were generated.

## Prediction Baseline Inputs

When a predicted sequence is generated, capture a baseline fingerprint for:

- migration step files (`NNNN-name.md`) and their semantic content;
- migration ordering/identity (number + slug/filename);
- context satellites that affect planning (`NNNN--context.md`, and if used by template, `--snapshot.md` / `--backlog.md`);
- execution frontier (last completed migration number and first pending predicted migration number).

## Staleness Trigger Conditions

Mark downstream predictions stale when any condition below is true.

1. Semantic TODO/task changes in an already completed migration file.
   - Added/removed checklist items.
   - Checklist text changed.
   - Task ordering changed.
   - Checkbox state changed in a way that alters completed intent/history.

2. Semantic migration-body changes in an already completed migration file.
   - Requirements, constraints, acceptance notes, or implementation guidance changed.
   - Sections that feed AI context changed (not just cosmetic formatting).

3. Structural migration sequence changes at or before the pending frontier.
   - Migration file added/removed/renamed/re-numbered.
   - Migration numbers reordered or no longer contiguous by intent.
   - Slug changes that alter migration identity (`0008-old-name.md` -> `0008-new-name.md`).

4. Planning-context satellite changes at or before the pending frontier.
   - `--context.md` changed for the latest completed position.
   - Any satellite included in prediction prompts (`--snapshot.md`, `--backlog.md`) changed.

5. Manual edits to a pending predicted migration.
   - Treat the edited migration as the new starting point and invalidate only that file and later pending files.
   - Completed migrations before that point remain untouched.

## Non-Trigger Conditions

Do not mark predictions stale for:

- whitespace-only or line-ending-only edits;
- formatting-only edits that do not change semantic markdown content;
- known runtime residue lines (for example trace/fix/skipped annotations) when excluded by normalization;
- changes in unrelated files outside the prediction input set.

## Invalidation Boundary Rules

- If a completed migration (<= last completed) changes, invalidate from the first pending migration.
- If a pending migration changes, invalidate from that migration onward.
- Never invalidate or rewrite already completed migration artifacts; only recalculate pending plan/satellites.

## Suggested Detection Contract

- Normalize files before hashing (trim trailing spaces, normalize newlines, strip known runtime residue).
- Store per-file semantic hashes plus an ordered sequence hash.
- On mismatch, derive earliest affected migration number and mark pending predictions from that point as stale.
- Record `staleReason` values for auditability (for example: `task_text_changed`, `sequence_changed`, `context_changed`, `pending_manual_edit`).
