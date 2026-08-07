import pc from "picocolors";
import { stripAnsi } from "../domain/services/string-utils.js";

export interface AnimationContext {
  skipped?: boolean;
}

export const isTTY = (): boolean => Boolean(process.stdout.isTTY);

export function sleep(ms: number, ctx?: AnimationContext): Promise<void> {
  if (!isTTY() || ms <= 0 || ctx?.skipped) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function pause(ms = 400, ctx?: AnimationContext): Promise<void> {
  await sleep(ms, ctx);
}

export async function typeText(text: string, ctx?: AnimationContext, charDelay = 18): Promise<void> {
  if (!isTTY() || ctx?.skipped) {
    process.stdout.write(text);
    return;
  }
  for (let i = 0; i < text.length; i++) {
    process.stdout.write(text[i]);
    await sleep(charDelay, ctx);
    if (ctx?.skipped) {
      const remaining = text.slice(i + 1);
      if (remaining) process.stdout.write(remaining);
      return;
    }
  }
}

export function drawBox(title: string, lines: string[]): string[] {
  const innerWidth = Math.max(title.length + 2, ...lines.map(stripAnsi).map((line) => line.length)) + 2;
  const pad = (s: string) => {
    const visible = stripAnsi(s).length;
    return s + " ".repeat(Math.max(0, innerWidth - visible));
  };
  const top = `  ${pc.dim("╭─")} ${pc.cyan(title)} ${pc.dim("─".repeat(Math.max(0, innerWidth - title.length - 2)) + "╮")}`;
  const bot = `  ${pc.dim("╰" + "─".repeat(innerWidth + 2) + "╯")}`;
  const body = lines.map((line) => `  ${pc.dim("│")} ${pad(line)} ${pc.dim("│")}`);
  return [top, ...body, bot];
}
