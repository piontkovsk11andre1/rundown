// Canonical directory name used for rundown project configuration.
export const CONFIG_DIR_NAME = ".rundown";

/**
 * Resolved config-directory information.
 *
 * - `configDir`: absolute path to the effective `.rundown` directory
 * - `isExplicit`: true when provided via `--config-dir`, false when discovered
 */
export interface ConfigDirResult {
  // Absolute path to the resolved configuration directory.
  configDir: string;
  // Indicates whether the directory came from an explicit CLI flag.
  isExplicit: boolean;
}

/**
 * Resolves the effective `.rundown` directory for a command/use case.
 *
 * Fallback contract when discovery returns `undefined` (no `.rundown` found):
 *
 * - Template consumers (`run`, `discuss`, `plan`, `reverify`):
 *   use built-in default templates and continue execution.
 * - Optional config-file consumers (default vars file):
 *   treat as "no default vars file" and continue unless user provided an explicit path.
 * - Runtime artifact/log consumers:
 *   create a local `<cwd>/.rundown` on demand for writes.
 * - Init command:
 *   does not use discovery; always creates `<cwd>/.rundown` unless an explicit config dir is supplied.
 * - Explicit `--config-dir`:
 *   bypasses discovery; path validation errors are fatal.
 */
export interface ConfigDirPort {
  // Resolves from the provided start directory using adapter-specific discovery.
  resolve(startDir: string): ConfigDirResult | undefined;
}
