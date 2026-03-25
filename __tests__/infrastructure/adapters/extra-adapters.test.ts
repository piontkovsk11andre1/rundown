import { describe, expect, it, vi } from "vitest";

const { loadTemplateVarsFileMock, openDirectoryMock } = vi.hoisted(() => ({
  loadTemplateVarsFileMock: vi.fn(() => ({ branch: "main" })),
  openDirectoryMock: vi.fn(),
}));

vi.mock("../../../src/infrastructure/template-vars-io.js", () => ({
  loadTemplateVarsFile: loadTemplateVarsFileMock,
}));

vi.mock("../../../src/infrastructure/open-directory.js", () => ({
  openDirectory: openDirectoryMock,
}));

import { createFsTemplateVarsLoaderAdapter } from "../../../src/infrastructure/adapters/fs-template-vars-loader-adapter.js";
import { createDirectoryOpenerAdapter } from "../../../src/infrastructure/adapters/directory-opener-adapter.js";

describe("extra infrastructure adapters", () => {
  it("template vars loader adapter delegates to loadTemplateVarsFile", () => {
    const adapter = createFsTemplateVarsLoaderAdapter();
    const result = adapter.load(".rundown/vars.json", "/repo");

    expect(loadTemplateVarsFileMock).toHaveBeenCalledWith(".rundown/vars.json", "/repo");
    expect(result).toEqual({ branch: "main" });
  });

  it("directory opener adapter exposes openDirectory", () => {
    const adapter = createDirectoryOpenerAdapter();
    adapter.openDirectory("/repo");

    expect(openDirectoryMock).toHaveBeenCalledWith("/repo");
  });
});
