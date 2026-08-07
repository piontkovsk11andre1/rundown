import type { WorkerHealthStore } from "../../domain/ports/worker-health-store.js";
import {
  readWorkerHealthSnapshot,
  updateWorkerHealthSnapshot,
  workerHealthStoreFilePath,
  writeWorkerHealthSnapshot,
} from "../worker-health-store.js";

/**
 * Creates a filesystem-backed worker health persistence adapter.
 */
export function createFsWorkerHealthStore(): WorkerHealthStore {
  return {
    read(configDirOrCwd) {
      return readWorkerHealthSnapshot(configDirOrCwd);
    },
    write(snapshot, configDirOrCwd) {
      writeWorkerHealthSnapshot(snapshot, configDirOrCwd);
    },
    update(updater, configDirOrCwd) {
      return updateWorkerHealthSnapshot(updater, configDirOrCwd);
    },
    removeEntry(key, configDirOrCwd) {
      return updateWorkerHealthSnapshot((snapshot) => ({
        ...snapshot,
        entries: snapshot.entries.filter((entry) => entry.key !== key),
      }), configDirOrCwd);
    },
    filePath(configDirOrCwd) {
      return workerHealthStoreFilePath(configDirOrCwd);
    },
  };
}
