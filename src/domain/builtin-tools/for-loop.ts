import type { ToolHandlerFn } from "../ports/tool-handler-port.js";
import {
  FOR_LOOP_MISSING_CHILDREN_FAILURE_MESSAGE,
  FOR_LOOP_MISSING_CHILDREN_FAILURE_REASON,
  formatForLoopItemMetadataLine,
  getForCurrentValue,
  hasForLoopCheckboxChildren,
  resolveForLoopItems,
} from "../for-loop.js";
import { buildResearchOutputPromptContract } from "./research-output-prompt.js";

interface OpenFence {
  char: "`" | "~";
  length: number;
}

function buildForLoopResearchPrompt(
  payload: string,
  source: string,
  contextBefore: string,
  taskText: string,
  context: Pick<Parameters<ToolHandlerFn>[0], "templates">,
): string {
  const outputContract = buildResearchOutputPromptContract({
    itemLabel: "item",
    metadataPrefix: "for-item:",
    emptyConditionLabel: "items are found",
  }, context.templates?.researchOutputContract);

  return [
    "You are a full-scale research agent preparing concrete loop items for a for-each task.",
    "Investigate the repository context and derive specific actionable items.",
    ...outputContract,
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
  const fencePattern = /^(`{3,}|~{3,})/;
  let openFence: OpenFence | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    const fenceMatch = trimmed.match(fencePattern);
    if (fenceMatch) {
      const marker = fenceMatch[1] ?? "";
      const char = marker[0] as "`" | "~";
      const length = marker.length;

      if (openFence === null) {
        openFence = { char, length };
      } else if (openFence.char === char && length >= openFence.length) {
        openFence = null;
      }
      continue;
    }

    if (openFence !== null || trimmed.length === 0) {
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
  const payloadFallbackItems = metadataItems.source === "payload"
    ? metadataItems.items
    : [];
  if (metadataItems.source === "metadata" && metadataItems.items.length > 0) {
    bakedItems = metadataItems.items;
    itemSource = metadataItems.source;
  } else {
    let researchOutput = "";
    try {
      const prompt = buildForLoopResearchPrompt(
        payload,
        context.source,
        context.contextBefore,
        context.task.text,
        {
          templates: context.templates,
        },
      );
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

    bakedItems = extractForLoopItemsFromOutput(researchOutput);
    itemSource = "research";
    if (bakedItems.length === 0 && payloadFallbackItems.length > 0) {
      bakedItems = payloadFallbackItems;
      itemSource = "payload";
    }
  }

  if (bakedItems.length === 0) {
    context.emit({ kind: "info", message: "For loop resolved zero items; completing without iteration." });
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
    message: "For loop baked " + bakedItems.length + " items from " + itemSource + ": " + bakedItems.join(", "),
  });
  context.emit({ kind: "info", message: "For loop current item: " + (existingCurrent ?? bakedItems[0] ?? "") });

  return {
    skipExecution: true,
    shouldVerify: false,
    childTasks: metadataLines,
    forLoopItems: bakedItems,
  };
};
