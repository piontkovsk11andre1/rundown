import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { invokeAcp } from "@p10i/rundown/acp";
import { Runtime } from "../sources/index.mjs";
const agent = {
  command: process.execPath,
  args: [fileURLToPath(new URL("./fixtures/acp-agent.mjs", import.meta.url))],
};
function setup(t, options) {
  const events = [],
    calls = [];
  const runtime = new Runtime({
    commands: new Map([
      [
        "agent",
        {
          name: "agent",
          parameters: [],
          surfaces: ["*"],
          validate() {},
          handler: (_args, context) =>
            invokeAcp(context, agent, {
              prompt: "submit",
              record: (e) => events.push(e),
              terminal: "submit",
              callbacks: {
                submit: {
                  inputSchema: {
                    type: "object",
                    properties: { text: { type: "string" } },
                    required: ["text"],
                  },
                  handler: ({ text }) => {
                    calls.push(text);
                    if (text === "bad") throw Error("Try again");
                    return text;
                  },
                },
              },
              ...options,
            }),
        },
      ],
    ]),
  });
  t.after(() => runtime.close());
  return { invoke: () => runtime.invoke("agent"), events, calls };
}
test("ACP accepts one terminal result through scoped MCP and ignores replayed history", async (t) => {
  const { invoke, events, calls } = setup(t, { sessionId: "fixture" });
  const result = await invoke();
  assert.equal(result.status, "accepted");
  assert.equal(result.value, "ok");
  assert.equal(result.sessionId, "fixture");
  assert.deepEqual(calls, ["bad", "ok"]);
  assert.deepEqual(
    events.filter((e) => e.type === "message").map((e) => e.text),
    ["visible"],
  );
  assert.equal(events.at(-1).status, "accepted");
});
test("ACP distinguishes a normal turn without submission from disconnect", async (t) => {
  const { invoke } = setup(t, { prompt: "no-result" });
  assert.equal((await invoke()).status, "no-result");
  await assert.rejects(setup(t, { prompt: "disconnect" }).invoke(), {
    code: "RUNDOWN_ACP_DISCONNECTED",
  });
});
test("ACP deadline closes the invocation and records interruption", async (t) => {
  const { invoke, events } = setup(t, { prompt: "hang", timeoutMs: 250 });
  await assert.rejects(invoke, { code: "RUNDOWN_ACP_TIMEOUT" });
  assert.equal(events.at(-1).status, "timeout");
});

test("ACP refuses an unsupported MCP transport or colliding callback server", async (t) => {
  const extra = {
    name: "extra",
    type: "sse",
    url: "http://127.0.0.1:1",
    headers: [],
  };
  await assert.rejects(setup(t, { mcpServers: [extra] }).invoke(), {
    code: "RUNDOWN_ACP_CAPABILITY",
  });
  await assert.rejects(
    setup(t, {
      mcpServers: [{ ...extra, name: "rundown_callbacks" }],
    }).invoke(),
    { code: "RUNDOWN_ACP_INPUT" },
  );
});

test("ACP cancels a live session while an independent invocation completes", async (t) => {
  const ctrl = new AbortController();
  const hanging = setup(t, {
    signal: ctrl.signal,
    prompt: "hang",
    record: (e) => {
      if (e.type === "prompt") ctrl.abort();
    },
  });
  const other = setup(t, { prompt: "no-result" });
  await Promise.all([
    assert.rejects(hanging.invoke(), { code: "RUNDOWN_ACP_CANCELLED" }),
    other.invoke().then((result) => assert.equal(result.status, "no-result")),
  ]);
});
