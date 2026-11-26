# Release procedure

## Source and dependency baseline

The canonical npm package occupies this standalone repository's root. Its examples,
templates, Skill and reference are release inputs. Historical workspace material
outside this repository is not part of the package.
The selected published do-md baseline is exactly `2.0.0-rc.2`; the newer do-md
source candidate must be published and verified before changing that dependency.
Rundown does not require a remote do-md service for its library operations.

## Verification gates

```sh
npm ci
npm run check
npm audit
```

CI runs these checks on Ubuntu and Windows with Node 22.15, 24 and 26. Local
success is not evidence that all matrix jobs passed. Windows tests cover native
executables, paths, AbortSignals and package installation. The POSIX child-signal
console-interrupt test is explicitly skipped there: child.kill does not emulate
a real Windows console Ctrl+C event. Interactive console behavior and live
project-level harness integrations require separate explicit verification.

## Freeze a candidate

After reviewing and committing the package/workflow changes, run:

```sh
npm run release:candidate
```

`npm run release:candidate -- --verify-inputs` performs only the clean-input/version
preflight; it does not claim verification or create a candidate.

The script checks repository-root Git cleanliness, including the local CI workflow,
runs checks/audit, verifies unchanged HEAD and inputs, packs actual bytes, verifies
npm integrity, and writes a tarball plus SHA-256/integrity/runtime manifest under
`.release/<version>-<commit>/`. All repository source changes must be committed;
ignored caches and candidate artifacts are not release inputs.

Existing candidate directories are never overwritten. A failed partial directory
without manifest.json is not a frozen candidate and should be inspected explicitly.
The manifest records only the platform actually used; attach CI results separately.

Review the candidate tarball and evidence before any separately authorized tag,
push or npm publication. No release script performs those actions.
