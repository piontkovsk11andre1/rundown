import fs from "node:fs";
import path from "node:path";
import { EXIT_CODE_FAILURE, EXIT_CODE_SUCCESS, type RundownExitCode } from "../domain/exit-codes.js";
import type { FileSystem, PathOperationsPort } from "../domain/ports/index.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";

export type QueryOutputFormat = "markdown" | "json" | "yn" | "success-error";

interface QueryOutputDependencies {
  fileSystem?: FileSystem;
  pathOperations?: PathOperationsPort;
  output?: ApplicationOutputPort;
}

interface QueryOutputStep {
  title: string;
  content: string;
}

export async function aggregateQueryOutput(
  workdir: string,
  dependencies: QueryOutputDependencies = {},
): Promise<string> {
  const files = listStepFiles(workdir, dependencies)
    .filter((file) => file.toLowerCase().endsWith(".md"))
    .sort(compareStepFileNames);

  const sections: string[] = [];
  for (const [index, fileName] of files.entries()) {
    const stepFilePath = joinPath(workdir, fileName, dependencies);
    const raw = readText(stepFilePath, dependencies).trim();
    if (raw.length === 0) {
      continue;
    }

    const title = extractStepTitle(raw) ?? fileName;
    sections.push(`## Step ${index + 1}: ${title}\n\n${raw}`);
  }

  return sections.join("\n\n").trim();
}

export function formatQueryOutput(
  content: string,
  format: QueryOutputFormat,
  query: string,
): string {
  if (format === "markdown") {
    return content;
  }

  if (format === "json") {
    const steps = parseAggregatedSteps(content);
    return JSON.stringify({ query, steps, output: content }, null, 2);
  }

  if (format === "yn") {
    return extractYnVerdict(content) ?? "N";
  }

  return extractSuccessErrorVerdict(content) ?? "failure: verdict not found";
}

export function resolveQueryExitCode(
  format: QueryOutputFormat,
  output: string,
): RundownExitCode {
  if (format === "yn") {
    return output.trim() === "Y" ? EXIT_CODE_SUCCESS : EXIT_CODE_FAILURE;
  }

  if (format === "success-error") {
    return output.trim().toLowerCase() === "success" ? EXIT_CODE_SUCCESS : EXIT_CODE_FAILURE;
  }

  return EXIT_CODE_SUCCESS;
}

export async function writeQueryOutput(
  formatted: string,
  outputPath: string | undefined,
  dependencies: QueryOutputDependencies = {},
): Promise<void> {
  if (outputPath) {
    const parentDir = dirname(outputPath, dependencies);
    mkdir(parentDir, dependencies);
    writeText(outputPath, formatted, dependencies);
    return;
  }

  if (dependencies.output) {
    dependencies.output.emit({ kind: "text", text: formatted });
    return;
  }

  process.stdout.write(ensureTrailingNewline(formatted));
}

function parseAggregatedSteps(content: string): QueryOutputStep[] {
  const lines = content.split(/\r?\n/);
  const steps: QueryOutputStep[] = [];
  let currentTitle: string | null = null;
  let currentBody: string[] = [];

  const flush = (): void => {
    if (!currentTitle) {
      return;
    }
    steps.push({
      title: currentTitle,
      content: currentBody.join("\n").trim(),
    });
  };

  for (const line of lines) {
    const match = /^##\s+Step\s+\d+\s*:\s*(.+)$/.exec(line.trim());
    if (match) {
      flush();
      currentTitle = match[1].trim();
      currentBody = [];
      continue;
    }

    if (currentTitle) {
      currentBody.push(line);
    }
  }

  flush();

  if (steps.length > 0) {
    return steps;
  }

  return [{
    title: "Result",
    content: content.trim(),
  }];
}

function extractYnVerdict(content: string): "Y" | "N" | undefined {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    const normalized = normalizeVerdictLine(line);

    const explicitMatch = /^(?:final\s+)?(?:verdict|answer|result)\s*(?::|is)?\s*(Y|N|YES|NO|SUCCESS|FAIL(?:URE)?|PASS(?:ED)?)\b/i.exec(normalized);
    if (explicitMatch) {
      const token = explicitMatch[1].toLowerCase();
      if (token === "y" || token === "yes" || token === "success" || token === "pass" || token === "passed") {
        return "Y";
      }
      if (token === "n" || token === "no" || token === "fail" || token === "failed" || token === "failure") {
        return "N";
      }
    }

    if (
      /^Y$/i.test(normalized)
      || /^YES$/i.test(normalized)
      || /^verdict\s*:\s*Y$/i.test(normalized)
      || /^verdict\s*:\s*YES$/i.test(normalized)
      || /^verdict\s+is\s+Y$/i.test(normalized)
      || /^verdict\s+is\s+YES$/i.test(normalized)
      || /^success$/i.test(normalized)
      || /^pass(?:ed)?$/i.test(normalized)
    ) {
      return "Y";
    }
    if (
      /^N$/i.test(normalized)
      || /^NO$/i.test(normalized)
      || /^verdict\s*:\s*N$/i.test(normalized)
      || /^verdict\s*:\s*NO$/i.test(normalized)
      || /^verdict\s+is\s+N$/i.test(normalized)
      || /^verdict\s+is\s+NO$/i.test(normalized)
      || /^failure$/i.test(normalized)
      || /^fail(?:ed)?$/i.test(normalized)
    ) {
      return "N";
    }
  }

  return undefined;
}

