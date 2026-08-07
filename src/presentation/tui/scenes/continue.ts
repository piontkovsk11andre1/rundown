// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import pc from "picocolors";
import { createApp } from "../../../create-app.js";
import type { App } from "../../../create-app.js";
import type { ApplicationOutputEvent } from "../../../domain/ports/output-port.js";
import {
  formatDuration,
  formatTaskLines,
  formatTimestamp,
  progressBar,
} from "../layout.ts";
import { paintOperationBadge } from "../components/badge.ts";
import { applyOutputEvent, createInitialRunState, pushRecentMessage, type TuiRunState } from "../output-bridge.ts";

export const MATERIALIZE_MODES = [
  { key: "1", id: "migrations", label: "Materialize Migrations" },
  { key: "2", id: "path", label: "Materialize Specific Path" },
];

const DEFAULT_WORKER_PATTERN = {
  command: [],
  usesBootstrap: false,
  usesFile: false,
  appendFile: true,
};

function resolvePathSeparator(pathInput) {
  if (pathInput.includes("/") && !pathInput.includes("\\")) {
    return "/";
  }
  return path.sep;
}

function containsWildcardPattern(value) {
  return /[\*\?\[\]\{\}]/.test(value);
}

function longestCommonPrefix(values) {
  if (values.length === 0) {
    return "";
  }
  let prefix = values[0] ?? "";
  for (let index = 1; index < values.length; index += 1) {
    const candidate = values[index] ?? "";
    let cursor = 0;
    while (cursor < prefix.length && cursor < candidate.length && prefix[cursor] === candidate[cursor]) {
      cursor += 1;
    }
    prefix = prefix.slice(0, cursor);
    if (prefix.length === 0) {
      break;
    }
  }
  return prefix;
}


export function resolveMaterializeSource(activeMaterializeMode, customPath) {
  if (activeMaterializeMode === "migrations") {
    return "migrations/";
  }
  return customPath.trim();
}

export function evaluateMaterializePath(pathInput, workingDirectory) {
  const value = pathInput.trim();
  if (value.length === 0) {
    return { isValid: false, exists: false, error: "Specific path is empty. Type a path before pressing Enter." };
  }
  if (/[^\x20-\x7E]/.test(value)) {
    return { isValid: false, exists: false, error: "Path contains unsupported characters. Use visible ASCII characters only." };
  }
  const resolvedPath = path.resolve(workingDirectory, value);
  const exists = fs.existsSync(resolvedPath);
  if (!exists) {
    return { isValid: false, exists, error: `Path not found: ${value}` };
  }
  return { isValid: true, exists, error: "" };
}

export function validateMaterializePath(pathInput, workingDirectory) {
  return evaluateMaterializePath(pathInput, workingDirectory).error;
}

export function completeMaterializePathInput(pathInput, workingDirectory) {
  if (containsWildcardPattern(pathInput)) {
    return { nextInput: pathInput, hint: "Tab completion is disabled for wildcard paths." };
  }
  const lastSeparatorIndex = Math.max(pathInput.lastIndexOf("/"), pathInput.lastIndexOf("\\"));
  const hasDirPart = lastSeparatorIndex >= 0;
  const dirPart = hasDirPart ? pathInput.slice(0, lastSeparatorIndex + 1) : "";
  const partialName = hasDirPart ? pathInput.slice(lastSeparatorIndex + 1) : pathInput;
  const directoryToScan = path.resolve(workingDirectory, dirPart || ".");

  let entries;
  try {
    const stats = fs.statSync(directoryToScan);
    if (!stats.isDirectory()) {
      return { nextInput: pathInput, hint: "Tab completion failed: base path is not a directory." };
    }
    entries = fs.readdirSync(directoryToScan, { withFileTypes: true });
  } catch {
    return { nextInput: pathInput, hint: "Tab completion failed: base path does not exist." };
  }

  const normalizedPartial = partialName.toLowerCase();
  const matches = entries.filter((entry) => entry.name.toLowerCase().startsWith(normalizedPartial));
  if (matches.length === 0) {
    return { nextInput: pathInput, hint: "No matching paths for tab completion." };
  }
  const separator = resolvePathSeparator(pathInput);
  if (matches.length === 1) {
    const only = matches[0];
    const suffix = only.isDirectory() ? separator : "";
    return {
      nextInput: `${dirPart}${only.name}${suffix}`,
      hint: only.isDirectory() ? "Path completed (directory)." : "Path completed.",
    };
  }
  const sharedPrefix = longestCommonPrefix(matches.map((entry) => entry.name));
  if (sharedPrefix.length > partialName.length) {
    return { nextInput: `${dirPart}${sharedPrefix}`, hint: `${matches.length} matches (expanded to common prefix).` };
  }
  return { nextInput: pathInput, hint: `${matches.length} matches. Type more characters and press Tab again.` };
}

