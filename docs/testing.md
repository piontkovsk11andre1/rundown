# Testing Rundown programs

Use static checks for structure and Markdown tests for behavior:

```sh
rundown --check
rundown --test
rundown --test tests/greeting.test.md
rundown --test tests --json
```

Default selection uses `rundown.tests` in the nearest `package.json`, relative to
that manifest. No test-directory fallback exists. Explicit files
and directories resolve from `--cwd`, without requiring a declaration. Directory discovery does not follow symlinks
or traverse `node_modules` and `.git`. Tests need not have a command catalog unless
they invoke project commands.

## Test documents are modules

There is no additional test grammar. Write an ordinary module document ending in
`.test.md`; every public method is a test case and private methods are helpers.
Dependencies, constants, defaults and executable bodies have their normal meaning.
Code in Examples remains documentation.

Methods receive positional `(t, context)` arguments:

- `t` is Node's actual TestContext, supporting hooks, subtests and native mocks.
- `context` is a fresh Rundown invocation context supporting bindings, callbacks,
  logging, metrics, cancellation and application spans.

Declare the arguments you use in Parameters. Both may be omitted when unused;
declare the first argument too when you need the second. Use `node:assert/strict`
for assertions. Throw or reject to fail a test.

The complete [greeting test](../examples/greeting/tests/greeting.test.md)
demonstrates module and command tests. Its module test imports the production
Markdown dependency and runs ordinary assertions:

```js
assert.equal(await greeting.greet(), "Hello, World!");
assert.equal(await greeting.greet("Ada"), "Hello, Ada!");
```

Document-relative dynamic loading works too:

```js
const greeting = await rundown.loadModule("../example/module.md");
assert.equal(await greeting.greet("Ada"), "Hello, Ada!");
```

## Test the real command boundary

Declare `@p10i/rundown/testing` as a JavaScript dependency, for example with binding
`testing`. In a method receiving `(t, context)`:

```js
const runtime = await testing.createTestRuntime(t, { cwd: context.workdir });
assert.equal(await runtime.invoke("example", { name: "Ada" }), "Hello, Ada!");
await assert.rejects(runtime.invoke("example", { name: 42 }), {
  code: "RUNDOWN_ARGUMENTS",
});
```

`createTestRuntime` loads the real catalog and registers `runtime.close()` with
`t.after`. It accepts normal Runtime options plus an optional `entry` catalog
path/URL. Use explicit `adapters`, `io` or `observability` options when a test needs
substitutes or captured observations. Invoke supports `{surface, signal}` as its
third argument. This checks runtime contracts without opening HTTP/MCP listeners;
transport interoperability can be tested separately using the existing surfaces.

Pure module tests call exports directly. Methods needing invocation capabilities
receive `context` explicitly, according to their normal documented signature.
External substitutes are ordinary explicit inputs or adapters; imports are not
rewritten and native module state is not reset between methods.

## Lifetime and isolation

Each file runs in its own Node test process. Methods in that file share the normal
ESM namespace and cache, while each gets an independent invocation context.
Execution uses the real Runtime lifecycle: accepted callbacks drain before a test
passes; cancellation signals active work; cleanup failures fail the test.
`--grace-ms` selects the cleanup grace, defaulting to 5000 ms. A command runtime
created with explicit options has its own configured grace.

The runner creates and removes temporary native entry files to bridge Node's test
runner to Markdown; project files remain untouched. Working directory changes
occur only in isolated workers, including on Node 22.

Await operations and subtests. Node's normal test rules apply; unfinished arbitrary
JavaScript cannot be forcibly stopped in-process. Use native test facilities for
fixtures and hooks, and explicit signals for cancellable operations.

The [callback tests](../examples/callbacks/tests/callbacks.test.md) exercise
a real MCP round trip using a deterministic project binding and check scoped
registration cleanup without contacting an external provider.

## Results

Human output identifies the document and method. Runtime failures retain original
Markdown source locations. `--json` returns `{ok, files, results}` with result names,
files, pass/fail flags and structured diagnostics. Test stdout/stderr is forwarded
to stderr so stdout stays machine-readable.

Assertion failures, import/compile failures, cleanup failures and empty discovery
exit nonzero. Early CLI/discovery errors use the normal stderr diagnostic envelope.
An empty module also fails: discovery alone is not a successful test.
