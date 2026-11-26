# Agent harness

Run one external session with a live completion callback and observability tools.

## Dependencies

| Source               | Kind     | Binding | Description                          |
| -------------------- | -------- | ------- | ------------------------------------ |
| ./ai/harness/fake.md | markdown | fake    | Deterministic project-owned binding. |

## Method: run

Register session-local callbacks before starting the deterministic MCP client.
A successful client run and a successful completion report are both required.
No result is inferred from free-form text.

### Parameters

| Name    | Type   | Required | Default | Description              |
| ------- | ------ | -------- | ------- | ------------------------ |
| prompt  | string | yes      |         | The task instructions.   |
| context | object | yes      |         | Invocation capabilities. |

### Returns

| Type              | Description                                     |
| ----------------- | ----------------------------------------------- |
| `Promise<object>` | A successful outcome containing ok and summary. |

### Implementation

```js
let outcome;
const completed = context.metrics.counter("agent.completed", {
  description: "Work items completed by the external agent.",
});
await context.callbacks.with(
  {
    complete: {
      description: "Report the final task outcome exactly once.",
      inputSchema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          summary: { type: "string", minLength: 1 },
        },
        required: ["ok", "summary"],
        additionalProperties: false,
      },
      handler(result) {
        if (outcome) throw new Error("Outcome already reported");
        outcome = result;
        return { accepted: true };
      },
    },
  },
  { reporting: { logs: true, metrics: { completed } } },
  async (registration) => {
    const exposure = await registration.expose();
    const instructions =
      prompt +
      "\n\nUse MCP complete exactly once with {ok, summary}. " +
      "Use report_log for progress and report_metric to update completed. " +
      "Available definitions:\n" +
      JSON.stringify(exposure.tools);
    await context.run(fake, {
      prompt: instructions,
      mcp: { rundown_callbacks: exposure.mcp },
    });
  },
);
if (!outcome) throw new Error("Harness exited without a completion callback");
if (!outcome.ok) throw new Error(outcome.summary);
return outcome;
```

### Notes

The deterministic binding lives in this project's Markdown tree. Projects can
define their own integrations using the relevant configuration, API or CLI
protocol. The registration and its reporting tools close before this
method returns. A callback error is returned to its caller, not automatically
promoted to command failure; this method owns the final outcome policy.
