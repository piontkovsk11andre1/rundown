import { spawn } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

export const RUNDOWN_MCP_TOOL_NAMES = [
  "rundown_cli",
  "rundown_next",
  "rundown_list",
  "rundown_run",
  "rundown_all",
  "rundown_call",
  "rundown_loop",
  "rundown_plan",
  "rundown_make",
  "rundown_add",
  "rundown_do",
  "rundown_materialize",
  "rundown_discuss",
  "rundown_reverify",
  "rundown_undo",
  "rundown_artifacts",
  "rundown_log",
  "rundown_config_get",
  "rundown_config_list",
  "rundown_config_path",
  "rundown_config_set",
  "rundown_config_unset",
  "rundown_config_validate",
  "rundown_memory_view",
  "rundown_memory_validate",
  "rundown_memory_clean",
  "rundown_worker_health",
  "rundown_worker_status",
  "rundown_worker_reset",
  "rundown_unlock",
  "rundown_init",
  "rundown_localize",
  "rundown_with",
] as const;

type RundownMcpToolName = typeof RUNDOWN_MCP_TOOL_NAMES[number];

interface RundownCliResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

interface ToolExecutionResult extends RundownCliResult {
  command: "rundown";
  args: string[];
  cwd?: string;
}

const sortModeSchema = z.enum(["name-sort", "none", "old-first", "new-first"]);
const modeSchema = z.enum(["wait", "tui", "detached"]);
const commitModeSchema = z.enum(["per-task", "file-done"]);
const configReadScopeSchema = z.enum(["effective", "local", "global"]);
const configWriteScopeSchema = z.enum(["local", "global"]);
const configValueTypeSchema = z.enum(["auto", "string", "number", "boolean", "json"]);

const commonShape = {
  cwd: z.string().optional().describe("Working directory for the rundown process."),
  configDir: z.string().optional().describe("Forwarded as global --config-dir."),
  extraArgs: z.array(z.string()).optional().describe("Additional raw rundown CLI arguments appended before worker separator args."),
};

const workerShape = {
  workerPattern: z.string().optional().describe("Forwarded as --worker <pattern>."),
  worker: z.array(z.string()).optional().describe("Worker argv forwarded after --, for example ['opencode', 'run']."),
};

const runOptionsShape = {
  mode: modeSchema.optional(),
  sort: sortModeSchema.optional(),
  verify: z.boolean().optional(),
  onlyVerify: z.boolean().optional(),
  forceExecute: z.boolean().optional(),
  forceAttempts: z.number().int().nonnegative().optional(),
  noRepair: z.boolean().optional(),
  repairAttempts: z.number().int().nonnegative().optional(),
  resolveRepairAttempts: z.number().int().nonnegative().optional(),
  dryRun: z.boolean().optional(),
  printPrompt: z.boolean().optional(),
  keepArtifacts: z.boolean().optional(),
  trace: z.boolean().optional(),
  traceStats: z.boolean().optional(),
  traceOnly: z.boolean().optional(),
  varsFile: z.string().optional(),
  vars: z.record(z.string(), z.string()).optional(),
  commit: z.boolean().optional(),
  commitMessage: z.string().optional(),
  commitMode: commitModeSchema.optional(),
  revertable: z.boolean().optional(),
  onComplete: z.string().optional(),
  onFail: z.string().optional(),
  showAgentOutput: z.boolean().optional(),
  verbose: z.boolean().optional(),
  quiet: z.boolean().optional(),
  all: z.boolean().optional(),
  redo: z.boolean().optional(),
  resetAfter: z.boolean().optional(),
  clean: z.boolean().optional(),
  rounds: z.number().int().positive().optional(),
  compactBeforeExit: z.boolean().optional(),
  forceUnlock: z.boolean().optional(),
  ignoreCliBlock: z.boolean().optional(),
  cacheCliBlocks: z.boolean().optional(),
  cliBlockTimeoutMs: z.number().int().nonnegative().optional(),
  ...workerShape,
};

