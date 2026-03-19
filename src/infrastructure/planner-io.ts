import fs from "node:fs";
import {
  insertSubitems,
  parsePlannerOutput,
} from "../domain/planner.js";
import type { Task } from "../domain/parser.js";

export function applyPlannerOutput(task: Task, plannerOutput: string): number {
  const subitemLines = parsePlannerOutput(plannerOutput);
  if (subitemLines.length === 0) return 0;

  const source = fs.readFileSync(task.file, "utf-8");
  const updated = insertSubitems(source, task, subitemLines);
  fs.writeFileSync(task.file, updated, "utf-8");

  return subitemLines.length;
}
