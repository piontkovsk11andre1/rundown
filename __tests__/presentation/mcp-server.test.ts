import { describe, expect, it } from "vitest";
import { createRundownMcpServer, RUNDOWN_MCP_TOOL_NAMES } from "../../src/presentation/mcp-server.js";

describe("rundown MCP server", () => {
  it("registers the full tool surface", () => {
    const server = createRundownMcpServer("1.2.3");

    for (const toolName of RUNDOWN_MCP_TOOL_NAMES) {
      expect(server.toolInputSchemaJson(toolName)).toBeDefined();
    }
  });
});
