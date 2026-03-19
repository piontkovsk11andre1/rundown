import spawn from "cross-spawn";
import type {
  ProcessRunner,
  ProcessRunOptions,
  ProcessRunResult,
} from "../../domain/ports/process-runner.js";

export function createCrossSpawnProcessRunner(): ProcessRunner {
  return {
    run(options) {
      return runWithCrossSpawn(options);
    },
  };
}

function runWithCrossSpawn(options: ProcessRunOptions): Promise<ProcessRunResult> {
  return new Promise((resolve, reject) => {
    const { command, args, cwd, mode, shell, env, timeoutMs } = options;

    if (mode === "detached") {
      const child = spawn(command, args, {
        cwd,
        shell: shell ?? false,
        env,
        stdio: "ignore",
        detached: true,
      });
      child.on("error", reject);
      child.unref();
      resolve({ exitCode: null, stdout: "", stderr: "" });
      return;
    }

    if (mode === "tui") {
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
      timeoutHandle = setTimeout(() => {
        child.kill("SIGTERM");
      }, timeoutMs);
    }

    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (timeoutHandle) {
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
