/**
 * Git integration — auto-commit after task completion.
 *
 * Provides a small, focused API for committing task completion after rundown
 * marks a task as complete. The commit uses a structured message so that
 * `git log --grep="rundown:"` can trace task completions.
 */

import { execFile } from "node:child_process";
import path from "node:path";
import { CONFIG_DIR_NAME } from "../domain/ports/config-dir-port.js";
import { renderTemplate, type TemplateVars } from "../domain/template.js";

/**
 * Describes the inputs required to commit a newly checked task.
 */
export interface CommitTaskOptions {
  /** The task text. */
  task: string;
  /** Absolute path to the Markdown file that was updated. */
  file: string;
  /** 1-based line number of the completed task. */
  line: number;
  /** Zero-based task index. */
  index: number;
  /** Working directory for git commands. */
  cwd: string;
  /** Custom commit message template (supports {{task}}, {{file}} placeholders). */
  messageTemplate?: string;
}

// Fallback message format used when callers do not provide a template.
const DEFAULT_COMMIT_MESSAGE_TEMPLATE = "rundown: complete \"{{task}}\" in {{file}}";

// Pathspec exclusions keep runtime artifacts and lockfiles out of auto-commits.
const GIT_ARTIFACT_AND_LOCK_EXCLUDES = [
  `:(top,exclude)${CONFIG_DIR_NAME}/runs/**`,
  `:(top,exclude)${CONFIG_DIR_NAME}/logs/**`,
  `:(top,exclude)${CONFIG_DIR_NAME}/*.lock`,
  `:(glob,exclude)**/${CONFIG_DIR_NAME}/*.lock`,
] as const;

/**
 * Check whether the current directory is inside a git repository.
 */
export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await git(["rev-parse", "--is-inside-work-tree"], cwd);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stage all worktree changes and create a commit with a structured message.
 *
 * The default commit message format is:
 *   rundown: complete "<task text>" in <relative file path>
 *
 * A custom message template can be supplied via `messageTemplate`.
 * It supports `{{task}}` and `{{file}}` placeholders.
 *
 * Throws if git operations fail (caller is expected to catch and warn).
 */
export async function commitCheckedTask(options: CommitTaskOptions): Promise<string> {
  const { task, file, line, index, cwd, messageTemplate } = options;

  // Render file paths in a cross-platform, git-friendly format.
  const relativePath = path.relative(cwd, file).replace(/\\/g, "/");

  const message = renderCommitMessage(
    messageTemplate ?? DEFAULT_COMMIT_MESSAGE_TEMPLATE,
    { task, file: relativePath, line, index },
  );

  await git(["add", "-A", "--", ":/", ...GIT_ARTIFACT_AND_LOCK_EXCLUDES], cwd);
  await git(["commit", "-m", message], cwd);

  return message;
}

/**
 * Render the commit message template with task variables.
 */
function renderCommitMessage(
  template: string,
  vars: { task: string; file: string; line: number; index: number },
): string {
  // Reuse the project's template renderer with a minimal vars object.
  return renderTemplate(template, {
    task: vars.task,
    file: vars.file,
    context: "",
    taskIndex: vars.index,
    taskLine: vars.line,
    source: "",
  } as TemplateVars);
}

/**
 * Run a git command and return stdout.
 */
function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout: 30_000 }, (error, stdout, stderr) => {
      if (error) {
        // Prefer stderr for actionable details, then stdout, then process message.
        const message = stderr?.trim() || stdout?.trim() || error.message;
        reject(new Error(`git ${args[0]}: ${message}`));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}
