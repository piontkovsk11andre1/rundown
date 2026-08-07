import { afterEach, describe, expect, it, vi } from "vitest";
import { cancellableSleep } from "../../src/infrastructure/cancellable-sleep.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("cancellableSleep", () => {
  it("resolves after timeout elapses", async () => {
    vi.useFakeTimers();

    const onResolved = vi.fn();
    const { promise } = cancellableSleep(1000);
    promise.then(onResolved);

    await vi.advanceTimersByTimeAsync(999);
    expect(onResolved).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await promise;
    expect(onResolved).toHaveBeenCalledTimes(1);
  });

  it("resolves immediately when cancelled", async () => {
    vi.useFakeTimers();

    const onResolved = vi.fn();
    const { promise, cancel } = cancellableSleep(1000);
    promise.then(onResolved);

    cancel();
    await promise;
    expect(onResolved).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(1000);
    expect(onResolved).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears timeout when cancelled to avoid dangling timers", () => {
    vi.useFakeTimers();

    const { cancel } = cancellableSleep(1000);
    expect(vi.getTimerCount()).toBe(1);

    cancel();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns an already-resolved promise for non-positive delays", async () => {
    const onResolved = vi.fn();
    const { promise, cancel } = cancellableSleep(0);
    promise.then(onResolved);

    await promise;
    expect(onResolved).toHaveBeenCalledTimes(1);

    expect(() => cancel()).not.toThrow();
  });

  it("treats repeated cancel calls as a no-op", async () => {
    vi.useFakeTimers();

    const { promise, cancel } = cancellableSleep(1000);

    cancel();
    cancel();

    await expect(promise).resolves.toBeUndefined();
  });

  it("resolves immediately when SIGINT is emitted", async () => {
    vi.useFakeTimers();

    const listeners = new Map<string, () => void>();
    const signalSource = {
      once: vi.fn((event: string, listener: () => void) => {
        listeners.set(event, listener);
      }),
      off: vi.fn((event: string, listener: () => void) => {
        if (listeners.get(event) === listener) {
          listeners.delete(event);
        }
      }),
    };

    const onResolved = vi.fn();
    const { promise } = cancellableSleep(1000, { signalSource });
    promise.then(onResolved);

    const sigintHandler = listeners.get("SIGINT");
    expect(sigintHandler).toBeTypeOf("function");

    sigintHandler?.();
    await promise;

    expect(onResolved).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("unsubscribes signal listeners after timeout resolves", async () => {
    vi.useFakeTimers();

    const listeners = new Map<string, () => void>();
    const signalSource = {
      once: vi.fn((event: string, listener: () => void) => {
        listeners.set(event, listener);
      }),
      off: vi.fn((event: string, listener: () => void) => {
        if (listeners.get(event) === listener) {
          listeners.delete(event);
        }
      }),
    };

    const { promise } = cancellableSleep(25, { signalSource });
    await vi.advanceTimersByTimeAsync(25);
    await promise;

    expect(signalSource.once).toHaveBeenCalledWith("SIGINT", expect.any(Function));
    expect(signalSource.once).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
    expect(signalSource.off).toHaveBeenCalledWith("SIGINT", expect.any(Function));
    expect(signalSource.off).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
    expect(listeners.size).toBe(0);
  });
});
