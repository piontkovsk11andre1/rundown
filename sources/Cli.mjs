import { resolve, relative } from "node:path";
import { formatDiagnostic } from "@p10i/do-md";
import { loadCommands, permits, discover } from "./Catalog.mjs";
import { Runtime } from "./Runtime.mjs";
import { CallbackHost } from "./Callbacks.mjs";
import { compileFile } from "./Compiler.mjs";
import { resolveDocument } from "./Loader.mjs";
import { diagnostic, diagnose, RundownError } from "./Error.mjs";
import { jsonText } from "./Validation.mjs";
import { initializeTelemetry } from "./Observability.mjs";
import { bounded } from "./Lifecycle.mjs";
import { View } from "./Views.mjs";
import { TerminalHost } from "./Terminal.mjs";

/** @param {string[]} argv @param {import('./InternalContracts.mjs').CliOptions} options */
function parse(argv, options) {
  let index = 0;
  const take = () => {
    if (argv[index + 1] === undefined || argv[index + 1].startsWith("--"))
      throw new RundownError(
        "RUNDOWN_CLI",
        `Missing value for ${argv[index]}`,
        { status: 400 },
      );
    return argv[++index];
  };
  for (; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith("--")) break;
    if (
      [
        "--serve",
        "--mcp",
        "--mcp-http",
        "--compile",
        "--init",
        "--new-command",
        "--new-module",
        "--connect",
        "--check",
        "--test",
        "--skill",
        "--reference",
      ].includes(arg)
    ) {
      if (options.mode !== "command")
        throw new RundownError(
          "RUNDOWN_CLI",
          "Built-in modes are mutually exclusive",
          { status: 400 },
        );
      options.mode =
        /** @type {import('./InternalContracts.mjs').CliOptions['mode']} */ (
          arg.slice(2)
        );
      if (
        [
          "--mcp-http",
          "--compile",
          "--new-command",
          "--new-module",
          "--connect",
        ].includes(arg)
      )
        options.target = take();
      if (
        ["--check", "--reference", "--test", "--init"].includes(arg) &&
        argv[index + 1] !== undefined &&
        !argv[index + 1].startsWith("--")
      )
        options.target = take();
      if (
        arg === "--init" &&
        options.target !== undefined &&
        argv[index + 1] !== undefined &&
        !argv[index + 1].startsWith("--")
      )
        options.tests = take();
    } else if (arg === "--commands") options.commands = take();
    else if (arg === "--cwd") options.cwd = resolve(take());
    else if (arg === "--bind") options.bind = take();
    else if (arg === "--port") {
      options.port = Number(take());
      if (
        !Number.isInteger(options.port) ||
        options.port < 0 ||
        options.port > 65535
      )
        throw new RundownError("RUNDOWN_CLI", "Invalid port", { status: 400 });
    } else if (arg === "--public-url") options.publicURL = take();
    else if (arg === "--out") options.outDir = take();
    else if (arg === "--grace-ms") {
      options.graceMs = Number(take());
      if (!Number.isFinite(options.graceMs) || options.graceMs < 0)
        throw new RundownError("RUNDOWN_CLI", "Invalid cleanup grace period", {
          status: 400,
        });
    } else if (arg === "--debug-dir")
      process.env.RUNDOWN_DEBUG_DIR = resolve(take());
    else if (arg === "--json-errors") options.jsonErrors = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--markdown") options.markdown = true;
    else if (arg === "--fullscreen") options.fullscreen = true;
    else if (arg === "--no-fullscreen") options.fullscreen = false;
    else if (arg === "--logs") {
      const logs = take();
      if (logs !== "show" && logs !== "hide")
        throw new RundownError("RUNDOWN_CLI", "--logs requires show or hide", {
          status: 400,
        });
      options.logs = logs;
    } else if (arg === "--format") {
      const format = take();
      if (!["markdown", "text", "json"].includes(format))
        throw new RundownError(
          "RUNDOWN_CLI",
          "Format must be markdown, text or json",
          { status: 400 },
        );
      options.format = /** @type {'markdown'|'text'|'json'} */ (format);
    } else if (arg === "--help") {
      options.help = true;
    } else
      throw new RundownError("RUNDOWN_CLI", `Unknown Rundown option: ${arg}`, {
        status: 400,
      });
  }
  return { ...options, command: argv[index], args: argv.slice(index + 1) };
}

