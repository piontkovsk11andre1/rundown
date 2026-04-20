import { computeChildIndent } from "../planner.js";
import type { ToolHandlerContext, ToolHandlerFn } from "../ports/tool-handler-port.js";
import type { ProcessRunMode } from "../ports/process-runner.js";
import { escapeExtractionMetadataValue } from "../metadata-escape.js";
import { buildResearchOutputPromptContract } from "./research-output-prompt.js";

const GET_RESULT_PREFIX_PATTERN = /^get-result\s*:\s*(.*)$/i;
const GET_MODE_PREFIX_PATTERN = /^get-mode\s*:\s*(.*)$/i;
const GET_POLICY_PREFIX_PATTERN = /^get-policy\s*:\s*(.*)$/i;
const GET_EMPTY_MODE_PREFIX_PATTERN = /^get-empty\s*:\s*(.*)$/i;
const GET_EMPTY_POLICY_PREFIX_PATTERN = /^get-empty-policy\s*:\s*(.*)$/i;
const GET_EMPTY_RESULT_MARKER = "(empty)";

type GetRerunPolicy = "reuse" | "refresh";
type GetEmptyResultPolicy = "marker" | "fail";
type GetOutcome = "generated" | "reused" | "replaced" | "empty";

interface ImmediateChildLine {
  index: number;
  text: string;
}

interface OpenFence {
  char: "`" | "~";
  length: number;
}

function buildExtractionPrompt(query: string, context: ToolHandlerContext): string {
  const outputContract = buildResearchOutputPromptContract({
    itemLabel: "extracted item",
    metadataPrefix: "get-result:",
    emptyConditionLabel: "results are found",
  }, context.templates?.researchOutputContract);

  return [
    "You are a full-scale research agent resolving a task query against the current project.",
    "Investigate the repository context thoroughly before answering.",
    ...outputContract,
    "",
    "Task:",
    context.task.text,
    "",
    "Query:",
    query,
    "",
    "Context before task:",
    context.contextBefore,
    "",
    "Full source document:",
    context.source,
  ].join("\n");
}

function normalizeResultValue(value: string): string {
  return value.replace(/\r?\n/g, " ").trim();
}

