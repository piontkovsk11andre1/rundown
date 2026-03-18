import { runTask, type RunTaskOptions } from "./application/run-task.js";
import { planTask, type PlanTaskOptions } from "./application/plan-task.js";
import { listTasks, type ListTasksOptions } from "./application/list-tasks.js";
import { nextTask, type NextTaskOptions } from "./application/next-task.js";
import { initProject } from "./application/init-project.js";
import {
  manageArtifacts,
  type ManageArtifactsOptions,
} from "./application/manage-artifacts.js";

export type App = {
  runTask: (options: RunTaskOptions) => Promise<number>;
  planTask: (options: PlanTaskOptions) => Promise<number>;
  listTasks: (options: ListTasksOptions) => Promise<number>;
  nextTask: (options: NextTaskOptions) => Promise<number>;
  initProject: () => Promise<number>;
  manageArtifacts: (options: ManageArtifactsOptions) => number;
};

export type CreateAppDependencies = Partial<App>;

const defaultApp: App = {
  runTask,
  planTask,
  listTasks,
  nextTask,
  initProject,
  manageArtifacts,
};

export function createApp(
  dependencies: CreateAppDependencies = {},
): App {
  return {
    ...defaultApp,
    ...dependencies,
  };
}
