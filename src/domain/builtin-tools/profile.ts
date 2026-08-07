import type { ToolHandlerFn } from "../ports/tool-handler-port.js";

/**
 * Built-in profile modifier.
 *
 * Returns context modifications that set the named profile for downstream
 * tools and the default execution pipeline.
 */
export const profileHandler: ToolHandlerFn = async (context) => {
  const profileName = context.payload.trim();
  if (profileName.length === 0) {
    return {
      exitCode: 1,
      failureMessage: "Profile modifier requires a profile name.",
      failureReason: "Profile payload is empty.",
    };
  }

  return {
    contextModifications: {
      profile: profileName,
    },
  };
};
