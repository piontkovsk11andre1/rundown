import { describe, expect, it } from "vitest";
import { formatTaskDetailLines } from "../../src/presentation/task-detail-lines.js";

describe("formatTaskDetailLines", () => {
  const formatTaskLine = (task: { file: string; line: number; index: number; text: string }): string => (
    `${task.file}:${task.line} [#${task.index}] ${task.text}`
  );

  const formatSubItemLine = (subItem: { file: string; line: number; text: string }): string => (
    `${subItem.file}:${subItem.line} - ${subItem.text}`
  );

  it("returns an empty list when children and sub-items are not arrays", () => {
    const lines = formatTaskDetailLines({
      file: "TODO.md",
      parentDepth: 0,
      children: null,
      subItems: undefined,
      indentLevel: 1,
      formatTaskLine,
      formatSubItemLine,
    });

    expect(lines).toEqual([]);
  });

  it("renders nested child tasks recursively with increased indentation", () => {
    const lines = formatTaskDetailLines({
      file: "TODO.md",
      parentDepth: 0,
      indentLevel: 1,
      formatTaskLine,
      formatSubItemLine,
      children: [
        {
          file: "TODO.md",
          line: 11,
          index: 2,
          text: "Child task",
          depth: 1,
          children: [
            {
              file: "TODO.md",
              line: 12,
              index: 3,
              text: "Grandchild task",
              depth: 2,
            },
          ],
        },
      ],
    });

    expect(lines).toEqual([
      "  TODO.md:11 [#2] Child task",
      "    TODO.md:12 [#3] Grandchild task",
    ]);
  });

  it("keeps children and sub-items ordered by source line", () => {
    const lines = formatTaskDetailLines({
      file: "TODO.md",
      parentDepth: 0,
      indentLevel: 1,
      formatTaskLine,
      formatSubItemLine,
      children: [
        {
          file: "TODO.md",
          line: 13,
          index: 3,
          text: "Comes after detail",
          depth: 1,
        },
      ],
      subItems: [
        {
          text: "Comes before child",
          line: 12,
          depth: 1,
        },
      ],
    });

    expect(lines).toEqual([
      "  TODO.md:12 - Comes before child",
      "  TODO.md:13 [#3] Comes after detail",
    ]);
  });

  it("adds extra indentation for deeper sub-items relative to parent depth", () => {
    const lines = formatTaskDetailLines({
      file: "TODO.md",
      parentDepth: 0,
      indentLevel: 1,
      formatTaskLine,
      formatSubItemLine,
      subItems: [
        {
          text: "Depth one detail",
          line: 11,
          depth: 1,
        },
        {
          text: "Depth three detail",
          line: 12,
          depth: 3,
        },
      ],
    });

    expect(lines).toEqual([
      "  TODO.md:11 - Depth one detail",
      "      TODO.md:12 - Depth three detail",
    ]);
  });
});
