import type { Server } from "node:http";
import type { Runtime, CallbackHost } from "./index.mjs";
export function startHttp(options?: {
  runtime?: Runtime;
  callbackHost?: CallbackHost;
  bind?: string;
  port?: number;
  publicURL?: string;
  allowedOrigins?: string[];
}): Promise<{ server: Server; url: string; close(): Promise<void> }>;
