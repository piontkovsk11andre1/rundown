// @ts-nocheck
import { spawnSync } from "node:child_process";
import path from "node:path";

function parseCommandText(value) {
  if (typeof value !== "string") {
    return null;
  }
  const source = value.trim();
  if (source.length === 0) {
    return null;
  }

  const tokens = [];
  let current = "";
  let quote = "";
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if ((char === '"' || char === "'") && quote.length === 0) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = "";
      continue;
    }
    if (/\s/.test(char) && quote.length === 0) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  if (tokens.length === 0) {
    return null;
  }
  return {
    command: tokens[0],
    args: tokens.slice(1),
  };
}

function createEditorCandidates({ env = process.env, platform = process.platform } = {}) {
  const candidates = [];

  const visual = parseCommandText(env?.VISUAL);
  if (visual) {
    candidates.push({ ...visual, source: "VISUAL" });
  }

  const editor = parseCommandText(env?.EDITOR);
  if (editor && !candidates.some((entry) => entry.command === editor.command && entry.args.join("\u0000") === editor.args.join("\u0000"))) {
    candidates.push({ ...editor, source: "EDITOR" });
  }

  if (platform === "win32") {
    candidates.push({ command: "notepad", args: [], source: "fallback" });
    return candidates;
  }

  candidates.push({ command: "vi", args: [], source: "fallback" });
  candidates.push({ command: "nano", args: [], source: "fallback" });
  candidates.push({ command: "code", args: ["-w"], source: "fallback" });
  return candidates;
}

function formatCommand(command, args) {
  const parts = [command, ...args].map((part) => {
    if (!/\s/.test(part)) {
      return part;
    }
    return `"${part.replaceAll('"', '\\"')}"`;
  });
  return parts.join(" ");
}

function toPositiveLineNumber(value) {
  if (!Number.isInteger(value) || value <= 0) {
    return null;
  }
  return value;
}

function normalizeCommandName(command) {
  if (typeof command !== "string" || command.length === 0) {
    return "";
  }
  return path.basename(command).toLowerCase().replace(/\.exe$/, "");
}

function buildEditorArgs(candidate, targetPath, line) {
  const baseArgs = Array.isArray(candidate?.args) ? candidate.args : [];
  const resolvedLine = toPositiveLineNumber(line);
  if (resolvedLine === null) {
    return [...baseArgs, targetPath];
  }

  const commandName = normalizeCommandName(candidate?.command);
  if (commandName === "code" || commandName === "code-insiders" || commandName === "codium" || commandName === "cursor") {
    return [...baseArgs, "-g", `${targetPath}:${resolvedLine}`];
  }

  if (commandName === "vi" || commandName === "vim" || commandName === "nvim" || commandName === "gvim") {
    return [...baseArgs, `+${resolvedLine}`, targetPath];
  }

  return [...baseArgs, targetPath];
}

export function launchEditor(filePath, {
  cwd = process.cwd(),
  env = process.env,
  platform = process.platform,
  line,
} = {}) {
  if (typeof filePath !== "string" || filePath.trim().length === 0) {
    return {
      ok: false,
      reason: "invalid-path",
      message: "Editor path is required.",
    };
  }

  const targetPath = filePath.trim();
  const attempts = [];
  const candidates = createEditorCandidates({ env, platform });

  for (const candidate of candidates) {
    const args = buildEditorArgs(candidate, targetPath, line);
    const result = spawnSync(candidate.command, args, {
      cwd,
      env,
      stdio: "inherit",
      shell: false,
      windowsHide: false,
    });

    const commandLine = formatCommand(candidate.command, args);
    if (result.error) {
      const code = result.error && typeof result.error === "object" ? result.error.code : "";
      attempts.push(`${commandLine}: ${result.error.message}`);
      if (code === "ENOENT") {
        continue;
      }
      return {
        ok: false,
        reason: "launch-failed",
        source: candidate.source,
        command: candidate.command,
        args,
        commandLine,
        message: result.error.message,
      };
    }

    if (typeof result.status === "number" && result.status === 0) {
      return {
        ok: true,
        source: candidate.source,
        command: candidate.command,
        args,
        commandLine,
        exitCode: 0,
      };
    }

    if (typeof result.status === "number") {
      return {
        ok: false,
        reason: "non-zero-exit",
        source: candidate.source,
        command: candidate.command,
        args,
        commandLine,
        exitCode: result.status,
        message: `Editor exited with status ${result.status}.`,
      };
    }

    if (typeof result.signal === "string" && result.signal.length > 0) {
      return {
        ok: false,
        reason: "terminated",
        source: candidate.source,
        command: candidate.command,
        args,
        commandLine,
        signal: result.signal,
        message: `Editor terminated by signal ${result.signal}.`,
      };
    }

    return {
      ok: false,
      reason: "unknown-result",
      source: candidate.source,
      command: candidate.command,
      args,
      commandLine,
      message: "Editor exited with an unknown result.",
    };
  }

  return {
    ok: false,
    reason: "editor-not-found",
    message: attempts.length > 0
      ? `Could not launch any editor. Tried: ${attempts.join("; ")}`
      : "Could not launch any editor.",
  };
}

export { createEditorCandidates, parseCommandText };