/** @param {import('./types.mjs').Command} command @param {string[]} argv */
function cliArguments(command, argv) {
  /** @type {Record<string,unknown>} */
  const args = {};
  let position = 0;
  let literal = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!literal && token === "--") {
      literal = true;
      continue;
    }
    let parameter, value;
    if (!literal && token.startsWith("--")) {
      const [name, ...rest] = token.split("=");
      parameter = command.parameters.find((p) => p.cli === name);
      if (!parameter)
        throw new RundownError("RUNDOWN_ARGUMENTS", `Unknown option: ${name}`, {
          status: 400,
        });
      value = rest.length
        ? rest.join("=")
        : parameter.type === "boolean"
          ? "true"
          : argv[++i];
    } else {
      position++;
      parameter = command.parameters.find((p) => p.cli === String(position));
      value = token;
    }
    if (!parameter || value === undefined)
      throw new RundownError(
        "RUNDOWN_ARGUMENTS",
        "Unexpected or missing command argument",
        { status: 400 },
      );
    if (Object.hasOwn(args, parameter.name))
      throw new RundownError(
        "RUNDOWN_ARGUMENTS",
        `Repeated argument: ${parameter.name}`,
        { status: 400 },
      );
    if (["string", "path"].includes(parameter.type))
      args[parameter.name] = value;
    else {
      try {
        args[parameter.name] = JSON.parse(value);
      } catch {
        throw new RundownError(
          "RUNDOWN_ARGUMENTS",
          `Invalid ${parameter.type}: ${value}`,
          { status: 400 },
        );
      }
    }
  }
  return args;
}

const usage = [
  "Usage: rundown [options] <command> [arguments]",
  "       rundown --commands <catalog.md> <command> [arguments]",
  "       rundown --init <catalog.md> [test-file-or-directory]",
  "       rundown --new-command <name> [--out <directory>]",
  "       rundown --new-module <file.md>",
  "       rundown --connect <commands.md>",
  "       rundown --check [file.md] [--json]",
  "       rundown --test [file.test.md|directory] [--json]",
  "       rundown --skill | --reference [topic] [--format markdown|text|json]",
  "       rundown --serve | --mcp | --mcp-http <url>",
  "       rundown --compile <module.md> --out <directory>",
  "       rundown help [command]",
  "Options: --commands --cwd --bind --port --public-url --debug-dir --grace-ms --json-errors --json",
  "View output: --markdown --fullscreen --no-fullscreen --logs show|hide",
  "",
].join("\n");

/** Preserve actionable nested diagnostics in human output as well as JSON.
 * @param {import('./types.mjs').Diagnostic} value @param {number} [depth] @returns {string}
 */
function humanDiagnostic(value, depth = 0) {
  return (
    formatDiagnostic(value) +
    (depth < 5 && value.related?.length
      ? "\n\nRelated:\n" +
        value.related
          .map((error) => humanDiagnostic(error, depth + 1))
          .join("\n\n")
      : "")
  );
}

/** Built-ins work before project discovery and never initialize telemetry or run handlers.
 * @param {import('./InternalContracts.mjs').CliOptions&{command?:string,args:string[]}} options
 * @param {AbortSignal} signal @returns {Promise<number|null>}
 */
