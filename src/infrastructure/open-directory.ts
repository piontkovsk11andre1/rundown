import { spawn } from "node:child_process";

export function openDirectory(dirPath: string): void {
  if (process.platform === "win32") {
    const child = spawn("explorer", [dirPath], {
      detached: true,
      stdio: "ignore",
      shell: false,
    });
    child.unref();
    return;
  }

  if (process.platform === "darwin") {
    const child = spawn("open", [dirPath], {
      detached: true,
      stdio: "ignore",
      shell: false,
    });
    child.unref();
    return;
  }

  const child = spawn("xdg-open", [dirPath], {
    detached: true,
    stdio: "ignore",
    shell: false,
  });
  child.unref();
}