const planOptionsShape = {
  scanCount: z.number().int().positive().optional(),
  maxItems: z.number().int().nonnegative().optional(),
  deep: z.number().int().nonnegative().optional(),
  loop: z.boolean().optional(),
  mode: z.enum(["wait"]).optional(),
  dryRun: z.boolean().optional(),
  printPrompt: z.boolean().optional(),
  keepArtifacts: z.boolean().optional(),
  showAgentOutput: z.boolean().optional(),
  verbose: z.boolean().optional(),
  quiet: z.boolean().optional(),
  trace: z.boolean().optional(),
  forceUnlock: z.boolean().optional(),
  varsFile: z.string().optional(),
  vars: z.record(z.string(), z.string()).optional(),
  ignoreCliBlock: z.boolean().optional(),
  cliBlockTimeoutMs: z.number().int().nonnegative().optional(),
  ...workerShape,
};

export function createRundownMcpServer(version = "0.0.0"): McpServer {
  const server = new McpServer({ name: "rundown", version });

  registerCliTool(
    server,
    "rundown_cli",
    "Run any rundown CLI argv array. Use named tools where possible; this is an escape hatch for new or uncommon commands.",
    z.object({
      ...commonShape,
      args: z.array(z.string()).describe("Arguments passed to the real rundown executable."),
    }),
    (input) => input.args,
  );

  registerCliTool(server, "rundown_next", "Show the next unchecked task without executing it.", z.object({
    ...commonShape,
    source: z.string(),
    sort: sortModeSchema.optional(),
  }), (input) => withExtra(["next", input.source, ...option("--sort", input.sort)], input));

  registerCliTool(server, "rundown_list", "List tasks across a source.", z.object({
    ...commonShape,
    source: z.string(),
    sort: sortModeSchema.optional(),
    all: z.boolean().optional(),
  }), (input) => withExtra(["list", input.source, ...option("--sort", input.sort), ...flag("--all", input.all)], input));

  registerRunLikeTool(server, "rundown_run", "Execute the next unchecked task or an all-task run.", "run");
  registerRunLikeTool(server, "rundown_all", "Run all unchecked tasks sequentially.", "all", { forceAll: false });
  registerRunLikeTool(server, "rundown_call", "Run a clean all-task pass with CLI block caching.", "call", { forceAll: false });
  registerRunLikeTool(server, "rundown_loop", "Run repeated clean call passes.", "loop", {
    extraShape: {
      iterations: z.number().int().positive().optional(),
      timeLimitSeconds: z.number().int().positive().optional(),
      cooldownSeconds: z.number().int().nonnegative().optional(),
      continueOnError: z.boolean().optional(),
    },
    extraArgs: (input) => [
      ...option("--iterations", input.iterations),
      ...option("--time-limit", input.timeLimitSeconds),
      ...option("--cooldown", input.cooldownSeconds),
      ...flag("--continue-on-error", input.continueOnError),
    ],
  });

  registerCliTool(server, "rundown_plan", "Synthesize actionable TODOs for a Markdown document.", z.object({
    ...commonShape,
    markdownFile: z.string(),
    ...planOptionsShape,
  }), (input) => withExtra(withWorker(["plan", input.markdownFile, ...buildPlanOptions(input)], input), input));

  registerPlanCompositeTool(server, "rundown_make", "Create a Markdown task doc from seed text, then run plan.", "make");
  registerPlanCompositeTool(server, "rundown_add", "Append seed text to an existing Markdown task doc, then run plan.", "add", { includeDeep: true });
  registerPlanCompositeTool(server, "rundown_do", "Bootstrap with make, then execute all tasks against the same Markdown file.", "do", { includeRunOptions: true });

  registerRunLikeTool(server, "rundown_materialize", "Run all tasks, then record implementation snapshot history.", "materialize", {
    extraShape: { workspace: z.string().optional() },
    extraArgs: (input) => option("--workspace", input.workspace),
  });

  registerCliTool(server, "rundown_discuss", "Start an interactive discussion session for a Markdown file.", z.object({
    ...commonShape,
    ...workerShape,
    file: z.string(),
    mode: z.enum(["wait", "tui"]).optional(),
    printPrompt: z.boolean().optional(),
    keepArtifacts: z.boolean().optional(),
    showAgentOutput: z.boolean().optional(),
    trace: z.boolean().optional(),
    forceUnlock: z.boolean().optional(),
  }), (input) => withExtra(withWorker([
    "discuss",
    input.file,
    ...option("--mode", input.mode),
    ...flag("--print-prompt", input.printPrompt),
    ...flag("--keep-artifacts", input.keepArtifacts),
    ...flag("--show-agent-output", input.showAgentOutput),
    ...flag("--trace", input.trace),
    ...flag("--force-unlock", input.forceUnlock),
  ], input), input));

  registerCliTool(server, "rundown_reverify", "Re-run verification for the previously completed task from saved artifacts.", z.object({
    ...commonShape,
    run: z.string().optional(),
    showAgentOutput: z.boolean().optional(),
    keepArtifacts: z.boolean().optional(),
    dryRun: z.boolean().optional(),
  }), (input) => withExtra([
    "reverify",
    ...option("--run", input.run),
    ...flag("--show-agent-output", input.showAgentOutput),
    ...flag("--keep-artifacts", input.keepArtifacts),
    ...flag("--dry-run", input.dryRun),
  ], input));

  registerCliTool(server, "rundown_undo", "Undo completed task runs using AI-generated reversal steps.", z.object({
    ...commonShape,
    ...workerShape,
    run: z.string().optional(),
    last: z.number().int().positive().optional(),
    force: z.boolean().optional(),
    commit: z.boolean().optional(),
    dryRun: z.boolean().optional(),
    keepArtifacts: z.boolean().optional(),
    showAgentOutput: z.boolean().optional(),
  }), (input) => withExtra(withWorker([
    "undo",
    ...option("--run", input.run),
    ...option("--last", input.last),
    ...flag("--force", input.force),
    ...flag("--commit", input.commit),
    ...flag("--dry-run", input.dryRun),
    ...flag("--keep-artifacts", input.keepArtifacts),
    ...flag("--show-agent-output", input.showAgentOutput),
  ], input), input));

  registerCliTool(server, "rundown_artifacts", "List, clean, filter, or open saved runtime artifacts.", z.object({
    ...commonShape,
    clean: z.boolean().optional(),
    json: z.boolean().optional(),
    failed: z.boolean().optional(),
    open: z.string().optional(),
  }), (input) => withExtra(["artifacts", ...flag("--clean", input.clean), ...flag("--json", input.json), ...flag("--failed", input.failed), ...option("--open", input.open)], input));

  registerCliTool(server, "rundown_log", "Show completed run history.", z.object({
    ...commonShape,
    revertable: z.boolean().optional(),
    command: z.string().optional(),
    limit: z.number().int().positive().optional(),
    json: z.boolean().optional(),
  }), (input) => withExtra(["log", ...flag("--revertable", input.revertable), ...option("--command", input.command), ...option("--limit", input.limit), ...flag("--json", input.json)], input));

  registerConfigTools(server);
  registerMemoryTools(server);
  registerWorkerTools(server);

  registerCliTool(server, "rundown_unlock", "Manually release a stale source lockfile.", z.object({ ...commonShape, source: z.string() }), (input) => withExtra(["unlock", input.source], input));

  registerCliTool(server, "rundown_init", "Create a .rundown configuration directory with default templates.", z.object({
    ...commonShape,
    language: z.string().optional(),
    defaultWorker: z.string().optional(),
    interactiveWorker: z.string().optional(),
    overwriteConfig: z.boolean().optional(),
    gitignore: z.boolean().optional(),
  }), (input) => withExtra([
    "init",
    ...option("--language", input.language),
    ...option("--default-worker", input.defaultWorker),
    ...option("--interactive-worker", input.interactiveWorker),
    ...flag("--overwrite-config", input.overwriteConfig),
    ...flag("--gitignore", input.gitignore),
  ], input));

  registerCliTool(server, "rundown_localize", "Localize .rundown templates and locale intent aliases.", z.object({ ...commonShape, language: z.string().optional() }), (input) => withExtra(["localize", ...option("--language", input.language)], input));
  registerCliTool(server, "rundown_with", "Configure worker settings for a known provider preset.", z.object({ ...commonShape, provider: z.string(), worker: z.array(z.string()).optional() }), (input) => withExtra(withWorker(["with", input.provider], input), input));

  return server;
}

