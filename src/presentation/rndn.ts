import { spawn } from "node:child_process";

const child = spawn("rundown", ["materialize", ...process.argv.slice(2)], {
  stdio: "inherit",
  shell: false,
});

child.on("close", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});
