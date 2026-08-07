// @ts-nocheck
import pc from "picocolors";

function normalizeBindings(bindings) {
  if (!Array.isArray(bindings)) {
    return [];
  }

  const rows = [];
  for (const binding of bindings) {
    if (!binding || typeof binding !== "object") {
      continue;
    }
    const key = typeof binding.key === "string" ? binding.key.trim() : "";
    const description = typeof binding.description === "string" ? binding.description.trim() : "";
    if (!key || !description) {
      continue;
    }
    rows.push({ key, description });
  }
  return rows;
}

export function createKeybindingsOverlayState({ title, globalBindings, sceneBindings } = {}) {
  return {
    title: typeof title === "string" && title.length > 0 ? title : "Keybindings cheatsheet",
    globalBindings: normalizeBindings(globalBindings),
    sceneBindings: normalizeBindings(sceneBindings),
  };
}

export function renderKeybindingsOverlayLines({ state } = {}) {
  const overlayState = state ?? createKeybindingsOverlayState();
  const lines = [pc.bold(overlayState.title), ""];

  lines.push("Global");
  if (overlayState.globalBindings.length === 0) {
    lines.push(pc.dim("  (none)"));
  } else {
    for (const binding of overlayState.globalBindings) {
      lines.push(`  ${pc.cyan(`[${binding.key}]`)} ${binding.description}`);
    }
  }

  if (overlayState.sceneBindings.length > 0) {
    lines.push("");
    lines.push("Scene specific");
    for (const binding of overlayState.sceneBindings) {
      lines.push(`  ${pc.cyan(`[${binding.key}]`)} ${binding.description}`);
    }
  }

  lines.push("");
  lines.push(pc.dim("[Esc] close"));
  return lines;
}

export function handleKeybindingsOverlayInput({ rawInput, state } = {}) {
  const overlayState = state ?? createKeybindingsOverlayState();
  const input = typeof rawInput === "string" ? rawInput : "";
  const isEscape = input === "\u001b";
  const isBackspace = input === "\b" || input === "\u007f";
  const isClose = input === "k" || input === "K";
  if (isEscape || isBackspace || isClose) {
    return {
      handled: true,
      state: overlayState,
      close: true,
    };
  }
  return {
    handled: false,
    state: overlayState,
    close: false,
  };
}
