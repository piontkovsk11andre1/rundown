import { lstat, mkdir, readFile, realpath, stat } from "node:fs/promises";
import {
  dirname,
  join,
  relative,
  resolve,
  basename,
  extname,
  sep,
  isAbsolute,
} from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { Editor, NodeFilesystem, Template, Writer } from "@p10i/do-md";
import { parseMarkdown } from "@p10i/do-md/markdown";
import { COLUMNS } from "./Format.mjs";
import { compile, parseDocument } from "./Compiler.mjs";
import { discover } from "./Catalog.mjs";
import { checkProject } from "./Check.mjs";
import { resolveDocument } from "./Loader.mjs";
import { parsePackage, findProject } from "./Project.mjs";
import { documentURL, isPackageSpecifier } from "./Paths.mjs";
import {
  RundownError,
  diagnose,
  unavailableLocation,
  fileFailure,
} from "./Error.mjs";

const io = new NodeFilesystem();
/** @param {string} cwd */
async function projectDirectory(cwd) {
  try {
    const root = await realpath(cwd);
    if (!(await stat(root)).isDirectory())
      throw new RundownError(
        "RUNDOWN_AUTHORING",
        "--cwd must name an existing directory",
        { status: 400 },
      );
    return root;
  } catch (cause) {
    if (cause instanceof RundownError) throw cause;
    throw fileFailure(cause, pathToFileURL(resolve(cwd)).href);
  }
}

/** Package exports are read sources; generated commands connect through a local catalog.
 * @param {string} cwd @param {string|URL} [commands]
 */
function localCatalog(cwd, commands) {
  const selected = commands ?? findProject(cwd).manifest.rundown?.commands;
  if (typeof selected === "string" && isPackageSpecifier(selected))
    throw new RundownError(
      "RUNDOWN_AUTHORING",
      "Select a local catalog for authoring and connect packaged catalogs through Connections",
      { status: 400 },
    );
}

/** @param {'command'|'module'|'connections'} name @param {Record<string,unknown>} data */
async function render(name, data) {
  const url = new URL(
    `../templates/starters/${name}.md.template`,
    import.meta.url,
  );
  const writer = new Writer(data);
  Template.compile(await readFile(url, "utf8"), { file: url.href }).execute(
    writer,
    writer.context,
    data,
  );
  return writer.toMarkdown();
}
/** @param {readonly string[]} headers @param {string[][]} rows */
const table = (headers, rows) => ({ headers: [...headers], rows });
/** @param {string} value */
const body = (value) => ({ language: "js", meta: "", value });
/** @param {string} path */
async function absent(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return;
    throw error;
  }
  throw new RundownError(
    "RUNDOWN_AUTHORING_CONFLICT",
    `File already exists: ${path}`,
    { status: 409, locations: [unavailableLocation(pathToFileURL(path).href)] },
  );
}
/** @param {unknown} cause @param {string[]} created */
function partial(cause, created) {
  const error = diagnose(cause);
  if (created.length)
    error.related.push({
      code: "RUNDOWN_AUTHORING_PARTIAL",
      message: `Created files were preserved: ${created.join(", ")}. Inspect them before reconnecting or retrying.`,
      locations: created.map((file) =>
        unavailableLocation(pathToFileURL(file).href),
      ),
    });
  return error;
}
/** @param {string} file @param {string} source @param {'module'|'commands'} kind */
function validate(file, source, kind) {
  return compile(source, pathToFileURL(file).href, { kind }).document;
}

/** Publish independent files with no-overwrite semantics; publish the entry catalog last.
 * @param {{file:string,source:string,kind:'module'|'commands'}[]} files @param {AbortSignal} [signal]
 */
async function createFiles(files, signal) {
  for (const { file } of files) await absent(file);
  for (const file of files) validate(file.file, file.source, file.kind);
  const created = [];
  try {
    for (const { file, source } of files) {
      signal?.throwIfAborted();
      await mkdir(dirname(file), { recursive: true });
      await io.writeFileAtomicAsync(file, source, { ifAbsent: true });
      created.push(file);
    }
  } catch (cause) {
    throw partial(cause, created);
  }
  return created;
}

