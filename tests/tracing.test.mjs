import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { Runtime } from "../sources/index.mjs";
import { startHttp } from "../sources/Http.mjs";
import {
  Observability,
  initializeTelemetry,
} from "../sources/Observability.mjs";
import { runProcess, ProcessAdapter } from "../sources/Process.mjs";

const traceId = "0123456789abcdef0123456789abcdef";
const parentId = "0123456789abcdef";
const traceparent = `00-${traceId}-${parentId}-01`;

test(
  "HTTP, external processes and scoped MCP callbacks preserve W3C context without identity overrides",
  { timeout: 10000 },
  async () => {
    const exporter = new InMemorySpanExporter();
    const telemetry = await initializeTelemetry({
      autoDetectResources: false,
      logRecordProcessors: [],
      metricReaders: [],
      spanProcessors: [new SimpleSpanProcessor({ exporter })],
    });
    const records = [],
      captures = [];
    let executions = 0;
    const observability = new Observability({
      sink: (record) => records.push(record),
    });
    const command = {
      name: "test",
      parameters: [],
      surfaces: ["*"],
      validate: () => {},
      handler: async (_args, context) => {
        const registration = context.callbacks.register(
          {
            complete: {
              inputSchema: { type: "object", additionalProperties: false },
              handler: () => {
                context.log.info("Completed");
                return { accepted: true };
              },
            },
          },
          { reporting: { logs: true } },
        );
        const exposure = await registration.expose();
        const input = {
          instructions: "Work",
          connections: { callbacks: exposure.mcp },
        };
        if (executions++ === 0) await context.adapters.worker.run(input);
        else await context.run(worker, input);
        await registration.close();
        return context.id;
      },
    };
    const worker = {
      async run(input) {
        const script =
          "console.log(JSON.stringify({carrier:JSON.parse(process.env.RUNDOWN_TRACE_CONTEXT),config:JSON.parse(process.env.EXAMPLE_REMOTE_CONFIG)}))";
        const headers = new Headers({
          ...input.connections.callbacks.headers,
          "x-preserved": "yes",
          Traceparent: "wrong",
        });
        for (const [key, value] of Object.entries(input.traceContext))
          headers.set(key, value);
        const remoteConfig = {
          ...input.connections.callbacks,
          headers: Object.fromEntries(headers),
        };
        const adapter = new ProcessAdapter({
          env: {
            ...process.env,
            EXAMPLE_REMOTE_CONFIG: JSON.stringify({
              existing: "retained",
              callback: remoteConfig,
            }),
          },
        });
        const result = await adapter.run({
          command: process.execPath,
          args: ["-e", script],
          cwd: input.cwd,
          signal: input.signal,
          traceContext: input.traceContext,
        });
        const capture = JSON.parse(result.stdout);
        captures.push(capture);
        const remote = capture.config.callback;
        assert.equal(
          remote.headers.traceparent,
          input.traceContext.traceparent,
        );
        assert.equal(remote.headers["x-preserved"], "yes");
        assert.equal(
          capture.carrier.traceparent,
          input.traceContext.traceparent,
        );
        assert.equal(capture.config.existing, "retained");
        const client = new Client({
          name: "external-callback-test",
          version: "1",
        });
        await client.connect(
          new StreamableHTTPClientTransport(new URL(remote.url), {
            requestInit: { headers: remote.headers },
          }),
        );
        try {
          assert.equal(
            (await client.callTool({ name: "complete", arguments: {} }))
              .isError,
            undefined,
          );
          await client.callTool({
            name: "report_log",
            arguments: {
              level: "info",
              message: "External log",
              fields: { invocationId: "spoof", traceId: "spoof" },
            },
          });
        } finally {
          await client.close();
        }
      },
    };
    const runtime = new Runtime(
      { commands: new Map([["test", command]]) },
      { observability, adapters: { worker } },
    );
    const http = await startHttp({ runtime });
    try {
      const first = await fetch(http.url + "/commands/test", {
        method: "POST",
        body: "{}",
        headers: { traceparent, tracestate: "vendor=external" },
      });
      assert.equal(first.status, 200);
      const identity = (await first.json()).result;
      const second = await fetch(http.url + "/commands/test", {
        method: "POST",
        body: "{}",
      });
      assert.equal(second.status, 200);
      const spans = exporter.getFinishedSpans();
      const commands = spans.filter((span) => span.name === "rundown.command");
      const commandSpan = commands.find(
        (span) => span.spanContext().traceId === traceId,
      );
      assert.equal(commandSpan.parentSpanContext.spanId, parentId);
      assert.equal(commandSpan.kind, 1);
      assert.equal(
        commands.find((span) => span !== commandSpan).parentSpanContext,
        undefined,
      );
      const callback = spans.find(
        (span) =>
          span.name === "rundown.callback" &&
          span.attributes.callback === "complete" &&
          span.spanContext().traceId === traceId,
      );
      const adapter = spans.find(
        (span) =>
          span.name === "rundown.adapter" &&
          span.spanContext().traceId === traceId,
      );
      assert.equal(
        callback.parentSpanContext.spanId,
        commandSpan.spanContext().spanId,
      );
      assert.ok(
        callback.links.some(
          (link) => link.context.spanId === adapter.spanContext().spanId,
        ),
      );
      assert.ok(
        records.some(
          (record) =>
            record.message === "External log" &&
            record.invocationId === identity &&
            record.traceId === traceId,
        ),
      );
      assert.ok(
        records.every(
          (record) =>
            record.invocationId !== "spoof" && record.traceId !== "spoof",
        ),
      );
      assert.equal(captures[0].carrier.tracestate, "vendor=external");
      // A session's initialization headers must not become the parent of later calls.
      let carrier = { traceparent };
      const protocol = new Client({ name: "request-traces", version: "1" });
      await protocol.connect(
        new StreamableHTTPClientTransport(new URL(http.url + "/mcp"), {
          fetch: (input, init) => {
            const headers = new Headers(init?.headers);
            for (const [key, value] of Object.entries(carrier))
              headers.set(key, value);
            return fetch(input, { ...init, headers });
          },
        }),
      );
      try {
        const nextParent = "fedcba9876543210";
        carrier = { traceparent: `00-${traceId}-${nextParent}-01` };
        await protocol.callTool({ name: "test", arguments: {} });
        carrier = {};
        await protocol.callTool({ name: "test", arguments: {} });
        const commands = exporter
          .getFinishedSpans()
          .filter((span) => span.name === "rundown.command");
        assert.ok(
          commands.some(
            (span) => span.parentSpanContext?.spanId === nextParent,
          ),
        );
        assert.equal(
          commands.filter((span) => !span.parentSpanContext).length,
          2,
        );
      } finally {
        await protocol.close();
      }
      // A stdio bridge forwards an inherited carrier even without a local SDK.
      const bridgeParent = "abababababababab";
      const bridge = new Client({ name: "bridge-traces", version: "1" });
      await bridge.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [
            fileURLToPath(new URL("../bin/rundown.mjs", import.meta.url)),
            "--mcp-http",
            http.url + "/mcp",
          ],
          env: {
            ...Object.fromEntries(
              Object.entries(process.env).filter(
                ([key]) => !key.startsWith("OTEL_"),
              ),
            ),
            RUNDOWN_TRACE_CONTEXT: JSON.stringify({
              traceparent: `00-${traceId}-${bridgeParent}-01`,
            }),
          },
          stderr: "pipe",
        }),
      );
      try {
        await bridge.callTool({ name: "test", arguments: {} });
        assert.ok(
          exporter
            .getFinishedSpans()
            .some(
              (span) =>
                span.name === "rundown.command" &&
                span.parentSpanContext?.spanId === bridgeParent,
            ),
        );
      } finally {
        await bridge.close();
      }
    } finally {
      await http.close();
      await telemetry.close();
    }
  },
);

