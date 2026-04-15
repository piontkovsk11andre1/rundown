import type { ToolHandlerFn } from "../ports/tool-handler-port.js";
import {
  FOR_LOOP_MISSING_CHILDREN_FAILURE_MESSAGE,
  FOR_LOOP_MISSING_CHILDREN_FAILURE_REASON,
  formatForLoopItemMetadataLine,
  getForCurrentValue,
  hasForLoopCheckboxChildren,
  resolveForLoopItems,
} from "../for-loop.js";

function buildForLoopResearchPrompt(payload: string, source: string, contextBefore: string, taskText: string): string {
  return [
    "You are a full-scale research agent preparing concrete loop items for a for-each task.",
    "Investigate the repository context and derive specific actionable items.",
    "Return a Markdown bullet list only.",
    "Each bullet must be one item and should start with `for-item:`.",
    "Example: `- for-item: item 1`.",
    "Preserve discovery order and avoid duplicates.",
    "If no items are found, return an empty response.",
    "Do not include commentary.",
    "",
    "Loop task:",
    taskText,
    "",
    "Loop payload:",
    payload,
    "",
    "Context before task:",
    contextBefore,
    "",
    "Full source document:",
    source,
  ].join("\n");
}

function extractForLoopItemsFromOutput(output: string): string[] {
  try {
    const parsed = JSON.parse(output) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
    }

    if (typeof parsed === "object" && parsed !== null) {
      const container = parsed as Record<string, unknown>;
      const candidates = [container.results, container.items, container.names];
      for (const candidate of candidates) {
        if (!Array.isArray(candidate)) {
          continue;
        }

        return candidate
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim())
          .filter((value) => value.length > 0);
      }
    }
  } catch {
    // Fall through to line-based parsing.
  }

  const parsed: string[] = [];
  const lines = output.split(/\r?\n/);
  let insideFence = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      insideFence = !insideFence;
      continue;
    }

    if (insideFence || trimmed.length === 0) {
      continue;
    }

    const withoutBullet = trimmed.replace(/^([-*+]\s+|\d+[.)]\s+)/, "");
    const withoutPrefix = withoutBullet.replace(/^for-item\s*:\s*/i, "");
    const normalized = withoutPrefix.trim();
    if (normalized.length > 0) {
      parsed.push(normalized);
    }
  }

  return parsed;
}

function dedupeItems(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const item of items) {
    if (seen.has(item)) {
      continue;
    }
    seen.add(item);
    deduped.push(item);
  }

  return deduped;
}

/**
 * Built-in for-each loop handler.
 *
 * The full loop orchestration is handled by the application layer. The
 * built-in handler remains a control-flow marker that skips direct worker
 * execution and verification.
 */
export const forLoopHandler: ToolHandlerFn = async (context) => {
  const payload = context.payload.trim();
  if (payload.length === 0) {
    return {
      exitCode: 1,
      failureMessage: "For loop tool requires a non-empty payload.",
      failureReason: "For loop payload is empty.",
    };
  }

  if (!hasForLoopCheckboxChildren(context.task)) {
    return {
      exitCode: 1,
      failureMessage: FOR_LOOP_MISSING_CHILDREN_FAILURE_MESSAGE,
      failureReason: FOR_LOOP_MISSING_CHILDREN_FAILURE_REASON,
    };
  }

  let bakedItems: string[];
  let itemSource: "metadata" | "payload" | "research";
  const metadataItems = resolveForLoopItems(context.task.subItems, payload);
  if (metadataItems.source === "metadata" && metadataItems.items.length > 0) {
    bakedItems = metadataItems.items;
    itemSource = "metadata";
  } else {
    let researchOutput = "";
    try {
      const prompt = buildForLoopResearchPrompt(payload, context.source, context.contextBefore, context.task.text);
      const runResult = await context.workerExecutor.runWorker({
        workerPattern: context.workerPattern,
        prompt,
        mode: context.mode as "wait" | "detached" | "tui",
        trace: context.trace,
        cwd: context.cwd,
        env: context.executionEnv,
        configDir: context.configDir,
        artifactContext: context.artifactContext,
        artifactPhase: "execute",
        artifactExtra: { taskType: "for-loop-research" },
      });

      if (context.showAgentOutput) {
        if (runResult.stdout.trim().length > 0) {
          context.emit({ kind: "text", text: runResult.stdout });
        }
        if (runResult.stderr.trim().length > 0) {
          context.emit({ kind: "stderr", text: runResult.stderr });
        }
      }

      if (runResult.exitCode !== 0 && runResult.exitCode !== null) {
        return {
          exitCode: runResult.exitCode,
          failureMessage: "For loop research worker exited with code " + runResult.exitCode + ".",
          failureReason: "For loop research worker exited with a non-zero code.",
        };
      }

      researchOutput = runResult.stdout;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        exitCode: 1,
        failureMessage: "Failed to run for loop research: " + message,
        failureReason: "For loop research worker invocation failed.",
      };
    }

    bakedItems = dedupeItems(extractForLoopItemsFromOutput(researchOutput));
    itemSource = "research";
  }

  if (bakedItems.length === 0) {
    context.emit({ kind: "warn", message: "For loop resolved zero unique items; completing without iteration." });
    return {
      skipExecution: true,
      shouldVerify: false,
      forLoopItems: [],
    };
  }

  const existingCurrent = getForCurrentValue(context.task.subItems);
  const metadataLines = bakedItems.map((item) => formatForLoopItemMetadataLine(item));

  context.emit({
    kind: "info",
    message: "For loop baked " + bakedItems.length + " unique items from " + itemSource + ": " + bakedItems.join(", "),
  });
  context.emit({ kind: "info", message: "For loop current item: " + (existingCurrent ?? bakedItems[0] ?? "") });

  return {
    skipExecution: true,
    shouldVerify: false,
    childTasks: metadataLines,
    forLoopItems: bakedItems,
  };
};
