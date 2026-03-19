import type { ApplicationOutputEvent, ApplicationOutputPort } from "../domain/ports/output-port.js";
import pc from "picocolors";

function dim(message: string): string {
  return pc.dim(message);
}

function taskLabel(task: { text: string; file: string; line: number; index: number }): string {
  return `${pc.cyan(task.file)}:${pc.yellow(String(task.line))} ${pc.dim(`[#${task.index}]`)} ${task.text}`;
}

export const cliOutputPort: ApplicationOutputPort = {
  emit(event: ApplicationOutputEvent): void {
    switch (event.kind) {
      case "info":
        console.log(pc.blue("ℹ") + " " + event.message);
        return;
      case "warn":
        console.log(pc.yellow("⚠") + " " + event.message);
        return;
      case "error":
        console.error(pc.red("✖") + " " + event.message);
        return;
      case "success":
        console.log(pc.green("✔") + " " + event.message);
        return;
      case "task":
        console.log(
          taskLabel(event.task)
          + (event.blocked ? dim(" (blocked — has unchecked subtasks)") : ""),
        );
        return;
      case "text":
        console.log(event.text);
        return;
      case "stderr":
        process.stderr.write(event.text);
        return;
      default:
        return;
    }
  },
};
