# Deterministic harness binding

This project binding simulates an external caller through the actual MCP protocol.
It exercises callback and reporting definitions without a provider-specific client.

## Dependencies

| Source                                             | Kind       | Binding | Description                    |
| -------------------------------------------------- | ---------- | ------- | ------------------------------ |
| @modelcontextprotocol/sdk/client/index.js          | javascript | sdk     | MCP client.                    |
| @modelcontextprotocol/sdk/client/streamableHttp.js | javascript | http    | Standard remote MCP transport. |

## Method: run

Connect to the supplied registration, report progress and a declared metric, then
deliver a completion outcome. This method invokes no AI provider.

### Parameters

| Name  | Type   | Required | Default | Description                                                       |
| ----- | ------ | -------- | ------- | ----------------------------------------------------------------- |
| input | object | yes      |         | This project's prompt, MCP configuration and cancellation signal. |

### Returns

| Type            | Description                                           |
| --------------- | ----------------------------------------------------- |
| `Promise<void>` | Resolves after all callback responses have succeeded. |

### Implementation

```js
const { mcp, signal } = input;
const remote = mcp.rundown_callbacks;
const client = new sdk.Client({ name: "fake-harness", version: "1" });
await client.connect(
  new http.StreamableHTTPClientTransport(new URL(remote.url), {
    requestInit: { headers: remote.headers },
  }),
);
try {
  for (const [name, args] of [
    ["report_log", { level: "info", message: "Fake harness connected" }],
    ["report_metric", { metric: "completed", value: 1 }],
    [
      "complete",
      { ok: true, summary: "Deterministic callback round trip completed." },
    ],
  ]) {
    const result = await client.callTool({ name, arguments: args }, undefined, {
      signal,
    });
    if (result.isError) throw new Error(JSON.stringify(result));
  }
} finally {
  await client.close();
}
```
