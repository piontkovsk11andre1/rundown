import { describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

import { openDirectory } from "../../src/infrastructure/open-directory.js";

describe("openDirectory", () => {
  it("uses explorer on Windows", () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const unref = vi.fn();
    spawnMock.mockReturnValue({ unref });

    openDirectory("C:/repo");

    expect(spawnMock).toHaveBeenCalledWith("explorer", ["C:/repo"], {
      detached: true,
      stdio: "ignore",
      shell: false,
    });
    expect(unref).toHaveBeenCalledTimes(1);
    platformSpy.mockRestore();
  });

  it("uses open on macOS", () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const unref = vi.fn();
    spawnMock.mockReturnValue({ unref });

    openDirectory("/repo");

    expect(spawnMock).toHaveBeenCalledWith("open", ["/repo"], {
      detached: true,
      stdio: "ignore",
      shell: false,
    });
    expect(unref).toHaveBeenCalledTimes(1);
    platformSpy.mockRestore();
  });

  it("uses xdg-open on Linux", () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const unref = vi.fn();
    spawnMock.mockReturnValue({ unref });

    openDirectory("/repo");

    expect(spawnMock).toHaveBeenCalledWith("xdg-open", ["/repo"], {
      detached: true,
      stdio: "ignore",
      shell: false,
    });
    expect(unref).toHaveBeenCalledTimes(1);
    platformSpy.mockRestore();
  });
});