async function authoringMode(options, signal) {
  if (
    ![
      "init",
      "new-command",
      "new-module",
      "connect",
      "check",
      "skill",
      "reference",
    ].includes(options.mode)
  )
    return null;
  if (options.command)
    throw new RundownError(
      "RUNDOWN_CLI",
      `Unexpected argument for --${options.mode}: ${options.command}`,
      { status: 400 },
    );
  const authoring = await import("./Authoring.mjs");
  if (options.mode === "init" && options.target === undefined) {
    process.stdout.write(
      "Usage: rundown --init <catalog.md> [test-file-or-directory]\nRegister existing paths in the nearest package.json. No source files are generated.\n",
    );
    return 0;
  }
  if (options.mode === "skill") {
    const skill = await authoring.readSkill();
    process.stdout.write(options.json ? jsonText(skill) + "\n" : skill);
    return 0;
  }
  if (options.mode === "reference") {
    process.stdout.write(
      authoring.renderReference(
        options.target,
        options.json ? "json" : (options.format ?? "markdown"),
      ),
    );
    return 0;
  }
  if (options.mode === "check") {
    const checked = await authoring.checkProject({
      cwd: options.cwd,
      file: options.target,
      commands: options.commands,
      signal,
    });
    if (options.json)
      process.stdout.write(JSON.stringify(checked, null, 2) + "\n");
    else {
      process.stdout.write(
        `${checked.ok ? "Checked" : "Check failed:"} ${checked.files.length} Markdown document(s), ${checked.commands.length} command(s). No user code executed.\n`,
      );
      for (const error of checked.errors)
        process.stderr.write(humanDiagnostic(error) + "\n");
      if (checked.dynamicLoads.length)
        process.stdout.write(
          `Note: ${checked.dynamicLoads.length} loader expression(s) require runtime verification.\n` +
            checked.dynamicLoads
              .map(
                (load) =>
                  `  ${load.location.source}:${load.location.range.start.line}:${load.location.range.start.column} ${load.loader}: ${load.reason}`,
              )
              .join("\n") +
            "\n",
        );
    }
    return checked.ok ? 0 : 1;
  }
  const input = { cwd: options.cwd, commands: options.commands, signal };
  const result =
    options.mode === "init"
      ? await authoring.initProject(options.target ?? "", {
          cwd: options.cwd,
          tests: options.tests,
          signal,
        })
      : options.mode === "new-command"
        ? await authoring.newCommand(options.target ?? "", {
            ...input,
            outDir: options.outDir,
          })
        : options.mode === "connect"
          ? await authoring.connectCatalog(options.target ?? "", input)
          : await authoring.newModule(options.target ?? "", input);
  if (options.json)
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  else
    process.stdout.write(
      [
        ...result.created.map(
          (file) => `Created ${relative(options.cwd, file)}`,
        ),
        ...result.updated.map(
          (file) => `Updated ${relative(options.cwd, file)}`,
        ),
        "",
        `Next (from ${options.cwd}):`,
        ...result.next.map((command) => `  ${command}`),
        "",
      ].join("\n"),
    );
  return 0;
}

/** @param {import('./types.mjs').Command} command */
function commandHelp(command) {
  const parameters = command.parameters
    .map(
      (p) =>
        `  ${p.name}: ${p.type} (${p.required ? "required" : "optional"}${p.hasDefault ? `, default ${JSON.stringify(p.default)}` : ""})${p.cli ? ` [CLI: ${p.cli}]` : ""}\n    ${p.description}`,
    )
    .join("\n");
  return `${command.name}\n\n${command.description}\n\nParameters:\n${parameters || "  None."}\n\nReturns: ${command.returns.type} — ${command.returns.description}\nSurfaces: ${command.surfaces.join(", ")}\n`;
}

/** CLI owns process signals, optional SDK lifecycle and temporary listener cleanup.
 * @param {string[]} [argv] @returns {Promise<number>}
 */
