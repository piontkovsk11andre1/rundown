import type { ToolHandlerFn } from "../ports/tool-handler-port.js";

/**
 * Built-in for-each loop handler.
 *
 * The full loop orchestration is handled by the application layer. The
 * built-in handler remains a control-flow marker that skips direct worker
 * execution and verification.
 */
export const forLoopHandler: ToolHandlerFn = async (_context) => {
  return {
    skipExecution: true,
    shouldVerify: false,
  };
};
