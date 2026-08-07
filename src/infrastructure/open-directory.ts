import { spawn } from "node:child_process";

/**
 * Opens a directory in the operating system's default file browser.
 *
 * Uses platform-specific commands and detaches the child process so the
 * current CLI process is not blocked while the file browser launches.
 */
export function openDirectory(dirPath: string): void {
  // Use Windows Explorer when running on Windows.
  if (process.platform === "win32") {
    const child = spawn("explorer", [dirPath], {
      detached: true,
      stdio: "ignore",
      shell: false,
    });
    child.unref();
    return;
  }

  // Use the native open command on macOS.
  if (process.platform === "darwin") {
    const child = spawn("open", [dirPath], {
      detached: true,
      stdio: "ignore",
      shell: false,
    });
    child.unref();
    return;
  }

  // Default to xdg-open for Linux and other POSIX environments.
  const child = spawn("xdg-open", [dirPath], {
    detached: true,
    stdio: "ignore",
    shell: false,
  });
  child.unref();
}
