import ts from "typescript";
import { readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// Check implementation-to-implementation contracts, not adjacent public .d.mts
// stubs (which TypeScript normally prefers over same-basename JavaScript).
const root = fileURLToPath(new URL("../", import.meta.url));
const source = join(root, "sources");
const config = ts.readConfigFile(
  join(root, "tsconfig.internal.json"),
  ts.sys.readFile,
);
if (config.error)
  throw new Error(
    ts.flattenDiagnosticMessageText(config.error.messageText, "\n"),
  );
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
if (parsed.errors.length)
  throw new Error(
    parsed.errors
      .map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n"))
      .join("\n"),
  );
const host = ts.createCompilerHost(parsed.options);
host.resolveModuleNameLiterals = (
  names,
  containingFile,
  redirectedReference,
  options,
  containingSourceFile,
) =>
  names.map((name) => {
    const result = ts.resolveModuleName(
      name.text,
      containingFile,
      options,
      host,
      undefined,
      redirectedReference,
      ts.getModeForUsageLocation(containingSourceFile, name, options),
    );
    const resolved = result.resolvedModule;
    if (
      resolved?.resolvedFileName.startsWith(source) &&
      resolved.resolvedFileName.endsWith(".d.mts")
    ) {
      const implementation = resolved.resolvedFileName.replace(
        /\.d\.mts$/,
        ".mjs",
      );
      if (existsSync(implementation))
        return {
          ...result,
          resolvedModule: {
            ...resolved,
            resolvedFileName: implementation,
            extension: ts.Extension.Mjs,
          },
        };
    }
    return result;
  });
const files = readdirSync(source)
  .filter((file) => file.endsWith(".mjs"))
  .map((file) => join(source, file));
const program = ts.createProgram(files, parsed.options, host);
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) {
  process.stderr.write(
    ts.formatDiagnostics(diagnostics, {
      getCurrentDirectory: () => root,
      getCanonicalFileName: (name) => name,
      getNewLine: () => "\n",
    }),
  );
  process.exitCode = 1;
} else
  process.stdout.write(
    `Checked ${files.length} implementation modules with strict checkJs.\n`,
  );