function registerRunLikeTool(
  server: McpServer,
  name: RundownMcpToolName,
  description: string,
  command: string,
  options: {
    forceAll?: boolean;
    extraShape?: z.ZodRawShape;
    extraArgs?: (input: Record<string, unknown>) => string[];
  } = {},
): void {
  registerCliTool(server, name, description, z.object({
    ...commonShape,
    source: z.string(),
    ...runOptionsShape,
    ...(options.extraShape ?? {}),
  }), (input) => withExtra(withWorker([
    command,
    input.source,
    ...buildRunOptions({ ...input, all: options.forceAll ? true : input.all }),
    ...(options.extraArgs?.(input) ?? []),
  ], input), input));
}

function registerPlanCompositeTool(
  server: McpServer,
  name: RundownMcpToolName,
  description: string,
  command: string,
  options: { includeDeep?: boolean; includeRunOptions?: boolean } = {},
): void {
  registerCliTool(server, name, description, z.object({
    ...commonShape,
    seedText: z.string(),
    markdownFile: z.string(),
    ...planOptionsShape,
    ...(options.includeRunOptions ? runOptionsShape : {}),
  }), (input) => withExtra(withWorker([
    command,
    input.seedText,
    input.markdownFile,
    ...buildPlanOptions(options.includeDeep ? input : { ...input, deep: undefined }),
    ...(options.includeRunOptions ? buildRunOptions(input) : []),
  ], input), input));
}

