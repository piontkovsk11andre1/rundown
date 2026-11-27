import { createInterface } from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const send = (msg) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
let servers;
async function reply({ id, method, params }) {
  const result = (value) => send({ id, result: value });
  if (method === "initialize")
    return result({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, mcpCapabilities: { http: true } },
    });
  if (method === "session/new" || method === "session/load") {
    servers = params.mcpServers;
    if (method === "session/load")
      send({
        method: "session/update",
        params: {
          sessionId: "fixture",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "replayed" },
          },
        },
      });
    return result(method === "session/new" ? { sessionId: "fixture" } : {});
  }
  if (method !== "session/prompt") return;
  const mode = params.prompt[0].text;
  if (mode === "hang") return;
  if (mode === "disconnect") return process.exit(0);
  send({
    method: "session/update",
    params: {
      sessionId: "fixture",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "visible" },
      },
    },
  });
  if (mode !== "no-result") {
    const endpoint = servers.find((s) => s.name === "rundown_callbacks");
    const mcp = new Client({ name: "fixture", version: "1" });
    await mcp.connect(
      new StreamableHTTPClientTransport(new URL(endpoint.url), {
        requestInit: {
          headers: Object.fromEntries(
            endpoint.headers.map((h) => [h.name, h.value]),
          ),
        },
      }),
    );
    if (mode === "report") {
      const { traceparent } = JSON.parse(process.env.RUNDOWN_TRACE_CONTEXT);
      for (const [name, args] of [
        [
          "report_log",
          {
            level: "info",
            message: "Agent report",
            fields: { agentTraceparent: traceparent },
          },
        ],
        ["report_metric", { metric: "accepted", value: 3 }],
        ["submit", { text: "ok" }],
      ]) {
        const r = await mcp.callTool({ name, arguments: args });
        if (r.isError) throw Error(`Rejected ${name}`);
      }
    } else
      for (const [text, expectedError] of [
        ["bad", true],
        ["ok", false],
        ["duplicate", true],
      ]) {
        const r = await mcp.callTool({ name: "submit", arguments: { text } });
        if (Boolean(r.isError) !== expectedError)
          throw Error("Unexpected callback result");
      }
    await mcp.close();
  }
  result({ stopReason: "end_turn" });
}
createInterface({ input: process.stdin }).on("line", (line) => {
  reply(JSON.parse(line)).catch(() => process.exit(1));
});