function extractSuccessErrorVerdict(content: string): string | undefined {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    const normalized = normalizeVerdictLine(line);

    const explicitMatch = /^(?:final\s+)?(?:verdict|answer|result)\s*(?::|is)?\s*(success|failure|pass(?:ed)?|fail(?:ed)?|Y|N|YES|NO)\b(?:\s*[:\-]\s*(.+))?$/i.exec(normalized);
    if (explicitMatch) {
      const token = explicitMatch[1].toLowerCase();
      const reason = explicitMatch[2]?.trim();
      if (token === "success" || token === "pass" || token === "passed" || token === "y" || token === "yes") {
        return "success";
      }
      if (token === "failure" || token === "fail" || token === "failed" || token === "n" || token === "no") {
        return reason && reason.length > 0 ? `failure: ${reason}` : "failure: no reason provided";
      }
    }

    if (
      /^success$/i.test(normalized)
      || /^yes$/i.test(normalized)
      || /^y$/i.test(normalized)
      || /^verdict\s*:\s*success$/i.test(normalized)
      || /^verdict\s+is\s+success$/i.test(normalized)
      || /^final\s+verdict\s*:\s*success$/i.test(normalized)
      || /^final\s+answer\s*:\s*success$/i.test(normalized)
      || /^pass(?:ed)?$/i.test(normalized)
    ) {
      return "success";
    }

    const match = /^failure\s*[:\-]\s*(.+)$/i.exec(normalized)
      ?? /^verdict\s*:\s*failure\s*[:\-]\s*(.+)$/i.exec(normalized)
      ?? /^verdict\s+is\s+failure\s*[:\-]\s*(.+)$/i.exec(normalized)
      ?? /^fail(?:ed)?\s*[:\-]\s*(.+)$/i.exec(normalized);
    if (match) {
      const reason = match[1].trim();
      return reason.length > 0 ? `failure: ${reason}` : "failure: no reason provided";
    }

    if (
      /^failure$/i.test(normalized)
      || /^no$/i.test(normalized)
      || /^n$/i.test(normalized)
      || /^verdict\s*:\s*failure$/i.test(normalized)
      || /^verdict\s+is\s+failure$/i.test(normalized)
      || /^final\s+verdict\s*:\s*failure$/i.test(normalized)
      || /^final\s+answer\s*:\s*failure$/i.test(normalized)
      || /^fail(?:ed)?$/i.test(normalized)
    ) {
      return "failure: no reason provided";
    }
  }

  const ynVerdict = extractYnVerdict(content);
  if (ynVerdict === "Y") {
    return "success";
  }
  if (ynVerdict === "N") {
    return "failure: condition not satisfied";
  }

  return undefined;
}

function extractStepTitle(content: string): string | undefined {
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const headingMatch = /^#{1,6}\s+(.+)$/.exec(line.trim());
    if (headingMatch) {
      return headingMatch[1].trim();
    }
  }

  return undefined;
}

function compareStepFileNames(left: string, right: string): number {
  const leftIndex = extractStepIndex(left);
  const rightIndex = extractStepIndex(right);

  if (leftIndex !== undefined && rightIndex !== undefined) {
    if (leftIndex !== rightIndex) {
      return leftIndex - rightIndex;
    }
  } else if (leftIndex !== undefined) {
    return -1;
  } else if (rightIndex !== undefined) {
    return 1;
  }

  return left.localeCompare(right);
}

function extractStepIndex(fileName: string): number | undefined {
  const match = /^step-(\d+)/i.exec(fileName);
  if (!match) {
    return undefined;
  }

  return Number.parseInt(match[1], 10);
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function normalizeVerdictLine(line: string): string {
  let normalized = line.trim();
  normalized = normalized.replace(/^[-*+]\s+/, "");
  normalized = normalized.replace(/^\d+[.)]\s+/, "");
  normalized = normalized.replace(/^[>`]+\s*/, "");
  normalized = normalized.replace(/[*_`]/g, "");
  normalized = normalized.replace(/[.;,!?]+$/g, "");
  return normalized.trim();
}

function listStepFiles(workdir: string, dependencies: QueryOutputDependencies): string[] {
  if (dependencies.fileSystem) {
    if (!dependencies.fileSystem.exists(workdir)) {
      return [];
    }

    return dependencies.fileSystem
      .readdir(workdir)
      .filter((entry) => entry.isFile)
      .map((entry) => entry.name);
  }

  if (!fs.existsSync(workdir)) {
    return [];
  }

  return fs.readdirSync(workdir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
}

function readText(filePath: string, dependencies: QueryOutputDependencies): string {
  if (dependencies.fileSystem) {
    return dependencies.fileSystem.readText(filePath);
  }

  return fs.readFileSync(filePath, "utf-8");
}

function writeText(filePath: string, content: string, dependencies: QueryOutputDependencies): void {
  if (dependencies.fileSystem) {
    dependencies.fileSystem.writeText(filePath, content);
    return;
  }

  fs.writeFileSync(filePath, content, "utf-8");
}

function mkdir(dirPath: string, dependencies: QueryOutputDependencies): void {
  if (dependencies.fileSystem) {
    dependencies.fileSystem.mkdir(dirPath, { recursive: true });
    return;
  }

  fs.mkdirSync(dirPath, { recursive: true });
}

function joinPath(left: string, right: string, dependencies: QueryOutputDependencies): string {
  if (dependencies.pathOperations) {
    return dependencies.pathOperations.join(left, right);
  }

  return path.join(left, right);
}

function dirname(value: string, dependencies: QueryOutputDependencies): string {
  if (dependencies.pathOperations) {
    return dependencies.pathOperations.dirname(value);
  }

  return path.dirname(value);
}
