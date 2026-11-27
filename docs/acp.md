# Invoking an ACP agent

Import `invokeAcp` from `@p10i/rundown/acp` in a JavaScript module, or bind that subpath as a `javascript` dependency of a Markdown module. Pass the current Rundown invocation context as the first argument. Each call starts a stdio child and opens one new or resumed session for one prompt.

```js
import { invokeAcp } from "@p10i/rundown/acp";

export async function ask(context, connection, prompt) {
  const result = await invokeAcp(context, connection, {
    prompt: `${prompt}\nSend your answer through the submit tool.`,
    callbacks: {
      submit: {
        inputSchema: {
          type: "object",
          properties: { answer: { type: "string", minLength: 1 } },
          required: ["answer"],
          additionalProperties: false,
        },
        handler: ({ answer }) => answer,
      },
    },
    terminal: "submit",
  });
  if (result.status !== "accepted") throw Error("No answer was submitted");
  return result.value;
}
```

**Launch settings.** The trusted caller supplies `connection`: `command`, optional `args`, explicit `env` entries and optional advertised `authMethod`. The child receives `PATH` and those entries. Supply any home directory or platform-specific variables your agent requires. Rundown launches the command directly. The agent executes with the user's OS permissions; `cwd` selects a workspace, not a sandbox. ACP permission requests are denied by default.

**Session settings.** The workspace defaults to the invocation's working directory. Pass an absolute `cwd` to override it, `sessionId` to resume, and `mcpServers` for additional ACP server descriptors. `rundown_callbacks` is reserved for the invocation's own scoped HTTP MCP endpoint. The agent must support HTTP MCP; unsupported authentication, resume or requested SSE capability fails explicitly. `timeoutMs` defaults to 120000 and combines with the parent and optional caller cancellation signal.

**Results.** All callbacks use Rundown's normal schema and handler conventions. A rejected handler leaves the terminal callback available for correction. The first successful terminal handler supplies `value`; the agent receives an acknowledgement. Later submissions cannot overwrite it. The agent gets a brief opportunity to finish its turn before shutdown. A turn ending without an accepted submission returns `status: "no-result"` with `sessionId` and the reported `stopReason`. A disconnect, deadline or cancellation before acceptance rejects the call. If the agent disconnects after acceptance, inspect `diagnostic` on the result. Each call closes its own child and callback exposure.

**Reporting.** Pass the same `reporting` options as for `context.callbacks.with`, for example `reporting: { logs: true, metrics: { completed: context.metrics.counter("work.completed") } }`. The agent can then call `report_log` and `report_metric` through the scoped MCP endpoint. Only explicitly enabled tools and metric aliases are available. When tracing is active, the child receives the adapter span’s W3C carrier as JSON in `RUNDOWN_TRACE_CONTEXT`, just as a Rundown process adapter does. The child can extract it to continue the trace.

**Recording.** Pass a synchronous `record(event)` sink to capture session start, prompt, visible text chunks, agent-reported tool summaries, callback dispositions and termination. The sink chooses storage and filtering. The adapter omits private reasoning, raw tool arguments/results, launch environment and replay during session load. Visible prompt and reply text can itself be sensitive; filter it before persistence. External tool reporting is limited to updates the agent sends. A recorder exception does not replay or invalidate a successful callback.
