import test from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryLogRecordExporter,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import {
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
  AggregationTemporality,
} from "@opentelemetry/sdk-metrics";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace";
import {
  Observability,
  initializeTelemetry,
} from "../sources/Observability.mjs";
import { Runtime } from "../sources/index.mjs";

test("OTel exports correlated logs, declared metrics and command/callback/adapter spans", async () => {
  const logExporter = new InMemoryLogRecordExporter();
  const metricExporter = new InMemoryMetricExporter(
    AggregationTemporality.CUMULATIVE,
  );
  const traceExporter = new InMemorySpanExporter();
  const reader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: 60000,
  });
  const telemetry = await initializeTelemetry({
    autoDetectResources: false,
    logRecordProcessors: [
      new SimpleLogRecordProcessor({ exporter: logExporter }),
    ],
    metricReaders: [reader],
    spanProcessors: [new SimpleSpanProcessor({ exporter: traceExporter })],
  });
  const records = [];
  const observability = new Observability({
    sink: (record) => records.push(record),
  });
  let ready;
  const registrationReady = new Promise((resolve) => {
    ready = resolve;
  });
  let release;
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  const command = {
    name: "test",
    surfaces: ["*"],
    parameters: [],
    validate: () => {},
    handler: async (_args, context) => {
      const counter = context.metrics.counter("work.completed", {
        attributeKeys: ["kind"],
      });
      const histogram = context.metrics.histogram("work.duration", {
        unit: "ms",
      });
      histogram.record(12);
      const reg = context.callbacks.register(
        {
          complete: {
            inputSchema: { type: "object", additionalProperties: false },
            handler: () => {
              context.log.info("Callback completed", { invocationId: "spoof" });
              return { ok: true };
            },
          },
        },
        { reporting: { metrics: { completed: counter } } },
      );
      ready(reg);
      await context.adapters.worker.run({ prompt: "test" });
      await hold;
      await reg.close();
      return "done";
    },
  };
  const runtime = new Runtime(
    { commands: new Map([["test", command]]) },
    { observability, adapters: { worker: { run: async () => {} } } },
  );
  try {
    const run = runtime.invoke("test");
    const reg = await registrationReady;
    const exposure = await reg.expose();
    const response = await fetch(exposure.url + "/complete", {
      method: "POST",
      body: "{}",
    });
    assert.equal(response.status, 200);
    await reg.call("report_metric", {
      metric: "completed",
      value: 2,
      attributes: { kind: "task" },
    });
    release();
    await run;
    await reader.forceFlush();
    const spans = traceExporter.getFinishedSpans();
    const commandSpan = spans.find((s) => s.name === "rundown.command");
    const callbackSpan = spans.find((s) => s.name === "rundown.callback");
    assert.ok(spans.some((s) => s.name === "rundown.adapter"));
    assert.equal(
      callbackSpan.parentSpanContext.spanId,
      commandSpan.spanContext().spanId,
    );
    assert.equal(records[0].traceId, commandSpan.spanContext().traceId);
    assert.notEqual(records[0].invocationId, "spoof");
    assert.ok(
      logExporter
        .getFinishedLogRecords()
        .some((record) => record.body === "Callback completed"),
    );
    const metrics = metricExporter
      .getMetrics()
      .flatMap((data) => data.scopeMetrics.flatMap((scope) => scope.metrics));
    assert.ok(
      metrics.some(
        (metric) =>
          metric.descriptor.name === "work.completed" &&
          metric.dataPoints[0].value === 2,
      ),
    );
    assert.ok(
      metrics.some((metric) => metric.descriptor.name === "work.duration"),
    );
    assert.ok(
      metrics.every((metric) =>
        metric.dataPoints.every(
          (point) => !Object.hasOwn(point.attributes, "invocationId"),
        ),
      ),
    );
  } finally {
    release();
    await runtime.close();
    await telemetry.close();
  }
});
