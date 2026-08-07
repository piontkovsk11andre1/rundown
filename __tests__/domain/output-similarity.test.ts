import { describe, expect, it } from "vitest";
import {
  areOutputsSuspiciouslySimilar,
  containsKnownUsageLimitPattern,
  normalizeWorkerOutput,
} from "../../src/domain/services/output-similarity.js";

describe("normalizeWorkerOutput", () => {
  it("trims, lowercases, and compresses whitespace", () => {
    const stdout = "  HELLO   WORLD\n\n  AGAIN  ";

    expect(normalizeWorkerOutput(stdout)).toBe("hello world again");
  });

  it("strips ANSI escape codes", () => {
    const stdout = "\u001b[31mRATE LIMIT\u001b[0m";

    expect(normalizeWorkerOutput(stdout)).toBe("rate limit");
  });

  it("removes timestamps and UUIDs as common noise", () => {
    const stdout = [
      "Request failed at 2026-04-08T00:09:55.970Z",
      "request id: 123e4567-e89b-12d3-a456-426614174000",
      "retry after 2026-04-08 10:11:12",
    ].join("\n");

    expect(normalizeWorkerOutput(stdout)).toBe("request failed at request id: retry after");
  });
});

describe("areOutputsSuspiciouslySimilar", () => {
  it("returns true for exact matching outputs", () => {
    const output =
      "Rate limit reached. Please retry later because your usage cap has been exceeded for this account.";

    expect(areOutputsSuspiciouslySimilar(output, output)).toBe(true);
  });

  it("returns true for near-match outputs with noise", () => {
    const outputA = "\u001b[31mRate Limit Reached\u001b[0m\nPlease retry later because your usage cap has been exceeded.\nRequest ID: 123e4567-e89b-12d3-a456-426614174000\n2026-04-08T00:09:55.970Z";
    const outputB = "rate   limit reached\nplease retry later because your usage cap has been exceeded.\nrequest id: 987e6543-e21b-12d3-a456-426614174111\n2026-04-08T01:10:56.971Z";

    expect(areOutputsSuspiciouslySimilar(outputA, outputB)).toBe(true);
  });

  it("returns false when either normalized output is empty", () => {
    expect(areOutputsSuspiciouslySimilar("   ", "rate limit")).toBe(false);
    expect(areOutputsSuspiciouslySimilar("rate limit", "\n\t")).toBe(false);
  });

  it("returns false for legitimate different outputs", () => {
    const outputA = "Rate limit reached. Please retry later because your usage cap has been exceeded for this account.";
    const outputB =
      "Verification failed: the document is missing the acceptance criteria section and fallback worker details.";

    expect(areOutputsSuspiciouslySimilar(outputA, outputB)).toBe(false);
  });

  it("returns false for trivially short outputs by default", () => {
    const shortOutput = "rate limit";

    expect(areOutputsSuspiciouslySimilar(shortOutput, shortOutput)).toBe(false);
  });

  it("supports overriding the minimum output length threshold", () => {
    const shortOutput = "rate limit";

    expect(areOutputsSuspiciouslySimilar(shortOutput, shortOutput, { minLength: 5 })).toBe(true);
  });
});

describe("containsKnownUsageLimitPattern", () => {
  it("returns true for known usage-limit patterns", () => {
    const cases = [
      "Rate limit exceeded, please retry later.",
      "Quota exceeded for current plan.",
      "Your usage limit has been reached.",
      "Too many requests. Slow down.",
      "Billing issue detected for this account.",
      "HTTP 429 returned by provider.",
    ];

    for (const stdout of cases) {
      expect(containsKnownUsageLimitPattern(stdout)).toBe(true);
    }
  });

  it("returns true for partial wording variations", () => {
    expect(containsKnownUsageLimitPattern("RATE   LIMITED by upstream")).toBe(true);
    expect(containsKnownUsageLimitPattern("received 429 from API")).toBe(true);
  });

  it("returns false for legitimate non-matching output", () => {
    const stdout = "Verification failed: missing acceptance criteria section in the document.";

    expect(containsKnownUsageLimitPattern(stdout)).toBe(false);
  });

  it("returns false for empty output", () => {
    expect(containsKnownUsageLimitPattern("   \n\t")).toBe(false);
  });
});
