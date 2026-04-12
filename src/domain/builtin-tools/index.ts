import type { ToolDefinition } from "../ports/tool-resolver-port.js";
import { endHandler } from "./end.js";
import { verifyHandler } from "./verify.js";
import { includeHandler } from "./include.js";
import { profileHandler } from "./profile.js";
import { forceHandler } from "./force.js";
import { parallelHandler } from "./parallel.js";
import { forLoopHandler } from "./for-loop.js";

/**
 * Static registry of built-in tool definitions.
 *
 * Used as the fallback resolution layer when no project-level `.js` or `.md`
 * tool file is found for a given prefix name. Memory tool is not registered
 * here because it requires a `MemoryWriterPort` dependency at construction time;
 * it is registered dynamically by the tool resolver adapter.
 */
const BUILTIN_TOOLS: Record<string, ToolDefinition> = {
  verify: {
    name: "verify",
    kind: "handler",
    handler: verifyHandler,
    frontmatter: { skipExecution: true, shouldVerify: true },
  },
  confirm: {
    name: "confirm",
    kind: "handler",
    handler: verifyHandler,
    frontmatter: { skipExecution: true, shouldVerify: true },
  },
  check: {
    name: "check",
    kind: "handler",
    handler: verifyHandler,
    frontmatter: { skipExecution: true, shouldVerify: true },
  },
  include: {
    name: "include",
    kind: "handler",
    handler: includeHandler,
    frontmatter: { skipExecution: true, autoComplete: true, shouldVerify: false },
  },
  parallel: {
    name: "parallel",
    kind: "handler",
    handler: parallelHandler,
    frontmatter: { skipExecution: true, autoComplete: true, shouldVerify: false },
  },
  concurrent: {
    name: "concurrent",
    kind: "handler",
    handler: parallelHandler,
    frontmatter: { skipExecution: true, autoComplete: true, shouldVerify: false },
  },
  par: {
    name: "par",
    kind: "handler",
    handler: parallelHandler,
    frontmatter: { skipExecution: true, autoComplete: true, shouldVerify: false },
  },
  for: {
    name: "for",
    kind: "handler",
    handler: forLoopHandler,
    frontmatter: { skipExecution: true, autoComplete: true, shouldVerify: false },
  },
  each: {
    name: "for",
    kind: "handler",
    handler: forLoopHandler,
    frontmatter: { skipExecution: true, autoComplete: true, shouldVerify: false },
  },
  foreach: {
    name: "for",
    kind: "handler",
    handler: forLoopHandler,
    frontmatter: { skipExecution: true, autoComplete: true, shouldVerify: false },
  },
  end: {
    name: "end",
    // `end` is terminal control flow, so it is a handler (not a modifier).
    kind: "handler",
    handler: endHandler,
    // Keep worker execution enabled so `endHandler` can evaluate the condition.
    // Verification is disabled because end-condition tasks are control-flow only.
    frontmatter: { skipExecution: false, shouldVerify: false },
  },
  return: {
    name: "return",
    kind: "handler",
    handler: endHandler,
    frontmatter: { skipExecution: false, shouldVerify: false },
  },
  skip: {
    name: "skip",
    kind: "handler",
    handler: endHandler,
    frontmatter: { skipExecution: false, shouldVerify: false },
  },
  quit: {
    name: "quit",
    kind: "handler",
    handler: endHandler,
    frontmatter: { skipExecution: false, shouldVerify: false },
  },
  break: {
    name: "break",
    kind: "handler",
    handler: endHandler,
    frontmatter: { skipExecution: false, shouldVerify: false },
  },
  profile: {
    name: "profile",
    kind: "modifier",
    handler: profileHandler,
  },
  force: {
    name: "force",
    kind: "modifier",
    handler: forceHandler,
  },
};

/**
 * Returns all statically registered built-in tool names.
 */
export function listBuiltinToolNames(): string[] {
  return Object.keys(BUILTIN_TOOLS);
}

/**
 * Returns the built-in tool definition for a given name, or `undefined`.
 */
export function resolveBuiltinTool(toolName: string): ToolDefinition | undefined {
  return BUILTIN_TOOLS[toolName.toLowerCase()];
}
