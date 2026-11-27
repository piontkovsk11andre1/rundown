import type { McpServer } from "@agentclientprotocol/sdk";
import type { CallbackDefinition, Reporting } from "./types.mjs";

export interface AcpConnection {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  authMethod?: string;
}
export interface AcpEvent {
  type: "session" | "prompt" | "message" | "tool" | "callback" | "end";
  sessionId?: string;
  text?: string;
  name?: string;
  status?: string;
  toolCallId?: string;
}
export interface AcpInvocation {
  prompt: string;
  cwd?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  sessionId?: string;
  mcpServers?: McpServer[];
  callbacks: Record<string, CallbackDefinition<never, unknown>>;
  reporting?: Reporting;
  terminal: string;
  record?: (event: AcpEvent) => void;
}
export interface AcpResult {
  status: "accepted" | "no-result";
  sessionId: string;
  value?: unknown;
  stopReason?: string;
  diagnostic?: string;
}
