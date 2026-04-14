import { describe, expect, it, vi } from "vitest";
import {
  createConfigGet,
  createConfigList,
  createConfigPath,
  createConfigSet,
  createConfigUnset,
  type ConfigMutationDependencies,
} from "../../src/application/config-mutation.js";
import type { ApplicationOutputEvent } from "../../src/domain/ports/output-port.js";

describe("config-mutation", () => {
  it("parses typed values and delegates set to worker config port", () => {
    const { dependencies, events } = createDependencies();
    const setConfig = createConfigSet(dependencies);

    const code = setConfig({
      scope: "local",
      key: "workers.default",
      value: "true",
      valueType: "boolean",
    });

    expect(code).toBe(0);
    expect(dependencies.workerConfigPort.setValue).toHaveBeenCalledWith("/workspace/.rundown", {
      scope: "local",
      keyPath: "workers.default",
      value: true,
    });
    expect(events).toContainEqual({ kind: "success", message: "Updated local config: workers.default" });
  });

  it("supports auto type by parsing JSON first", () => {
    const { dependencies } = createDependencies();
    const setConfig = createConfigSet(dependencies);

    setConfig({
      scope: "global",
      key: "workers.default",
      value: "[\"opencode\",\"run\"]",
      valueType: "auto",
    });

    expect(dependencies.workerConfigPort.setValue).toHaveBeenCalledWith("/workspace/.rundown", {
      scope: "global",
      keyPath: "workers.default",
      value: ["opencode", "run"],
    });
  });

  it("emits no-change message when set operation is unchanged", () => {
    const { dependencies, events } = createDependencies({ setChanged: false });
    const setConfig = createConfigSet(dependencies);

    setConfig({
      scope: "local",
      key: "workers.default",
      value: "opencode run",
      valueType: "string",
    });

    expect(events).toContainEqual({
      kind: "info",
      message: "No change: workers.default already has the requested value.",
    });
  });

  it("delegates unset and reports removed keys", () => {
    const { dependencies, events } = createDependencies();
    const unsetConfig = createConfigUnset(dependencies);

    const code = unsetConfig({
      scope: "global",
      key: "commands.plan",
    });

    expect(code).toBe(0);
    expect(dependencies.workerConfigPort.unsetValue).toHaveBeenCalledWith("/workspace/.rundown", {
      scope: "global",
      keyPath: "commands.plan",
    });
    expect(events).toContainEqual({ kind: "success", message: "Removed global config key: commands.plan" });
  });

  it("rejects invalid boolean values", () => {
    const { dependencies } = createDependencies();
    const setConfig = createConfigSet(dependencies);

    expect(() => setConfig({
      scope: "local",
      key: "workers.default",
      value: "yes",
      valueType: "boolean",
    })).toThrow("Invalid config value for --type boolean: yes. Use true or false.");
  });

  it("rejects invalid number values", () => {
    const { dependencies } = createDependencies();
    const setConfig = createConfigSet(dependencies);

    expect(() => setConfig({
      scope: "local",
      key: "workers.default",
      value: "not-a-number",
      valueType: "number",
    })).toThrow("Invalid config value for --type number: not-a-number.");
  });

  it("rejects invalid json values", () => {
    const { dependencies } = createDependencies();
    const setConfig = createConfigSet(dependencies);

    expect(() => setConfig({
      scope: "local",
      key: "workers.default",
      value: "{invalid",
      valueType: "json",
    })).toThrow("Invalid config value for --type json");
  });

  it("reads scoped values via config get", () => {
    const { dependencies, events } = createDependencies();
    const getConfig = createConfigGet(dependencies);

    const code = getConfig({
      scope: "global",
      key: "workers.default",
      json: false,
      showSource: false,
    });

    expect(code).toBe(0);
    expect(dependencies.workerConfigPort.readValue).toHaveBeenCalledWith(
      "/workspace/.rundown",
      "global",
      "workers.default",
    );
    expect(events).toContainEqual({
      kind: "text",
      text: JSON.stringify(["opencode", "run"], null, 2),
    });
  });

  it("includes source attribution for effective get --show-source --json", () => {
    const { dependencies, events } = createDependencies();
    const getConfig = createConfigGet(dependencies);

    const code = getConfig({
      scope: "effective",
      key: "workers.default",
      json: true,
      showSource: true,
    });

    expect(code).toBe(0);
    expect(events).toContainEqual({
      kind: "text",
      text: JSON.stringify({
        scope: "effective",
        value: ["opencode", "run"],
        source: "global",
      }, null, 2),
    });
  });

  it("lists effective config as json with sources", () => {
    const { dependencies, events } = createDependencies();
    const listConfig = createConfigList(dependencies);

    const code = listConfig({
      scope: "effective",
      json: true,
      showSource: true,
    });

    expect(code).toBe(0);
    expect(dependencies.workerConfigPort.listValues).toHaveBeenCalledWith("/workspace/.rundown", "effective");
    expect(events).toContainEqual({
      kind: "text",
      text: JSON.stringify({
        scope: "effective",
        config: {
          workers: {
            default: ["opencode", "run"],
          },
        },
        sources: {
          "workers.default": "global",
        },
      }, null, 2),
    });
  });

  it("resolves config path by scope", () => {
    const { dependencies, events } = createDependencies();
    const configPath = createConfigPath(dependencies);

    const code = configPath({ scope: "global" });

    expect(code).toBe(0);
    expect(dependencies.workerConfigPort.getConfigPaths).toHaveBeenCalledWith("/workspace/.rundown");
    expect(events).toContainEqual({
      kind: "text",
      text: JSON.stringify({
        scope: "global",
        path: "/home/test/.config/rundown/config.json",
      }, null, 2),
    });
  });
});

function createDependencies(options: {
  setChanged?: boolean;
  unsetChanged?: boolean;
} = {}): {
  dependencies: ConfigMutationDependencies;
  events: ApplicationOutputEvent[];
} {
  const events: ApplicationOutputEvent[] = [];

  const dependencies: ConfigMutationDependencies = {
    workerConfigPort: {
      load: vi.fn(() => undefined),
      loadWithSources: vi.fn(() => ({
        config: {
          workers: {
            default: ["opencode", "run"],
          },
        },
        valueSources: {
          "workers.default": "global" as const,
        },
        localConfigPath: "/workspace/.rundown/config.json",
        globalConfigPath: "/home/test/.config/rundown/config.json",
      })),
      readValue: vi.fn(() => ["opencode", "run"]),
      listValues: vi.fn(() => ({
        workers: {
          default: ["opencode", "run"],
        },
      })),
      getConfigPaths: vi.fn(() => ({
        localConfigPath: "/workspace/.rundown/config.json",
        globalConfigPath: "/home/test/.config/rundown/config.json",
        globalCanonicalPath: "/home/test/.config/rundown/config.json",
      })),
      setValue: vi.fn(() => ({
        configPath: "/workspace/.rundown/config.json",
        changed: options.setChanged ?? true,
      })),
      unsetValue: vi.fn(() => ({
        configPath: "/workspace/.rundown/config.json",
        changed: options.unsetChanged ?? true,
      })),
    },
    configDir: {
      configDir: "/workspace/.rundown",
      isExplicit: false,
    },
    output: {
      emit: (event) => events.push(event),
    },
  };

  return {
    dependencies,
    events,
  };
}
