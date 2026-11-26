import { pathToFileURL } from "node:url";
import { projectPath } from "./Project.mjs";
import { resolveDocument, commandArtifact } from "./Loader.mjs";
import { problem, RundownError, processingError, location } from "./Error.mjs";
import { commandSchema } from "./Validation.mjs";
import { isDocumentSpecifier } from "./Paths.mjs";

/** Discover the nearest package's declared catalog; Connections remain explicit.
 * @param {string} cwd
 */
export function discover(cwd) {
  return pathToFileURL(projectPath(cwd, "commands"));
}

/** Assemble declarative definitions and callable handlers without invoking commands.
 * @param {string|URL} [specifier] @param {import('./types.mjs').LoadOptions} [options]
 */
export async function loadCommands(specifier, options = {}) {
  const entry = specifier ?? discover(options.cwd ?? process.cwd());
  /** @type {Map<string,import('./types.mjs').Command>} */
  const commands = new Map();
  const loaded = new Set();
  /** @type {string[]} */
  const chain = [];
  /** @param {string|URL} input @param {string|URL} [baseURL] @returns {Promise<void>} */
  async function visit(input, baseURL) {
    options.signal?.throwIfAborted();
    const url = resolveDocument(input, { ...options, baseURL });
    if (chain.includes(url.href))
      throw new RundownError(
        "RUNDOWN_CONNECTION_CYCLE",
        `Command connection cycle: ${[...chain, url.href].join(" -> ")}`,
        { status: 400 },
      );
    if (loaded.has(url.href)) return;
    chain.push(url.href);
    const { artifact, namespace } = await commandArtifact(url, options);
    const document = structuredClone(artifact.document);
    for (const connection of document.connections) {
      if (!isDocumentSpecifier(connection.file))
        throw problem(
          "Connections require relative/absolute paths or explicit npm: exports",
          document,
          connection.position,
        );
      try {
        await visit(connection.file, url.href);
      } catch (cause) {
        throw processingError(cause, {
          ...location(
            document.url,
            document.source,
            connection.position?.start.offset ?? 0,
          ),
          relation: "processing",
        });
      }
    }
    for (const [index, member] of document.members.entries()) {
      const previous = commands.get(member.name);
      if (previous) {
        const error = problem(
          `Duplicate command ${member.name}; previously defined in ${previous.url}`,
          document,
          member.position,
        );
        error.locations.push(previous.location);
        throw error;
      }
      const contract = commandSchema(member);
      const handler = namespace[`__command${index}`];
      if (typeof handler !== "function")
        throw problem(
          `Missing compiled handler for ${member.name}`,
          document,
          member.position,
        );
      const error = problem("", document, member.position);
      commands.set(member.name, {
        name: member.name,
        description: member.description.trim(),
        parameters: member.parameters,
        returns: member.returns,
        surfaces: /** @type {import('./types.mjs').Command['surfaces']} */ (
          member.surfaces
        ),
        url: url.href,
        location: error.locations[0],
        handler: /** @type {import('./types.mjs').Command['handler']} */ (
          handler
        ),
        ...contract,
      });
    }
    chain.pop();
    loaded.add(url.href);
  }
  await visit(entry, options.baseURL);
  return Object.freeze({
    entry: resolveDocument(entry, options).href,
    commands,
  });
}

/** @param {import('./types.mjs').Command} command @param {import('./types.mjs').Surface} surface */
export function permits(command, surface) {
  return command.surfaces.includes("*") || command.surfaces.includes(surface);
}

/** @param {import('./types.mjs').Command} command */
export function describe(command) {
  return {
    name: command.name,
    description: command.description,
    parameters: command.parameters,
    returns: command.returns,
    surfaces: command.surfaces,
    inputSchema: command.schema,
  };
}
