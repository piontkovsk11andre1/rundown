// Marker used to identify signal listeners registered by this module.
const LOCK_RELEASE_SIGNAL_HANDLER_MARKER = "__rundownLockReleaseSignalHandler";
// Marker used to identify exit listeners registered by this module.
const LOCK_RELEASE_EXIT_HANDLER_MARKER = "__rundownLockReleaseExitHandler";
// Symbol key used to persist mutable handler dependencies on the process object.
const LOCK_RELEASE_HANDLER_STATE_SYMBOL = Symbol.for("rundown.lock-release-handler-state");

type TaggedLockReleaseHandler = ((...args: unknown[]) => unknown) & {
  [LOCK_RELEASE_SIGNAL_HANDLER_MARKER]?: boolean;
  [LOCK_RELEASE_EXIT_HANDLER_MARKER]?: boolean;
};

// Minimal cleanup surface required by lock-release shutdown handlers.
interface LockReleaseApp {
  releaseAllLocks?: () => void;
  awaitShutdown?: () => Promise<void>;
}

// Runtime dependencies injected by the caller and resolved lazily by handlers.
interface LockReleaseHandlerDependencies {
  terminate: (code: number) => never;
  getAppForCleanup: () => LockReleaseApp | undefined;
  resolveExitCodeForSignal?: (signal: NodeJS.Signals) => number | undefined;
}

interface LockReleaseHandlerState {
  dependencies: LockReleaseHandlerDependencies;
  shutdownInProgress: Promise<void> | null;
  shutdownError: unknown;
}

/**
 * Returns shared handler state stored on `process`, creating defaults once.
 */
function getLockReleaseHandlerState(): LockReleaseHandlerState {
  const processWithState = process as typeof process & {
    [LOCK_RELEASE_HANDLER_STATE_SYMBOL]?: LockReleaseHandlerState;
  };

  // Initialize default dependencies to keep handlers safe before registration.
  if (!processWithState[LOCK_RELEASE_HANDLER_STATE_SYMBOL]) {
    processWithState[LOCK_RELEASE_HANDLER_STATE_SYMBOL] = {
      dependencies: {
        terminate: (code: number) => {
          process.exit(code);
        },
        getAppForCleanup: () => undefined,
        resolveExitCodeForSignal: () => undefined,
      },
      shutdownInProgress: null,
      shutdownError: null,
    };
  }

  return processWithState[LOCK_RELEASE_HANDLER_STATE_SYMBOL];
}

/**
 * Attempts lock cleanup without ever throwing during shutdown.
 */
function releaseHeldFileLocksBestEffort(getAppForCleanup: () => LockReleaseApp | undefined): void {
  try {
    getAppForCleanup()?.releaseAllLocks?.();
  } catch {
    // best-effort cleanup: never mask shutdown with lock release failures
  }
}

/**
 * Waits for app-level in-flight shutdown work to finish before terminating.
 */
async function awaitAppShutdownBestEffort(getAppForCleanup: () => LockReleaseApp | undefined): Promise<void> {
  try {
    await getAppForCleanup()?.awaitShutdown?.();
  } catch {
    // best-effort shutdown coordination: never block process termination on failures
  }
}

/**
 * Resolves the most recent lock-release dependencies used by all handlers.
 */
function resolveLockReleaseHandlerDependencies(): LockReleaseHandlerDependencies {
  return getLockReleaseHandlerState().dependencies;
}

/**
 * Runs coordinated signal shutdown exactly once and terminates with provided code.
 */
function startLockReleaseShutdownForSignal(signal: NodeJS.Signals): Promise<void> {
  const state = getLockReleaseHandlerState();
  if (state.shutdownInProgress) {
    return state.shutdownInProgress;
  }

  state.shutdownInProgress = (async () => {
    const dependencies = resolveLockReleaseHandlerDependencies();
    await awaitAppShutdownBestEffort(dependencies.getAppForCleanup);
    releaseHeldFileLocksBestEffort(dependencies.getAppForCleanup);
    const defaultExitCode = signal === "SIGINT" ? 130 : 143;
    try {
      dependencies.terminate(dependencies.resolveExitCodeForSignal?.(signal) ?? defaultExitCode);
    } catch (error) {
      state.shutdownError = error;
    }
  })().finally(() => {
    state.shutdownInProgress = null;
  });

  return state.shutdownInProgress;
}

/**
 * Determines whether this module already registered a listener for a signal.
 */
function hasRegisteredLockReleaseHandler(signal: NodeJS.Signals): boolean {
  return process.listeners(signal).some((listener) => {
    const tagged = listener as TaggedLockReleaseHandler;
    return tagged[LOCK_RELEASE_SIGNAL_HANDLER_MARKER] === true;
  });
}

/**
 * Determines whether this module already registered an `exit` cleanup listener.
 */
function hasRegisteredLockReleaseExitHandler(): boolean {
  return process.listeners("exit").some((listener) => {
    const tagged = listener as TaggedLockReleaseHandler;
    return tagged[LOCK_RELEASE_EXIT_HANDLER_MARKER] === true;
  });
}

/**
 * Registers process shutdown handlers that release held file locks.
 *
 * Handlers are tagged to avoid duplicate registration when this function is
 * called multiple times. Cleanup runs on SIGINT/SIGTERM for all platforms and
 * additionally on `exit` for Windows where signal handling can differ.
 */
export function registerLockReleaseSignalHandlers({
  terminate,
  getAppForCleanup,
  resolveExitCodeForSignal,
}: LockReleaseHandlerDependencies): void {
  // Refresh dependencies so existing handlers always use latest app reference.
  getLockReleaseHandlerState().dependencies = {
    terminate,
    getAppForCleanup,
    resolveExitCodeForSignal,
  };

  if (!hasRegisteredLockReleaseHandler("SIGINT")) {
    const sigintHandler = Object.assign(() => {
      void startLockReleaseShutdownForSignal("SIGINT");
    }, { [LOCK_RELEASE_SIGNAL_HANDLER_MARKER]: true });
    process.on("SIGINT", sigintHandler);
  }

  if (!hasRegisteredLockReleaseHandler("SIGTERM")) {
    const sigtermHandler = Object.assign(() => {
      void startLockReleaseShutdownForSignal("SIGTERM");
    }, { [LOCK_RELEASE_SIGNAL_HANDLER_MARKER]: true });
    process.on("SIGTERM", sigtermHandler);
  }

  if (process.platform === "win32" && !hasRegisteredLockReleaseExitHandler()) {
    const exitHandler = Object.assign(() => {
      const dependencies = resolveLockReleaseHandlerDependencies();
      // Process `exit` cannot be interrupted; perform cleanup only.
      releaseHeldFileLocksBestEffort(dependencies.getAppForCleanup);
    }, { [LOCK_RELEASE_EXIT_HANDLER_MARKER]: true });
    process.on("exit", exitHandler);
  }
}

/**
 * Waits for active lock-release shutdown work and rethrows termination errors.
 */
export async function awaitLockReleaseShutdown(): Promise<void> {
  const state = getLockReleaseHandlerState();
  if (state.shutdownInProgress) {
    await state.shutdownInProgress;
  }

  if (state.shutdownError) {
    const error = state.shutdownError;
    state.shutdownError = null;
    throw error;
  }
}
