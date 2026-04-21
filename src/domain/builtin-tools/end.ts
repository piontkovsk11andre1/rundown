import type { ToolHandlerFn } from "../ports/tool-handler-port.js";
import type { ProcessRunMode } from "../ports/process-runner.js";
import { msg, type LocaleMessages } from "../locale.js";
import {
  classifyTerminalPayload,
  resolveTerminalStopExitCode,
  type TerminalPrefixAlias,
} from "../terminal-control.js";

function resolveLocaleMessages(context: Parameters<ToolHandlerFn>[0]): LocaleMessages {
  return (context as Parameters<ToolHandlerFn>[0] & { localeMessages?: LocaleMessages }).localeMessages ?? {};
}

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

function buildConditionPrompt(condition: string): string {
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

function parseConditionDecision(raw: string): "yes" | "no" | null {
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

async function evaluateCondition(context: Parameters<ToolHandlerFn>[0], condition: string): Promise<{
  ok: boolean;
  decision?: "yes" | "no" | null;
  exitCode?: number;
  failureMessage?: string;
  failureReason?: string;
}> {
  const evaluationPrompt = buildConditionPrompt(condition);

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
      artifactExtra: { taskType: "terminal-condition-evaluation" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      exitCode: 1,
      failureMessage: "Failed to evaluate condition: " + message,
      failureReason: "Condition worker invocation failed.",
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
    return {
      ok: false,
      exitCode: runResult.exitCode,
      failureMessage: "End condition worker exited with code " + runResult.exitCode + ".",
      failureReason: "End condition worker exited with a non-zero code.",
    };
  }

  return {
    ok: true,
    decision: parseConditionDecision(runResult.stdout),
  };
}

/**
 * Built-in end handler.
 *
 * Signals that task execution should be skipped because there is no output
 * to process for this task.
 */
export const endHandler: ToolHandlerFn = async (context) => {
  const localeMessages = resolveLocaleMessages(context);
  const condition = context.payload.trim();
  if (condition.length === 0) {
    const message = msg("tool.end.missing-payload", {}, localeMessages);
    context.emit({ kind: "warn", message });
    return {
      exitCode: 1,
      failureMessage: message,
      failureReason: "End condition payload is empty.",
    };
  }

  context.emit({ kind: "info", message: msg("tool.end.evaluating-optional", {}, localeMessages) });
  const conditionResult = await evaluateCondition(context, condition);
  if (!conditionResult.ok) {
    context.emit({
      kind: "warn",
      message: msg("tool.end.eval-failed", {
        reason: conditionResult.failureMessage ?? "Failed to evaluate optional condition.",
      }, localeMessages),
    });
    return {
      exitCode: conditionResult.exitCode ?? 1,
      failureMessage: conditionResult.failureMessage,
      failureReason: conditionResult.failureReason,
    };
  }

  const decision = conditionResult.decision;
  if (decision === "yes") {
    context.emit({ kind: "info", message: msg("tool.end.optional-met", {}, localeMessages) });
    return {
      skipExecution: true,
      skipRemainingSiblings: {
        reason: condition,
      },
    };
  }

  if (decision === "no") {
    context.emit({ kind: "info", message: msg("tool.end.optional-not-met", {}, localeMessages) });
    return {
      skipExecution: true,
    };
  }

  context.emit({
    kind: "warn",
    message: msg("tool.end.optional-ambiguous", {}, localeMessages),
  });
  return {
    skipExecution: true,
  };
};

function resolveRequestedTerminalAlias(taskText: string): TerminalPrefixAlias {
  const prefix = taskText.trim().split(":", 1)[0]?.trim().toLowerCase();
  if (prefix === "quit" || prefix === "exit" || prefix === "end" || prefix === "break" || prefix === "return") {
    return prefix;
  }

  return "end";
}

/**
 * Built-in terminal stop handler.
 *
 * - Empty payload is unconditional and immediately requests graceful stop.
 * - Non-empty payload is evaluated as a yes/no condition.
 * - `yes` requests graceful stop, `no` continues.
 */
export const terminalHandler: ToolHandlerFn = async (context) => {
  const localeMessages = resolveLocaleMessages(context);
  const requestedBy = resolveRequestedTerminalAlias(context.task.text);
  const payload = classifyTerminalPayload(context.payload);
  const gracefulExitCode = resolveTerminalStopExitCode();

  if (payload.mode === "unconditional") {
    context.emit({
      kind: "info",
      message: msg("tool.end.terminal-stop", { requestedBy }, localeMessages),
    });
    return {
      skipExecution: true,
      terminalStop: {
        requestedBy,
        mode: "unconditional",
        reason: requestedBy + ": (no condition)",
        stopRun: true,
        stopLoop: true,
        exitCode: gracefulExitCode,
      },
    };
  }

  context.emit({
    kind: "info",
    message: msg("tool.end.evaluating-terminal", { requestedBy }, localeMessages),
  });
  const conditionResult = await evaluateCondition(context, payload.condition);
  if (!conditionResult.ok) {
    context.emit({
      kind: "warn",
      message: msg("tool.end.eval-failed", {
        reason: conditionResult.failureMessage ?? "Failed to evaluate terminal condition.",
      }, localeMessages),
    });
    return {
      exitCode: conditionResult.exitCode ?? 1,
      failureMessage: conditionResult.failureMessage,
      failureReason: conditionResult.failureReason,
    };
  }

  if (conditionResult.decision === "yes") {
    context.emit({
      kind: "info",
      message: msg("tool.end.terminal-met", {}, localeMessages),
    });
    return {
      skipExecution: true,
      terminalStop: {
        requestedBy,
        mode: "conditional",
        reason: payload.condition,
        stopRun: true,
        stopLoop: true,
        exitCode: gracefulExitCode,
      },
    };
  }

  if (conditionResult.decision === "no") {
    context.emit({
      kind: "info",
      message: msg("tool.end.terminal-not-met", {}, localeMessages),
    });
    return {
      skipExecution: true,
    };
  }

  context.emit({
    kind: "warn",
    message: msg("tool.end.terminal-ambiguous", {}, localeMessages),
  });
  return {
    skipExecution: true,
  };
};
