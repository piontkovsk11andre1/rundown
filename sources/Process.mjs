import { spawn } from "node:child_process";
import { normalizeTraceCarrier } from "./Observability.mjs";
/** @typedef {import('./InternalContracts.mjs').ProcessOptions&{command:string,args?:string[]}} ProcessInput */

/** Bounded subprocess execution. POSIX cancellation terminates the process group.
 * @param {string} command @param {string[]} args @param {import('./InternalContracts.mjs').ProcessOptions} [options]
 * @returns {Promise<{stdout:string,stderr:string}>}
 */
export function runProcess(
  command,
  args,
  {
    cwd,
    env = process.env,
    signal,
    timeoutMs = 180000,
    maxBytes = 8 * 1024 * 1024,
    traceContext,
  } = {},
) {
  signal?.throwIfAborted();
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new TypeError("timeoutMs must be positive");
  if (!Number.isFinite(maxBytes) || maxBytes <= 0)
    throw new TypeError("maxBytes must be positive");
  if (
    !command ||
    !Array.isArray(args) ||
    args.some((argument) => typeof argument !== "string")
  )
    throw new TypeError("Expected a command and string argv array");
  return new Promise((resolve, reject) => {
    const grouped = process.platform !== "win32";
    const child = spawn(command, args, {
      cwd,
      env: traceContext
        ? {
            ...env,
            RUNDOWN_TRACE_CONTEXT: JSON.stringify(
              normalizeTraceCarrier(traceContext),
            ),
          }
        : env,
      shell: false,
      detached: grouped,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "",
      errors = "",
      bytes = 0;
    /** @type {{error:unknown}|undefined} */
    let failure;
    /** @type {ReturnType<typeof setTimeout>|undefined} */
    let timer;
    /** @type {ReturnType<typeof setTimeout>|undefined} */
    let killTimer;
    /** @param {NodeJS.Signals} how */
    const kill = (how) => {
      if (!child.pid) return;
      try {
        if (grouped) process.kill(-child.pid, how);
        else child.kill(how);
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== "ESRCH"
        )
          failure ??= { error };
      }
    };
    /** @param {unknown} error */
    const stop = (error) => {
      failure ??= { error };
      kill("SIGTERM");
      killTimer ??= setTimeout(() => kill("SIGKILL"), 1000);
    };
    const abort = () =>
      stop(signal?.reason ?? new DOMException("Cancelled", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(
      () => stop(new Error(`Process timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    /** @param {'stdout'|'stderr'} channel @returns {(chunk:string)=>void} */
    const receive = (channel) => (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes) {
        stop(new Error("Process output exceeded limit"));
        return;
      }
      if (channel === "stdout") output += chunk;
      else errors += chunk;
    };
    child.stdout.setEncoding("utf8").on("data", receive("stdout"));
    child.stderr.setEncoding("utf8").on("data", receive("stderr"));
    child.once("error", (error) => {
      failure ??= { error };
    });
    child.once("close", (code, exitSignal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);
      if (failure) reject(failure.error);
      else if (code !== 0)
        reject(
          new Error(`Process exited with ${exitSignal ?? code}: ${errors}`),
        );
      else resolve({ stdout: output, stderr: errors });
    });
    if (signal?.aborted) abort();
  });
}

/** Domain-neutral adapter for commands, deployment tools and build scripts. */
export class ProcessAdapter {
  /** @param {{timeoutMs?:number,maxBytes?:number,env?:NodeJS.ProcessEnv}} [defaults] */
  constructor(defaults = {}) {
    this.defaults = { ...defaults };
  }
  /** @param {ProcessInput} input */
  run({ command, args = [], ...options }) {
    return runProcess(command, args, { ...this.defaults, ...options });
  }
}
