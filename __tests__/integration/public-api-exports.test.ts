import { describe, expect, expectTypeOf, it } from "vitest";
import * as api from "../../src/index.js";
import * as createAppApi from "../../src/create-app.js";
import type { TraceEvent, TraceWriterPort } from "../../src/index.js";
import type { TraceEvent as DomainTraceEvent } from "../../src/domain/trace.js";
import type { DiscussTaskOptions } from "../../src/create-app.js";

describe("public API exports", () => {
  it("keeps root index exports intentionally narrow", () => {
    expect(Object.keys(api).sort()).toEqual(["createApp", "resetAllCheckboxes"]);
  });

  it("exports trace-related public types", () => {
    expectTypeOf<TraceEvent>().toEqualTypeOf<DomainTraceEvent>();

    const writer: TraceWriterPort = {
      write: () => {},
      flush: () => {},
    };

    expectTypeOf(writer).toMatchTypeOf<TraceWriterPort>();
  });

  it("keeps create-app runtime exports stable", () => {
    expect(Object.keys(createAppApi).sort()).toEqual(["createApp"]);
  });

  it("keeps createApp application surface stable", () => {
    const app = createAppApi.createApp();

    expect(app).toMatchObject({
      runTask: expect.any(Function),
      discussTask: expect.any(Function),
      planTask: expect.any(Function),
      listTasks: expect.any(Function),
      nextTask: expect.any(Function),
      initProject: expect.any(Function),
      manageArtifacts: expect.any(Function),
      configGet: expect.any(Function),
      configList: expect.any(Function),
      configPath: expect.any(Function),
      configSet: expect.any(Function),
      configUnset: expect.any(Function),
    });

    expectTypeOf<Parameters<typeof app.discussTask>[0]>().toEqualTypeOf<DiscussTaskOptions>();
  });
});
