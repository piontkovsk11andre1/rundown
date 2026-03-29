export type ArtifactStoreStatus =
  | "running"
  | "completed"
  | "failed"
  | "detached"
  | "execution-failed"
  | "verification-failed"
  | "reverify-completed"
  | "reverify-failed"
  | "reverted"
  | "revert-failed"
  | "metadata-missing"
  | "discuss-completed"
  | "discuss-cancelled";

export type ArtifactStorePhase = "execute" | "verify" | "repair" | "plan" | "discuss" | "inline-cli" | "worker";

export interface ArtifactTaskMetadata {
  text: string;
  file: string;
  line: number;
  index: number;
  source: string;
}

export interface ArtifactRunContext {
  runId: string;
  rootDir: string;
  cwd: string;
  keepArtifacts: boolean;
  commandName: string;
  workerCommand?: string[];
  mode?: string;
  transport?: string;
  task?: ArtifactTaskMetadata;
}

export interface ArtifactPhaseHandle {
  context: ArtifactRunContext;
  phase: ArtifactStorePhase;
  sequence: number;
  dir: string;
  promptFile: string | null;
}

export interface ArtifactRunMetadata {
  runId: string;
  rootDir: string;
  relativePath: string;
  commandName: string;
  workerCommand?: string[];
  mode?: string;
  transport?: string;
  source?: string;
  task?: ArtifactTaskMetadata;
  keepArtifacts: boolean;
  startedAt: string;
  completedAt?: string;
  status?: ArtifactStoreStatus;
  extra?: Record<string, unknown>;
}

export interface ArtifactStore {
  createContext(options: {
    cwd?: string;
    commandName: string;
    workerCommand?: string[];
    mode?: string;
    transport?: string;
    source?: string;
    task?: ArtifactTaskMetadata;
    keepArtifacts?: boolean;
  }): ArtifactRunContext;
  beginPhase(
    context: ArtifactRunContext,
    options: {
      phase: ArtifactStorePhase;
      prompt?: string;
      command?: string[];
      mode?: string;
      transport?: string;
      notes?: string;
      extra?: Record<string, unknown>;
    },
  ): ArtifactPhaseHandle;
  completePhase(
    handle: ArtifactPhaseHandle,
    options: {
      exitCode: number | null;
      stdout?: string;
      stderr?: string;
      outputCaptured: boolean;
      notes?: string;
      extra?: Record<string, unknown>;
    },
  ): void;
  finalize(
    context: ArtifactRunContext,
    options: { status: ArtifactStoreStatus; preserve?: boolean; extra?: Record<string, unknown> },
  ): void;
  displayPath(context: ArtifactRunContext): string;
  rootDir(cwd?: string): string;
  listSaved(cwd?: string): ArtifactRunMetadata[];
  listFailed(cwd?: string): ArtifactRunMetadata[];
  latest(cwd?: string): ArtifactRunMetadata | null;
  find(runId: string, cwd?: string): ArtifactRunMetadata | null;
  removeSaved(cwd?: string): number;
  removeFailed(cwd?: string): number;
  isFailedStatus(status: ArtifactStoreStatus | undefined): boolean;
}