function registerConfigTools(server: McpServer): void {
  registerCliTool(server, "rundown_config_get", "Read one config value by dotted key path.", z.object({
    ...commonShape,
    key: z.string(),
    scope: configReadScopeSchema.optional(),
    json: z.boolean().optional(),
    showSource: z.boolean().optional(),
  }), (input) => withExtra(["config", "get", input.key, ...option("--scope", input.scope), ...flag("--json", input.json), ...flag("--show-source", input.showSource)], input));

  registerCliTool(server, "rundown_config_list", "List config keys/values for a scope.", z.object({
    ...commonShape,
    scope: configReadScopeSchema.optional(),
    json: z.boolean().optional(),
    showSource: z.boolean().optional(),
  }), (input) => withExtra(["config", "list", ...option("--scope", input.scope), ...flag("--json", input.json), ...flag("--show-source", input.showSource)], input));

  registerCliTool(server, "rundown_config_path", "Print the resolved config file path for a scope.", z.object({ ...commonShape, scope: configReadScopeSchema.optional() }), (input) => withExtra(["config", "path", ...option("--scope", input.scope)], input));
  registerCliTool(server, "rundown_config_set", "Set a config value by dotted key path.", z.object({
    ...commonShape,
    key: z.string(),
    value: z.string(),
    scope: configWriteScopeSchema.optional(),
    type: configValueTypeSchema.optional(),
    unsafe: z.boolean().optional(),
  }), (input) => withExtra(["config", "set", input.key, input.value, ...option("--scope", input.scope), ...option("--type", input.type), ...flag("--unsafe", input.unsafe)], input));
  registerCliTool(server, "rundown_config_unset", "Remove a config value by dotted key path.", z.object({ ...commonShape, key: z.string(), scope: configWriteScopeSchema.optional() }), (input) => withExtra(["config", "unset", input.key, ...option("--scope", input.scope)], input));
  registerCliTool(server, "rundown_config_validate", "Validate config JSON and known rundown config values for a scope.", z.object({ ...commonShape, scope: configReadScopeSchema.optional(), json: z.boolean().optional() }), (input) => withExtra(["config", "validate", ...option("--scope", input.scope), ...flag("--json", input.json)], input));
}

