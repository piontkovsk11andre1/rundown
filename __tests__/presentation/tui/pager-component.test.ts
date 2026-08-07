import { describe, expect, it } from "vitest";
import {
  createPagerState,
  handlePagerInput,
  renderPagerLines,
  scrollPager,
  scrollPagerToBottom,
  scrollPagerToTop,
  setPagerContent,
  setPagerViewportHeight,
} from "../../../src/presentation/tui/components/pager.ts";

function makeContent(count: number): string {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n");
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

describe("pager component", () => {
  it("creates state with normalized viewport and split lines", () => {
    const state = createPagerState({
      content: "alpha\nbeta\ngamma",
      title: "Template",
      filePath: "tools/example.md",
      viewportHeight: 5,
    });
    expect(state.totalLines).toBe(3);
    expect(state.lines).toEqual(["alpha", "beta", "gamma"]);
    expect(state.viewportHeight).toBe(5);
    expect(state.offset).toBe(0);
    expect(state.title).toBe("Template");
    expect(state.filePath).toBe("tools/example.md");
  });

  it("normalizes CRLF and tab characters", () => {
    const state = createPagerState({ content: "one\r\ntwo\r\n\tindented" });
    expect(state.lines).toEqual(["one", "two", "    indented"]);
  });

  it("clamps tiny viewport heights to a minimum", () => {
    const state = createPagerState({ content: "a\nb\nc", viewportHeight: 1 });
    expect(state.viewportHeight).toBeGreaterThanOrEqual(3);
  });

  it("scrolls down and up by deltas without exceeding bounds", () => {
    const state = createPagerState({ content: makeContent(20), viewportHeight: 5 });
    const downOnce = scrollPager(state, 1);
    expect(downOnce.offset).toBe(1);

    const downFar = scrollPager(state, 1000);
    expect(downFar.offset).toBe(20 - 5);

    const upPastTop = scrollPager(downOnce, -100);
    expect(upPastTop.offset).toBe(0);
  });

  it("supports top and bottom jumps", () => {
    const state = createPagerState({ content: makeContent(30), viewportHeight: 10 });
    const bottom = scrollPagerToBottom(state);
    expect(bottom.offset).toBe(30 - 10);

    const top = scrollPagerToTop(bottom);
    expect(top.offset).toBe(0);
  });

  it("handles input keys with less-style bindings", () => {
    const state = createPagerState({ content: makeContent(50), viewportHeight: 10 });

    const downArrow = handlePagerInput({ rawInput: "\u001b[B", state });
    expect(downArrow.handled).toBe(true);
    expect(downArrow.state.offset).toBe(1);
    expect(downArrow.backToParent).toBe(false);

    const jKey = handlePagerInput({ rawInput: "j", state });
    expect(jKey.state.offset).toBe(1);

    const space = handlePagerInput({ rawInput: " ", state });
    expect(space.state.offset).toBe(9); // pageSize = viewportHeight - 1

    const bKey = handlePagerInput({ rawInput: "b", state: space.state });
    expect(bKey.state.offset).toBe(0);

    const gKey = handlePagerInput({ rawInput: "g", state: space.state });
    expect(gKey.state.offset).toBe(0);

    const bigG = handlePagerInput({ rawInput: "G", state });
    expect(bigG.state.offset).toBe(50 - 10);

    const halfDown = handlePagerInput({ rawInput: "d", state });
    expect(halfDown.state.offset).toBe(5);

    const halfUp = handlePagerInput({ rawInput: "u", state: halfDown.state });
    expect(halfUp.state.offset).toBe(0);
  });

  it("returns to caller scene on q, Esc, and Backspace", () => {
    const state = createPagerState({ content: "abc" });
    expect(handlePagerInput({ rawInput: "q", state }).backToParent).toBe(true);
    expect(handlePagerInput({ rawInput: "\u001b", state }).backToParent).toBe(true);
    expect(handlePagerInput({ rawInput: "\u007f", state }).backToParent).toBe(true);
  });

  it("returns handled=false for unknown input", () => {
    const state = createPagerState({ content: "abc" });
    const result = handlePagerInput({ rawInput: "z", state });
    expect(result.handled).toBe(false);
    expect(result.backToParent).toBe(false);
    expect(result.state).toBe(state);
  });

  it("renders title, file path, visible window, and footer", () => {
    const state = createPagerState({
      content: makeContent(8),
      title: "Template",
      filePath: "tools/example.md",
      viewportHeight: 4,
    });
    const lines = renderPagerLines({ state }).map(stripAnsi);
    expect(lines[0]).toBe("Template");
    expect(lines[1]).toBe("tools/example.md");
    expect(lines[2]).toBe("");
    expect(lines.slice(3, 7)).toEqual(["line 1", "line 2", "line 3", "line 4"]);
    const progress = lines.find((line) => line.startsWith("lines "));
    expect(progress).toContain("lines 1-4/8");
    expect(progress).toContain("TOP");
    const footer = lines[lines.length - 1];
    expect(footer).toContain("[q/Esc] close");
  });

  it("pads the viewport with tilde markers when content is short", () => {
    const state = createPagerState({
      content: "only line",
      viewportHeight: 5,
    });
    const lines = renderPagerLines({ state }).map(stripAnsi);
    const tildeCount = lines.filter((line) => line === "~").length;
    expect(tildeCount).toBeGreaterThanOrEqual(1);
  });

  it("renders an empty marker when content is empty", () => {
    const state = createPagerState({ content: "" });
    const lines = renderPagerLines({ state }).map(stripAnsi);
    expect(lines).toContain("(no content)");
  });

  it("setPagerContent replaces the content while preserving title defaults", () => {
    const initial = createPagerState({
      content: "a\nb",
      title: "First",
      filePath: "first.md",
    });
    const next = setPagerContent(initial, { content: "x\ny\nz" });
    expect(next.totalLines).toBe(3);
    expect(next.title).toBe("First");
    expect(next.filePath).toBe("first.md");
    expect(next.offset).toBe(0);
  });

  it("setPagerViewportHeight clamps offset to remain in bounds", () => {
    const state = createPagerState({ content: makeContent(20), viewportHeight: 5 });
    const scrolled = scrollPagerToBottom(state); // offset = 15
    const resized = setPagerViewportHeight(scrolled, 10);
    expect(resized.viewportHeight).toBe(10);
    expect(resized.offset).toBe(10); // 20 - 10
  });
});
