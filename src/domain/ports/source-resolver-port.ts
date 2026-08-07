/**
 * Defines the port for resolving source selectors into concrete source paths.
 *
 * Implementations can interpret the input as a file path, glob pattern,
 * logical identifier, or any project-specific source reference.
 */
export interface SourceResolverPort {
  /** Resolves a source selector into a list of matching source paths. */
  resolveSources(source: string): Promise<string[]>;
}