export async function main(argv = process.argv.slice(2)) {
  /** @type {(import('./InternalContracts.mjs').CliOptions&{command?:string,args:string[]})|undefined} */
  let options = {
    cwd: process.cwd(),
    mode: /** @type {const} */ ("command"),
    bind: "127.0.0.1",
    port: 0,
    args: [],
  };
  /** @type {Runtime|undefined} */
  let runtime;
  /** @type {{close():Promise<void>,url?:string}|undefined} */
  let resource;
  /** @type {{close():Promise<void>}|undefined} */
  let telemetry;
  let deadline,
    exitCode = 130;
  const controller = new AbortController();
  let finish = () => {};
  const stopped = new Promise((resolve) => {
    finish = () => resolve(undefined);
  });
  const stop = () => {
    controller.abort();
    finish();
  };
  const interrupt = () => {
    stop();
    deadline ??= setTimeout(
      () => process.exit(exitCode),
      options?.graceMs ?? 5000,
    );
    deadline.unref();
  };
  const terminate = () => {
    exitCode = 143;
    interrupt();
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    options = parse(argv, options);
    if (options.commands !== undefined && options.mode === "init")
      throw new RundownError(
        "RUNDOWN_CLI",
        "--init registers package defaults; --commands selects a catalog for this invocation",
        { status: 400 },
      );
    if (options.json && options.markdown)
      throw new RundownError(
        "RUNDOWN_CLI",
        "--json and --markdown are mutually exclusive",
        { status: 400 },
      );
    if (options.markdown && options.mode !== "command")
      throw new RundownError(
        "RUNDOWN_CLI",
        "--markdown applies to command results",
        { status: 400 },
      );
    if (options.help) {
      process.stdout.write(usage);
      return 0;
    }
    if (options.format && options.mode !== "reference")
      throw new RundownError(
        "RUNDOWN_CLI",
        "--format applies to --reference; use --json for authoring results",
        { status: 400 },
      );
    const authored = await authoringMode(options, controller.signal);
    if (authored !== null)
      return controller.signal.aborted ? exitCode : authored;
    if (options.mode === "test") {
      if (options.command)
        throw new RundownError(
          "RUNDOWN_CLI",
          "Unexpected argument for --test",
          { status: 400 },
        );
      const report = await (
        await import("./TestRunner.mjs")
      ).runTests({
        cwd: options.cwd,
        file: options.target,
        signal: controller.signal,
        graceMs: options.graceMs,
        json: options.json,
      });
      return controller.signal.aborted ? exitCode : report.ok ? 0 : 1;
    }
    if (options.mode === "compile") {
      if (!options.target)
        throw new RundownError(
          "RUNDOWN_CLI",
          "--compile requires a module path",
          { status: 400 },
        );
      if (!options.outDir)
        throw new RundownError("RUNDOWN_CLI", "--compile requires --out", {
          status: 400,
        });
      const url = resolveDocument(options.target, { cwd: options.cwd });
      compileFile(url, { outDir: resolve(options.cwd, options.outDir) });
      return 0;
    }
    if (
      Object.keys(process.env).some((key) =>
        /^OTEL_(EXPORTER|TRACES_EXPORTER|LOGS_EXPORTER|METRICS_EXPORTER)/.test(
          key,
        ),
      )
    )
      telemetry = await initializeTelemetry();
    if (options.mode === "mcp-http") {
      if (!options.target)
        throw new RundownError("RUNDOWN_CLI", "--mcp-http requires a URL", {
          status: 400,
        });
      resource = await (await import("./Mcp.mjs")).startBridge(options.target);
      process.stdin.once("end", stop);
      await stopped;
      return 0;
    }
    if (
      options.mode === "command" &&
      (!options.command || (options.command === "help" && !options.args.length))
    ) {
      try {
        if (!options.commands) discover(options.cwd);
      } catch (cause) {
        if (diagnose(cause).code !== "RUNDOWN_DISCOVERY") throw cause;
        process.stdout.write(
          usage +
            "\nNo project catalog found. Register an existing catalog with rundown --init <catalog.md>, select --commands, or read rundown --skill.\n",
        );
        return 0;
      }
    }
    const catalog = await loadCommands(options.commands, {
      cwd: options.cwd,
      signal: controller.signal,
    });
    runtime = new Runtime(catalog, {
      cwd: options.cwd,
      callbackHost: new CallbackHost(options),
      graceMs: options.graceMs,
    });
    if (
      options.command === "help" ||
      (!options.command && options.mode === "command")
    ) {
      const selected = options.args[0];
      if (selected) {
        const command = catalog.commands.get(selected);
        if (!command || !permits(command, "cli"))
          throw new RundownError(
            "RUNDOWN_COMMAND_UNKNOWN",
            `Unknown command: ${selected}`,
            { status: 404 },
          );
        process.stdout.write(commandHelp(command));
      } else
        process.stdout.write(
          usage +
            "\n" +
            [...catalog.commands.values()]
              .filter((c) => permits(c, "cli"))
              .map((c) => `${c.name}\t${c.description}`)
              .join("\n") +
            "\n",
        );
      return 0;
    }
    if (options.mode === "serve") {
      resource = await (
        await import("./Http.mjs")
      ).startHttp({ runtime, ...options });
      process.stderr.write(`Rundown listening at ${resource.url}\n`);
      await stopped;
      return 0;
    }
    if (options.mode === "mcp") {
      resource = await (await import("./Mcp.mjs")).startStdio(runtime);
      process.stdin.once("end", stop);
      await stopped;
      return 0;
    }
    if (!options.command)
      throw new RundownError("RUNDOWN_CLI", "Expected a command name", {
        status: 400,
      });
    const command = catalog.commands.get(options.command);
    if (!command)
      throw new RundownError(
        "RUNDOWN_COMMAND_UNKNOWN",
        `Unknown command: ${options.command}`,
        { status: 404 },
      );
    const terminal = new TerminalHost(options);
    let result;
    /** @type {RundownError|undefined} */
    let invocationFailure;
    try {
      result = await runtime.invoke(
        command.name,
        cliArguments(command, options.args),
        { signal: controller.signal, onView: (view) => terminal.mount(view) },
      );
    } catch (error) {
      invocationFailure = diagnose(error);
      throw invocationFailure;
    } finally {
      terminal.close(invocationFailure);
    }
    if (result instanceof View) {
      if (options.json) process.stdout.write(jsonText(result.data) + "\n");
      else if (!terminal.interactive)
        process.stdout.write(result.render().replace(/\n?$/, "\n"));
      return 0;
    }
    if (options.markdown)
      throw new RundownError(
        "RUNDOWN_VIEW_EXPECTED",
        "--markdown requires a view result",
        { status: 400 },
      );
    if (result === undefined && !options.json) return 0;
    process.stdout.write(
      typeof result === "string" && !options.json
        ? result + "\n"
        : jsonText(result) + "\n",
    );
    return 0;
  } catch (error) {
    const failure = diagnose(error);
    process.stderr.write(
      options?.jsonErrors || options?.json
        ? JSON.stringify({
            ok: false,
            error: diagnostic(failure),
          }) + "\n"
        : humanDiagnostic(diagnostic(failure)) + "\n",
    );
    return controller.signal.aborted ? exitCode : 1;
  } finally {
    const cleanup = await bounded(
      Promise.allSettled([
        runtime?.close(),
        resource?.close(),
        telemetry?.close(),
      ]),
      options?.graceMs ?? 5000,
    );
    const failure = !cleanup.completed
      ? new RundownError(
          "RUNDOWN_CLEANUP_TIMEOUT",
          "CLI shutdown deadline expired",
        )
      : cleanup.value.find((value) => value.status === "rejected")?.reason;
    if (!controller.signal.aborted) clearTimeout(deadline);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    if (failure) {
      process.stderr.write(
        options?.json || options?.jsonErrors
          ? JSON.stringify({ ok: false, error: diagnostic(failure) }) + "\n"
          : humanDiagnostic(diagnostic(failure)) + "\n",
      );
      return controller.signal.aborted ? exitCode : 1;
    }
  }
}
