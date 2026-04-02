import { describe, expect, expectTypeOf, it } from "vitest";
import * as runTaskApi from "../../src/application/run-task.js";
import * as runTaskExecutionApi from "../../src/application/run-task-execution.js";
import type {
  RunTaskDependencies,
  RunTaskOptions,
} from "../../src/application/run-task.js";

describe("run-task public API stability", () => {
  it("keeps run-task runtime exports stable", () => {
    expect(Object.keys(runTaskApi).sort()).toEqual([
      "createRunTask",
      "createRunTaskExecution",
      "finalizeRunArtifacts",
      "getAutomationWorkerCommand",
      "isOpenCodeWorkerCommand",
      "toRuntimeTaskMetadata",
    ]);
  });

  it("keeps createRunTask as a stable alias", () => {
    expect(runTaskApi.createRunTask).toBe(runTaskApi.createRunTaskExecution);
  });

  it("keeps run-task helper re-exports wired to run-task-execution", () => {
    expect(runTaskApi.createRunTaskExecution).toBe(runTaskExecutionApi.createRunTaskExecution);
    expect(runTaskApi.getAutomationWorkerCommand).toBe(runTaskExecutionApi.getAutomationWorkerCommand);
    expect(runTaskApi.isOpenCodeWorkerCommand).toBe(runTaskExecutionApi.isOpenCodeWorkerCommand);
    expect(runTaskApi.toRuntimeTaskMetadata).toBe(runTaskExecutionApi.toRuntimeTaskMetadata);
  });

  it("keeps run-task dependency and options types stable", () => {
    expectTypeOf<Parameters<typeof runTaskApi.createRunTaskExecution>[0]>().toEqualTypeOf<RunTaskDependencies>();
    expectTypeOf<Parameters<ReturnType<typeof runTaskApi.createRunTaskExecution>>[0]>().toEqualTypeOf<RunTaskOptions>();
  });
});
