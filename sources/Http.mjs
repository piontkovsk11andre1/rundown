import { createServer } from "node:http";
import { CallbackHost } from "./Callbacks.mjs";
import { describe, permits } from "./Catalog.mjs";
import { McpHttpHost } from "./Mcp.mjs";
import { diagnostic, diagnose, RundownError } from "./Error.mjs";
import { jsonText } from "./Validation.mjs";
import { withTraceContext } from "./Observability.mjs";
import { View, viewDisplay } from "./Views.mjs";

/** @param {import('node:http').IncomingMessage} request @returns {Promise<unknown>} */
async function body(request) {
  let size = 0;
  /** @type {Buffer[]} */
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024)
      throw new RundownError("RUNDOWN_REQUEST_SIZE", "Request exceeds 1 MiB", {
        status: 413,
      });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (cause) {
    throw new RundownError("RUNDOWN_ARGUMENTS", "Expected a JSON body", {
      cause,
      status: 400,
    });
  }
}
/** @param {import('node:http').ServerResponse} response @param {number} status @param {unknown} value */
function send(response, status, value) {
  const text = jsonText(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(text);
}

/** Negotiate supported representations with exact media exclusions overriding wildcards.
 * @param {string|undefined} accept @returns {'json'|'markdown'}
 */
function responseFormat(accept) {
  if (!accept) return "json";
  const entries = accept.split(",").map((value) => {
    const [media, ...parameters] = value.trim().toLowerCase().split(";");
    const parameter = parameters
      .map((item) => item.trim())
      .find((item) => /^q\s*=/.test(item));
    const raw = parameter?.split("=")[1]?.trim() ?? "1";
    const q = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(raw)
      ? Number(raw)
      : 0;
    return { media: media.trim(), q };
  });
  /** @param {string} media */
  const quality = (media) => {
    for (const pattern of [media, media.split("/")[0] + "/*", "*/*"]) {
      const matches = entries.filter((entry) => entry.media === pattern);
      if (matches.length) return Math.max(...matches.map((entry) => entry.q));
    }
    return 0;
  };
  const markdown = quality("text/markdown"),
    json = quality("application/json");
  if (!markdown && !json)
    throw new RundownError(
      "RUNDOWN_NOT_ACCEPTABLE",
      "Accept must allow application/json or text/markdown",
      { status: 406 },
    );
  return markdown > json ||
    (markdown === json &&
      entries.some((entry) => entry.media === "text/markdown" && entry.q > 0))
    ? "markdown"
    : "json";
}

/** Plain HTTP and standard Streamable HTTP MCP share dispatch and callback ownership.
 * @param {import('./InternalContracts.mjs').HttpOptions} [options] @returns {Promise<import('./InternalContracts.mjs').HttpHandle>}
 */
export async function startHttp({
  runtime,
  callbackHost = runtime?.callbackHost ?? new CallbackHost(),
  bind = "127.0.0.1",
  port = 0,
  publicURL,
  allowedOrigins = [],
} = {}) {
  /** @type {Promise<void>|undefined} */
  let closing;
  const mcp = new McpHttpHost();
  const server = createServer((request, response) =>
    withTraceContext(request.headers, async () => {
      /** @type {string|undefined} */
      let invocationId;
      const controller = new AbortController();
      response.once("close", () => {
        if (!response.writableFinished) controller.abort();
      });
      try {
        const origin = request.headers.origin;
        if (origin && !allowedOrigins.includes(origin))
          throw new RundownError("RUNDOWN_ORIGIN", "Origin is not allowed", {
            status: 403,
          });
        const url = new URL(request.url ?? "/", "http://localhost");
        let parts;
        try {
          parts = url.pathname
            .split("/")
            .filter(Boolean)
            .map(decodeURIComponent);
        } catch (cause) {
          throw new RundownError(
            "RUNDOWN_ARGUMENTS",
            "Malformed URL encoding",
            { cause, status: 400 },
          );
        }
        if (parts[0] === "mcp" && parts.length === 1 && runtime) {
          await mcp.handle(request, response, { runtime, surface: "http-mcp" });
          return;
        }
        if (parts[0] === "callbacks") {
          const registration = callbackHost.registrations.get(parts[1]);
          if (!registration || registration.state !== "open")
            throw new RundownError(
              "RUNDOWN_CALLBACK_UNKNOWN",
              "Unknown callback registration",
              { status: 404 },
            );
          invocationId = registration.context.id;
          if (parts[2] === "mcp" && parts.length === 3) {
            await mcp.handle(request, response, { registration });
            return;
          }
          if (request.method === "POST" && parts.length === 3) {
            send(response, 200, {
              ok: true,
              result: await registration.call(parts[2], await body(request), {
                signal: controller.signal,
              }),
            });
            return;
          }
        }
        if (parts[0] === "commands" && runtime) {
          if (request.method === "GET" && parts.length === 1) {
            send(response, 200, {
              ok: true,
              result: [...runtime.catalog.commands.values()]
                .filter((c) => permits(c, "http"))
                .map(describe),
            });
            return;
          }
          const command = runtime.catalog.commands.get(parts[1]);
          if (!command)
            throw new RundownError(
              "RUNDOWN_COMMAND_UNKNOWN",
              "Unknown command",
              {
                status: 404,
              },
            );
          if (!permits(command, "http"))
            throw new RundownError(
              "RUNDOWN_SURFACE",
              "Command is unavailable on HTTP",
              { status: 403 },
            );
          if (parts.length === 2 && request.method === "GET") {
            send(response, 200, { ok: true, result: describe(command) });
            return;
          }
          if (parts.length === 2 && request.method === "POST") {
            const markdown =
              responseFormat(request.headers.accept) === "markdown";
            const display = markdown
              ? viewDisplay({
                  width: url.searchParams.has("width")
                    ? Number(url.searchParams.get("width"))
                    : undefined,
                  height: url.searchParams.has("height")
                    ? Number(url.searchParams.get("height"))
                    : undefined,
                })
              : undefined;
            const result = await runtime.invoke(
              command.name,
              await body(request),
              {
                surface: "http",
                signal: controller.signal,
              },
            );
            if (markdown) {
              if (!(result instanceof View))
                throw new RundownError(
                  "RUNDOWN_VIEW_EXPECTED",
                  "Markdown output requires a view result",
                  { status: 400 },
                );
              const text = result.render(display);
              response.writeHead(200, {
                "Content-Type": "text/markdown; charset=utf-8",
                "Cache-Control": "no-store",
              });
              response.end(text);
              return;
            }
            send(response, 200, {
              ok: true,
              result: result instanceof View ? result.data : result,
            });
            return;
          }
        }
        throw new RundownError("RUNDOWN_NOT_FOUND", "Route not found", {
          status: 404,
        });
      } catch (error) {
        const failure = diagnose(error);
        if (!response.headersSent && !response.destroyed)
          send(response, failure.status, {
            ok: false,
            error: diagnostic(failure, invocationId),
          });
        else if (!response.writableEnded) response.end();
      }
    }),
  );
  server.requestTimeout = 30000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, bind, () => {
      server.off("error", reject);
      resolve(undefined);
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected a TCP listening address");
  const host = address.address.includes(":")
    ? `[${address.address}]`
    : address.address;
  const url = (publicURL ?? `http://${host}:${address.port}`).replace(
    /\/$/,
    "",
  );
  /** @type {import('./InternalContracts.mjs').HttpHandle} */
  const handle = {
    server,
    url,
    releaseRegistration: (id) => mcp.release(id),
    close: () =>
      (closing ??= (async () => {
        let failure;
        try {
          if (runtime) await runtime.close();
        } catch (error) {
          failure = error;
        }
        try {
          await mcp.close();
        } finally {
          await new Promise((resolve, reject) => {
            server.close((error) =>
              error ? reject(error) : resolve(undefined),
            );
            server.closeAllConnections();
          });
        }
        if (failure) throw failure;
      })()),
  };
  callbackHost.server = handle;
  return handle;
}
