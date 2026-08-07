import type { ToolHandlerFn } from "../ports/tool-handler-port.js";

/**
 * Built-in parallel-group handler.
 *
 * Parallel-group tasks are structural control-flow markers. They do not run a
 * worker and should not trigger verification.
 */
export const parallelHandler: ToolHandlerFn = async (_context) => {
  return {
    skipExecution: true,
    shouldVerify: false,
  };
};
