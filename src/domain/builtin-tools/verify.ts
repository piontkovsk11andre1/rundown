import type { ToolHandlerFn } from "../ports/tool-handler-port.js";

/**
 * Built-in verify handler.
 *
 * Signals that task execution should be skipped and only verification should run.
 * The actual verification is handled by the orchestrator and existing verify pipeline.
 */
export const verifyHandler: ToolHandlerFn = async (_context) => {
  return {
    skipExecution: true,
    shouldVerify: true,
  };
};
