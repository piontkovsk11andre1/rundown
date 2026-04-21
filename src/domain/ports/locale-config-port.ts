export interface LocaleConfig {
  language: string;
  aliases: Record<string, string>;
}

export interface LocaleConfigPort {
  load(configDir: string): LocaleConfig | null;
  save(configDir: string, config: LocaleConfig): void;
}
