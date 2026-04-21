import { MESSAGES, type MessageId } from "./messages";

export type LocaleMessages = Record<string, string>;

export function msg(
  id: MessageId,
  vars: Record<string, string> = {},
  localeMessages: LocaleMessages = {},
): string {
  const englishTemplate = MESSAGES[id];
  const template = localeMessages[id] ?? englishTemplate ?? id;
  const rendered = template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => vars[key] ?? `{{${key}}}`);

  if (id.startsWith("verify.")) {
    return rendered;
  }

  return rendered.replace(
    /\b(\d+)([^\n]*?)\b([A-Za-z-]+)\(s\)(?=[^A-Za-z]|$)/g,
    (_match, count: string, middle: string, word: string) =>
      count === "1"
        ? `${count}${middle}${word}`
        : `${count}${middle}${word}s`,
  );
}
