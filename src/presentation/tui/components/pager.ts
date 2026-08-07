// @ts-nocheck
import pc from "picocolors";

const DEFAULT_VIEWPORT_HEIGHT = 20;
const MIN_VIEWPORT_HEIGHT = 3;
const TAB_REPLACEMENT = "    ";

function normalizeViewportHeight(value) {
  if (!Number.isFinite(value)) {
    return DEFAULT_VIEWPORT_HEIGHT;
  }
  const integer = Math.floor(value);
  if (integer < MIN_VIEWPORT_HEIGHT) {
    return MIN_VIEWPORT_HEIGHT;
  }
  return integer;
}

function splitContentIntoLines(content) {
  if (typeof content !== "string" || content.length === 0) {
    return [];
  }
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const rawLines = normalized.split("\n");
  return rawLines.map((line) => line.replace(/\t/g, TAB_REPLACEMENT));
}

function clampOffset(offset, totalLines, viewportHeight) {
  if (!Number.isFinite(offset)) {
    return 0;
  }
  const integer = Math.floor(offset);
  if (integer <= 0) {
    return 0;
  }
  const maxOffset = Math.max(0, totalLines - viewportHeight);
  if (integer > maxOffset) {
    return maxOffset;
  }
  return integer;
}

export function createPagerState({
  content = "",
  title = "",
  filePath = "",
  viewportHeight = DEFAULT_VIEWPORT_HEIGHT,
} = {}) {
  const lines = splitContentIntoLines(content);
  const normalizedHeight = normalizeViewportHeight(viewportHeight);
  return {
    title: typeof title === "string" ? title : "",
    filePath: typeof filePath === "string" ? filePath : "",
    lines,
    totalLines: lines.length,
    offset: 0,
    viewportHeight: normalizedHeight,
  };
}

export function setPagerContent(state, { content, title, filePath, viewportHeight } = {}) {
  const previous = state ?? createPagerState();
  return createPagerState({
    content: typeof content === "string" ? content : previous.lines.join("\n"),
    title: typeof title === "string" ? title : previous.title,
    filePath: typeof filePath === "string" ? filePath : previous.filePath,
    viewportHeight: typeof viewportHeight === "number" ? viewportHeight : previous.viewportHeight,
  });
}

export function setPagerViewportHeight(state, viewportHeight) {
  const sceneState = state ?? createPagerState();
  const normalizedHeight = normalizeViewportHeight(viewportHeight);
  if (normalizedHeight === sceneState.viewportHeight) {
    return sceneState;
  }
  return {
    ...sceneState,
    viewportHeight: normalizedHeight,
    offset: clampOffset(sceneState.offset, sceneState.totalLines, normalizedHeight),
  };
}

function pageStep(viewportHeight) {
  return Math.max(1, viewportHeight - 1);
}

export function scrollPager(state, delta) {
  const sceneState = state ?? createPagerState();
  const numericDelta = Number.isFinite(delta) ? Math.floor(delta) : 0;
  const nextOffset = clampOffset(
    sceneState.offset + numericDelta,
    sceneState.totalLines,
    sceneState.viewportHeight,
  );
  if (nextOffset === sceneState.offset) {
    return sceneState;
  }
  return {
    ...sceneState,
    offset: nextOffset,
  };
}

export function scrollPagerToTop(state) {
  const sceneState = state ?? createPagerState();
  if (sceneState.offset === 0) {
    return sceneState;
  }
  return {
    ...sceneState,
    offset: 0,
  };
}

export function scrollPagerToBottom(state) {
  const sceneState = state ?? createPagerState();
  const maxOffset = Math.max(0, sceneState.totalLines - sceneState.viewportHeight);
  if (sceneState.offset === maxOffset) {
    return sceneState;
  }
  return {
    ...sceneState,
    offset: maxOffset,
  };
}

function formatProgress(state) {
  const { offset, viewportHeight, totalLines } = state;
  if (totalLines === 0) {
    return "(empty)";
  }
  const firstVisible = offset + 1;
  const lastVisible = Math.min(totalLines, offset + viewportHeight);
  if (lastVisible >= totalLines && offset === 0) {
    return `lines ${firstVisible}-${lastVisible}/${totalLines} · ALL`;
  }
  if (lastVisible >= totalLines) {
    return `lines ${firstVisible}-${lastVisible}/${totalLines} · END`;
  }
  if (offset === 0) {
    return `lines ${firstVisible}-${lastVisible}/${totalLines} · TOP`;
  }
  const percent = Math.min(100, Math.max(0, Math.round((lastVisible / totalLines) * 100)));
  return `lines ${firstVisible}-${lastVisible}/${totalLines} · ${percent}%`;
}