/** Register existing entry points in the nearest package without generating files.
 * @param {string|URL} catalog
 * @param {import('./AuthoringTypes.mjs').InitOptions} [options]
 * @returns {Promise<import('./AuthoringTypes.mjs').AuthoringResult>}
 */
export async function initProject(
  catalog,
  { cwd = process.cwd(), tests, signal } = {},
) {
  if (
    !(catalog instanceof URL) &&
    (typeof catalog !== "string" || !catalog.trim())
  )
    throw new RundownError(
      "RUNDOWN_AUTHORING",
      "Registration requires an existing command catalog path",
      { status: 400 },
    );
  const directory = await projectDirectory(cwd);
  const { root, file: manifestFile } = findProject(directory);
  signal?.throwIfAborted();
  if (!(await lstat(manifestFile)).isFile())
    throw new RundownError(
      "RUNDOWN_AUTHORING_CONFLICT",
      "package.json must be a regular file to update it",
      { status: 409 },
    );
  const existing = await io.readFileSnapshotAsync(manifestFile);
  const manifest = parsePackage(existing.content, manifestFile);
  const entry = resolveDocument(catalog, { cwd: directory });
  if (!entry.pathname.endsWith(".md"))
    throw new RundownError(
      "RUNDOWN_AUTHORING",
      "Registration requires a command catalog, not a module or view template",
      { status: 400 },
    );
  const checked = await checkProject({ file: entry, kind: "commands", signal });
  if (!checked.ok) {
    const error = new RundownError(
      "RUNDOWN_AUTHORING",
      "Fix the catalog's static check errors before registration",
      { status: 400 },
    );
    error.related = checked.errors;
    throw error;
  }
  if (
    !entry.pathname.endsWith(".md") ||
    checked.files.find((item) => item.file === entry.href)?.kind !== "commands"
  )
    throw new RundownError(
      "RUNDOWN_AUTHORING",
      "Registration requires a command catalog, not a module or view template",
      { status: 400 },
    );
  let testTarget;
  if (tests !== undefined) {
    if (!(tests instanceof URL) && (typeof tests !== "string" || !tests.trim()))
      throw new RundownError(
        "RUNDOWN_AUTHORING",
        "Expected an existing test directory or .test.md file",
        { status: 400 },
      );
    let path;
    try {
      path = fileURLToPath(documentURL(tests, undefined, directory));
      testTarget = await realpath(path);
      const info = await stat(testTarget);
      if (
        !info.isDirectory() &&
        !(info.isFile() && testTarget.endsWith(".test.md"))
      )
        throw new RundownError(
          "RUNDOWN_AUTHORING",
          "Test target must be a directory or .test.md file",
          { status: 400 },
        );
    } catch (cause) {
      if (cause instanceof RundownError) throw cause;
      throw fileFailure(cause, path ? pathToFileURL(path).href : String(tests));
    }
  }
  /** Keep equivalent declarations byte-for-byte rather than rewriting their spelling.
   * @param {string|undefined} previous @param {string} target
   */
  async function equivalent(previous, target) {
    if (!previous) return false;
    try {
      return (
        (await realpath(
          isPackageSpecifier(previous)
            ? fileURLToPath(documentURL(previous, pathToFileURL(manifestFile)))
            : resolve(root, previous),
        )) === target
      );
    } catch {
      return false;
    }
  }
  /** @param {string} target */
  function storedPath(target) {
    const path = relative(root, target);
    if (isAbsolute(path)) return path;
    const portable = path.split(sep).join("/");
    return portable.startsWith("../") ? portable : "./" + portable;
  }
  const config = { ...manifest.rundown };
  let changed = false;
  const target = fileURLToPath(entry);
  if (!(await equivalent(config.commands, target))) {
    config.commands =
      typeof catalog === "string" && isPackageSpecifier(catalog)
        ? catalog
        : storedPath(target);
    changed = true;
  }
  if (
    testTarget !== undefined &&
    !(await equivalent(config.tests, testTarget))
  ) {
    config.tests =
      typeof tests === "string" && isPackageSpecifier(tests)
        ? tests
        : storedPath(testTarget);
    changed = true;
  }
  const next = ["rundown --check", ...(config.tests ? ["rundown --test"] : [])];
  signal?.throwIfAborted();
  if (!changed) {
    if (
      (await io.readFileSnapshotAsync(manifestFile)).revision !==
      existing.revision
    )
      throw new RundownError(
        "RUNDOWN_AUTHORING_CONFLICT",
        "package.json changed during registration",
        { status: 409 },
      );
    return { ok: true, created: [], updated: [], next };
  }
  manifest.rundown = config;
  const original = existing.content;
  const indent = original.includes("\n")
    ? (/\n([ \t]+)"/.exec(original)?.[1] ?? "  ")
    : undefined;
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const manifestSource =
    JSON.stringify(manifest, null, indent).replaceAll("\n", eol) + eol;
  await io.writeFileAtomicAsync(manifestFile, manifestSource, {
    expectedRevision: existing.revision,
  });
  return { ok: true, created: [], updated: [manifestFile], next };
}

/** An in-memory editing template uses do-md's Editor and revision-checked publication. */
class EditingFilesystem extends NodeFilesystem {
  /** @param {string} path @param {string} source */
  constructor(path, source) {
    super();
    this.templatePath = path;
    this.templateSource = source;
  }
  /** @param {string} path @param {unknown} [options] */
  readFileAsync(path, options) {
    return path === this.templatePath
      ? Promise.resolve(this.templateSource)
      : super.readFileAsync(path, options);
  }
}

/** Publish a Connections row last, preserving other regions and concurrent edits.
 * Only this metadata merge is retried on CAS conflicts; no user code executes.
 * @param {string} entry @param {string} catalog @param {string} description @param {AbortSignal} [signal] @param {string} [reference]
 */
async function connect(entry, catalog, description, signal, reference) {
  const path = relative(dirname(entry), catalog);
  const connection =
    reference ??
    (isAbsolute(path)
      ? pathToFileURL(catalog).href
      : "./" + path.split(sep).map(encodeURIComponent).join("/"));
  for (let attempt = 0; attempt < 3; attempt++) {
    signal?.throwIfAborted();
    const snapshot = await io.readFileSnapshotAsync(entry);
    const source = snapshot.content;
    const parsed = parseDocument(source, pathToFileURL(entry).href, "commands");
    const target = resolveDocument(catalog).href;
    const current = await checkProject({
      file: entry,
      kind: "commands",
      signal,
    });
    signal?.throwIfAborted();
    if (!current.ok) {
      const error = new RundownError(
        "RUNDOWN_AUTHORING_CONFLICT",
        "Catalog checks failed before connecting the new command",
        { status: 409 },
      );
      error.related = current.errors;
      throw error;
    }
    if (
      parsed.connections.some(
        (row) =>
          resolveDocument(row.file, { baseURL: pathToFileURL(entry).href })
            .href === target,
      )
    )
      return false;
    const row = [connection, description];
    /** @param {string} candidate */
    const validateConnection = async (candidate) => {
      const checked = await checkProject({
        file: entry,
        kind: "commands",
        signal,
        sourceOverrides: { [resolveDocument(entry).href]: candidate },
      });
      signal?.throwIfAborted();
      if (!checked.ok) {
        const error = new RundownError(
          "RUNDOWN_AUTHORING_CONFLICT",
          "Connecting this catalog would make the command graph invalid",
          { status: 409 },
        );
        error.related = checked.errors;
        throw error;
      }
    };
    const connections = parsed.sections.Connections;
    try {
      if (connections) {
        const templatePath = join(
          dirname(entry),
          "__connections_edit__.md.template",
        );
        const template =
          '{% doc.literal(options.prefix); doc.table().as("connections"); doc.literal(options.suffix); %}';
        const editor = await Editor.open({
          io: new EditingFilesystem(templatePath, template),
          file: entry,
          template: templatePath,
          options: {
            prefix: source.slice(0, connections.position.start.offset),
            suffix: source.slice(connections.position.end.offset),
          },
        });
        if (editor.revision !== snapshot.revision) continue;
        editor.set("connections", {
          headers: [...connections.headers],
          rows: [...connections.rows, row],
          align: connections.align ?? connections.headers.map(() => null),
        });
        await validateConnection(editor.render());
        signal?.throwIfAborted();
        await editor.save();
      } else {
        const first = parseMarkdown(source).children.find(
          (node) => node.type === "heading" && node.level === 2,
        );
        const offset = first?.position?.start.offset ?? source.length;
        const prefix = source.slice(0, offset),
          suffix = source.slice(offset);
        const block = await render("connections", {
          connections: table(COLUMNS.connections, [row]),
        });
        const updated =
          prefix +
          (prefix.endsWith("\n\n") ? "" : "\n\n") +
          block +
          "\n" +
          suffix;
        const candidate = parseDocument(
          updated,
          pathToFileURL(entry).href,
          "commands",
        );
        if (!candidate.connections.some((row) => row.file === connection))
          throw new RundownError(
            "RUNDOWN_AUTHORING_CONFLICT",
            "Cannot insert Connections into the current document structure",
            { status: 409 },
          );
        await validateConnection(updated);
        signal?.throwIfAborted();
        await io.writeFileAtomicAsync(entry, updated, {
          expectedRevision: snapshot.revision,
        });
      }
      return true;
    } catch (cause) {
      if (diagnose(cause).code === "DO_MD_CONFLICT" && attempt < 2) continue;
      throw cause;
    }
  }
  throw new RundownError(
    "RUNDOWN_AUTHORING_CONFLICT",
    "Catalog changed repeatedly; reconnect the created command after reviewing it",
    { status: 409 },
  );
}

/** Create a runnable command and companion module, then connect their catalog.
 * @param {string} name @param {import('./AuthoringTypes.mjs').NewCommandOptions} [options]
 * @returns {Promise<import('./AuthoringTypes.mjs').AuthoringResult>}
 */
export async function newCommand(
  name,
  { cwd = process.cwd(), commands, outDir, signal } = {},
) {
  if (!/^[a-zA-Z][\w-]*$/.test(name))
    throw new RundownError(
      "RUNDOWN_AUTHORING",
      "Command name must start with a letter and contain letters, digits, _ or -",
      { status: 400 },
    );
  if (outDir !== undefined && /[\u0000-\u001f|`]/.test(outDir))
    throw new RundownError(
      "RUNDOWN_AUTHORING",
      "Output directory cannot contain control or table-delimiter characters",
      { status: 400 },
    );
  const root = await projectDirectory(cwd);
  localCatalog(root, commands);
  const entry = fileURLToPath(
    commands ? resolveDocument(commands, { cwd: root }) : discover(root),
  );
  const checked = await checkProject({ file: entry, kind: "commands", signal });
  signal?.throwIfAborted();
  if (!checked.ok) {
    const error = new RundownError(
      "RUNDOWN_AUTHORING",
      "Fix the catalog's check errors before adding a command",
      { status: 400 },
    );
    error.related = checked.errors;
    throw error;
  }
  if (checked.commands.some((command) => command.name === name))
    throw new RundownError(
      "RUNDOWN_AUTHORING_CONFLICT",
      `Command already defined: ${name}`,
      { status: 409 },
    );
  const directory =
      outDir === undefined ? join(dirname(entry), name) : resolve(root, outDir),
    catalog = join(directory, "commands.md"),
    module = join(directory, "module.md");
  const value = `${name} is ready.`;
  const commandSource = await render("command", {
    title: `${name} commands`,
    name,
    description:
      "Return a message through the companion module. Replace this starter recipe with the command's intended behavior.",
    parameters: table(COLUMNS.commandParameters, [
      [
        "message",
        "string",
        "no",
        JSON.stringify(value),
        "1",
        "The message to return.",
      ],
    ]),
    returns: table(COLUMNS.returns, [["string", "The supplied message."]]),
    body: body(
      'const module = await rundown.loadModule("./module.md");\nreturn module.run(args.message);',
    ),
  });
  const moduleSource = await render("module", {
    title: `${name} module`,
    description: "A small starter module for the command.",
    method: "run",
    methodDescription: "Return the supplied message without external effects.",
    parameters: table(COLUMNS.methodParameters, [
      [
        "message",
        "string",
        "no",
        JSON.stringify(value),
        "The message to return.",
      ],
    ]),
    returns: table(COLUMNS.returns, [
      ["Promise<string>", "The supplied message."],
    ]),
    body: body("return message;"),
  });
  const created = await createFiles(
    [
      { file: module, source: moduleSource, kind: "module" },
      { file: catalog, source: commandSource, kind: "commands" },
    ],
    signal,
  );
  try {
    const updated = await connect(
      entry,
      catalog,
      `Starter command: ${name}.`,
      signal,
    );
    return {
      ok: true,
      created,
      updated: updated ? [entry] : [],
      next: commands
        ? [
            `rundown --commands ${JSON.stringify(String(commands))} --check`,
            `rundown --commands ${JSON.stringify(String(commands))} ${name}`,
          ]
        : ["rundown --check", `rundown ${name}`],
    };
  } catch (cause) {
    throw partial(cause, created);
  }
}

/** Connect a copied or existing catalog without regenerating or executing it.
 * @param {string} file @param {import('./AuthoringTypes.mjs').AuthoringOptions} [options]
 * @returns {Promise<import('./AuthoringTypes.mjs').AuthoringResult>}
 */
export async function connectCatalog(
  file,
  { cwd = process.cwd(), commands, signal } = {},
) {
  const root = await projectDirectory(cwd),
    entry = fileURLToPath(
      commands ? resolveDocument(commands, { cwd: root }) : discover(root),
    );
  localCatalog(root, commands);
  const target = resolveDocument(file, { cwd: root });
  if (!target.pathname.endsWith(".md"))
    throw new RundownError(
      "RUNDOWN_AUTHORING",
      "Connections import command catalogs",
      { status: 400 },
    );
  const checked = await checkProject({
    file: target,
    kind: "commands",
    signal,
  });
  signal?.throwIfAborted();
  if (!checked.ok) {
    const error = new RundownError(
      "RUNDOWN_AUTHORING",
      "Connections import command catalogs; fix the imported catalog's check errors before connecting it",
      { status: 400 },
    );
    error.related = checked.errors;
    throw error;
  }
  if (
    checked.files.find((item) => item.file === target.href)?.kind !== "commands"
  )
    throw new RundownError(
      "RUNDOWN_AUTHORING",
      "Connections import command catalogs; use module dependencies for this document",
      { status: 400 },
    );
  const updated = await connect(
    entry,
    fileURLToPath(target),
    "Imported command catalog.",
    signal,
    isPackageSpecifier(file) ? file : undefined,
  );
  const prefix = commands
    ? `rundown --commands ${JSON.stringify(String(commands))}`
    : "rundown";
  return {
    ok: true,
    created: [],
    updated: updated ? [entry] : [],
    next: [
      `${prefix} --check`,
      ...checked.commands.map((command) => `${prefix} help ${command.name}`),
    ],
  };
}

/** Create a standalone documentation-first module; it is not implicitly imported.
 * @param {string} file @param {import('./AuthoringTypes.mjs').AuthoringOptions} [options]
 * @returns {Promise<import('./AuthoringTypes.mjs').AuthoringResult>}
 */
export async function newModule(file, { cwd = process.cwd(), signal } = {}) {
  if (extname(file) !== ".md" || /[\u0000-\u001f|`]/.test(file))
    throw new RundownError(
      "RUNDOWN_AUTHORING",
      "Module file must have a .md extension and no control or table-delimiter characters",
      { status: 400 },
    );
  const target = resolve(await projectDirectory(cwd), file);
  const title = basename(target, ".md").replace(/[-_]/g, " ");
  const source = await render("module", {
    title,
    description: "A standalone Markdown module.",
    method: "run",
    methodDescription:
      "Return an empty result. Document the intended behavior before extending this starter.",
    parameters: table(COLUMNS.methodParameters, []),
    returns: table(COLUMNS.returns, [["Promise<null>", "An empty result."]]),
    body: body("return null;"),
  });
  return {
    ok: true,
    created: await createFiles(
      [{ file: target, source, kind: "module" }],
      signal,
    ),
    updated: [],
    next: [
      `rundown --check ${JSON.stringify(file)}`,
      "Declare a dependency or call loadModule to use this module.",
    ],
  };
}
