export interface TemplateLoader {
  load(filePath: string): string | null;
}
