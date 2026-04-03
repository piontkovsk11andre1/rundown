/**
 * Describes source-local memory metadata resolved for a Markdown document.
 */
export interface MemoryMetadata {
  // Indicates whether memory context currently exists for the source.
  available: boolean;
  // Resolved source-local memory file path for the source document.
  filePath: string;
  // Optional short human-readable memory description.
  summary?: string;
}

/**
 * Resolves memory metadata for a source Markdown path.
 */
export interface MemoryResolverPort {
  // Returns memory metadata without reading/inlining memory file contents.
  resolve(sourcePath: string): MemoryMetadata;
}
