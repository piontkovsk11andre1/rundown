export interface CancellableSleep {
  promise: Promise<void>;
  cancel: () => void;
}

interface CancellableSleepSignalSource {
  once: (event: NodeJS.Signals, listener: () => void) => unknown;
  off: (event: NodeJS.Signals, listener: () => void) => unknown;
}

export interface CancellableSleepOptions {
  signalSource?: CancellableSleepSignalSource;
  cancelSignals?: readonly NodeJS.Signals[];
}

const DEFAULT_CANCEL_SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

export function cancellableSleep(ms: number, options: CancellableSleepOptions = {}): CancellableSleep {
  if (ms <= 0) {
    return {
      promise: Promise.resolve(),
      cancel: () => {},
    };
  }

  const signalSource = options.signalSource ?? process;
  const cancelSignals = options.cancelSignals ?? DEFAULT_CANCEL_SIGNALS;

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  let resolvePromise: (() => void) | undefined;
  const signalHandlers = new Map<NodeJS.Signals, () => void>();

  const unsubscribeSignals = () => {
    signalHandlers.forEach((handler, signal) => {
      signalSource.off(signal, handler);
    });
    signalHandlers.clear();
  };

  const complete = () => {
    if (settled) {
      return;
    }

    settled = true;

    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
      timeoutHandle = undefined;
    }

    unsubscribeSignals();

    resolvePromise?.();
  };

  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
    timeoutHandle = setTimeout(() => {
      complete();
    }, ms);
  });

  for (const signal of cancelSignals) {
    const handler = () => {
      complete();
    };
    signalHandlers.set(signal, handler);
    signalSource.once(signal, handler);
  }

  return {
    promise,
    cancel: complete,
  };
}
