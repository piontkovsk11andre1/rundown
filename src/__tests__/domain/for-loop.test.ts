import { describe, expect, it } from "vitest";
import { resolveForLoopItems } from "../../domain/for-loop.ts";
import type { SubItem } from "../../domain/parser.ts";

function createSubItem(text: string, line: number): SubItem {
  return {
    text,
    line,
    depth: 1,
  };
}

describe("resolveForLoopItems", () => {
  it("uses existing metadata when for-current points to a baked item", () => {
    const result = resolveForLoopItems(
      [
        createSubItem("for-item: This", 2),
        createSubItem("for-item: That", 3),
        createSubItem("for-current: This", 4),
      ],
      "PayloadOne,PayloadTwo",
    );

    expect(result).toEqual({
      items: ["This", "That"],
      source: "metadata",
    });
  });

  it("regenerates baked items from payload when metadata has no current cursor", () => {
    const result = resolveForLoopItems(
      [
        createSubItem("for-item: Legacy", 2),
        createSubItem("for-item: Values", 3),
      ],
      "This,That",
    );

    expect(result).toEqual({
      items: ["This", "That"],
      source: "payload",
    });
  });

  it("regenerates baked items from payload when current cursor is invalid", () => {
    const result = resolveForLoopItems(
      [
        createSubItem("for-item: This", 2),
        createSubItem("for-item: That", 3),
        createSubItem("for-current: Missing", 4),
      ],
      "PayloadA,PayloadB",
    );

    expect(result).toEqual({
      items: ["PayloadA", "PayloadB"],
      source: "payload",
    });
  });
});
