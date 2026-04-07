import type { ToolHandlerFn } from "../ports/tool-handler-port.js";
import type { ProcessRunMode } from "../ports/process-runner.js";

function tryParseJson(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }

  return null;
}

function normalizeYesNo(raw: string): "yes" | "no" | null {
  const normalized = raw.trim().toLowerCase();
  if (normalized.length === 0) {
    return null;
  }

  const firstToken = normalized.split(/\s+/)[0]?.replace(/[^a-z]/g, "") ?? "";
  if (firstToken === "yes") {
    return "yes";
  }
  if (firstToken === "no") {
    return "no";
  }
  return null;
}

function buildEndConditionPrompt(condition: string): string {
  return [
    "You are evaluating an end-condition for a Markdown task runner.",
    "Decide whether the condition is true right now.",
    "Answer the yes/no question based only on the condition text.",
    "If the condition is ambiguous or cannot be determined, choose no.",
    "Return JSON only: {\"decision\":\"yes\"} or {\"decision\":\"no\"}.",
    "",
    "Question: Is this condition true right now?",
    "Condition:",
    condition,
  ].join("\n");
}

function parseEndConditionDecision(raw: string): "yes" | "no" | null {
  const parsed = tryParseJson(raw);
  if (parsed && typeof parsed === "object") {
    const candidate = ["decision", "answer", "verdict"]
      .map((key) => parsed[key])
      .find((value): value is string => typeof value === "string");
    if (candidate) {
      const normalized = normalizeYesNo(candidate);
      if (normalized) {
        return normalized;
      }
    }
  }

  return normalizeYesNo(raw);
}

/**
 * Built-in end handler.
 *
 * Signals that task execution should be skipped because there is no output
 * to process for this task.
 */
export const endHandler: ToolHandlerFn = async (context) => {
  const condition = context.payload.trim();
  if (condition.length === 0) {
    context.emit({ kind: "warn", message: "End tool requires a non-empty condition payload." });
    return {
      exitCode: 1,
      failureMessage: "End tool requires a non-empty condition payload.",
      failureReason: "End condition payload is empty.",
    };
  }

  context.emit({ kind: "info", message: "Evaluating end condition." });

  const evaluationPrompt = buildEndConditionPrompt(condition);

  let runResult: Awaited<ReturnType<typeof context.workerExecutor.runWorker>>;
  try {
    runResult = await context.workerExecutor.runWorker({
      workerPattern: context.workerPattern,
      prompt: evaluationPrompt,
      mode: context.mode as ProcessRunMode,
      trace: context.trace,
      cwd: context.cwd,
      env: context.executionEnv,
      configDir: context.configDir,
      artifactContext: context.artifactContext,
      artifactPhase: "execute",
      artifactExtra: { taskType: "end-condition-evaluation" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    context.emit({ kind: "warn", message: "Failed to evaluate end condition: " + message });
    return {
      exitCode: 1,
      failureMessage: "Failed to evaluate end condition: " + message,
      failureReason: "End condition worker invocation failed.",
    };
  }

  if (context.showAgentOutput) {
    if (runResult.stdout) {
      context.emit({ kind: "text", text: runResult.stdout });
    }
    if (runResult.stderr) {
      context.emit({ kind: "stderr", text: runResult.stderr });
    }
  }

  if (runResult.exitCode !== 0 && runResult.exitCode !== null) {
    context.emit({ kind: "warn", message: "End condition worker exited with code " + runResult.exitCode + "." });
    return {
      exitCode: runResult.exitCode,
      failureMessage: "End condition worker exited with code " + runResult.exitCode + ".",
      failureReason: "End condition worker exited with a non-zero code.",
    };
  }

  const decision = parseEndConditionDecision(runResult.stdout);
  if (decision === "yes") {
    context.emit({ kind: "info", message: "End condition met; skipping remaining sibling tasks." });
    return {
      skipExecution: true,
      skipRemainingSiblings: {
        reason: condition,
      },
    };
  }

  if (decision === "no") {
    context.emit({ kind: "info", message: "End condition not met; continuing execution." });
    return {
      skipExecution: true,
    };
  }

  context.emit({
    kind: "warn",
    message: "End condition response was ambiguous; defaulting to no and continuing execution.",
  });
  return {
    skipExecution: true,
  };
};