export function renderPagerLines({ state } = {}) {
  const sceneState = state ?? createPagerState();
  const lines = [];
  if (sceneState.title) {
    lines.push(pc.bold(sceneState.title));
  }
  if (sceneState.filePath) {
    lines.push(pc.dim(sceneState.filePath));
  }
  if (sceneState.title || sceneState.filePath) {
    lines.push("");
  }

  const visibleLines = sceneState.lines.slice(
    sceneState.offset,
    sceneState.offset + sceneState.viewportHeight,
  );
  if (visibleLines.length === 0) {
    lines.push(pc.dim("(no content)"));
  } else {
    for (const line of visibleLines) {
      lines.push(line);
    }
    const visibleCount = visibleLines.length;
    if (visibleCount < sceneState.viewportHeight) {
      const padding = sceneState.viewportHeight - visibleCount;
      for (let index = 0; index < padding; index += 1) {
        lines.push(pc.dim("~"));
      }
    }
  }

  lines.push("");
  lines.push(pc.dim(formatProgress(sceneState)));
  lines.push(pc.dim("[↑/k] up   [↓/j] down   [Space/f] page down   [b] page up   [g] top   [G] bottom   [q/Esc] close"));
  return lines;
}

export function handlePagerInput({ rawInput, state } = {}) {
  const sceneState = state ?? createPagerState();
  const input = typeof rawInput === "string" ? rawInput : "";

  const isEscape = input === "\u001b";
  const isBackspace = input === "\b" || input === "\u007f";
  const isQuit = input === "q" || input === "Q";

  if (isEscape || isBackspace || isQuit) {
    return {
      handled: true,
      state: sceneState,
      backToParent: true,
    };
  }

  const pageSize = pageStep(sceneState.viewportHeight);

  // Down: ↓, j, Enter, Ctrl+N
  if (input === "\u001b[B" || input === "j" || input === "\r" || input === "\n" || input === "\u000e") {
    return {
      handled: true,
      state: scrollPager(sceneState, 1),
      backToParent: false,
    };
  }

  // Up: ↑, k, Ctrl+P
  if (input === "\u001b[A" || input === "k" || input === "\u0010") {
    return {
      handled: true,
      state: scrollPager(sceneState, -1),
      backToParent: false,
    };
  }

  // Page down: Space, f, Ctrl+F, Page Down (\u001b[6~)
  if (input === " " || input === "f" || input === "\u0006" || input === "\u001b[6~") {
    return {
      handled: true,
      state: scrollPager(sceneState, pageSize),
      backToParent: false,
    };
  }

  // Page up: b, Ctrl+B, Page Up (\u001b[5~)
  if (input === "b" || input === "\u0002" || input === "\u001b[5~") {
    return {
      handled: true,
      state: scrollPager(sceneState, -pageSize),
      backToParent: false,
    };
  }

  // Half-page down: d, Ctrl+D
  if (input === "d" || input === "\u0004") {
    const halfPage = Math.max(1, Math.floor(sceneState.viewportHeight / 2));
    return {
      handled: true,
      state: scrollPager(sceneState, halfPage),
      backToParent: false,
    };
  }

  // Half-page up: u, Ctrl+U
  if (input === "u" || input === "\u0015") {
    const halfPage = Math.max(1, Math.floor(sceneState.viewportHeight / 2));
    return {
      handled: true,
      state: scrollPager(sceneState, -halfPage),
      backToParent: false,
    };
  }

  // Top: g, Home
  if (input === "g" || input === "\u001b[H" || input === "\u001b[1~") {
    return {
      handled: true,
      state: scrollPagerToTop(sceneState),
      backToParent: false,
    };
  }

  // Bottom: G, End
  if (input === "G" || input === "\u001b[F" || input === "\u001b[4~") {
    return {
      handled: true,
      state: scrollPagerToBottom(sceneState),
      backToParent: false,
    };
  }

  return {
    handled: false,
    state: sceneState,
    backToParent: false,
  };
}
