import type { ParsedWorkerPattern } from "../../domain/worker-pattern.js";
import type { CliApp } from "../cli-app-init.js";

export interface RunRootTuiOptions {
  app?: CliApp;
  workerPattern?: ParsedWorkerPattern;
  cliVersion?: string;
  argv?: string[];
}

export interface CreateSceneRouterStateOptions {
  currentWorkingDirectory?: string;
}

export interface RootWorkspaceState {
  isEmptyBootstrap: boolean;
  hasWorkersConfigured: boolean;
}

export interface SceneRouterState {
  sceneId: string;
  sceneStack: string[];
  showHelpOverlay: boolean;
  mainMenuHint: string;
  mainMenuState: {
    selectedIndex: number;
    variant: "initialized" | "emptyBootstrap";
  };
  continueUiState: "previewing" | "running" | "done";
  continueSceneState: unknown;
  runState: unknown;
  workersSceneState: unknown;
  healthSceneState: unknown;
  toolsSceneState: unknown;
  toolsBuiltInsVisibilitySession: unknown;
  profilesSceneState: unknown;
  settingsSceneState: unknown;
  helpSceneState: unknown;
  newWorkSceneState: unknown;
  agentSessionPending: boolean;
  workersActionPending: boolean;
  healthActionPending: boolean;
  toolsActionPending: boolean;
  settingsActionPending: boolean;
  profilesActionPending: boolean;
  helpActionPending: boolean;
  startActionPending: boolean;
  rootWorkspaceState: RootWorkspaceState;
}

export function createSceneRouterState(options?: CreateSceneRouterStateOptions): SceneRouterState;

export function runMainMenuStartAction(options: {
  state: SceneRouterState;
  app: unknown;
  currentWorkingDirectory: string;
  refreshStatuses?: () => Promise<void>;
}): Promise<void>;

export function runRootTui(options?: RunRootTuiOptions): Promise<number>;
