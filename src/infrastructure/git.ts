/**
 * Git integration — auto-commit after task completion.
 *
 * Provides a small, focused API for committing the checked Markdown file
 * after md-todo marks a task as complete. The commit uses a structured
 * message so that `git log --grep="md-todo:"` can trace task completions.
 */

import { execFile } from "node:child_process";
import path from "node:path";
import { renderTemplate, type TemplateVars } from "../domain/template.js";

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

const DEFAULT_COMMIT_MESSAGE_TEMPLATE = "md-todo: complete \"{{task}}\" in {{file}}";

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
 * Stage the task file and create a commit with a structured message.
 *
 * The default commit message format is:
 *   md-todo: complete "<task text>" in <relative file path>
 *
 * A custom message template can be supplied via `messageTemplate`.
 * It supports `{{task}}` and `{{file}}` placeholders.
 *
 * Throws if git operations fail (caller is expected to catch and warn).
 */
export async function commitCheckedTask(options: CommitTaskOptions): Promise<string> {
  const { task, file, line, index, cwd, messageTemplate } = options;

  const relativePath = path.relative(cwd, file).replace(/\\/g, "/");

  const message = renderCommitMessage(
    messageTemplate ?? DEFAULT_COMMIT_MESSAGE_TEMPLATE,
    { task, file: relativePath, line, index },
  );

  await git(["add", "--", relativePath], cwd);
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
        const message = stderr?.trim() || stdout?.trim() || error.message;
        reject(new Error(`git ${args[0]}: ${message}`));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}
