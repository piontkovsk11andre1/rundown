import { describe, expect, it } from "vitest";
import {
  normalizeWorkerOutput,
  areOutputsSuspiciouslySimilar,
  containsKnownUsageLimitPattern,
} from "../../src/domain/services/output-similarity.js";

describe("Usage Limit Detection", () => {
  describe("normalizeWorkerOutput", () => {
    it("normalizes whitespace", () => {
      expect(normalizeWorkerOutput("  hello   world  \n\t  ")).toBe("hello world");
    });

    it("strips ANSI codes", () => {
      expect(normalizeWorkerOutput("\x1b[31mred\x1b[0m text")).toBe("red text");
    });

    it("removes UUIDs", () => {
      expect(normalizeWorkerOutput("error 123e4567-e89b-12d3-a456-426614174000 occurred")).toBe("error occurred");
    });

    it("removes ISO timestamps", () => {
      expect(normalizeWorkerOutput("at 2023-04-07T12:34:56Z something")).toBe("at something");
    });

    it("removes datetime patterns", () => {
      expect(normalizeWorkerOutput("on 2023-04-07 12:34:56 happened")).toBe("on happened");
    });

    it("converts to lowercase", () => {
      expect(normalizeWorkerOutput("ERROR MESSAGE")).toBe("error message");
    });

    it("handles complex output with multiple transformations", () => {
      const input = "\x1b[31mError\x1b[0m 123e4567-e89b-12d3-a456-426614174000 at 2023-04-07T12:34:56Z\nRATE LIMIT";
      expect(normalizeWorkerOutput(input)).toBe("error at rate limit");
    });
  });

  describe("areOutputsSuspiciouslySimilar", () => {
    it("returns true for exact match above min length", () => {
      const output = "Service is temporarily unavailable while backend processing is paused for maintenance window.";
      expect(areOutputsSuspiciouslySimilar(output, output)).toBe(true);
    });

    it("returns true for near-match with noise removed", () => {
      const outputA = "Error: rate limit exceeded for this workspace at 2023-04-07T12:34:56Z due to high usage volume and concurrent requests from multiple users.";
      const outputB = "error: rate limit exceeded for this workspace at 2024-05-08T13:45:67Z due to high usage volume and concurrent requests from multiple users.";
      expect(areOutputsSuspiciouslySimilar(outputA, outputB)).toBe(true);
    });

    it("returns false for short outputs", () => {
      expect(areOutputsSuspiciouslySimilar("OK", "OK")).toBe(false);
      expect(areOutputsSuspiciouslySimilar("short", "short")).toBe(false);
    });

    it("returns false for empty outputs", () => {
      expect(areOutputsSuspiciouslySimilar("", "something")).toBe(false);
      expect(areOutputsSuspiciouslySimilar("something", "")).toBe(false);
      expect(areOutputsSuspiciouslySimilar("", "")).toBe(false);
    });

    it("returns false for legitimately different outputs", () => {
      const outputA = "Task completed successfully with no errors.";
      const outputB = "Verification failed due to missing test coverage.";
      expect(areOutputsSuspiciouslySimilar(outputA, outputB)).toBe(false);
    });

    it("respects custom min length", () => {
      expect(areOutputsSuspiciouslySimilar("short", "short", { minLength: 3 })).toBe(true);
      expect(areOutputsSuspiciouslySimilar("short", "short", { minLength: 10 })).toBe(false);
    });
  });

  describe("containsKnownUsageLimitPattern", () => {
    it("detects rate limit patterns", () => {
      expect(containsKnownUsageLimitPattern("Error: rate limit exceeded")).toBe(true);
      expect(containsKnownUsageLimitPattern("You have been rate limited")).toBe(true);
    });

    it("detects quota patterns", () => {
      expect(containsKnownUsageLimitPattern("Quota exceeded for this month")).toBe(true);
      expect(containsKnownUsageLimitPattern("Billing quota reached")).toBe(true);
    });

    it("detects usage limit patterns", () => {
      expect(containsKnownUsageLimitPattern("Usage limit has been reached")).toBe(true);
    });

    it("detects too many requests patterns", () => {
      expect(containsKnownUsageLimitPattern("Too many requests")).toBe(true);
    });

    it("detects billing patterns", () => {
      expect(containsKnownUsageLimitPattern("Billing error: insufficient funds")).toBe(true);
    });

    it("detects HTTP 429 status", () => {
      expect(containsKnownUsageLimitPattern("HTTP 429 Too Many Requests")).toBe(true);
      expect(containsKnownUsageLimitPattern("Status: 429")).toBe(true);
    });

    it("returns false for partial matches that are not the full pattern", () => {
      expect(containsKnownUsageLimitPattern("This is a rate of something")).toBe(false);
      expect(containsKnownUsageLimitPattern("My quota is good")).toBe(false);
    });

    it("returns false for legitimate outputs", () => {
      expect(containsKnownUsageLimitPattern("Task completed successfully")).toBe(false);
      expect(containsKnownUsageLimitPattern("Build failed due to syntax error")).toBe(false);
    });

    it("returns false for empty output", () => {
      expect(containsKnownUsageLimitPattern("")).toBe(false);
    });

    it("is case insensitive", () => {
      expect(containsKnownUsageLimitPattern("RATE LIMIT EXCEEDED")).toBe(true);
      expect(containsKnownUsageLimitPattern("quota exceeded")).toBe(true);
    });
  });
});