import type { ToolHandlerFn } from "../ports/tool-handler-port.js";

export const forceHandler: ToolHandlerFn = async () => {
  return {
    contextModifications: {},
  };
};
