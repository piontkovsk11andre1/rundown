export interface PathOperationsPort {
  join(...parts: string[]): string;
  resolve(...parts: string[]): string;
  dirname(filePath: string): string;
  relative(from: string, to: string): string;
  isAbsolute(filePath: string): boolean;
}