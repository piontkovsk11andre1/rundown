import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { stripVTControlCharacters } from "node:util";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import stringWidth from "string-width";
import { View } from "../sources/Views.mjs";
import { TerminalHost, terminalMarkdown } from "../sources/Terminal.mjs";
import { runProcess } from "../sources/Process.mjs";

class Stream extends EventEmitter {
  isTTY = true;
  columns = 40;
  rows = 12;
  text = "";
  write(chunk, encoding, callback) {
    this.text += String(chunk);
    (typeof encoding === "function" ? encoding : callback)?.();
    return true;
  }
}
const turn = () => new Promise((resolve) => setImmediate(resolve));
const source =
  "# Report\n\n{% doc.write(ctx.data.status); %}\n\nWidth {% doc.write(ctx.display.width); %}\n";

test("terminal Markdown renders headings, tables, nested content and Unicode within display width", () => {
  const input =
    "# Heading\n\n**Bold** and `code` with [link](https://example.test)\n\n- [x] Done\n- Item\n\n> Quote\n\n| Name | Value |\n| --- | --- |\n| 界界界 | 👩‍💻👩‍💻 |\n\n```js\nconsole.log('example');\n```\n";
  for (const width of [1, 10, 35]) {
    const text = terminalMarkdown(input, { width, color: true });
    assert.ok(text.includes("\x1b["));
    for (const line of text.split("\n"))
      assert.ok(stringWidth(line) <= width, JSON.stringify(line));
  }
  const plain = terminalMarkdown(input);
  assert.ok(!plain.includes("\x1b"));
  assert.match(plain, /Heading/);
  assert.match(plain, /\[x\] Done/);
  assert.ok(
    !terminalMarkdown("Bad\x1b[2J\x1b]0;title\x07 text").includes("\x1b"),
  );
});

test("inline host coalesces state changes, redraws after logs and handles resize without state mutations", async () => {
  const stdout = new Stream(),
    stderr = new Stream();
  const original = stdout.write;
  const host = new TerminalHost({ stdout, stderr, env: {} });
  const view = new View(source, { status: "First" });
  try {
    host.mount(view);
    view.update({ status: "Intermediate" });
    view.update({ status: "Latest" });
    stderr.write("progress\n");
    await turn();
    assert.ok(!stdout.text.includes("Intermediate"));
    assert.match(stdout.text, /Latest/);
    assert.equal(stderr.text, "progress\n");
    const revision = view.revision;
    stdout.columns = 20;
    stdout.emit("resize");
    await turn();
    assert.match(stdout.text, /Width 20/);
    assert.equal(view.revision, revision);
    view.close();
  } finally {
    host.close();
  }
  assert.equal(stdout.write, original);
  assert.equal(stdout.listenerCount("resize"), 0);
});

test("full-screen mode has bounded logs, supports visibility changes and restores the terminal", async () => {
  const stdout = new Stream(),
    stderr = new Stream();
  const host = new TerminalHost({ stdout, stderr, env: { NO_COLOR: "" } });
  const view = new View(source, { status: "Live" }, { fullscreen: true });
  try {
    host.mount(view);
    stderr.write("hidden progress\n");
    assert.ok(!stdout.text.includes("hidden progress"));
    view.configure({ logs: "show" });
    for (let index = 0; index < 250; index++) stderr.write(`log ${index}\n`);
    await turn();
    assert.ok(host.logs.length <= 200);
    assert.match(stdout.text, /log 249/);
    assert.match(stdout.text, /\x1b\[\?1049h/);
    assert.ok(
      !stdout.text.includes("\x1b[1;36m"),
      "NO_COLOR suppresses styling, not cursor ownership",
    );
    view.fail(new Error("failed work"));
  } finally {
    host.close();
  }
  assert.match(stdout.text, /\x1b\[\?25h\x1b\[\?1049l/);
  assert.match(stripVTControlCharacters(stdout.text), /Live/);
  assert.equal(stderr.text, "");
});

test("JSON output routes direct stdout to stderr and never mounts an interactive screen", () => {
  const stdout = new Stream(),
    stderr = new Stream();
  const host = new TerminalHost({ stdout, stderr, json: true });
  const view = new View(source, { status: "Data" }, { fullscreen: true });
  try {
    stdout.write("console output\n");
    host.mount(view);
    stdout.write("more output\n");
    view.close();
  } finally {
    host.close();
  }
  assert.equal(stdout.text, "");
  assert.equal(stderr.text, "console output\nmore output\n");
});

test("terminal restoration is reliable when a template fails during mounting", () => {
  const stdout = new Stream(),
    stderr = new Stream();
  const originalOut = stdout.write,
    originalErr = stderr.write;
  const host = new TerminalHost({ stdout, stderr });
  const view = new View(
    "{% throw new Error('render failure'); %}",
    {},
    { fullscreen: true },
  );
  try {
    assert.throws(() => host.mount(view), /render failure/);
    view.fail(new Error("render failure"));
  } finally {
    host.close();
  }
  assert.equal(stdout.write, originalOut);
  assert.equal(stderr.write, originalErr);
});

const hasPty =
  process.platform !== "win32" &&
  spawnSync("python3", ["-c", "import pty"]).status === 0;
test(
  "CLI full-screen presentation runs in a real pseudo-terminal",
  { skip: !hasPty },
  async () => {
    const cwd = fileURLToPath(new URL("../examples/views/", import.meta.url));
    const bin = fileURLToPath(new URL("../bin/rundown.mjs", import.meta.url));
    const bridge = `import os, pty, sys, subprocess, fcntl, termios, struct
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
child = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave)
os.close(slave)
while True:
    try:
        chunk = os.read(master, 65536)
    except OSError:
        break
    if not chunk:
        break
    sys.stdout.buffer.write(chunk)
    sys.stdout.buffer.flush()
os.close(master)
sys.exit(child.wait())`;
    const result = await runProcess(
      "python3",
      [
        "-c",
        bridge,
        process.execPath,
        bin,
        "--cwd",
        cwd,
        "--fullscreen",
        "--logs",
        "show",
        "report",
      ],
      { cwd, env: { ...process.env, TERM: "xterm-256color" } },
    );
    assert.match(result.stdout, /\x1b\[\?1049h/);
    assert.match(result.stdout, /\x1b\[\?1049l/);
    assert.match(stripVTControlCharacters(result.stdout), /Completed/);
    assert.match(stripVTControlCharacters(result.stdout), /Processed\s+item/);
  },
);
