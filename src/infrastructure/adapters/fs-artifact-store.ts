import type {
  ArtifactStore,
  ArtifactRunContext,
  ArtifactPhaseHandle,
  ArtifactRunMetadata,
  ArtifactStorePhase,
} from "../../domain/ports/artifact-store.js";
import {
  beginRuntimePhase,
  completeRuntimePhase,
  createRuntimeArtifactsContext,
  displayArtifactsPath,
  findSavedRuntimeArtifact,
  finalizeRuntimeArtifacts,
  isFailedRuntimeArtifactStatus,
  latestSavedRuntimeArtifact,
  listFailedRuntimeArtifacts,
  listSavedRuntimeArtifacts,
  removeFailedRuntimeArtifacts,
  removeSavedRuntimeArtifacts,
  runtimeArtifactsRootDir,
  type BeginRuntimePhaseOptions,
  type CompleteRuntimePhaseOptions,
  type RuntimeArtifactsContext,
  type RuntimePhaseHandle,
  type RuntimePhase,
} from "../runtime-artifacts.js";

const toRuntimePhase = (phase: ArtifactStorePhase): RuntimePhase => phase;

export function createFsArtifactStore(): ArtifactStore {
  return {
    createContext(options): ArtifactRunContext {
      return createRuntimeArtifactsContext(options);
    },
    beginPhase(context, options): ArtifactPhaseHandle {
      const runtimeOptions: BeginRuntimePhaseOptions = {
        ...options,
        phase: toRuntimePhase(options.phase),
      };
      return beginRuntimePhase(context as RuntimeArtifactsContext, runtimeOptions);
    },
    completePhase(handle, options): void {
      const runtimeOptions: CompleteRuntimePhaseOptions = options;
      completeRuntimePhase(handle as RuntimePhaseHandle, runtimeOptions);
    },
    finalize(context, options): void {
      finalizeRuntimeArtifacts(context as RuntimeArtifactsContext, {
        status: options.status,
        preserve: options.preserve,
      });
    },
    displayPath(context): string {
      return displayArtifactsPath(context as RuntimeArtifactsContext);
    },
    rootDir(cwd): string {
      return runtimeArtifactsRootDir(cwd);
    },
    listSaved(cwd): ArtifactRunMetadata[] {
      return listSavedRuntimeArtifacts(cwd);
    },
    listFailed(cwd): ArtifactRunMetadata[] {
      return listFailedRuntimeArtifacts(cwd);
    },
    latest(cwd): ArtifactRunMetadata | null {
      return latestSavedRuntimeArtifact(cwd);
    },
    find(runId, cwd): ArtifactRunMetadata | null {
      return findSavedRuntimeArtifact(runId, cwd);
    },
    removeSaved(cwd): number {
      return removeSavedRuntimeArtifacts(cwd);
    },
    removeFailed(cwd): number {
      return removeFailedRuntimeArtifacts(cwd);
    },
    isFailedStatus(status: string | undefined): boolean {
      return isFailedRuntimeArtifactStatus(status);
    },
  };
}
