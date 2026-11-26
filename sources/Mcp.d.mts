import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Runtime, Registration } from "./index.mjs";
export function createMcpServer(options: {
  runtime?: Runtime;
  registration?: Registration;
  surface?: "mcp" | "http-mcp";
}): Server;
export function startStdio(runtime: Runtime): Promise<Server>;
export function startBridge(url: string): Promise<{ close(): Promise<void> }>;
export class McpHttpHost {
  handle(
    request: import("node:http").IncomingMessage,
    response: import("node:http").ServerResponse,
    options: Parameters<typeof createMcpServer>[0],
  ): Promise<void>;
  release(registrationId: string): void;
  close(): Promise<void>;
}
