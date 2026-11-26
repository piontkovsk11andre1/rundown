import { test, run } from "node:test";
import { readdir, stat, mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { formatDiagnostic } from "@p10i/do-md";
import { loadModule } from "./Loader.mjs";
import { Runtime } from "./Runtime.mjs";
import { diagnostic, diagnose, RundownError } from "./Error.mjs";
import { projectPath } from "./Project.mjs";
import { documentURL } from "./Paths.mjs";

/** Register one ordinary Markdown module with Node; called only in a test worker.
 * @param {URL} url
 * @param {number} [graceMs]
 */
export async function registerTestFile(url, graceMs = 5000) {
  let methods;
  try {
    const namespace = await loadModule(url);
    methods = Object.entries(namespace).filter(
      ([, value]) => typeof value === "function",
    );
    if (!methods.length)
      throw new RundownError(
        "RUNDOWN_TEST_EMPTY",
        `No public test methods in ${url.href}`,
      );
  } catch (error) {
    test(`${url.href}#load`, () => {
      throw diagnose(error);
    });
    return;
  }
  for (const [name, method] of methods) {
    test(`${url.href}#${name}`, async (t) => {
      // A private in-memory command gives module tests the production invocation
      // lifecycle without exposing a synthetic command in the project's catalog.
      const command = {
        name,
        description: "Markdown test",
        parameters: [],
        returns: { type: "unknown", description: "Test result" },
        surfaces: ["*"],
        url: url.href,
        location: {
          role: "document",
          relation: "processing",
          source: url.href,
          range: { start: { offset: null, line: 1, column: 1 }, end: null },
          precision: "context",
          snippet: null,
        },
        schema: { type: "object" },
        validate: () => {},
        handler: (
          /** @type {Record<string,unknown>} */ _args,
          /** @type {import('./types.mjs').InvocationContext} */ context,
        ) => /** @type {Function} */ (method)(t, context),
      };
      const runtime = new Runtime(
        /** @type {import('./types.mjs').Catalog} */ ({
          entry: url.href,
          commands: new Map([[name, command]]),
        }),
        { cwd: process.cwd(), graceMs },
      );
      t.after(() => runtime.close());
      await runtime.invoke(name, {}, { signal: t.signal });
    });
  }
}

/** Discover only explicit test modules; do not traverse symlinks or dependencies.
 * @param {string} target
 * @param {boolean} explicit
 * @returns {Promise<string[]>}
 */
async function discoverTests(target, explicit) {
  let info;
  try {
    info = await stat(target);
  } catch (error) {
    if (
      !explicit &&
      /** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT"
    )
      return [];
    throw error;
  }
  if (info.isFile()) {
    if (!target.endsWith(".test.md"))
      throw new RundownError(
        "RUNDOWN_TEST_PATH",
        "Test files must end in .test.md",
      );
    return [target];
  }
  const files = [];
  for (const entry of (await readdir(target, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    if (["node_modules", ".git"].includes(entry.name)) continue;
    const path = join(target, entry.name);
    if (entry.isDirectory()) files.push(...(await discoverTests(path, true)));
    else if (entry.isFile() && entry.name.endsWith(".test.md"))
      files.push(path);
  }
  return files;
}

/** Execute test files in Node's isolated workers, returning a bounded-shape report.
 * @param {{cwd:string,file?:string,signal?:AbortSignal,graceMs?:number,json?:boolean}} options
 */
export async function runTests({
  cwd,
  file,
  signal,
  graceMs = 5000,
  json = false,
}) {
  cwd = resolve(cwd);
  const files = await discoverTests(
    file
      ? fileURLToPath(documentURL(file, undefined, cwd))
      : projectPath(cwd, "tests"),
    true,
  );
  if (!files.length)
    throw new RundownError("RUNDOWN_TEST_EMPTY", "No Markdown tests found");
  // Native Node entry files allow import/compile failures to become ordinary
  // failing tests. Only these tiny bridges are temporary; project files are untouched.
  const temporary = await mkdtemp(join(tmpdir(), "rundown-tests-"));
  try {
    const workers = [];
    for (const [index, file] of files.entries()) {
      const worker = join(temporary, `${index}.mjs`);
      await writeFile(
        worker,
        `import {registerTestFile} from ${JSON.stringify(import.meta.url)};\nprocess.chdir(${JSON.stringify(cwd)});\nawait registerTestFile(new URL(${JSON.stringify(pathToFileURL(file).href)}), ${graceMs});\n`,
        { flag: "wx" },
      );
      workers.push(worker);
    }
    const stream = run({ files: workers, signal });
    /** @type {{name:string,file?:string,ok:boolean,error?:import('./types.mjs').Diagnostic}[]} */
    const results = [];
    const reported = new Set();
    /** @param {typeof results[number]} result */
    const record = (result) => {
      results.push(result);
      if (!json) {
        process.stdout.write(
          `${result.ok ? "PASS" : "FAIL"} ${result.file ?? ""} ${result.name}\n`,
        );
        if (result.error)
          process.stderr.write(formatDiagnostic(result.error) + "\n");
      }
    };
    for await (const event of stream) {
      const { type, data } = event;
      if (type === "test:stdout" || type === "test:stderr") {
        process.stderr.write(data.message);
      } else if (type === "test:pass" || type === "test:fail") {
        const split = data.name.lastIndexOf("#");
        const identified = data.name.startsWith("file:") && split > 0;
        const workerIndex = workers.indexOf(data.file ?? "");
        // A clean worker exit without any registered Markdown cases is not a test.
        if (!identified && workerIndex >= 0 && type === "test:pass") continue;
        const result = {
          name: identified ? data.name.slice(split + 1) : data.name,
          file: identified
            ? fileURLToPath(data.name.slice(0, split))
            : (files[workerIndex] ?? data.file),
          ok: type === "test:pass",
          ...(type === "test:fail"
            ? { error: testDiagnostic(data.details.error) }
            : {}),
        };
        if (result.file && (identified || workerIndex >= 0))
          reported.add(result.file);
        record(result);
      }
    }
    for (const file of files) {
      if (!reported.has(file))
        record({
          name: "load",
          file,
          ok: false,
          error: diagnostic(
            new RundownError(
              "RUNDOWN_TEST_EMPTY",
              `No Markdown test results from ${file}`,
            ),
          ),
        });
    }
    const report = {
      ok:
        results.length > 0 &&
        results.every((result) => result.ok) &&
        !signal?.aborted,
      files,
      results,
    };
    if (json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return report;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/** Recover Rundown diagnostics retained by Node's cross-process error serializer.
 * @param {unknown} error
 * @returns {import('./types.mjs').Diagnostic}
 */
function testDiagnostic(error) {
  if (error && typeof error === "object") {
    if (
      "code" in error &&
      "locations" in error &&
      Array.isArray(error.locations)
    )
      return {
        code: String(error.code),
        message: "message" in error ? String(error.message) : String(error),
        locations: error.locations,
        ...("related" in error && Array.isArray(error.related)
          ? { related: error.related }
          : {}),
      };
    if ("cause" in error && error.cause) return testDiagnostic(error.cause);
  }
  return diagnostic(error);
}
