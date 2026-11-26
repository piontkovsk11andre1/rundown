import type { TestContext } from "node:test";
import type { RuntimeOptions } from "./types.mjs";
import type { Runtime } from "./index.mjs";

export interface TestRuntimeOptions extends RuntimeOptions {
  entry?: string | URL;
}
/** Create a production command runtime and register its close with t.after. */
export function createTestRuntime(
  t: TestContext,
  options?: TestRuntimeOptions,
): Promise<Runtime>;
