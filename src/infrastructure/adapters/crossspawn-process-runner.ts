import spawn from "cross-spawn";
import type {
  ProcessRunner,
  ProcessRunOptions,
  ProcessRunResult,
} from "../../domain/ports/process-runner.js";

/**
 * Creates a `ProcessRunner` backed by the `cross-spawn` process API.
 *
 * The returned adapter supports all runner modes defined by the domain port,
 * including detached background execution, inherited TUI execution, and
 * buffered execution with optional timeout enforcement.
 */
export function createCrossSpawnProcessRunner(): ProcessRunner {
  return {
    // Route all run requests through the shared cross-spawn execution pipeline.
    run(options) {
      return runWithCrossSpawn(options);
    },
  };
}

/**
 * Executes a command with `cross-spawn` according to the requested run mode.
 *
 * Detached runs are started and immediately resolved, TUI runs inherit stdio,
 * and default runs buffer stdout/stderr for structured return values.
 */
function runWithCrossSpawn(options: ProcessRunOptions): Promise<ProcessRunResult> {
  return new Promise((resolve, reject) => {
    const { command, args, cwd, mode, shell, env, timeoutMs } = options;

    if (mode === "detached") {
      // Launch background work fully detached from the current terminal session.
      const child = spawn(command, args, {
        cwd,
        shell: shell ?? false,
        env,
        stdio: "ignore",
        detached: true,
      });
      child.on("error", reject);
      child.unref();
      // Detached mode does not expose streams or a terminal exit code to the caller.
      resolve({ exitCode: null, stdout: "", stderr: "" });
      return;
    }

    if (mode === "tui") {
      // Inherit stdio so interactive tools render directly in the active terminal.
      const child = spawn(command, args, {
        cwd,
        shell: shell ?? false,
        env,
        stdio: "inherit",
      });
      child.on("close", (exitCode) => {
        resolve({ exitCode, stdout: "", stderr: "" });
      });
      child.on("error", reject);
      return;
    }

    const child = spawn(command, args, {
      cwd,
      shell: shell ?? false,
      env,
      stdio: ["inherit", "pipe", "pipe"],
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timeoutHandle: NodeJS.Timeout | null = null;

    if (typeof timeoutMs === "number" && timeoutMs > 0) {
      // Terminate long-running commands after the configured timeout window.
      timeoutHandle = setTimeout(() => {
        child.kill("SIGTERM");
      }, timeoutMs);
    }

    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (timeoutHandle) {
        // Prevent the timeout callback from firing after process completion.
        clearTimeout(timeoutHandle);
      }

      resolve({
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf-8"),
        stderr: Buffer.concat(stderr).toString("utf-8"),
      });
    });
  });
}
