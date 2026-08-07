import type {
  ArtifactStore,
  ArtifactRunContext,
  ArtifactPhaseHandle,
  ArtifactRunMetadata,
  ArtifactStorePhase,
  ArtifactStoreStatus,
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

// Bridges domain phase values to the runtime artifact phase type.
const toRuntimePhase = (phase: ArtifactStorePhase): RuntimePhase => phase;

/**
 * Creates the filesystem-backed artifact store adapter.
 *
 * This adapter implements the domain `ArtifactStore` port by delegating each
 * operation to the runtime-artifacts infrastructure module while preserving the
 * domain-oriented interface expected by application services.
 */
export function createFsArtifactStore(): ArtifactStore {
  return {
    // Initializes per-run artifact context from the provided run options.
    createContext(options): ArtifactRunContext {
      return createRuntimeArtifactsContext(options);
    },
    // Starts a phase and records runtime metadata for artifact capture.
    beginPhase(context, options): ArtifactPhaseHandle {
      const runtimeOptions: BeginRuntimePhaseOptions = {
        ...options,
        phase: toRuntimePhase(options.phase),
      };
      return beginRuntimePhase(context as RuntimeArtifactsContext, runtimeOptions);
    },
    // Completes a phase and persists final phase-level state.
    completePhase(handle, options): void {
      const runtimeOptions: CompleteRuntimePhaseOptions = options;
      completeRuntimePhase(handle as RuntimePhaseHandle, runtimeOptions);
    },
    // Finalizes artifact output according to completion status and retention options.
    finalize(context, options): void {
      finalizeRuntimeArtifacts(context as RuntimeArtifactsContext, {
        status: options.status,
        preserve: options.preserve,
        extra: options.extra,
      });
    },
    // Returns a user-facing display path for the run's artifact directory.
    displayPath(context): string {
      return displayArtifactsPath(context as RuntimeArtifactsContext);
    },
    // Resolves the root runtime-artifacts directory for a configuration path.
    rootDir(configDir): string {
      return runtimeArtifactsRootDir(configDir);
    },
    // Lists metadata for saved (successful/preserved) runtime artifact runs.
    listSaved(configDir): ArtifactRunMetadata[] {
      return listSavedRuntimeArtifacts(configDir);
    },
    // Lists metadata for runs currently tracked in the failed artifacts area.
    listFailed(configDir): ArtifactRunMetadata[] {
      return listFailedRuntimeArtifacts(configDir);
    },
    // Returns metadata for the latest saved runtime artifact run.
    latest(configDir): ArtifactRunMetadata | null {
      return latestSavedRuntimeArtifact(configDir);
    },
    // Finds metadata for a specific saved run by run identifier.
    find(runId, configDir): ArtifactRunMetadata | null {
      return findSavedRuntimeArtifact(runId, configDir);
    },
    // Removes all saved runtime artifacts and returns the removed count.
    removeSaved(configDir): number {
      return removeSavedRuntimeArtifacts(configDir);
    },
    // Removes all failed runtime artifacts and returns the removed count.
    removeFailed(configDir): number {
      return removeFailedRuntimeArtifacts(configDir);
    },
    // Indicates whether a status should be treated as a failed artifact state.
    isFailedStatus(status: ArtifactStoreStatus | undefined): boolean {
      return isFailedRuntimeArtifactStatus(status);
    },
  };
}
