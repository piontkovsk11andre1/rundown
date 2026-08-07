import fs from "node:fs";
import path from "node:path";
import type {
  LocaleConfig,
  LocaleConfigPort,
} from "../../domain/ports/locale-config-port.js";

const LOCALE_CONFIG_FILE_NAME = "locale.json";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeStringMap(
  value: unknown,
  fieldName: string,
  configPath: string,
  options: { optional: boolean } = { optional: false },
): Record<string, string> {
  if (value === undefined && options.optional) {
    return {};
  }

  if (!isPlainObject(value)) {
    throw new Error(`Invalid locale config at "${configPath}": "${fieldName}" must be an object.`);
  }

  const normalized: Record<string, string> = {};
  for (const [key, mappedValue] of Object.entries(value)) {
    if (typeof mappedValue !== "string" || mappedValue.length === 0) {
      throw new Error(`Invalid locale config at "${configPath}": ${fieldName}["${key}"] must be a non-empty string.`);
    }
    normalized[key] = mappedValue;
  }

  return normalized;
}

function validateLocaleConfig(value: unknown, configPath: string): LocaleConfig {
  if (!isPlainObject(value)) {
    throw new Error(`Invalid locale config at "${configPath}": expected top-level JSON object.`);
  }

  const language = value.language;
  const aliases = value.aliases;
  const messages = value.messages;

  if (typeof language !== "string" || language.trim().length === 0) {
    throw new Error(`Invalid locale config at "${configPath}": "language" must be a non-empty string.`);
  }

  const normalizedAliases = normalizeStringMap(aliases, "aliases", configPath);
  const normalizedMessages = normalizeStringMap(messages, "messages", configPath, { optional: true });

  return {
    language,
    aliases: normalizedAliases,
    messages: normalizedMessages,
  };
}

export function extractLocaleMessages(config: LocaleConfig): Record<string, string> {
  return config.messages ?? {};
}

export function createLocaleConfigAdapter(): LocaleConfigPort {
  return {
    load(configDir) {
      const configPath = path.join(configDir, LOCALE_CONFIG_FILE_NAME);

      let parsed: unknown;
      try {
        parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      } catch (error) {
        const errno = error as NodeJS.ErrnoException;
        if (errno.code === "ENOENT") {
          return null;
        }

        if (error instanceof SyntaxError) {
          throw new Error(`Failed to parse locale config at "${configPath}": invalid JSON (${error.message}).`);
        }

        throw new Error(`Failed to read locale config at "${configPath}": ${String(error)}.`);
      }

      return validateLocaleConfig(parsed, configPath);
    },
    save(configDir, config) {
      const configPath = path.join(configDir, LOCALE_CONFIG_FILE_NAME);
      const validated = validateLocaleConfig(config, configPath);
      const serialized = JSON.stringify(validated, null, 2) + "\n";

      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, serialized, "utf-8");
    },
  };
}