export function buildMaterializeCommand(sourceTarget) {
  return `rundown materialize ${sourceTarget}`;
}

async function stopMaterializeRun(runState: TuiRunState): Promise<void> {
  const app = runState.app;
  try {
    app?.releaseAllLocks?.();
    await app?.awaitShutdown?.();
  } finally {
    runState.finished = true;
    runState.exitCode = typeof runState.exitCode === "number" ? runState.exitCode : 130;
    runState.currentOperation = "finalize";
    pushRecentMessage(runState, "warn", "Stop requested. Run closed.");
  }
}

export async function listTasksFromSource(source) {
  const items = [];
  const app = createApp({
    ports: {
      output: {
        emit(event: ApplicationOutputEvent) {
          if (event.kind === "task" && event.task) {
            const task = event.task;
            items.push({
              line: typeof task.line === "number" ? task.line : 0,
              textLines: Array.isArray(task.textLines) && task.textLines.length > 0
                ? task.textLines
                : [task.text ?? ""],
            });
          }
        },
      },
    },
  });

  try {
    const exitCode = await app.listTasks({ source, sortMode: "name-sort", includeAll: false });
    return { ok: exitCode === 0 || exitCode === 3, taskItems: items, exitCode };
  } catch (error) {
    return { ok: false, taskItems: items, error: String(error) };
  } finally {
    app.releaseAllLocks?.();
    await app.awaitShutdown?.();
  }
}

export function startMaterializeRun(source: string, runState: TuiRunState): App {
  const app = createApp({
    ports: {
      output: {
        emit(event: ApplicationOutputEvent) {
          applyOutputEvent(runState, event);
        },
      },
    },
  });
  runState.app = app;
  runState.actionKey = "m";
  runState.actionLabel = "materialize";
  runState.sourceTarget = source;
  runState.runStartedAt = Date.now();

  app
    .runTask({
      source,
      mode: "wait",
      workerPattern: { ...DEFAULT_WORKER_PATTERN },
      sortMode: "name-sort",
      verify: true,
      onlyVerify: false,
      forceExecute: false,
      forceAttempts: 0,
      noRepair: false,
      repairAttempts: 0,
      dryRun: false,
      printPrompt: false,
      keepArtifacts: false,
      clean: false,
      rounds: 1,
      varsFileOption: undefined,
      cliTemplateVarArgs: [],
      commitAfterComplete: false,
      commitMode: "per-task",
      runAll: true,
      redo: false,
      resetAfter: false,
      showAgentOutput: false,
      trace: false,
      traceOnly: false,
      verbose: false,
      forceUnlock: false,
      ignoreCliBlock: false,
    })
    .then((exitCode) => {
      runState.exitCode = exitCode;
      runState.finished = true;
      runState.currentOperation = "finalize";
    })
    .catch((error) => {
      runState.exitCode = 1;
      runState.error = error instanceof Error ? error.message : String(error);
      runState.finished = true;
      pushRecentMessage(runState, "error", runState.error);
    });

  return app;
}

