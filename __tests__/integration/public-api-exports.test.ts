import { describe, expect, it } from "vitest";
import * as api from "../../src/index.js";
import * as createAppApi from "../../src/create-app.js";

describe("public API exports", () => {
  it("keeps root index exports intentionally narrow", () => {
    expect(Object.keys(api).sort()).toEqual(["createApp"]);
  });

  it("keeps create-app runtime exports stable", () => {
    expect(Object.keys(createAppApi).sort()).toEqual(["createApp"]);
  });

  it("keeps createApp application surface stable", () => {
    const app = createAppApi.createApp();

    expect(app).toMatchObject({
      runTask: expect.any(Function),
      planTask: expect.any(Function),
      listTasks: expect.any(Function),
      nextTask: expect.any(Function),
      initProject: expect.any(Function),
      manageArtifacts: expect.any(Function),
    });
  });
});