function registerMemoryTools(server: McpServer): void {
  registerCliTool(server, "rundown_memory_view", "Display memory entries for a source.", z.object({ ...commonShape, source: z.string(), json: z.boolean().optional(), summary: z.boolean().optional(), all: z.boolean().optional() }), (input) => withExtra(["memory-view", input.source, ...flag("--json", input.json), ...flag("--summary", input.summary), ...flag("--all", input.all)], input));
  registerCliTool(server, "rundown_memory_validate", "Check memory consistency and report issues.", z.object({ ...commonShape, source: z.string(), fix: z.boolean().optional(), json: z.boolean().optional() }), (input) => withExtra(["memory-validate", input.source, ...flag("--fix", input.fix), ...flag("--json", input.json)], input));
  registerCliTool(server, "rundown_memory_clean", "Remove orphaned, outdated, or invalid memory.", z.object({
    ...commonShape,
    source: z.string(),
    dryRun: z.boolean().optional(),
    orphans: z.boolean().optional(),
    outdated: z.boolean().optional(),
    olderThan: z.string().optional(),
    all: z.boolean().optional(),
    force: z.boolean().optional(),
  }), (input) => withExtra(["memory-clean", input.source, ...flag("--dry-run", input.dryRun), ...flag("--orphans", input.orphans), ...flag("--outdated", input.outdated), ...option("--older-than", input.olderThan), ...flag("--all", input.all), ...flag("--force", input.force)], input));
}

function registerWorkerTools(server: McpServer): void {
  registerCliTool(server, "rundown_worker_health", "Display or reset worker health state.", z.object({ ...commonShape, json: z.boolean().optional(), reset: z.string().optional(), resetAll: z.boolean().optional() }), (input) => withExtra(["worker-health", ...flag("--json", input.json), ...option("--reset", input.reset), ...flag("--reset-all", input.resetAll)], input));
  registerCliTool(server, "rundown_worker_status", "Show worker/profile status, eligibility, and fallback order.", z.object({ ...commonShape, json: z.boolean().optional() }), (input) => withExtra(["worker", "status", ...flag("--json", input.json)], input));
  registerCliTool(server, "rundown_worker_reset", "Reset worker/profile status so blocked workers can be selected again.", z.object({ ...commonShape, key: z.string().optional(), all: z.boolean().optional(), json: z.boolean().optional() }), (input) => withExtra(["worker", "reset", ...positional(input.key), ...flag("--all", input.all), ...flag("--json", input.json)], input));
}

function registerCliTool<T extends z.ZodRawShape>(
  server: McpServer,
  name: RundownMcpToolName,
  description: string,
  inputSchema: z.ZodObject<T>,
  buildArgs: (input: z.infer<z.ZodObject<T>>) => string[],
): void {
  server.registerTool(name, { description, inputSchema }, async (input) => {
    const typedInput = input as z.infer<z.ZodObject<T>>;
    const args = withGlobalOptions(buildArgs(typedInput), typedInput as Record<string, unknown>);
    const result = await runRundownCli(args, stringValue((typedInput as Record<string, unknown>).cwd));
    const structuredContent: ToolExecutionResult = {
      command: "rundown",
      args,
      cwd: stringValue((typedInput as Record<string, unknown>).cwd),
      ...result,
    };

    return {
      content: [{ type: "text", text: formatToolResult(structuredContent) }],
      structuredContent,
    };
  });
}

function buildRunOptions(input: Record<string, unknown>): string[] {
  return [
    ...option("--mode", input.mode),
    ...option("--sort", input.sort),
    ...booleanOption("--verify", input.verify),
    ...flag("--only-verify", input.onlyVerify),
    ...flag("--force-execute", input.forceExecute),
    ...option("--force-attempts", input.forceAttempts),
    ...flag("--no-repair", input.noRepair),
    ...option("--repair-attempts", input.repairAttempts),
    ...option("--resolve-repair-attempts", input.resolveRepairAttempts),
    ...flag("--dry-run", input.dryRun),
    ...flag("--print-prompt", input.printPrompt),
    ...flag("--keep-artifacts", input.keepArtifacts),
    ...flag("--trace", input.trace),
    ...flag("--trace-stats", input.traceStats),
    ...flag("--trace-only", input.traceOnly),
    ...option("--vars-file", input.varsFile),
    ...varOptions(input.vars),
    ...flag("--commit", input.commit),
    ...option("--commit-message", input.commitMessage),
    ...option("--commit-mode", input.commitMode),
    ...flag("--revertable", input.revertable),
    ...option("--on-complete", input.onComplete),
    ...option("--on-fail", input.onFail),
    ...flag("--show-agent-output", input.showAgentOutput),
    ...flag("--verbose", input.verbose),
    ...flag("--quiet", input.quiet),
    ...flag("--all", input.all),
    ...flag("--redo", input.redo),
    ...flag("--reset-after", input.resetAfter),
    ...flag("--clean", input.clean),
    ...option("--rounds", input.rounds),
    ...flag("--compact-before-exit", input.compactBeforeExit),
    ...flag("--force-unlock", input.forceUnlock),
    ...flag("--ignore-cli-block", input.ignoreCliBlock),
    ...flag("--cache-cli-blocks", input.cacheCliBlocks),
    ...option("--cli-block-timeout", input.cliBlockTimeoutMs),
  ];
}