function decodeRenderedGetResultValue(value: string): string {
  const inlineCodeMatch = value.match(/^(`+)([\s\S]*?)\1$/);
  if (!inlineCodeMatch) {
    return value;
  }

  return inlineCodeMatch[2] ?? "";
}

function renderGetResultValue(value: string): string {
  if (value === GET_EMPTY_RESULT_MARKER) {
    return value;
  }

  return escapeExtractionMetadataValue(value);
}

function findExistingResults(subItems: readonly { text: string }[]): string[] {
  const results: string[] = [];
  for (const subItem of subItems) {
    const match = subItem.text.match(GET_RESULT_PREFIX_PATTERN);
    if (!match) {
      continue;
    }

    const normalized = normalizeResultValue(decodeRenderedGetResultValue(match[1] ?? ""));
    if (normalized.length > 0) {
      results.push(normalized);
    }
  }

  return results;
}

function parseRerunPolicyValue(rawValue: string): GetRerunPolicy | undefined {
  const normalized = rawValue.trim().toLowerCase();
  if (normalized === "reuse") {
    return "reuse";
  }
  if (normalized === "refresh") {
    return "refresh";
  }
  return undefined;
}

function parseEmptyResultPolicyValue(rawValue: string): GetEmptyResultPolicy | undefined {
  const normalized = rawValue.trim().toLowerCase();
  if (normalized === "marker") {
    return "marker";
  }
  if (normalized === "fail") {
    return "fail";
  }
  return undefined;
}

function resolveRerunPolicy(subItems: readonly { text: string }[]):
  | { ok: true; policy: GetRerunPolicy }
  | { ok: false; invalidValue: string } {
  let policy: GetRerunPolicy = "reuse";

  for (const subItem of subItems) {
    const match = subItem.text.match(GET_MODE_PREFIX_PATTERN)
      ?? subItem.text.match(GET_POLICY_PREFIX_PATTERN);
    if (!match) {
      continue;
    }

    const rawValue = normalizeResultValue(match[1] ?? "");
    const parsed = parseRerunPolicyValue(rawValue);
    if (!parsed) {
      return { ok: false, invalidValue: rawValue };
    }
    policy = parsed;
  }

  return { ok: true, policy };
}

function resolveEmptyResultPolicy(subItems: readonly { text: string }[]):
  | { ok: true; policy: GetEmptyResultPolicy }
  | { ok: false; invalidValue: string } {
  let policy: GetEmptyResultPolicy = "marker";

  for (const subItem of subItems) {
    const match = subItem.text.match(GET_EMPTY_MODE_PREFIX_PATTERN)
      ?? subItem.text.match(GET_EMPTY_POLICY_PREFIX_PATTERN);
    if (!match) {
      continue;
    }

    const rawValue = normalizeResultValue(match[1] ?? "");
    const parsed = parseEmptyResultPolicyValue(rawValue);
    if (!parsed) {
      return { ok: false, invalidValue: rawValue };
    }
    policy = parsed;
  }

  return { ok: true, policy };
}

function tryParseJsonResults(raw: string): string[] | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .filter((value): value is string => typeof value === "string")
        .map((value) => normalizeResultValue(value))
        .filter((value) => value.length > 0);
    }

    if (typeof parsed === "object" && parsed !== null) {
      const container = parsed as Record<string, unknown>;
      const candidates = [container.results, container.names, container.items];
      for (const candidate of candidates) {
        if (!Array.isArray(candidate)) {
          continue;
        }

        return candidate
          .filter((value): value is string => typeof value === "string")
          .map((value) => normalizeResultValue(value))
          .filter((value) => value.length > 0);
      }

      return null;
    }
  } catch {
    // Fall through to plain-text parsing.
    return null;
  }

  return null;
}

function parseTextResults(raw: string): string[] {
  const lines = raw.split(/\r?\n/);
  const parsed: string[] = [];
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

    const withoutBullet = trimmed.replace(/^([-*+]|\d+[.)])\s+/, "");
    const withoutPrefix = withoutBullet.replace(/^get-result\s*:\s*/i, "");
    const normalized = normalizeResultValue(decodeRenderedGetResultValue(withoutPrefix));
    if (normalized.length > 0) {
      parsed.push(normalized);
    }
  }

  return parsed;
}

function extractResults(raw: string): string[] {
  const jsonResults = tryParseJsonResults(raw);
  if (jsonResults !== null) {
    return jsonResults;
  }

  return parseTextResults(raw);
}

function emitOutcome(
  context: ToolHandlerContext,
  outcome: GetOutcome,
  details: string,
  kind: "info" | "warn" = "info",
): void {
  context.emit({
    kind,
    message: `Get outcome: ${outcome}; ${details}`,
  });
}

function collectImmediateChildren(lines: string[], parentLineIndex: number, childIndentLength: number, parentIndentLength: number): ImmediateChildLine[] {
  const immediateChildren: ImmediateChildLine[] = [];
  const fencePattern = /^\s*(`{3,}|~{3,})/;
  let openFence: OpenFence | null = null;

  for (let index = parentLineIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const leadingWhitespaceLength = (line.match(/^(\s*)/)?.[1] ?? "").length;
    if (leadingWhitespaceLength <= parentIndentLength) {
      break;
    }

    const fenceMatch = line.match(fencePattern);
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

    if (openFence !== null || line.trim().length === 0) {
      continue;
    }

    if (leadingWhitespaceLength !== childIndentLength) {
      continue;
    }
    if (!/^\s*[-*+]\s+/.test(line)) {
      continue;
    }

    const text = line.replace(/^\s*[-*+]\s+/, "").trim();
    immediateChildren.push({ index, text });
  }

  return immediateChildren;
}

function upsertResultSubItems(source: string, context: ToolHandlerContext, results: readonly string[]): string {
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  const parentLineIndex = context.task.line - 1;
  if (parentLineIndex < 0 || parentLineIndex >= lines.length) {
    throw new Error(`Task line ${context.task.line} is out of range in ${context.task.file}`);
  }

  const parentLine = lines[parentLineIndex] ?? "";
  const childIndent = computeChildIndent(parentLine);
  const parentIndentLength = (parentLine.match(/^(\s*)/)?.[1] ?? "").length;
  const childIndentLength = childIndent.length;

  const immediateChildren = collectImmediateChildren(lines, parentLineIndex, childIndentLength, parentIndentLength);
  const existingResultChildren = immediateChildren.filter((child) => GET_RESULT_PREFIX_PATTERN.test(child.text));

  const nextResultLines = results.map((result) => `${childIndent}- get-result: ${renderGetResultValue(result)}`);
  const insertIndex = existingResultChildren.length > 0
    ? existingResultChildren[0]!.index
    : parentLineIndex + 1;

  const existingIndexes = new Set(existingResultChildren.map((child) => child.index));
  const pruned = lines.filter((_line, index) => !existingIndexes.has(index));
  pruned.splice(insertIndex, 0, ...nextResultLines);

  return pruned.join(eol);
}

export const getHandler: ToolHandlerFn = async (context) => {
  const query = context.payload.trim();
  if (query.length === 0) {
    return {
      exitCode: 1,
      failureMessage: "Get tool requires query text payload.",
      failureReason: "Get payload is empty.",
    };
  }

  const policyResolution = resolveRerunPolicy(context.task.subItems);
  if (!policyResolution.ok) {
    return {
      exitCode: 1,
      failureMessage: `Get rerun policy must be \`reuse\` or \`refresh\`; received: ${policyResolution.invalidValue || "(empty)"}.`,
      failureReason: "Get rerun policy is invalid.",
    };
  }

  const emptyResultPolicyResolution = resolveEmptyResultPolicy(context.task.subItems);
  if (!emptyResultPolicyResolution.ok) {
    return {
      exitCode: 1,
      failureMessage: `Get empty-result policy must be \`marker\` or \`fail\`; received: ${emptyResultPolicyResolution.invalidValue || "(empty)"}.`,
      failureReason: "Get empty-result policy is invalid.",
    };
  }

  const existingResults = findExistingResults(context.task.subItems);
  if (existingResults.length > 0 && policyResolution.policy === "reuse") {
    emitOutcome(
      context,
      "reused",
      `rerun-policy=reuse; existing-results=${existingResults.length}.`,
    );
    return {
      skipExecution: true,
      shouldVerify: false,
    };
  }

  if (existingResults.length > 0 && policyResolution.policy === "refresh") {
    context.emit({
      kind: "info",
      message: "Get rerun policy set to refresh; replacing existing get-result values.",
    });
  }

  const extractionPrompt = buildExtractionPrompt(query, context);

  let runResult: Awaited<ReturnType<typeof context.workerExecutor.runWorker>>;
  try {
    runResult = await context.workerExecutor.runWorker({
      workerPattern: context.workerPattern,
      prompt: extractionPrompt,
      mode: context.mode as ProcessRunMode,
      trace: context.trace,
      cwd: context.cwd,
      env: context.executionEnv,
      configDir: context.configDir,
      artifactContext: context.artifactContext,
      artifactPhase: "execute",
      artifactExtra: { taskType: "get-extraction" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      exitCode: 1,
      failureMessage: "Failed to run get extraction: " + message,
      failureReason: "Get extraction worker invocation failed.",
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
      exitCode: runResult.exitCode,
      failureMessage: "Get extraction worker exited with code " + runResult.exitCode + ".",
      failureReason: "Get extraction worker exited with a non-zero code.",
    };
  }

  const extractedResults = extractResults(runResult.stdout);
  if (extractedResults.length === 0) {
    if (emptyResultPolicyResolution.policy === "fail") {
      emitOutcome(
        context,
        "empty",
        "empty-result-policy=fail; action=task-failed.",
        "warn",
      );
      return {
        exitCode: 1,
        failureMessage: "Get extraction returned no results (empty-result policy: fail).",
        failureReason: "Get extraction produced an empty result set and empty-result policy is fail.",
      };
    }

    const source = context.fileSystem.readText(context.task.file);
    const updatedSource = upsertResultSubItems(source, context, [GET_EMPTY_RESULT_MARKER]);
    if (updatedSource !== source) {
      context.fileSystem.writeText(context.task.file, updatedSource);
    }

    emitOutcome(
      context,
      "empty",
      "empty-result-policy=marker; action=persisted-empty-marker.",
    );
    return {
      skipExecution: true,
      shouldVerify: false,
    };
  }

  const source = context.fileSystem.readText(context.task.file);
  const updatedSource = upsertResultSubItems(source, context, extractedResults);
  if (updatedSource !== source) {
    context.fileSystem.writeText(context.task.file, updatedSource);
  }

  emitOutcome(
    context,
    existingResults.length > 0 ? "replaced" : "generated",
    `result-count=${extractedResults.length}; rerun-policy=${policyResolution.policy}.`,
  );
  return {
    skipExecution: true,
    shouldVerify: false,
  };
};
