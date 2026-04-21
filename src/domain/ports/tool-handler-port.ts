import type { Task } from "../parser.js";
import type { FileSystem } from "./file-system.js";
import type { PathOperationsPort } from "./path-operations-port.js";
import type { ApplicationOutputPort } from "./output-port.js";
import type { WorkerExecutorPort } from "./worker-executor-port.js";
import type { ArtifactRunContext, CommandExecutionOptions } from "./index.js";
import type { TemplateVars } from "../template.js";
import type { ParsedWorkerPattern } from "../worker-pattern.js";
import type { TerminalStopSignal } from "../terminal-control.js";
import type { LocaleMessages } from "../locale.js";

/**
 * Classifies how a tool participates in the prefix chain.
 *
 * - `"modifier"` adjusts context (profile, variables) then passes through.
 * - `"handler"` performs the terminal action for the task.
 */
export type ToolKind = "modifier" | "handler";

/**
 * Behavioral flags that can be declared via YAML frontmatter in `.md` tools
 * or via `config.json` tool overrides.
 */
export interface ToolFrontmatter {
  kind?: ToolKind;
  skipExecution?: boolean;
  shouldVerify?: boolean;
  autoComplete?: boolean;
  insertChildren?: boolean;
  profile?: string;
}

/**
 * Context modifications returned by modifier tools.
 */
export interface ToolContextModifications {
  profile?: string;
  workerArgs?: string[];
  templateVars?: Record<string, string>;
}

/**
 * Result returned by a tool handler after execution.
 */
export interface ToolHandlerResult {
  skipExecution?: boolean;
  shouldVerify?: boolean;
  forLoopItems?: string[];
  skipRemainingSiblings?: {
    reason: string;
  };
  /**
   * Explicit terminal-control intent flags.
   *
   * These fields allow handlers to signal run-stop and loop-stop intent
   * independently of sibling-skip semantics.
   */
  stopRun?: boolean;
  stopLoop?: boolean;
  childTasks?: string[];
  contextModifications?: ToolContextModifications;
  childFile?: string;
  exitCode?: number;
  failureMessage?: string;
  failureReason?: string;
  terminalStop?: TerminalStopSignal;
}

/**
 * Runtime context provided to tool handlers during execution.
 */
export interface ToolHandlerContext {
  task: Task;
  allTasks?: Task[];
  payload: string;
  source: string;
  contextBefore: string;
  fileSystem: FileSystem;
  pathOperations: PathOperationsPort;
  emit: (event: Parameters<ApplicationOutputPort["emit"]>[0]) => void;
  configDir?: string;
  workerExecutor: WorkerExecutorPort;
  workerPattern: ParsedWorkerPattern;
  workerCommand: string[];
  mode: string;
  trace: boolean;
  cwd: string;
  executionEnv?: Record<string, string>;
  artifactContext: ArtifactRunContext;
  keepArtifacts: boolean;
  templateVars: TemplateVars;
  showAgentOutput: boolean;
  localeMessages?: LocaleMessages;
  templates?: {
    researchOutputContract: string;
  };
}

/**
 * Function signature for JavaScript tool handlers loaded via `import()`.
 */
export type ToolHandlerFn = (context: ToolHandlerContext) => Promise<ToolHandlerResult>;