function buildPlanOptions(input: Record<string, unknown>): string[] {
  return [
    ...option("--scan-count", input.scanCount),
    ...option("--max-items", input.maxItems),
    ...option("--deep", input.deep),
    ...flag("--loop", input.loop),
    ...option("--mode", input.mode),
    ...flag("--dry-run", input.dryRun),
    ...flag("--print-prompt", input.printPrompt),
    ...flag("--keep-artifacts", input.keepArtifacts),
    ...flag("--show-agent-output", input.showAgentOutput),
    ...flag("--verbose", input.verbose),
    ...flag("--quiet", input.quiet),
    ...flag("--trace", input.trace),
    ...flag("--force-unlock", input.forceUnlock),
    ...option("--vars-file", input.varsFile),
    ...varOptions(input.vars),
    ...flag("--ignore-cli-block", input.ignoreCliBlock),
    ...option("--cli-block-timeout", input.cliBlockTimeoutMs),
  ];
}

function withGlobalOptions(args: string[], input: Record<string, unknown>): string[] {
  return [...option("--config-dir", input.configDir), ...args];
}

function withWorker(args: string[], input: Record<string, unknown>): string[] {
  const workerPattern = stringValue(input.workerPattern);
  const worker = Array.isArray(input.worker) ? input.worker.filter((value): value is string => typeof value === "string") : [];
  return [
    ...args,
    ...option("--worker", workerPattern),
    ...(worker.length > 0 ? ["--", ...worker] : []),
  ];
}

function withExtra(args: string[], input: Record<string, unknown>): string[] {
  const extraArgs = Array.isArray(input.extraArgs) ? input.extraArgs.filter((value): value is string => typeof value === "string") : [];
  if (extraArgs.length === 0) {
    return args;
  }

  const separatorIndex = args.indexOf("--");
  if (separatorIndex === -1) {
    return [...args, ...extraArgs];
  }

  return [...args.slice(0, separatorIndex), ...extraArgs, ...args.slice(separatorIndex)];
}

function flag(name: string, value: unknown): string[] {
  return value === true ? [name] : [];
}

function booleanOption(name: string, value: unknown): string[] {
  if (value === true) {
    return [name];
  }
  if (value === false) {
    return ["--no-" + name.slice(2)];
  }
  return [];
}

function option(name: string, value: unknown): string[] {
  if (typeof value === "string" && value.length > 0) {
    return [name, value];
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return [name, String(value)];
  }
  return [];
}

function positional(value: unknown): string[] {
  return typeof value === "string" && value.length > 0 ? [value] : [];
}

function varOptions(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [];
  }

  return Object.entries(value).flatMap(([key, entryValue]) => ["--var", `${key}=${entryValue}`]);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function runRundownCli(args: string[], cwd: string | undefined): Promise<RundownCliResult> {
  return new Promise((resolve) => {
    const child = spawn("rundown", args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("close", (exitCode) => {
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf-8"),
        stderr: Buffer.concat(stderr).toString("utf-8"),
      });
    });
    child.on("error", (error) => {
      resolve({
        exitCode: 1,
        stdout: Buffer.concat(stdout).toString("utf-8"),
        stderr: error.message,
      });
    });
  });
}

function formatToolResult(result: ToolExecutionResult): string {
  const lines = [
    `$ ${[result.command, ...result.args].join(" ")}`,
    `exitCode: ${result.exitCode ?? "null"}`,
  ];

  if (result.stdout.length > 0) {
    lines.push("", "stdout:", result.stdout.trimEnd());
  }
  if (result.stderr.length > 0) {
    lines.push("", "stderr:", result.stderr.trimEnd());
  }

  return lines.join("\n");
}
