import { CONFIG_DIR_NAME } from "../domain/ports/config-dir-port.js";
import type { Task } from "../domain/parser.js";
import { renderTemplate } from "../domain/template.js";
import type {
  ConfigDirResult,
  GitClient,
  PathOperationsPort,
} from "../domain/ports/index.js";

/**
 * Default commit message template used when no custom template is configured.
 */
const DEFAULT_COMMIT_MESSAGE_TEMPLATE = "rundown: complete \"{{task}}\" in {{file}}";

/**
 * Detects whether the provided working directory is inside a Git repository.
 */
export async function isGitRepoWithGitClient(gitClient: GitClient, cwd: string): Promise<boolean> {
  try {
    // `rev-parse --is-inside-work-tree` returns the literal string `true` for repo directories.
    const output = await gitClient.run(["rev-parse", "--is-inside-work-tree"], cwd);
    return output.trim() === "true";
  } catch {
    // Any Git invocation failure is treated as "not a repository" for caller simplicity.
    return false;
  }
}

/**
 * Checks whether the repository has pending changes after excluding generated
 * runtime artifacts and lock files.
 */
export async function isWorkingDirectoryClean(
  gitClient: GitClient,
  cwd: string,
  configDir: ConfigDirResult | undefined,
  pathOperations: PathOperationsPort,
): Promise<boolean> {
  // Build shared pathspec exclusions so runtime artifacts do not pollute cleanliness checks.
  const excludes = await resolveGitArtifactAndLockExcludes(gitClient, cwd, configDir, pathOperations);
  const output = await gitClient.run(
    ["status", "--porcelain", "--", ":/", ...excludes],
    cwd,
  );
  // Porcelain output is empty only when no tracked or untracked changes remain.
  return output.trim().length === 0;
}

/**
 * Stages repository changes (excluding runtime artifacts) and commits them for
 * the selected checked task.
 */
export async function commitCheckedTaskWithGitClient(
  gitClient: GitClient,
  task: Task,
  cwd: string,
  message: string,
  configDir: ConfigDirResult | undefined,
  pathOperations: PathOperationsPort,
): Promise<{ kind: "committed" } | { kind: "skipped-no-changes" }> {
  // Reuse the same exclusion rules used by status checks to keep behavior consistent.
  const excludes = await resolveGitArtifactAndLockExcludes(gitClient, cwd, configDir, pathOperations);

  // Skip no-op commit attempts when there are no candidate changes to stage.
  const statusOutput = await gitClient.run(
    ["status", "--porcelain", "--untracked-files=no", "--", ":/", ...excludes],
    cwd,
  );
  if (statusOutput.trim().length === 0) {
    return { kind: "skipped-no-changes" };
  }

  await gitClient.run(["add", "-A", "--", ":/", ...excludes], cwd);
  try {
    await gitClient.run(["commit", "-m", message], cwd);
    return { kind: "committed" };
  } catch (error) {
    if (isNoOpCommitError(error)) {
      return { kind: "skipped-no-changes" };
    }
    throw error;
  }
}

function isNoOpCommitError(error: unknown): boolean {
  const message = String(error).toLowerCase();
  return message.includes("nothing to commit") || message.includes("nothing added to commit");
}

/**
 * Resolves Git pathspec exclusions for generated rundown artifacts and lock
 * files, while safely handling config directories outside the repository root.
 */
export async function resolveGitArtifactAndLockExcludes(
  gitClient: GitClient,
  cwd: string,
  configDir: ConfigDirResult | undefined,
  pathOperations: PathOperationsPort,
): Promise<string[]> {
  // Always exclude lock files under any `.rundown` directory in the repository tree.
  const excludes = [`:(glob,exclude)**/${CONFIG_DIR_NAME}/*.lock`];
  const effectiveConfigDir = configDir?.configDir;
  if (!effectiveConfigDir) {
    return excludes;
  }

  let repoRoot = "";
  try {
    // Resolve the absolute repository root so relative pathspecs can be computed reliably.
    repoRoot = (await gitClient.run(["rev-parse", "--show-toplevel"], cwd)).trim();
  } catch {
    // If Git root resolution fails, fall back to the minimal lock-file exclusion.
    return excludes;
  }

  // Git pathspecs expect POSIX separators even on Windows.
  const relativeConfigDir = pathOperations.relative(repoRoot, effectiveConfigDir).replace(/\\/g, "/");
  if (!isPathInsideRepo(relativeConfigDir)) {
    // Ignore config directories outside the repo to avoid unintended absolute pathspecs.
    return excludes;
  }

  // When the config directory is covered by .gitignore, explicit exclude
  // pathspecs are unnecessary (git already skips ignored paths) and cause
  // `git add` to fail with "The following paths are ignored" errors.
  try {
    await gitClient.run(["check-ignore", "-q", relativeConfigDir], cwd);
    // check-ignore exits 0 when the path is ignored — no excludes needed.
    return [];
  } catch {
    // Non-zero exit means the path is NOT ignored — add explicit excludes.
  }

  // Prioritize top-level exclusions for known artifact folders and root lock files.
  excludes.unshift(
    `:(top,exclude)${relativeConfigDir}/runs/**`,
    `:(top,exclude)${relativeConfigDir}/logs/**`,
    `:(top,exclude)${relativeConfigDir}/*.lock`,
  );

  return excludes;
}

/**
 * Validates that a relative path stays within repository boundaries.
 */
export function isPathInsideRepo(relativePath: string): boolean {
  if (relativePath.length === 0 || relativePath === ".") {
    return false;
  }

  if (relativePath === ".." || relativePath.startsWith("../")) {
    return false;
  }

  if (relativePath.startsWith("/") || /^[A-Za-z]:\//.test(relativePath)) {
    return false;
  }

  return true;
}

/**
 * Builds the commit message for a completed task using a template with task and
 * path metadata.
 */
export function buildCommitMessage(
  task: Task,
  cwd: string,
  messageTemplate: string | undefined,
  pathOperations: PathOperationsPort,
): string {
  // Store task file path relative to the invocation directory for concise commit subjects.
  const relativePath = pathOperations.relative(cwd, task.file).replace(/\\/g, "/");
  return renderTemplate(messageTemplate ?? DEFAULT_COMMIT_MESSAGE_TEMPLATE, {
    task: task.text,
    file: relativePath,
    context: "",
    taskIndex: task.index,
    taskLine: task.line,
    source: "",
  });
}
