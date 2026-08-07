import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectTracePhaseArtifacts,
  formatAgentSignalsForTrace,
  formatPhaseOutputsForTrace,
  formatPhaseTimingsForTrace,
  formatThinkingBlocksForTrace,
  formatToolUsageForTrace,
  parseAnalysisSummaryFromWorkerOutput,
  parseTraceWorkerOutputForEvents,
  summarizePhaseAnalyses,
} from "../../src/application/trace-artifacts.js";
import { createInMemoryFileSystem } from "./run-task-test-helpers.js";

describe("trace-artifacts", () => {
  it("collects phase artifacts from artifact directories", () => {
    const root = "/workspace/.rundown/runs/run-1";
    const phase1 = path.join(root, "001-execute");
    const phase2 = path.join(root, "002-verify");
    const fileSystem = createInMemoryFileSystem({
      [path.join(phase1, "metadata.json")]: JSON.stringify({
        sequence: 1,
        phase: "execute",
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:00:01.000Z",
        command: ["opencode", "run"],
        exitCode: 0,
        outputCaptured: true,
        stdoutFile: "stdout.txt",
        stderrFile: "stderr.txt",
      }),
      [path.join(phase1, "stdout.txt")]: "ok",
      [path.join(phase1, "stderr.txt")]: "",
      [path.join(phase2, "metadata.json")]: JSON.stringify({
        sequence: 2,
        phase: "verify",
        command: ["verify"],
        exitCode: 0,
        outputCaptured: true,
      }),
    });
    fileSystem.readdir = () => [
      { name: "001-execute", isDirectory: true, isFile: false },
      { name: "002-verify", isDirectory: true, isFile: false },
    ];

    const phases = collectTracePhaseArtifacts(
      { runId: "run-1", rootDir: root, cwd: "/workspace", keepArtifacts: true, commandName: "run" },
      fileSystem,
      path,
    );

    expect(phases).toHaveLength(2);
    expect(phases[0]).toMatchObject({ phase: "execute", sequence: 1, stdout: "ok" });
    expect(phases[1]).toMatchObject({ phase: "verify", sequence: 2 });
  });

  it("formats trace artifact summaries", () => {
    const phases = [{
      sequence: 1,
      phase: "execute",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:01.000Z",
      durationMs: 1000,
      command: ["opencode", "run"],
      exitCode: 0,
      outputCaptured: true,
      stdout: "out",
      stderr: "err",
    }];

    expect(formatPhaseTimingsForTrace(phases)).toContain("#1 execute");
    expect(formatPhaseOutputsForTrace(phases)).toContain("Phase 1: execute");
    expect(formatAgentSignalsForTrace([{ phase: "execute", sequence: 1, values: { confidence: "80" } }])).toContain("confidence: 80");
    expect(formatThinkingBlocksForTrace([{ phase: "execute", sequence: 1, content: "reasoning" }])).toContain("reasoning");
    expect(formatToolUsageForTrace(["read", "bash"])).toContain("- read");
  });

  it("summarizes parsed phase analyses and analysis.summary blocks", () => {
    const phases = [{
      sequence: 1,
      phase: "execute",
      startedAt: null,
      completedAt: null,
      durationMs: 0,
      command: ["opencode", "run"],
      exitCode: 0,
      outputCaptured: true,
      stdout: "```rundown-trace\nconfidence: 75\ntools_used: read,bash\n```\n```thinking\nplan\n```",
      stderr: "",
    }];

    const summary = summarizePhaseAnalyses(phases);
    expect(summary.signals).toHaveLength(1);
    expect(summary.tools).toContain("read");
    expect(summary.thinkingBlocks).toHaveLength(1);

    const payload = parseAnalysisSummaryFromWorkerOutput([
      "```analysis.summary",
      JSON.stringify({
        task_complexity: "high",
        execution_quality: "clean",
        direction_changes: 1,
        modules_touched: ["src/a.ts"],
        wasted_effort_pct: 0,
        key_decisions: ["x"],
        risk_flags: [],
        improvement_suggestions: [],
        skill_gaps: [],
        thinking_quality: "clear",
        uncertainty_moments: 0,
      }),
      "```",
    ].join("\n"));

    expect(payload?.task_complexity).toBe("high");
    expect(payload?.modules_touched).toEqual(["src/a.ts"]);
  });

  it("parses worker output into trace event payloads", () => {
    const parsed = parseTraceWorkerOutputForEvents([
      "```rundown-trace",
      "confidence: 80",
      "files_read: src/a.ts,src/b.ts",
      "files_written: src/c.ts",
      "tools_used: read,bash",
      "approach: mechanical refactor",
      "blockers:",
      "```",
      "```thinking",
      "first",
      "```",
      "```thinking",
      "second",
      "```",
    ].join("\n"));

    expect(parsed.agentSignals).toEqual({
      confidence: 80,
      filesRead: ["src/a.ts", "src/b.ts"],
      filesWritten: ["src/c.ts"],
      toolsUsed: ["read", "bash"],
      approach: "mechanical refactor",
      blockers: null,
      includesToolsUsedField: true,
    });
    expect(parsed.thinking).toEqual({
      thinkingBlocksCount: 2,
      totalThinkingChars: 11,
    });
    expect(parsed.toolCalls).toEqual(["read", "bash"]);
  });
});