const CONTINUE_UI_STATES = new Set([
  "previewing",
  "running",
  "done",
]);

function formatLabeledValue(label, value, labelWidth) {
  const key = `${label}:`.padEnd(labelWidth + 1, " ");
  return `${pc.bold(key)} ${value}`;
}

function pushGap(lines, count) {
  for (let index = 0; index < count; index += 1) {
    lines.push("");
  }
}

function stripAnsi(text) {
  return String(text).replace(/\u001B\[[0-9;]*m/g, "");
}

function visibleLength(text) {
  return stripAnsi(text).length;
}

function padVisible(text, width) {
  const value = String(text);
  const padding = Math.max(0, width - visibleLength(value));
  return value + " ".repeat(padding);
}

function mergeColumns(leftLines, rightLines, leftWidth, gap) {
  const lineCount = Math.max(leftLines.length, rightLines.length);
  const merged = [];
  for (let index = 0; index < lineCount; index += 1) {
    const left = leftLines[index] ?? "";
    const right = rightLines[index] ?? "";
    if (right.length === 0) {
      merged.push(left);
    } else {
      merged.push(`${padVisible(left, leftWidth)}${" ".repeat(gap)}${right}`);
    }
  }
  return merged;
}

export function createContinueSceneState() {
  return {
    activeMaterializeMode: "migrations",
    materializePathInput: "",
    uiHint: "",
    taskItems: [],
    estimationPending: false,
    sourceTarget: "migrations/",
    previewLoaded: false,
  };
}

export function isContinueUiState(uiState) {
  return CONTINUE_UI_STATES.has(uiState);
}

export function updateContinueUiState(uiState, runState) {
  if (uiState === "running" && runState?.finished) {
    return "done";
  }
  return uiState;
}

function formatPreviewItem(label, task) {
  const labelToken = pc.bold(`${label}:`);
  if (!task) {
    return `${labelToken} ${pc.dim("(none)")}`;
  }
  const firstLine = Array.isArray(task.textLines) && task.textLines.length > 0
    ? task.textLines[0]
    : "";
  return `${labelToken} ${pc.white(String(task.line).padStart(3, "0"))} ${pc.dim("-")} ${pc.white(firstLine)}`;
}

function formatPhaseCounterLine(label, counter) {
  if (!counter || typeof counter.current !== "number" || typeof counter.total !== "number") {
    return `${pc.bold(label + ":")} ${pc.dim("n/a")}`;
  }
  return `${pc.bold(label + ":")} ${pc.white(`${counter.current}/${counter.total}`)}`;
}

function formatActiveProfile(state) {
  const profileName = typeof state.activeProfileName === "string"
    ? state.activeProfileName.trim()
    : "";
  return profileName.length > 0 ? profileName : "(default)";
}

function formatActiveWorker(state) {
  const workerLabel = typeof state.activeWorkerLabel === "string"
    ? state.activeWorkerLabel.trim()
    : "";
  if (workerLabel.length > 0) {
    return workerLabel;
  }
  const workerPattern = state.workerPattern && typeof state.workerPattern === "object"
    ? state.workerPattern
    : DEFAULT_WORKER_PATTERN;
  if (Array.isArray(workerPattern.command) && workerPattern.command.length > 0) {
    return workerPattern.command.join(" ");
  }
  return "(default resolver)";
}

export async function primeContinuePreview(state, currentWorkingDirectory) {
  const resolvedSource = resolveMaterializeSource(state.activeMaterializeMode, state.materializePathInput);
  if (state.activeMaterializeMode === "path") {
    const pathError = validateMaterializePath(state.materializePathInput, currentWorkingDirectory);
    if (pathError) {
      return {
        ...state,
        sourceTarget: resolvedSource,
        previewLoaded: true,
        estimationPending: false,
        taskItems: [],
        uiHint: pathError,
      };
    }
  }
  try {
    const result = await listTasksFromSource(resolvedSource);
    return {
      ...state,
      sourceTarget: resolvedSource,
      previewLoaded: true,
      estimationPending: false,
      taskItems: result.taskItems,
      uiHint: result.ok ? "" : `listTasks exited with code ${result.exitCode ?? "?"}.`,
    };
  } catch (error) {
    return {
      ...state,
      sourceTarget: resolvedSource,
      previewLoaded: true,
      estimationPending: false,
      taskItems: [],
      uiHint: "Failed to list tasks: " + String(error),
    };
  }
}

export function renderContinueSceneLines({
  uiState,
  state,
  runState,
  currentWorkingDirectory,
  sectionGap,
  hintGap,
  errorGap,
}) {
  void currentWorkingDirectory;
  const lines = [];
  const taskItems = state.taskItems;
  const totalTasks = runState.totalTasks > 0 ? runState.totalTasks : taskItems.length;
  const completedTasks = Math.min(totalTasks, runState.completedTasks);
  const elapsedMs = runState.runStartedAt > 0 ? Date.now() - runState.runStartedAt : 0;
  const completedRatio = totalTasks > 0 ? completedTasks / totalTasks : 0;

  if (uiState === "previewing") {
    const resolvedSource = state.sourceTarget || resolveMaterializeSource(state.activeMaterializeMode, state.materializePathInput);
    const sourcePath = resolvedSource || "(none)";
    const previewTasks = taskItems.slice(0, 3);
    lines.push(pc.bold("Continue Preview"));
    pushGap(lines, sectionGap);
    lines.push(
      `${pc.bold("Source:")} ${pc.cyan(resolvedSource)}`,
      `${pc.bold("Source path:")} ${pc.white(sourcePath)}`,
      `${pc.bold("Profile:")} ${pc.white(formatActiveProfile(state))}`,
      `${pc.bold("Worker:")} ${pc.white(formatActiveWorker(state))}`,
      `${pc.bold("Task count:")} ${pc.white(String(taskItems.length))}`,
    );
    pushGap(lines, sectionGap);
    lines.push(
      formatPreviewItem("next", previewTasks[0]),
      formatPreviewItem("after", previewTasks[1]),
      formatPreviewItem("later", previewTasks[2]),
    );
    pushGap(lines, sectionGap);
    if (state.estimationPending || !state.previewLoaded) {
      lines.push(pc.yellow("Loading task list..."));
    } else {
      lines.push(pc.dim("Enter: start run. r: refresh list. Esc: back."));
    }
    if (state.uiHint) {
      pushGap(lines, state.uiHint.startsWith("Path ") ? errorGap : hintGap);
      lines.push(state.uiHint.startsWith("Path ") ? pc.red(state.uiHint) : pc.yellow(state.uiHint));
    }
    return lines;
  }

  if (uiState === "running" || uiState === "done") {
    const isComplete = runState.finished || (totalTasks > 0 && completedTasks >= totalTasks);
    const taskListIndex = runState.currentTaskIndex >= 0 ? runState.currentTaskIndex : completedTasks;
    const previousTask = isComplete
      ? taskItems[taskItems.length - 1]
      : (taskListIndex > 0 ? taskItems[taskListIndex - 1] : undefined);
    const currentTask = isComplete ? undefined : taskItems[taskListIndex];
    const nextTask = isComplete ? undefined : taskItems[taskListIndex + 1];

    const previousTaskLines = formatTaskLines("previous", previousTask, true, "muted");
    const currentTaskLines = formatTaskLines("current", currentTask, false, "normal");
    const nextTaskLines = formatTaskLines("next", nextTask, false, "muted");
    const summaryLabelWidth = 7;
    const timingLabelWidth = 20;
    const phaseLabelWidth = 13;

    const leftLines = [];
    const rightLines = [];

    leftLines.push(
      formatLabeledValue("Action", pc.white(runState.actionLabel || "(none)"), summaryLabelWidth),
      formatLabeledValue("Target", pc.cyan(runState.sourceTarget || "(none)"), summaryLabelWidth),
      formatLabeledValue("Elapsed", pc.white(formatDuration(elapsedMs)), summaryLabelWidth),
      formatLabeledValue(
        "Tasks",
        `${pc.white(String(completedTasks))} / ${pc.white(String(totalTasks))}`,
        summaryLabelWidth,
      ),
    );
    pushGap(leftLines, sectionGap);
    leftLines.push(
      formatLabeledValue("Run Started", pc.white(formatTimestamp(runState.runStartedAt)), timingLabelWidth),
      formatLabeledValue(
        "Current Task Started",
        pc.white(isComplete ? "n/a (run complete)" : formatTimestamp(runState.currentTaskStartedAt)),
        timingLabelWidth,
      ),
    );
    pushGap(leftLines, sectionGap);
    leftLines.push(
      formatLabeledValue("Operation", paintOperationBadge(runState.currentOperation, runState.currentOperation.toUpperCase()), phaseLabelWidth),
      formatLabeledValue(
        "Task Progress",
        `${progressBar(40, completedRatio)} ${pc.white(`${Math.round(completedRatio * 100)}%`)}`,
        phaseLabelWidth,
      ),
    );

    const phaseCounter = runState.currentPhaseCounter;
    const hasPhaseCounters = phaseCounter || (runState.phaseCounters && Object.keys(runState.phaseCounters).length > 0);
    if (hasPhaseCounters) {
      rightLines.push(pc.bold("Phase Counters:"));
      rightLines.push(formatPhaseCounterLine("current", phaseCounter));
      const operationKey = (runState.currentOperation || "").toLowerCase();
      if (runState.phaseCounters?.attempt) {
        rightLines.push(formatPhaseCounterLine("attempt", runState.phaseCounters.attempt));
      }
      if (operationKey && runState.phaseCounters?.[operationKey]) {
        rightLines.push(formatPhaseCounterLine(operationKey, runState.phaseCounters[operationKey]));
      }
    } else {
      rightLines.push(pc.bold("Phase Counters:"));
      rightLines.push(formatPhaseCounterLine("current", null));
    }

    if (taskItems.length > 0) {
      pushGap(leftLines, sectionGap);
      leftLines.push(...previousTaskLines);
      pushGap(leftLines, sectionGap);
      leftLines.push(...currentTaskLines);
      pushGap(leftLines, sectionGap);
      leftLines.push(...nextTaskLines);
    }

    pushGap(leftLines, sectionGap);
    leftLines.push(
      `${pc.bold("Failures:")} ${pc.white(String(runState.failures))}   ${pc.bold("Repairs:")} ${pc.white(String(runState.repairs))}`,
      `${pc.bold("Resolvings:")} ${pc.white(String(runState.resolvings))}   ${pc.bold("Resets:")} ${pc.white(String(runState.resets))}`,
    );

    if (runState.recentMessages.length > 0) {
      pushGap(leftLines, sectionGap);
      leftLines.push(pc.bold("Recent:"));
      const tail = runState.recentMessages.slice(-6);
      for (const entry of tail) {
        const painter = entry.kind === "error"
          ? pc.red
          : entry.kind === "warn"
            ? pc.yellow
            : entry.kind === "success"
              ? pc.green
              : pc.dim;
        leftLines.push(`  ${painter(entry.message)}`);
      }
    }

    const merged = mergeColumns(leftLines, rightLines, 62, 4);
    lines.push(...merged);

    if (state.uiHint) {
      pushGap(lines, hintGap);
      lines.push(pc.yellow(state.uiHint));
    }

    if (uiState === "done") {
      pushGap(lines, sectionGap);
      lines.push(pc.bold("Run Summary"));
      lines.push(
        `${pc.bold("Counts:")} ${pc.white(`${completedTasks}/${totalTasks}`)} tasks`,
        `${pc.bold("Duration:")} ${pc.white(formatDuration(elapsedMs))}`,
        `${pc.bold("Failures:")} ${pc.white(String(runState.failures))}   ${pc.bold("Repairs:")} ${pc.white(String(runState.repairs))}   ${pc.bold("Resolves:")} ${pc.white(String(runState.resolvings))}`,
      );
      if (runState.exitCode !== 0 && runState.error) {
        lines.push(`${pc.bold("Failure reason:")} ${pc.red(runState.error)}`);
      }
      pushGap(lines, sectionGap);
      if (runState.exitCode === 0) {
        lines.push(pc.green(`Run complete (exit ${runState.exitCode ?? 0}).`));
      } else {
        lines.push(pc.red(`Run failed (exit ${runState.exitCode ?? "?"}).`));
      }
      lines.push(pc.dim("Press Esc to return to menu."));
    }
    return lines;
  }

  return lines;
}

export async function handleContinueInput({
  rawInput,
  uiState,
  state,
  runState,
  currentWorkingDirectory,
}) {
  const input = String(rawInput).toLowerCase();
  const isEnter = rawInput === "\r" || rawInput === "\n";
  const isEscape = rawInput === "\u001b";
  const isBackspace = rawInput === "\b" || rawInput === "\u007f";
  const isTab = rawInput === "\t";
  const isCtrlU = rawInput === "\u0015";
  const isArrowUp = rawInput === "\u001b[A";
  const isArrowDown = rawInput === "\u001b[B";
  const isSpace = rawInput === " ";

  if (uiState === "previewing") {
    if (isEscape) {
      return {
        handled: true,
        uiState,
        state: createContinueSceneState(),
        runState: createInitialRunState(),
        backToParent: true,
      };
    }

    if (input === "r") {
      const pendingState = {
        ...state,
        estimationPending: true,
        uiHint: "Loading task list...",
      };
      return {
        handled: true,
        uiState,
        state: await primeContinuePreview(pendingState, currentWorkingDirectory),
        runState,
        backToParent: false,
      };
    }

    if (isEnter) {
      if (state.estimationPending || !state.previewLoaded) {
        return { handled: true, uiState, state, runState, backToParent: false };
      }
      if (state.taskItems.length === 0) {
        return {
          handled: true,
          uiState,
          state: { ...state, uiHint: "No unchecked tasks found." },
          runState,
          backToParent: false,
        };
      }
      const resolvedSource = state.sourceTarget || resolveMaterializeSource(state.activeMaterializeMode, state.materializePathInput);
      const nextRunState = createInitialRunState();
      nextRunState.totalTasks = state.taskItems.length;
      startMaterializeRun(resolvedSource, nextRunState);
      return {
        handled: true,
        uiState: "running",
        state: { ...state, uiHint: "" },
        runState: nextRunState,
        backToParent: false,
      };
    }

    return { handled: false, uiState, state, runState, backToParent: false };
  }

  if (uiState === "running") {
    if (isSpace) {
      return {
        handled: true,
        uiState,
        state: { ...state, uiHint: "Pause not yet supported." },
        runState,
        backToParent: false,
      };
    }
    if (input === "s") {
      await stopMaterializeRun(runState);
      return {
        handled: true,
        uiState: "done",
        state: { ...state, uiHint: "Stop requested." },
        runState,
        backToParent: false,
      };
    }
    if (isArrowUp || isArrowDown || isBackspace || isTab || isCtrlU) {
      return { handled: true, uiState, state, runState, backToParent: false };
    }
  }

  if (uiState === "done" && isEscape) {
    return {
      handled: true,
      uiState,
      state: createContinueSceneState(),
      runState: createInitialRunState(),
      backToParent: true,
    };
  }

  return { handled: false, uiState, state, runState, backToParent: false };
}
