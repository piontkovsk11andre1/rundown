import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createRundownMcpServer } from "./mcp-server.js";

const VERSION = "1.0.0-rc.24";

export function serveRundownMcpStdio(): void {
  serveStdio(() => createRundownMcpServer(VERSION), {
    onerror: (error) => {
      console.error(error.message);
    },
  });
}

serveRundownMcpStdio();
