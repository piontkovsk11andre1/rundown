import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  McpError,
  ErrorCode,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { describe, permits } from "./Catalog.mjs";
import { diagnostic } from "./Error.mjs";
import { jsonText } from "./Validation.mjs";
import { randomUUID } from "node:crypto";
import { VERSION } from "./Metadata.mjs";
import {
  tracedFetch,
  environmentTraceContext,
  withTraceContext,
} from "./Observability.mjs";
import { resourceDefinitions, readResource } from "./Knowledge.mjs";
import { View } from "./Views.mjs";

/** One protocol definition for stdio, command HTTP, and registration-scoped MCP.
 * @param {import('./InternalContracts.mjs').McpOptions} [options]
 */
export function createMcpServer({
  runtime,
  registration,
  surface = "mcp",
} = {}) {
  if (!runtime && !registration)
    throw new TypeError("MCP requires a runtime or callback registration");
  const server = new Server(
    { name: "rundown", version: VERSION },
    { capabilities: { tools: {}, ...(registration ? {} : { resources: {} }) } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: registration
      ? registration.tools
      : [...(runtime?.catalog.commands.values() ?? [])]
          .filter((c) => permits(c, surface))
          .map((c) => {
            const value = describe(c);
            return {
              name: value.name,
              description: value.description,
              inputSchema: value.inputSchema,
            };
          }),
  }));
  if (!registration) {
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: resourceDefinitions(),
    }));
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      if (
        !resourceDefinitions().some(
          (resource) => resource.uri === request.params.uri,
        )
      )
        throw new McpError(
          ErrorCode.InvalidParams,
          `Unknown resource: ${request.params.uri}`,
        );
      return readResource(request.params.uri);
    });
  }
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params.name;
    const command = runtime?.catalog.commands.get(name);
    if (
      registration
        ? !registration.definitions.has(name)
        : !command || !permits(command, surface)
    )
      throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
    try {
      const result = registration
        ? await registration.call(name, request.params.arguments ?? {}, {
            signal: extra.signal,
          })
        : await runtime?.invoke(name, request.params.arguments ?? {}, {
            surface,
            signal: extra.signal,
          });
      const text = jsonText(result instanceof View ? result.data : result);
      return {
        content: [
          {
            type: "text",
            text: result instanceof View ? result.render() : text,
          },
        ],
        structuredContent: { result: JSON.parse(text) },
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: diagnostic(error, registration?.context.id),
            }),
          },
        ],
      };
    }
  });
  return server;
}

/** Protocol sessions retain cancellation state; callback ownership stays independent. */
export class McpHttpHost {
  constructor() {
    /** @type {Map<string,import('./InternalContracts.mjs').McpSession>} */
    this.sessions = new Map();
  }
  /** @param {import('node:http').IncomingMessage} request @param {import('node:http').ServerResponse} response @param {import('./InternalContracts.mjs').McpOptions} options */
  async handle(request, response, options) {
    if (!["POST", "DELETE"].includes(request.method ?? "")) {
      request.resume();
      response.writeHead(405, { Allow: "POST, DELETE" });
      response.end();
      return;
    }
    const scope = new URL(request.url ?? "/", "http://localhost").pathname;
    const sessionId = request.headers["mcp-session-id"];
    /** @type {import('./InternalContracts.mjs').McpSession|undefined} */
    let record;
    if (Array.isArray(sessionId)) {
      response.writeHead(400);
      response.end();
      return;
    }
    if (sessionId) {
      record = this.sessions.get(sessionId);
      if (!record || record.scope !== scope || record.retiring) {
        response.writeHead(404);
        response.end();
        return;
      }
    } else {
      if (request.method !== "POST") {
        response.writeHead(400);
        response.end();
        return;
      }
      for (const old of this.sessions.values())
        if (!old.active.size && Date.now() - old.lastSeen > 300000)
          await this.remove(old);
      if (this.sessions.size >= 256) {
        response.writeHead(503);
        response.end();
        return;
      }
      const server = createMcpServer(options);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (id) => {
          if (record) this.sessions.set(id, record);
        },
        onsessionclosed: () => {
          if (transport.sessionId) this.sessions.delete(transport.sessionId);
        },
      });
      record = {
        server,
        transport,
        scope,
        registrationId: options.registration?.id,
        active: new Set(),
        lastSeen: Date.now(),
      };
      server.onclose = () => {
        if (transport.sessionId) this.sessions.delete(transport.sessionId);
      };
      await server.connect(transport);
    }
    const entry = record;
    entry.lastSeen = Date.now();
    entry.active.add(response);
    let finished = false;
    const complete = () => {
      if (finished) return;
      finished = true;
      entry.active.delete(response);
      if (!entry.transport.sessionId || (entry.retiring && !entry.active.size))
        this.remove(entry).catch(() => {});
    };
    response.once("finish", complete);
    response.once("close", complete);
    await entry.transport.handleRequest(request, response);
  }
  /** @param {import('./InternalContracts.mjs').McpSession} record */
  async remove(record) {
    if (record.transport.sessionId)
      this.sessions.delete(record.transport.sessionId);
    await record.server.close();
  }
  /** @param {string} registrationId */
  release(registrationId) {
    for (const record of this.sessions.values())
      if (record.registrationId === registrationId) {
        record.retiring = true;
        if (!record.active.size) this.remove(record).catch(() => {});
      }
  }
  async close() {
    await Promise.allSettled(
      [...this.sessions.values()].map((record) => this.remove(record)),
    );
  }
}

/** @param {import('./Runtime.mjs').Runtime} runtime */
export async function startStdio(runtime) {
  const server = createMcpServer({ runtime });
  await server.connect(new StdioServerTransport());
  return server;
}

/** Stdio-to-remote MCP forwarding. Failed executions are never automatically retried.
 * @param {string} url
 */
export async function startBridge(url) {
  const client = new Client({ name: "rundown-bridge", version: VERSION });
  const parent = environmentTraceContext();
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    fetch: (input, init) => {
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );
      for (const [key, value] of Object.entries(parent))
        headers.set(key, value);
      return tracedFetch(input, { ...init, headers });
    },
  });
  await withTraceContext(parent, () => client.connect(transport));
  const supportsResources = Boolean(client.getServerCapabilities()?.resources);
  const server = new Server(
    { name: "rundown-bridge", version: VERSION },
    {
      capabilities: {
        tools: {},
        ...(supportsResources ? { resources: {} } : {}),
      },
    },
  );
  if (supportsResources) {
    server.setRequestHandler(ListResourcesRequestSchema, (request, extra) =>
      withTraceContext(parent, () =>
        client.listResources(request.params, { signal: extra.signal }),
      ),
    );
    server.setRequestHandler(ReadResourceRequestSchema, (request, extra) =>
      withTraceContext(parent, () =>
        client.readResource(request.params, { signal: extra.signal }),
      ),
    );
  }
  server.setRequestHandler(ListToolsRequestSchema, (request) =>
    withTraceContext(parent, () => client.listTools(request.params)),
  );
  server.setRequestHandler(CallToolRequestSchema, (request, extra) =>
    withTraceContext(parent, () =>
      client.callTool(request.params, undefined, { signal: extra.signal }),
    ),
  );
  try {
    await server.connect(new StdioServerTransport());
  } catch (error) {
    await client.close();
    throw error;
  }
  return {
    close: async () => {
      await server.close();
      await client.close();
    },
  };
}
