import fs from "node:fs";
import {
  DEFAULT_CORRECT_TEMPLATE,
  DEFAULT_PLAN_TEMPLATE,
  DEFAULT_TASK_TEMPLATE,
  DEFAULT_VALIDATE_TEMPLATE,
  DEFAULT_VARS_FILE_CONTENT,
} from "../domain/defaults.js";
import * as log from "../presentation/log.js";

const CONFIG_DIR = ".md-todo";

export async function initProject(): Promise<number> {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }

  const write = (name: string, content: string) => {
    const filePath = `${CONFIG_DIR}/${name}`;
    if (fs.existsSync(filePath)) {
      log.warn(`${filePath} already exists, skipping.`);
      return;
    }

    fs.writeFileSync(filePath, content, "utf-8");
    log.success(`Created ${filePath}`);
  };

  write("execute.md", DEFAULT_TASK_TEMPLATE);
  write("verify.md", DEFAULT_VALIDATE_TEMPLATE);
  write("repair.md", DEFAULT_CORRECT_TEMPLATE);
  write("plan.md", DEFAULT_PLAN_TEMPLATE);
  write("vars.json", DEFAULT_VARS_FILE_CONTENT);

  log.success("Initialized .md-todo/ with default templates.");
  return 0;
}
