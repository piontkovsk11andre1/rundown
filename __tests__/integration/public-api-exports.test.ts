import { describe, expect, it } from "vitest";
import * as api from "../../src/index.js";

const expectedValueExports = [
  "parseTasks",
  "resolveSources",
  "selectNextTask",
  "selectTaskByLocation",
  "hasUncheckedDescendants",
  "filterRunnable",
  "renderTemplate",
  "runWorker",
  "validate",
  "readValidationFile",
  "removeValidationFile",
  "correct",
  "executeInlineCli",
  "checkTask",
  "isGitRepo",
  "commitCheckedTask",
  "runOnCompleteHook",
  "insertSubitems",
  "loadProjectTemplates",
  "createRuntimeArtifactsContext",
  "displayArtifactsPath",
  "findSavedRuntimeArtifact",
  "latestSavedRuntimeArtifact",
  "listFailedRuntimeArtifacts",
  "listSavedRuntimeArtifacts",
  "removeFailedRuntimeArtifacts",
  "removeSavedRuntimeArtifacts",
  "runtimeArtifactsRootDir",
  "isFailedRuntimeArtifactStatus",
] as const;

describe("public API exports", () => {
  it("keeps all expected value exports available from src/index.ts", () => {
    for (const exportName of expectedValueExports) {
      expect(api).toHaveProperty(exportName);
    }
  });
});