test(
  "standard environment configuration exports traces, logs and metrics over real OTLP HTTP",
  { timeout: 15000 },
  async () => {
    const received = [];
    const collector = createServer(async (request, response) => {
      if (request.url === "/ready") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            ready: ["/v1/traces", "/v1/logs", "/v1/metrics"].every((path) =>
              received.some((value) => value.path === path),
            ),
          }),
        );
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      try {
        received.push({
          path: request.url,
          type: request.headers["content-type"],
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        });
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end("{}");
      } catch {
        response.writeHead(400);
        response.end();
      }
    });
    await new Promise((resolve) => collector.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${collector.address().port}`;
    const env = {
      ...process.env,
      OTEL_SDK_DISABLED: "false",
      OTEL_SERVICE_NAME: "rundown-env-test",
      OTEL_NODE_RESOURCE_DETECTORS: "env",
      OTEL_PROPAGATORS: "tracecontext",
      OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
      OTEL_EXPORTER_OTLP_HEADERS: "",
      OTEL_EXPORTER_OTLP_COMPRESSION: "none",
      OTEL_BSP_SCHEDULE_DELAY: "20",
      OTEL_BLRP_SCHEDULE_DELAY: "20",
      OTEL_METRIC_EXPORT_INTERVAL: "200",
      OTEL_METRIC_EXPORT_TIMEOUT: "200",
    };
    for (const [signal, path] of [
      ["TRACES", "traces"],
      ["LOGS", "logs"],
      ["METRICS", "metrics"],
    ]) {
      env[`OTEL_${signal}_EXPORTER`] = "otlp";
      env[`OTEL_EXPORTER_OTLP_${signal}_ENDPOINT`] = endpoint + "/v1/" + path;
      env[`OTEL_EXPORTER_OTLP_${signal}_PROTOCOL`] = "http/json";
      env[`OTEL_EXPORTER_OTLP_${signal}_HEADERS`] = "";
      env[`OTEL_EXPORTER_OTLP_${signal}_COMPRESSION`] = "none";
    }
    const source = new URL("../sources/Observability.mjs", import.meta.url)
      .href;
    const script = `import {initializeTelemetry,Observability,withTraceContext} from ${JSON.stringify(source)};
const sdk=await initializeTelemetry();const obs=new Observability({sink:()=>{}});
try{await withTraceContext({traceparent:${JSON.stringify(traceparent)}},()=>obs.span("exported.command",{},()=>{const c=obs.scoped("export-test");c.log.info("exported log");c.metrics.counter("exported.counter").add(3);c.metrics.histogram("exported.duration").record(12);}));
const start=Date.now();while(!(await(await fetch(${JSON.stringify(endpoint + "/ready")})).json()).ready){if(Date.now()-start>5000)throw new Error("Exporter requests did not arrive");await new Promise(resolve=>setTimeout(resolve,25));}}finally{await sdk.close();}`;
    try {
      await runProcess(
        process.execPath,
        ["--input-type=module", "-e", script],
        { env, timeoutMs: 10000 },
      );
      assert.ok(
        received.every((value) => value.type.startsWith("application/json")),
      );
      const traces = received
        .filter((value) => value.path === "/v1/traces")
        .flatMap((value) => value.body.resourceSpans);
      assert.ok(
        traces.some((resource) =>
          resource.scopeSpans.some((scope) =>
            scope.spans.some(
              (span) =>
                span.name === "exported.command" && span.traceId === traceId,
            ),
          ),
        ),
      );
      assert.ok(
        traces.some((resource) =>
          resource.resource.attributes.some(
            (attribute) =>
              attribute.key === "service.name" &&
              attribute.value.stringValue === "rundown-env-test",
          ),
        ),
      );
      const logs = received
        .filter((value) => value.path === "/v1/logs")
        .flatMap((value) =>
          value.body.resourceLogs.flatMap((resource) =>
            resource.scopeLogs.flatMap((scope) => scope.logRecords),
          ),
        );
      assert.ok(
        logs.some(
          (record) =>
            record.body.stringValue === "exported log" &&
            record.traceId === traceId,
        ),
      );
      const metrics = received
        .filter((value) => value.path === "/v1/metrics")
        .flatMap((value) =>
          value.body.resourceMetrics.flatMap((resource) =>
            resource.scopeMetrics.flatMap((scope) => scope.metrics),
          ),
        );
      const counter = metrics.find(
        (metric) => metric.name === "exported.counter",
      );
      assert.ok(counter);
      assert.equal(
        Number(
          counter.sum.dataPoints[0].asDouble ?? counter.sum.dataPoints[0].asInt,
        ),
        3,
      );
      const histogram = metrics.find(
        (metric) => metric.name === "exported.duration",
      );
      assert.ok(histogram);
      assert.equal(histogram.histogram.dataPoints[0].sum, 12);
      assert.ok(
        metrics.every((metric) =>
          [
            ...(metric.sum?.dataPoints ?? []),
            ...(metric.histogram?.dataPoints ?? []),
          ].every(
            (point) =>
              !(point.attributes ?? []).some(
                (attribute) => attribute.key === "invocationId",
              ),
          ),
        ),
      );
    } finally {
      await new Promise((resolve) => {
        collector.close(resolve);
        collector.closeAllConnections();
      });
    }
  },
);
