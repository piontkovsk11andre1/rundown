import { computeChildIndent } from "../planner.js";
import type { ToolHandlerContext, ToolHandlerFn } from "../ports/tool-handler-port.js";
import type { ProcessRunMode } from "../ports/process-runner.js";

const GET_RESULT_PREFIX_PATTERN = /^get-result\s*:\s*(.*)$/i;

interface ImmediateChildLine {
  index: number;
  text: string;
}

function buildExtractionPrompt(query: string): string {
  return [
    "You are extracting a concrete list of names from a task query.",
    "Return JSON only.",
    "Use the format: {\"results\":[\"name 1\",\"name 2\"]}.",
    "Preserve discovery order.",
    "If no names are found, return {\"results\":[]}.",
    "Do not include commentary.",
    "",
    "Query:",
    query,
  ].join("\n");
}

function normalizeResultValue(value: string): string {
  return value.replace(/\r?\n/g, " ").trim();
}

function findExistingResults(subItems: readonly { text: string }[]): string[] {
  const results: string[] = [];
  for (const subItem of subItems) {
    const match = subItem.text.match(GET_RESULT_PREFIX_PATTERN);
    if (!match) {
      continue;
    }

    const normalized = normalizeResultValue(match[1] ?? "");
    if (normalized.length > 0) {
      results.push(normalized);
    }
  }

  return results;
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

      return [];
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

    const withoutBullet = trimmed.replace(/^([-*+]|\d+[.)])\s+/, "");
    const withoutPrefix = withoutBullet.replace(/^get-result\s*:\s*/i, "");
    const normalized = normalizeResultValue(withoutPrefix);
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

function collectImmediateChildren(lines: string[], parentLineIndex: number, childIndentLength: number, parentIndentLength: number): ImmediateChildLine[] {
  const immediateChildren: ImmediateChildLine[] = [];

  for (let index = parentLineIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0) {
      continue;
    }

    const leadingWhitespaceLength = (line.match(/^(\s*)/)?.[1] ?? "").length;
    if (leadingWhitespaceLength <= parentIndentLength) {
      break;
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

  const nextResultLines = results.map((result) => `${childIndent}- get-result: ${result}`);
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

  const existingResults = findExistingResults(context.task.subItems);
  if (existingResults.length > 0) {
    context.emit({
      kind: "info",
      message: "Get results already present; reusing existing values.",
    });
    return {
      skipExecution: true,
      shouldVerify: false,
    };
  }

  const extractionPrompt = buildExtractionPrompt(query);

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
    return {
      exitCode: 1,
      failureMessage: "Get extraction returned no results.",
      failureReason: "Get extraction produced an empty result set.",
    };
  }

  const source = context.fileSystem.readText(context.task.file);
  const updatedSource = upsertResultSubItems(source, context, extractedResults);
  if (updatedSource !== source) {
    context.fileSystem.writeText(context.task.file, updatedSource);
  }

  context.emit({
    kind: "info",
    message: "Get extraction generated " + extractedResults.length + " result(s).",
  });
  return {
    skipExecution: true,
    shouldVerify: false,
  };
};
