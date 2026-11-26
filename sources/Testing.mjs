import { loadCommands } from "./Catalog.mjs";
import { Runtime } from "./Runtime.mjs";

/** Create a real command runtime whose shutdown is owned by a Node test.
 * @param {import('node:test').TestContext} t
 * @param {import('./InternalContracts.mjs').InternalRuntimeOptions & {entry?:string|URL}} [options]
 */
export async function createTestRuntime(t, { entry, ...options } = {}) {
  const catalog = await loadCommands(entry, {
    cwd: options.cwd ?? process.cwd(),
    signal: t.signal,
  });
  const runtime = new Runtime(catalog, options);
  t.after(() => runtime.close());
  return runtime;
}
