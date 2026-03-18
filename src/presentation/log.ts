/**
 * Logging and output helpers.
 *
 * Provides consistent, styled terminal output for md-todo.
 */

import pc from "picocolors";

export function info(message: string): void {
  console.log(pc.blue("ℹ") + " " + message);
}

export function success(message: string): void {
  console.log(pc.green("✔") + " " + message);
}

export function warn(message: string): void {
  console.log(pc.yellow("⚠") + " " + message);
}

export function error(message: string): void {
  console.error(pc.red("✖") + " " + message);
}

export function dim(message: string): string {
  return pc.dim(message);
}

export function bold(message: string): string {
  return pc.bold(message);
}

export function taskLabel(task: { text: string; file: string; line: number; index: number }): string {
  return `${pc.cyan(task.file)}:${pc.yellow(String(task.line))} ${pc.dim(`[#${task.index}]`)} ${task.text}`;
}
