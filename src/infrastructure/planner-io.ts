import fs from "node:fs";
import {
  insertSubitems,
  parsePlannerOutput,
} from "../domain/planner.js";
import type { Task } from "../domain/parser.js";

/**
 * Applies planner-generated subitems to the task source file.
 *
 * The planner output is parsed into bullet lines, merged into the task location,
 * and then persisted back to disk. Returns the number of inserted subitems.
 */
export function applyPlannerOutput(task: Task, plannerOutput: string): number {
  // Parse the planner response into normalized subitem lines.
  const subitemLines = parsePlannerOutput(plannerOutput);
  // Exit early when the planner produced no actionable items.
  if (subitemLines.length === 0) return 0;

  // Load the current task source, insert parsed subitems, then persist updates.
  const source = fs.readFileSync(task.file, "utf-8");
  const updated = insertSubitems(source, task, subitemLines);
  fs.writeFileSync(task.file, updated, "utf-8");

  // Report how many subitems were added to the file.
  return subitemLines.length;
}
