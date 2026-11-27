import { spawn } from "node:child_process";
import { normalizeTraceCarrier } from "./Observability.mjs";
import { Readable, Writable } from "node:stream";
import { isAbsolute } from "node:path";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";
import { RundownError } from "./Error.mjs";

/** @param {string} code @param {string} message */
const failure = (code, message) =>
  new RundownError(`RUNDOWN_ACP_${code}`, message);

/** @param {import('./types.mjs').InvocationContext} context @param {import('./AcpTypes.mjs').AcpConnection} connection @param {import('./AcpTypes.mjs').AcpInvocation} input @returns {Promise<import('./AcpTypes.mjs').AcpResult>} */
export async function invokeAcp(context, connection, input) {
  if (
    !connection.command ||
    typeof input.prompt !== "string" ||
    !Object.hasOwn(input.callbacks, input.terminal)
  )
    throw failure(
      "INPUT",
      "Expected agent command, prompt and terminal callback",
    );
  const servers = input.mcpServers ?? [];
  const names = servers.map((s) => s.name);
  if (
    names.includes("rundown_callbacks") ||
    new Set(names).size !== names.length
  )
    throw failure("INPUT", "Duplicate or reserved MCP server name");
  const timeout = AbortSignal.timeout(input.timeoutMs ?? 120000);
  const signal = AbortSignal.any([
    context.signal,
    timeout,
    ...(input.signal ? [input.signal] : []),
  ]);
  const cwd = input.cwd ?? context.workdir;
  if (!isAbsolute(cwd))
    throw failure("INPUT", "Expected absolute ACP workspace");
  /** @type {string|undefined} */ let sessionId;
  let active = false,
    accepted = false;
  /** @type {unknown} */ let value;
  /** @type {string|undefined} */ let diagnostic;
  /** @param {import('./AcpTypes.mjs').AcpEvent} e */
  const record = (e) => {
    try {
      input.record?.({ ...e, sessionId });
    } catch {
      diagnostic = "ACP recorder failed";
    }
  };
  /** @type {ReturnType<typeof setTimeout>|undefined} */ let ackTimer;
  /** @type {()=>void} */ let acknowledge = () => {};
  const submitted = new Promise((resolve) => {
    acknowledge = () => {
      ackTimer = setTimeout(() => resolve(undefined), 250);
    };
  });
  const definitions = Object.fromEntries(
    Object.entries(input.callbacks).map(([name, def]) => [
      name,
      {
        ...def,
        /** @param {never} payload @param {import('./types.mjs').CallbackContext} ctx */
        async handler(payload, ctx) {
          if (!active || accepted || signal.aborted)
            throw failure(
              "CLOSED",
              "ACP callback is no longer accepting submissions",
            );
          try {
            const result = await def.handler(payload, {
              ...ctx,
              signal: AbortSignal.any([ctx.signal, signal]),
            });
            if (!active || signal.aborted || ctx.signal.aborted)
              throw failure("CLOSED", "ACP invocation ended during callback");
            if (name === input.terminal) {
              value = result;
              accepted = true;
              acknowledge();
            }
            record({ type: "callback", name, status: "accepted" });
            return name === input.terminal ? { accepted: true } : result;
          } catch (error) {
            record({ type: "callback", name, status: "rejected" });
            throw error;
          }
        },
      },
    ]),
  );
  let ending = "failed";
  try {
    signal.throwIfAborted();
    return await context.callbacks.with(
      definitions,
      { reporting: input.reporting },
      async (registration) => {
        const { mcp } = await registration.expose();
        const execution = await context.run(
          {
            /** @param {import('./types.mjs').ExecutionContext} execution */
            async run({ traceContext }) {
              signal.throwIfAborted();
              const child = spawn(connection.command, connection.args ?? [], {
                cwd,
                env: {
                  PATH: process.env.PATH,
                  ...connection.env,
                  ...(traceContext
                    ? {
                        RUNDOWN_TRACE_CONTEXT: JSON.stringify(
                          normalizeTraceCarrier(traceContext),
                        ),
                      }
                    : {}),
                },
                stdio: ["pipe", "pipe", "ignore"],
                windowsHide: true,
              });
              const closed = new Promise((resolve) =>
                child.once("close", resolve),
              );
              const disconnected = new Promise((_, reject) => {
                child.once("error", reject);
                closed.then(() =>
                  reject(failure("DISCONNECTED", "Agent disconnected")),
                );
              });
              /** @type {()=>void} */ let abort = () => {};
              const aborted = new Promise((_, reject) => {
                abort = () =>
                  reject(
                    timeout.aborted
                      ? failure("TIMEOUT", "ACP invocation timed out")
                      : failure("CANCELLED", "ACP invocation cancelled"),
                  );
                signal.addEventListener("abort", abort, { once: true });
                if (signal.aborted) abort();
              });
              let stopped = false;
              /** @type {ClientSideConnection|undefined} */ let client;
              /** @type {string|undefined} */ let stopReason;
              function check() {
                signal.throwIfAborted();
                if (stopped) throw failure("CLOSED", "Agent stopped");
              }
              async function turn() {
                const stream = ndJsonStream(
                  Writable.toWeb(child.stdin),
                  /** @type {Parameters<typeof ndJsonStream>[1]} */ (
                    /** @type {unknown} */ (Readable.toWeb(child.stdout))
                  ),
                );
                client = new ClientSideConnection(
                  () => ({
                    requestPermission: async () => ({
                      outcome: { outcome: "cancelled" },
                    }),
                    sessionUpdate: async (event) => {
                      if (!active || event.sessionId !== sessionId) return;
                      const u = event.update;
                      if (
                        u.sessionUpdate === "agent_message_chunk" &&
                        u.content.type === "text"
                      )
                        record({ type: "message", text: u.content.text });
                      if (
                        u.sessionUpdate === "tool_call" ||
                        u.sessionUpdate === "tool_call_update"
                      )
                        record({
                          type: "tool",
                          toolCallId: u.toolCallId,
                          status: u.status ?? undefined,
                          name: u.kind ?? undefined,
                        });
                    },
                  }),
                  stream,
                );
                const init = await client.initialize({
                  protocolVersion: PROTOCOL_VERSION,
                  clientCapabilities: {},
                });
                check();
                if (
                  init.protocolVersion !== PROTOCOL_VERSION ||
                  !init.agentCapabilities?.mcpCapabilities?.http
                )
                  throw failure(
                    "CAPABILITY",
                    "Agent must support the ACP protocol and HTTP MCP callbacks",
                  );
                if (connection.authMethod) {
                  if (
                    !init.authMethods?.some(
                      (m) => m.id === connection.authMethod,
                    )
                  )
                    throw failure(
                      "CAPABILITY",
                      "Authentication method unavailable",
                    );
                  await client.authenticate({
                    methodId: connection.authMethod,
                  });
                  check();
                }
                for (const s of servers)
                  if (
                    "type" in s &&
                    s.type === "sse" &&
                    !init.agentCapabilities.mcpCapabilities.sse
                  )
                    throw failure("CAPABILITY", "Agent lacks SSE MCP support");
                const params = {
                  cwd,
                  mcpServers: [
                    ...servers,
                    {
                      name: "rundown_callbacks",
                      type: /** @type {const} */ ("http"),
                      url: mcp.url,
                      headers: Object.entries(mcp.headers ?? {}).map(
                        ([name, value]) => ({ name, value }),
                      ),
                    },
                  ],
                };
                if (input.sessionId) {
                  if (!init.agentCapabilities.loadSession)
                    throw failure("CAPABILITY", "Agent cannot resume sessions");
                  await client.loadSession({
                    ...params,
                    sessionId: input.sessionId,
                  });
                  sessionId = input.sessionId;
                } else ({ sessionId } = await client.newSession(params));
                check();
                active = true;
                record({
                  type: "session",
                  status: input.sessionId ? "resumed" : "new",
                });
                record({ type: "prompt", text: input.prompt });
                stopReason = (
                  await client.prompt({
                    sessionId,
                    prompt: [{ type: "text", text: input.prompt }],
                  })
                ).stopReason;
              }
              try {
                await Promise.race([turn(), submitted, aborted, disconnected]);
              } catch (error) {
                if (!accepted) {
                  if (
                    error instanceof Error &&
                    error.message === "ACP connection closed"
                  )
                    throw failure("DISCONNECTED", "Agent disconnected");
                  throw error;
                }
                diagnostic = "Agent interrupted after accepted submission";
              } finally {
                active = false;
                stopped = true;
                clearTimeout(ackTimer);
                signal.removeEventListener("abort", abort);
                if (sessionId && !stopReason)
                  client?.cancel({ sessionId }).catch(() => {});
                child.stdin.end();
                child.kill();
                const kill = setTimeout(() => {
                  child.kill("SIGKILL");
                  child.stdin.destroy();
                  child.stdout.destroy();
                }, 500);
                try {
                  await closed;
                } finally {
                  clearTimeout(kill);
                }
              }
              return {
                status: accepted
                  ? /** @type {const} */ ("accepted")
                  : /** @type {const} */ ("no-result"),
                sessionId: sessionId ?? "",
                ...(accepted ? { value } : {}),
                ...(stopReason ? { stopReason } : {}),
                ...(diagnostic ? { diagnostic } : {}),
              };
            },
          },
          { cwd, signal },
        );
        ending = execution.status;
        return execution;
      },
    );
  } catch (error) {
    ending = timeout.aborted
      ? "timeout"
      : signal.aborted
        ? "cancelled"
        : "failed";
    throw error;
  } finally {
    active = false;
    record({ type: "end", status: ending });
  }
}
