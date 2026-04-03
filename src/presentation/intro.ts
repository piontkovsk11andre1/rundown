import pc from "picocolors";

// ---------------------------------------------------------------------------
// Slide context — tracks skip state for the current slide
// ---------------------------------------------------------------------------

interface SlideContext {
  /** When true, all animation delays are bypassed (user pressed a key mid-slide). */
  skipped: boolean;
}

// ---------------------------------------------------------------------------
// Keypress listener — raw-mode stdin for "press any key" navigation
// ---------------------------------------------------------------------------

function waitForKeypress(onEarlyKey?: () => void): Promise<void> {
  if (!isTTY()) return Promise.resolve();
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();

    const handler = (data: Buffer): void => {
      stdin.removeListener("data", handler);
      stdin.setRawMode(wasRaw);
      stdin.pause();

      // Ctrl+C — exit gracefully.
      if (data[0] === 3) {
        writeln();
        process.exit(0);
      }

      if (onEarlyKey) {
        onEarlyKey();
      }
      resolve();
    };
    stdin.on("data", handler);
  });
}

// ---------------------------------------------------------------------------
// Animation primitives
// ---------------------------------------------------------------------------

const isTTY = (): boolean => Boolean(process.stdout.isTTY);

function sleep(ms: number, ctx?: SlideContext): Promise<void> {
  if (!isTTY() || ms <= 0 || ctx?.skipped) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function write(text: string): void {
  process.stdout.write(text);
}

function writeln(text: string = ""): void {
  write(text + "\n");
}

async function typeText(text: string, ctx?: SlideContext, charDelay = 18): Promise<void> {
  if (!isTTY() || ctx?.skipped) {
    write(text);
    return;
  }
  for (let i = 0; i < text.length; i++) {
    write(text[i]);
    await sleep(charDelay, ctx);
    if (ctx?.skipped) {
      const remaining = text.slice(i + 1);
      if (remaining) write(remaining);
      return;
    }
  }
}

async function typeLine(text: string, ctx?: SlideContext, charDelay = 18): Promise<void> {
  await typeText(text, ctx, charDelay);
  write("\n");
}

async function revealLines(lines: string[], ctx?: SlideContext, lineDelay = 60): Promise<void> {
  for (const line of lines) {
    writeln(line);
    await sleep(lineDelay, ctx);
  }
}

async function pause(ms = 400, ctx?: SlideContext): Promise<void> {
  await sleep(ms, ctx);
}

/** Dramatic slow type — for statements that need weight. */
async function dramatic(text: string, ctx?: SlideContext, charDelay = 45): Promise<void> {
  await typeLine(text, ctx, charDelay);
}

/** Whisper — dim, slow, intimate. */
async function whisper(text: string, ctx?: SlideContext): Promise<void> {
  await typeLine(pc.dim(`  ${text}`), ctx, 30);
}

/** Announce — bold, with a breath before and after. */
async function announce(text: string, ctx?: SlideContext): Promise<void> {
  await pause(500, ctx);
  await typeLine(pc.bold(text), ctx, 35);
  await pause(400, ctx);
}

/** Animated progress bar. */
async function progressBar(
  label: string,
  ctx?: SlideContext,
  width = 32,
  fillDelay = 35,
): Promise<void> {
  const prefix = `  ${label} `;
  if (!isTTY() || ctx?.skipped) {
    writeln(`${prefix}[${"█".repeat(width)}] done`);
    return;
  }
  write(`${prefix}[${" ".repeat(width)}]`);
  for (let i = 0; i < width; i++) {
    write(`\r${prefix}[${"█".repeat(i + 1)}${pc.dim("░".repeat(width - i - 1))}]`);
    await sleep(fillDelay, ctx);
    if (ctx?.skipped) {
      write(`\r${prefix}[${"█".repeat(width)}] done`);
      write("\n");
      return;
    }
  }
  write(` done\n`);
}

/** Spinner that runs for a duration then resolves with a message. */
async function spinner(
  message: string,
  durationMs: number,
  ctx?: SlideContext,
  doneMessage?: string,
): Promise<void> {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  if (!isTTY() || ctx?.skipped) {
    writeln(doneMessage ?? `  ${pc.green("✔")} ${message}`);
    return;
  }
  const start = Date.now();
  let i = 0;
  while (Date.now() - start < durationMs && !ctx?.skipped) {
    write(`\r  ${pc.cyan(frames[i % frames.length])} ${message}`);
    await sleep(80, ctx);
    i++;
  }
  const final = doneMessage ?? `  ${pc.green("✔")} ${message}`;
  write(`\r${final}${" ".repeat(10)}\n`);
}

/** "Cascade" — reveal lines one at a time with staggering vertical sweep. */
async function cascade(lines: string[], ctx?: SlideContext, lineDelay = 80): Promise<void> {
  for (const line of lines) {
    writeln(line);
    await sleep(lineDelay, ctx);
  }
}

/**
 * Runs a slide with interactive keypress handling.
 */
async function runSlide(slideFn: (ctx: SlideContext) => Promise<void>): Promise<void> {
  const ctx: SlideContext = { skipped: false };

  if (!isTTY()) {
    await slideFn(ctx);
    return;
  }

  let slideFinished = false;
  let resolveAdvance: (() => void) | undefined;

  const advancePromise = new Promise<void>((resolve) => {
    resolveAdvance = resolve;
  });

  const keypressLoop = async (): Promise<void> => {
    while (true) {
      await waitForKeypress();
      if (!slideFinished) {
        ctx.skipped = true;
      } else {
        resolveAdvance?.();
        return;
      }
    }
  };

  const keypressPromise = keypressLoop();

  await slideFn(ctx);
  slideFinished = true;

  write(`\n  ${pc.dim("▸ press any key")}`);
  await advancePromise;

  write("\r" + " ".repeat(30) + "\r");
  void keypressPromise;
}

// ---------------------------------------------------------------------------
// Formatting helpers — match real output-port.ts icons & colors
// ---------------------------------------------------------------------------

function fmtInfo(msg: string): string {
  return `  ${pc.blue("ℹ")} ${msg}`;
}

function fmtWarn(msg: string): string {
  return `  ${pc.yellow("⚠")} ${msg}`;
}

function fmtSuccess(msg: string): string {
  return `  ${pc.green("✔")} ${msg}`;
}

function fmtError(msg: string): string {
  return `  ${pc.red("✖")} ${msg}`;
}

function fmtTaskRef(file: string, line: number, index: number, text: string): string {
  return `${pc.cyan(file)}:${pc.yellow(String(line))} ${pc.dim(`[#${index}]`)} ${text}`;
}

function fmtCmd(cmd: string): string {
  return `  ${pc.dim("$")} ${pc.bold(cmd)}`;
}

// ---------------------------------------------------------------------------
// Box-drawing renderer
// ---------------------------------------------------------------------------

function drawBox(title: string, lines: string[]): string[] {
  const innerWidth = Math.max(title.length + 2, ...lines.map(stripAnsi).map((l) => l.length)) + 2;
  const pad = (s: string) => {
    const visible = stripAnsi(s).length;
    return s + " ".repeat(Math.max(0, innerWidth - visible));
  };
  const top = `  ${pc.dim("╭─")} ${pc.cyan(title)} ${pc.dim("─".repeat(Math.max(0, innerWidth - title.length - 2)) + "╮")}`;
  const bot = `  ${pc.dim("╰" + "─".repeat(innerWidth + 2) + "╯")}`;
  const body = lines.map((l) => `  ${pc.dim("│")} ${pad(l)} ${pc.dim("│")}`);
  return [top, ...body, bot];
}

/** Strip ANSI escape sequences for width calculation. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// ---------------------------------------------------------------------------
// ASCII banner
// ---------------------------------------------------------------------------

const BANNER_LINES = [
  `  ██████  ██    ██ ███    ██ ██████   ██████  ██     ██ ███    ██`,
  `  ██   ██ ██    ██ ████   ██ ██   ██ ██    ██ ██     ██ ████   ██`,
  `  ██████  ██    ██ ██ ██  ██ ██   ██ ██    ██ ██  █  ██ ██ ██  ██`,
  `  ██   ██ ██    ██ ██  ██ ██ ██   ██ ██    ██ ██ ███ ██ ██  ██ ██`,
  `  ██   ██  ██████  ██   ████ ██████   ██████   ███ ███  ██   ████`,
];

// ═══════════════════════════════════════════════════════════════════════════
//  ACT I — The Promise
// ═══════════════════════════════════════════════════════════════════════════

async function slideThePromise(ctx: SlideContext): Promise<void> {
  writeln();
  await pause(600, ctx);
  await whisper("They said AI can do anything.", ctx);
  await pause(800, ctx);
  await whisper("Write code. Fix bugs. Ship features.", ctx);
  await pause(600, ctx);
  writeln();
  await dramatic(`  ${pc.bold("So you write a prompt.")}`, ctx, 40);
  await pause(300, ctx);
  await dramatic(`  ${pc.bold("And it works.")}`, ctx, 40);
  await pause(800, ctx);
  writeln();
  await whisper("...mostly.", ctx);
  await pause(1000, ctx);
}

// ═══════════════════════════════════════════════════════════════════════════
//  ACT II — The Problem
// ═══════════════════════════════════════════════════════════════════════════

async function slideTheProblem(ctx: SlideContext): Promise<void> {
  writeln();
  await pause(300, ctx);
  await typeLine(`  You ask AI to build a login endpoint.`, ctx, 25);
  await pause(400, ctx);
  writeln();

  writeln(fmtInfo("Running worker..."));
  await spinner("Generating code...", 1200, ctx);
  writeln(fmtSuccess("Worker completed."));
  await pause(400, ctx);
  writeln();

  await typeLine(`  ${pc.dim("Looks good. Tests pass.")}`, ctx, 20);
  await pause(300, ctx);
  await typeLine(`  ${pc.dim("You ship it.")}`, ctx, 20);
  await pause(800, ctx);
  writeln();

  // The failure
  await pause(300, ctx);
  writeln(fmtError(pc.red("Production incident: expired JWT tokens bypass auth")));
  await pause(600, ctx);
  writeln(fmtError(pc.red("No error handling for malformed payloads")));
  await pause(400, ctx);
  writeln(fmtError(pc.red("Edge case: empty string accepted as valid token")));
  await pause(800, ctx);
  writeln();

  await dramatic(`  ${pc.bold(pc.yellow("The AI did the work."))}`, ctx, 35);
  await pause(400, ctx);
  await dramatic(`  ${pc.bold(pc.red("Nobody verified it."))}`, ctx, 35);
  await pause(800, ctx);
}

// ═══════════════════════════════════════════════════════════════════════════
//  ACT III — The Idea
// ═══════════════════════════════════════════════════════════════════════════

async function slideTheIdea(ctx: SlideContext): Promise<void> {
  writeln();
  await pause(400, ctx);

  await whisper("What if there was a second AI...", ctx);
  await pause(600, ctx);
  await whisper("...whose only job was to check the first one's work?", ctx);
  await pause(800, ctx);
  writeln();

  await whisper("And if it failed —", ctx);
  await pause(500, ctx);
  await typeLine(`  ${pc.bold("a third one fixes it.")}`, ctx, 30);
  await pause(500, ctx);
  await whisper("And then the second one checks again.", ctx);
  await pause(800, ctx);
  writeln();

  await pause(300, ctx);
  await typeLine(
    `  ${pc.dim("Execute.")}   ${pc.dim("→")}   ${pc.blue("Verify.")}   ${pc.dim("→")}   ${pc.yellow("Repair.")}   ${pc.dim("→")}   ${pc.green("Verify.")}`,
    ctx,
    12,
  );
  await pause(600, ctx);
  writeln();

  await announce(`  Until it's ${pc.green("right")}.`, ctx);
  await pause(400, ctx);

  await typeLine(`  ${pc.dim("Not \"probably right.\" Not \"looks right.\"")}`, ctx, 20);
  await pause(400, ctx);
  await typeLine(`  ${pc.bold("Verified right.")}`, ctx, 30);
  await pause(600, ctx);
}

// ═══════════════════════════════════════════════════════════════════════════
//  ACT IV — The Proof (live demo)
// ═══════════════════════════════════════════════════════════════════════════

async function slideTheProof(ctx: SlideContext): Promise<void> {
  writeln();
  await pause(300, ctx);
  await typeLine(`  ${pc.dim("One markdown file. One command.")}`, ctx, 22);
  await pause(400, ctx);
  writeln();

  const box = drawBox("Task.md", [
    "",
    `We are building a CLI tool for task execution.`,
    `The auth module uses JWT tokens stored in`,
    `environment variables.`,
    "",
    `${pc.green("- [x]")} First, set up the auth module.`,
    `${pc.dim("- [ ]")} Implement the login endpoint.`,
    "",
  ]);
  await revealLines(box, ctx, 40);
  await pause(500, ctx);

  writeln();
  writeln(fmtCmd("rundown run Task.md -- opencode run"));
  writeln();
  await pause(500, ctx);

  // ── Execute ──
  writeln(fmtInfo(`Next task: ${fmtTaskRef("Task.md", 7, 2, "Implement the login endpoint.")}`));
  await pause(200, ctx);
  await spinner("Executing task...", 1500, ctx, fmtSuccess("Worker completed."));
  await pause(300, ctx);

  // ── Verify — FAIL ──
  await spinner(
    "Running verification...",
    1200,
    ctx,
    fmtWarn("Verification " + pc.yellow("failed") + ": missing error handling for expired tokens."),
  );
  await pause(600, ctx);
  writeln();
  await typeLine(
    `  ${pc.yellow("  ↳")} ${pc.dim("The verifier caught what a human reviewer would.")}`,
    ctx,
    16,
  );
  await pause(600, ctx);
  writeln();

  // ── Repair 1 — FAIL ──
  writeln(fmtInfo("Repair attempt 1/3..."));
  await spinner(
    "Repairing...",
    1000,
    ctx,
    fmtWarn("Repair attempt 1 " + pc.yellow("failed") + ": still missing try/catch around token decode"),
  );
  await pause(400, ctx);

  // ── Repair 2 — SUCCESS ──
  writeln(fmtInfo("Repair attempt 2/3..."));
  await spinner("Repairing...", 1200, ctx, fmtSuccess("Repair succeeded."));
  await pause(300, ctx);

  // ── Verify again — PASS ──
  await spinner("Re-verifying...", 1000, ctx, fmtSuccess("Verification " + pc.green("passed") + "."));
  await pause(400, ctx);
  writeln();

  writeln(fmtSuccess(pc.green(pc.bold("Task checked: Implement the login endpoint."))));
  await pause(300, ctx);
  writeln(fmtSuccess("All tasks completed (2 total)."));
  await pause(600, ctx);
  writeln();

  await typeLine(
    `  ${pc.dim("The expired token bug?")} ${pc.green("Caught.")} ${pc.dim("Fixed.")} ${pc.green("Verified.")}`,
    ctx,
    18,
  );
  await pause(300, ctx);
  await typeLine(`  ${pc.dim("Before it ever left your machine.")}`, ctx, 20);
}

// ═══════════════════════════════════════════════════════════════════════════
//  ACT V — The Workflow
// ═══════════════════════════════════════════════════════════════════════════

async function slideTheWorkflow(ctx: SlideContext): Promise<void> {
  writeln();
  await pause(300, ctx);
  await announce(`  ${pc.dim("But what if you don't know")} what ${pc.dim("to build yet?")}`, ctx);
  await pause(300, ctx);
  writeln();

  // ── research ──
  await typeLine(`  ${pc.bold("Research")} ${pc.dim("— turn a vague idea into a structured document.")}`, ctx, 18);
  await pause(200, ctx);
  writeln(fmtCmd("rundown research Task.md -- opencode run"));
  await spinner("Researching...", 800, ctx, fmtSuccess("Document enriched with 3 new sections."));
  writeln();
  await pause(300, ctx);

  // ── plan ──
  await typeLine(`  ${pc.bold("Plan")} ${pc.dim("— decompose the document into TODO items.")}`, ctx, 18);
  await pause(200, ctx);
  writeln(fmtCmd("rundown plan Task.md -- opencode run"));
  await progressBar(pc.blue("Planning"), ctx, 28, 30);
  writeln(fmtSuccess("Added 4 new TODO items."));
  writeln();
  await pause(200, ctx);

  const box = drawBox("Task.md", [
    "",
    pc.dim("We are building a CLI tool for task execution..."),
    "",
    `${pc.dim("- [ ]")} Set up project structure and deps`,
    `${pc.dim("- [ ]")} Implement auth module with JWT`,
    `${pc.dim("- [ ]")} Add login endpoint with validation`,
    `${pc.dim("- [ ]")} Write integration tests`,
    "",
  ]);
  await revealLines(box, ctx, 35);
  writeln();
  await pause(300, ctx);

  // ── make ──
  await typeLine(
    `  ${pc.bold("Make")} ${pc.dim("— create a file from scratch. Research it. Plan it. One command.")}`,
    ctx,
    16,
  );
  await pause(200, ctx);
  writeln(fmtCmd(`rundown make "Build a REST API" api.md -- opencode run`));
  await spinner(
    "Creating, researching, planning...",
    1500,
    ctx,
    fmtSuccess("api.md created with 6 TODO items."),
  );
  writeln();
  await pause(300, ctx);

  // ── run ──
  await typeLine(
    `  ${pc.bold("Run")} ${pc.dim("— execute every task. Verify every result. Repair every failure.")}`,
    ctx,
    16,
  );
  await pause(200, ctx);
  writeln(fmtCmd("rundown run Task.md -- opencode run"));
  writeln();

  const tasks = [
    "Set up project structure and deps",
    "Implement auth module with JWT",
    "Add login endpoint with validation",
    "Write integration tests",
  ];
  for (let i = 0; i < tasks.length; i++) {
    writeln(fmtInfo(`Next task: ${fmtTaskRef("Task.md", 8 + i, i + 1, tasks[i])}`));
    await sleep(120, ctx);
    writeln(fmtSuccess(`Task checked: ${tasks[i]}`));
    await sleep(80, ctx);
  }
  writeln(fmtSuccess(pc.green("All tasks completed (4 total).")));
  await pause(400, ctx);
}

// ═══════════════════════════════════════════════════════════════════════════
//  ACT VI — The Power (CLI blocks)
// ═══════════════════════════════════════════════════════════════════════════

async function slideThePower(ctx: SlideContext): Promise<void> {
  writeln();
  await pause(300, ctx);
  await typeLine(`  ${pc.dim("Your tasks aren't just text.")}`, ctx, 22);
  await pause(300, ctx);
  await typeLine(`  ${pc.bold("They can run code.")}`, ctx, 28);
  await pause(400, ctx);
  writeln();

  const box = drawBox("Setup.md", [
    "",
    `${pc.dim("- [ ]")} Install dependencies`,
    "",
    `  ${pc.magenta("```cli")}`,
    `  ${pc.dim("cat package.json")}`,
    `  ${pc.dim("npm install")}`,
    `  ${pc.magenta("```")}`,
    "",
    `${pc.dim("- [ ]")} ${pc.yellow("cli:")} npm test`,
    `${pc.dim("- [ ]")} Verify all tests pass`,
    "",
  ]);
  await revealLines(box, ctx, 40);
  await pause(400, ctx);
  writeln();

  await typeLine(
    `  ${pc.magenta("cli")} ${pc.dim("blocks run shell commands and inject output as context.")}`,
    ctx,
    16,
  );
  await pause(200, ctx);
  await typeLine(
    `  ${pc.yellow("cli:")} ${pc.dim("prefix runs the command directly — no AI, no prompt, just a shell.")}`,
    ctx,
    16,
  );
  await pause(400, ctx);
  writeln();

  writeln(fmtCmd("rundown run Setup.md -- opencode run"));
  writeln();
  await pause(300, ctx);

  writeln(fmtInfo(`Next task: ${fmtTaskRef("Setup.md", 2, 1, "Install dependencies")}`));
  await sleep(100, ctx);
  writeln(fmtInfo(`Executing cli block: ${pc.dim("cat package.json")}`));
  await sleep(80, ctx);
  writeln(fmtInfo(`Executing cli block: ${pc.dim("npm install")}`));
  await spinner(
    "Running worker with cli context...",
    800,
    ctx,
    fmtSuccess("Task checked: Install dependencies"),
  );
  writeln(fmtInfo(`Next task: ${fmtTaskRef("Setup.md", 9, 2, "npm test")}`));
  await sleep(100, ctx);
  writeln(fmtInfo(`Executing inline: ${pc.dim("npm test")}`));
  await sleep(200, ctx);
  writeln(fmtSuccess("Task checked: npm test"));
  writeln(fmtInfo(`Next task: ${fmtTaskRef("Setup.md", 10, 3, "Verify all tests pass")}`));
  await spinner("Running worker...", 600, ctx, fmtSuccess("Task checked: Verify all tests pass"));
  writeln(fmtSuccess("All tasks completed (3 total)."));
  await pause(300, ctx);
}

// ═══════════════════════════════════════════════════════════════════════════
//  ACT VII — The Machine (clean runs, caching, rounds)
// ═══════════════════════════════════════════════════════════════════════════

async function slideTheMachine(ctx: SlideContext): Promise<void> {
  writeln();
  await pause(300, ctx);
  await typeLine(`  ${pc.dim("Now imagine running it")} ${pc.bold("three times")}.`, ctx, 22);
  await pause(300, ctx);
  await typeLine(
    `  ${pc.dim("Resetting all checkboxes each round. Reinforcing the result.")}`,
    ctx,
    18,
  );
  await pause(400, ctx);
  writeln();

  writeln(fmtCmd("rundown run --all --clean Setup.md -- opencode run"));
  writeln();
  await pause(400, ctx);

  for (let round = 1; round <= 3; round++) {
    writeln(fmtInfo(`Round ${round}/3 — resetting checkboxes and running all tasks...`));
    if (round === 1) {
      writeln(fmtInfo(`Session cache: ${pc.dim("a7f3c1")} ${pc.dim("(reusing worker context)")}`));
      await sleep(100, ctx);
      writeln(fmtInfo(`cli blocks: ${pc.dim("cached")} (2 commands)`));
    }
    await progressBar(pc.cyan(`  Round ${round}`), ctx, 24, round === 1 ? 40 : 25);
    writeln(fmtSuccess(`Round ${round} completed (3 tasks).`));
    if (round < 3) {
      await pause(200, ctx);
    }
  }
  await pause(300, ctx);
  writeln();
  writeln(fmtSuccess(pc.green(pc.bold("All 3 rounds completed successfully (9 tasks total)."))));
  await pause(600, ctx);
  writeln();

  await typeLine(`  ${pc.dim("Same code. Three independent verification passes.")}`, ctx, 18);
  await pause(300, ctx);
  await typeLine(
    `  ${pc.dim("CLI block output cached. Worker context accumulated per session.")}`,
    ctx,
    18,
  );
  await pause(300, ctx);
  await typeLine(`  ${pc.bold("Not hope.")} ${pc.green("Proof.")}`, ctx, 35);
}

// ═══════════════════════════════════════════════════════════════════════════
//  FINALE — The Banner
// ═══════════════════════════════════════════════════════════════════════════

async function slideFinale(version: string, ctx: SlideContext): Promise<void> {
  writeln();
  await pause(600, ctx);

  for (const line of BANNER_LINES) {
    writeln(pc.cyan(line));
    await sleep(50, ctx);
  }

  await pause(400, ctx);
  writeln();
  writeln(`  ${pc.bold("rundown")} ${pc.dim(`v${version}`)}`);
  writeln();
  await dramatic(`  ${pc.dim("Markdown is no longer where work waits.")}`, ctx, 35);
  await pause(600, ctx);
  await dramatic(`  ${pc.bold("It is where work runs.")}`, ctx, 40);
  await pause(800, ctx);
  writeln();
  await typeLine(`  ${pc.dim("Execute. Verify. Repair. Until it's right.")}`, ctx, 20);
  await pause(400, ctx);
  writeln();
  await typeLine(`  ${pc.cyan("rundown --help")} ${pc.dim("to get started.")}`, ctx, 18);
  writeln();
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function renderIntro(version: string): Promise<number> {
  writeln();

  const slides: Array<(ctx: SlideContext) => Promise<void>> = [
    slideThePromise,
    slideTheProblem,
    slideTheIdea,
    slideTheProof,
    slideTheWorkflow,
    slideThePower,
    slideTheMachine,
  ];

  for (const slide of slides) {
    await runSlide(slide);
  }

  // Finale plays without interactive pause — it's the end.
  const ctx: SlideContext = { skipped: false };
  await slideFinale(version, ctx);

  return 0;
}
