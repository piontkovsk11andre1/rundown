export interface SourceResolverPort {
  resolveSources(source: string): Promise<string[]>;
}
