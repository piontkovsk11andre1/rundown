import { spawn } from "node:child_process";
import {
  beginRuntimePhase,
  completeRuntimePhase,
  createRuntimeArtifactsContext,
  finalizeRuntimeArtifacts,
  type RuntimeArtifactsContext,
} from "./runtime-artifacts.js";
import type { InlineCliResult } from "./inline-cli.js";

const DISABLE_AUTO_PARSE_ENV = "RUNDOWN_DISABLE_AUTO_PARSE";

/**
 * Options for delegating a task to a nested rundown run.
 *
 * These values let the parent process forward runtime behavior and artifact
 * preferences while still allowing explicit CLI arguments to take precedence.
 */
export interface RundownTaskOptions {
  artifactContext?: RuntimeArtifactsContext;
  keepArtifacts?: boolean;
  artifactExtra?: Record<string, unknown>;
  rundownCommand?: string[];
  parentWorkerCommand?: string[];
  parentTransport?: string;
  parentKeepArtifacts?: boolean;
  parentShowAgentOutput?: boolean;
  parentIgnoreCliBlock?: boolean;
  parentVerify?: boolean;
  parentNoRepair?: boolean;
  parentRepairAttempts?: number;
}

/**
 * Executes a nested `rundown run` command and captures its output.
 *
 * The function creates or reuses runtime artifact tracking, forwards compatible
 * parent flags, and returns the child process exit code plus collected streams.
 */
