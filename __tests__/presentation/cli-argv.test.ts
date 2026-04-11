import { describe, expect, it } from "vitest";
import { rewriteAllAlias, splitWorkerFromSeparator } from "../../src/presentation/cli-argv.js";

describe("splitWorkerFromSeparator", () => {
  it("returns separator worker tokens as a string array", () => {
    const argv = ["run", "tasks.md", "--", "opencode", "run", "--model", "gpt-5"];

    const result = splitWorkerFromSeparator(argv);

    expect(result.rundownArgs).toEqual(["run", "tasks.md"]);
    expect(result.workerFromSeparator).toEqual(["opencode", "run", "--model", "gpt-5"]);
  });

  it("preserves tokens with spaces and special characters", () => {
    const workerTokens = [
      "C:\\Program Files\\Tool\\runner.cmd",
      "--flag",
      "value with spaces",
      'with"quote',
      "C:\\Temp\\path\\with\\slashes",
    ];
    const argv = ["run", "tasks.md", "--", ...workerTokens];

    const result = splitWorkerFromSeparator(argv);

    expect(result.workerFromSeparator).toEqual(workerTokens);
  });

  it("returns undefined worker pattern when separator is absent or empty", () => {
    expect(splitWorkerFromSeparator(["run", "tasks.md"]).workerFromSeparator).toBeUndefined();
    expect(splitWorkerFromSeparator(["run", "tasks.md", "--"]).workerFromSeparator).toBeUndefined();
  });
});

describe("rewriteAllAlias", () => {
  it("rewrites migrate down to undo", () => {
    expect(rewriteAllAlias(["migrate", "down"]))
      .toEqual(["undo"]);
  });

  it("rewrites migrate down with a count to undo --last <n>", () => {
    expect(rewriteAllAlias(["migrate", "down", "5"]))
      .toEqual(["undo", "--last", "5"]);
  });

  it("preserves additional migrate down flags when rewriting", () => {
    expect(rewriteAllAlias(["migrate", "down", "3", "--force", "--worker", "opencode run"]))
      .toEqual(["undo", "--last", "3", "--force", "--worker", "opencode run"]);
  });
});
