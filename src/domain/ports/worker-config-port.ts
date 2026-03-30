import type { WorkerConfig } from "../worker-config.js";

export interface WorkerConfigPort {
  load(configDir: string): WorkerConfig | undefined;
}
