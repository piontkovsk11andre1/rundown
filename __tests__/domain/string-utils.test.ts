import { describe, expect, it } from "vitest";
import { sanitizeTerminalText, stripAnsi } from "../../src/domain/services/string-utils.js";

describe("string-utils", () => {
  it("strips ANSI escape sequences", () => {
    expect(stripAnsi("\u001b[31merror\u001b[0m")).toBe("error");
  });

  it("normalizes terminal text for deterministic logs", () => {
    const raw = [
      "progress 10%\rprogress 42%",
      "line with ansi: \u001b[32mok\u001b[0m",
      "line with bell\u0007 and backspace\u0008 and form-feed\u000c",
      "windows\r\nnewline",
    ].join("\n");

    expect(sanitizeTerminalText(raw)).toBe([
      "progress 42%",
      "line with ansi: ok",
      "line with bell and backspace and form-feed",
      "windows",
      "newline",
    ].join("\n"));
  });
});