export async function executeRundownTask(
  args: string[],
  cwd: string = process.cwd(),
  options?: RundownTaskOptions,
): Promise<InlineCliResult> {
  // Resolve how to invoke rundown in this runtime (override, node entrypoint, or PATH).
  const invocation = resolveRundownInvocation(options?.rundownCommand);
  // Build nested `run` arguments while preserving explicit child overrides.
  const forwardedArgs = buildForwardedRunArgs(args, options);
  const command = invocation.command;
  const commandArgs = [...invocation.args, "run", ...forwardedArgs];

  let ownedArtifactContext: RuntimeArtifactsContext | null = null;
  let artifactContext: RuntimeArtifactsContext;

  if (options?.artifactContext) {
    artifactContext = options.artifactContext;
  } else {
    ownedArtifactContext = createRuntimeArtifactsContext({
      cwd,
      commandName: "rundown-delegate",
      workerCommand: [command, ...commandArgs],
      mode: "wait",
      transport: "rundown-delegate",
      keepArtifacts: options?.keepArtifacts ?? false,
    });
    artifactContext = ownedArtifactContext;
  }

  const phase = beginRuntimePhase(artifactContext, {
    phase: "rundown-delegate",
    phaseLabel: "rundown-delegate",
    command: [command, ...commandArgs],
    mode: "wait",
    transport: "rundown-delegate",
    extra: options?.artifactExtra,
  });

  return new Promise((resolve, reject) => {
    // Ensure delegated runs can auto-parse their own output unless explicitly disabled there.
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    delete childEnv[DISABLE_AUTO_PARSE_ENV];

    const child = spawn(command, commandArgs, {
      stdio: ["inherit", "pipe", "pipe"],
      cwd,
      shell: false,
      env: childEnv,
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

    child.on("close", (code) => {
      const result = {
        exitCode: code,
        stdout: Buffer.concat(stdout).toString("utf-8"),
        stderr: Buffer.concat(stderr).toString("utf-8"),
      };

      completeRuntimePhase(phase, {
        exitCode: code,
        stdout: result.stdout,
        stderr: result.stderr,
        outputCaptured: true,
      });

      if (ownedArtifactContext) {
        // Finalize only contexts owned by this call; caller-owned contexts remain external.
        finalizeRuntimeArtifacts(ownedArtifactContext, {
          status: code === 0 ? "completed" : "failed",
          preserve: options?.keepArtifacts ?? false,
        });
      }

      resolve(result);
    });

    child.on("error", (error) => {
      completeRuntimePhase(phase, {
        exitCode: null,
        outputCaptured: true,
        notes: error.message,
        extra: { error: true },
      });

      if (ownedArtifactContext) {
        finalizeRuntimeArtifacts(ownedArtifactContext, {
          status: "failed",
          preserve: options?.keepArtifacts ?? false,
        });
      }

      reject(error);
    });
  });
}

/**
 * Merges parent-level options into nested `run` arguments.
 *
 * Explicit long-form options already present in `args` are never overwritten.
 */
function buildForwardedRunArgs(args: string[], options: RundownTaskOptions | undefined): string[] {
  // Normalize legacy retry flags before checking for explicit overrides.
  const forwarded: string[] = normalizeLegacyRetryArgs(args);

  const hasWorkerOverride = hasLongOption(forwarded, "--worker");
  const hasTransportOverride = hasLongOption(forwarded, "--transport");
  const hasKeepArtifactsOverride = hasLongOption(forwarded, "--keep-artifacts");
  const hasShowAgentOutputOverride = hasLongOptionVariant(forwarded, ["--show-agent-output", "--no-show-agent-output"]);
  const hasIgnoreCliBlockOverride = hasLongOption(forwarded, "--ignore-cli-block");
  const hasVerifyOverride = hasLongOptionVariant(forwarded, ["--verify", "--no-verify"]);
  const hasNoRepairOverride = hasLongOption(forwarded, "--no-repair");
  const hasRepairAttemptsOverride = hasLongOptionVariant(forwarded, ["--repair-attempts", "--retries"]);

  if (!hasWorkerOverride && options?.parentWorkerCommand && options.parentWorkerCommand.length > 0) {
    forwarded.push("--worker", ...options.parentWorkerCommand);
  }

  if (!hasTransportOverride && options?.parentTransport) {
    forwarded.push("--transport", options.parentTransport);
  }

  if (!hasKeepArtifactsOverride && options?.parentKeepArtifacts) {
    forwarded.push("--keep-artifacts");
  }

  if (!hasShowAgentOutputOverride && options?.parentShowAgentOutput) {
    forwarded.push("--show-agent-output");
  }

  if (!hasIgnoreCliBlockOverride && options?.parentIgnoreCliBlock) {
    forwarded.push("--ignore-cli-block");
  }

  if (!hasVerifyOverride && typeof options?.parentVerify === "boolean") {
    forwarded.push(options.parentVerify ? "--verify" : "--no-verify");
  }

  if (!hasNoRepairOverride && !hasRepairAttemptsOverride && options?.parentNoRepair) {
    forwarded.push("--no-repair");
  }

  if (
    !hasRepairAttemptsOverride
    && !hasNoRepairOverride
    && !options?.parentNoRepair
    && typeof options?.parentRepairAttempts === "number"
    && Number.isFinite(options.parentRepairAttempts)
  ) {
    const normalizedAttempts = Math.max(0, Math.floor(options.parentRepairAttempts));
    forwarded.push("--repair-attempts", String(normalizedAttempts));
  }

  return forwarded;
}

/**
 * Rewrites legacy retry flags to the current repair-attempts form.
 */
function normalizeLegacyRetryArgs(args: string[]): string[] {
  const normalized: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--retries") {
      normalized.push("--repair-attempts");
      const nextArg = args[index + 1];
      if (typeof nextArg === "string") {
        normalized.push(nextArg);
        index += 1;
      }
      continue;
    }

    if (arg.startsWith("--retries=")) {
      normalized.push("--repair-attempts=" + arg.slice("--retries=".length));
      continue;
    }

    normalized.push(arg);
  }

  return normalized;
}

/**
 * Returns whether any argument matches the provided long option.
 */
function hasLongOption(args: string[], option: string): boolean {
  return args.some((arg) => arg === option || arg.startsWith(option + "="));
}

/**
 * Returns whether any of the provided long options are present.
 */
function hasLongOptionVariant(args: string[], options: string[]): boolean {
  return options.some((option) => hasLongOption(args, option));
}

/**
 * Determines the executable and base arguments used to invoke rundown.
 *
 * Priority order is explicit override, current Node.js process/entrypoint, then
 * the plain `rundown` executable on PATH.
 */
function resolveRundownInvocation(override: string[] | undefined): { command: string; args: string[] } {
  if (override && override.length > 0) {
    return {
      command: override[0],
      args: override.slice(1),
    };
  }

  const execPath = process.argv[0];
  const entrypoint = process.argv[1];

  if (execPath && entrypoint) {
    return {
      command: execPath,
      args: [entrypoint],
    };
  }

  return {
    command: "rundown",
    args: [],
  };
}
