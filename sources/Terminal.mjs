import { stripVTControlCharacters } from "node:util";
import stringWidth from "string-width";
import { parseMarkdown } from "@p10i/do-md/markdown";
import { viewDisplay } from "./Views.mjs";
import { diagnostic } from "./Error.mjs";

/** Terminal control belongs to the host, never to template data. @param {string} text */
const clean = (text) =>
  stripVTControlCharacters(text)
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
    .replaceAll("\t", "    ");
const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Wrap styled text using display columns, retaining renderer-owned SGR sequences.
 * @param {string} text @param {number} width @returns {string[]}
 */
function wrap(text, width) {
  const lines = [];
  let line = "",
    columns = 0;
  for (const token of text.split(/(\x1b\[[0-9;]*m|\n|[^\S\n]+)/)) {
    if (/^\x1b\[/.test(token)) {
      line += token;
      continue;
    }
    if (token === "\n") {
      lines.push(line);
      line = "";
      columns = 0;
      continue;
    }
    const tokenWidth = stringWidth(token);
    if (columns && columns + tokenWidth > width && tokenWidth <= width) {
      lines.push(line.trimEnd());
      line = "";
      columns = 0;
      if (/^\s+$/.test(token)) continue;
    }
    for (const { segment } of segments.segment(token)) {
      if (segment === "\n") {
        lines.push(line);
        line = "";
        columns = 0;
        continue;
      }
      const size = stringWidth(segment);
      if (columns && columns + size > width) {
        lines.push(line);
        line = "";
        columns = 0;
      }
      if (size > width) continue;
      line += segment;
      columns += size;
    }
  }
  lines.push(line);
  return lines;
}

/** Render common Markdown using the existing do-md AST, not another Markdown grammar.
 * @param {string} markdown @param {{width?:number,color?:boolean}} [options]
 */
export function terminalMarkdown(markdown, { width = 80, color = false } = {}) {
  viewDisplay({ width });
  /** @param {string} text @param {string} code */
  const style = (text, code) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
  /** @param {readonly import('@p10i/do-md').MarkdownInlineNode[]} nodes @returns {string} */
  const inline = (nodes) =>
    nodes
      .map((node) => {
        switch (node.type) {
          case "text":
          case "html_inline":
            return clean(node.value);
          case "code_span":
            return style(clean(node.value), "33");
          case "strong":
            return style(inline(node.children), "1");
          case "emphasis":
            return style(inline(node.children), "3");
          case "link":
            return style(`${inline(node.children)} (${clean(node.url)})`, "36");
          case "autolink":
            return style(clean(node.url), "36");
          case "image":
            return `${clean(node.alt)} (${clean(node.url)})`;
          case "hard_break":
            return "\n";
          case "soft_break":
            return " ";
        }
      })
      .join("");
  /** @param {readonly import('@p10i/do-md').MarkdownBlockNode[]} nodes @param {number} available @returns {string} */
  const blocks = (nodes, available) =>
    nodes
      .map((node) => {
        const size = Math.max(1, available);
        switch (node.type) {
          case "heading":
            return wrap(style(inline(node.children), "1;36"), size).join("\n");
          case "paragraph":
            return wrap(inline(node.children), size).join("\n");
          case "code_block":
            return wrap(
              style(clean(node.value).replace(/\n$/, ""), "2"),
              size,
            ).join("\n");
          case "thematic_break":
            return "─".repeat(size);
          case "block_quote":
            return blocks(node.children, size - 2)
              .split("\n")
              .map((line) => `│ ${line}`)
              .join("\n");
          case "list":
            return node.children
              .map((item, index) => {
                const prefix = node.ordered
                  ? `${(node.start ?? 1) + index}. `
                  : "• ";
                const checkbox =
                  item.checked === null ? "" : item.checked ? "[x] " : "[ ] ";
                return blocks(
                  item.children,
                  size - stringWidth(prefix + checkbox),
                )
                  .split("\n")
                  .map(
                    (line, index) =>
                      (index
                        ? " ".repeat(stringWidth(prefix + checkbox))
                        : prefix + checkbox) + line,
                  )
                  .join("\n");
              })
              .join("\n");
          case "list_item":
            return blocks(node.children, size);
          case "table": {
            const count = node.headers.length;
            const cellWidth = Math.floor(
              (size - (count - 1) * 3) / Math.max(1, count),
            );
            if (cellWidth < 3)
              return node.rows
                .map((row) =>
                  row
                    .map((cell, index) =>
                      wrap(
                        `${inline(node.headers[index]?.children ?? [])}: ${inline(cell.children)}`,
                        size,
                      ).join("\n"),
                    )
                    .join("\n"),
                )
                .join("\n\n");
            const row = (
              /** @type {import('@p10i/do-md').TableCell[]} */ cells,
            ) => {
              const values = Array.from({ length: count }, (_, index) =>
                wrap(inline(cells[index]?.children ?? []), cellWidth),
              );
              const height = Math.max(
                1,
                ...values.map((value) => value.length),
              );
              return Array.from({ length: height }, (_, line) =>
                values
                  .map((value, index) => {
                    const text = value[line] ?? "";
                    const padding = Math.max(0, cellWidth - stringWidth(text));
                    return node.align[index] === "right"
                      ? " ".repeat(padding) + text
                      : text + " ".repeat(padding);
                  })
                  .join(" │ "),
              ).join("\n");
            };
            return [
              style(row(node.headers), "1"),
              Array(count).fill("─".repeat(cellWidth)).join("─┼─"),
              ...node.rows.map(row),
            ].join("\n");
          }
          case "frontmatter":
            return "";
          case "raw":
          case "html_block":
            return wrap(clean(node.value), size).join("\n");
        }
      })
      .filter(Boolean)
      .join("\n\n");
  return blocks(parseMarkdown(markdown).children, width)
    .split("\n")
    .flatMap((line) => wrap(line, width))
    .join("\n");
}

/** One CLI invocation owns output routing. Exporters/sinks are never suppressed.
 * Streams are injectable for terminal contract tests; inherited child fds bypass JS.
 */
export class TerminalHost {
  /** @param {{json?:boolean,markdown?:boolean,fullscreen?:boolean,logs?:'show'|'hide',stdout?:NodeJS.WriteStream,stderr?:NodeJS.WriteStream,env?:NodeJS.ProcessEnv}} [options] */
  constructor({
    json = false,
    markdown = false,
    fullscreen,
    logs,
    stdout = process.stdout,
    stderr = process.stderr,
    env = process.env,
  } = {}) {
    this.stdout = stdout;
    this.stderr = stderr;
    this.json = json;
    this.markdown = markdown;
    this.override = { fullscreen, logs };
    this.color = env.NO_COLOR === undefined && env.TERM !== "dumb";
    this.interactive = Boolean(
      stdout.isTTY && stderr.isTTY && env.TERM !== "dumb" && !json && !markdown,
    );
    this.originalOut = stdout.write;
    this.originalErr = stderr.write;
    this.rawOut = stdout.write.bind(stdout);
    this.rawErr = stderr.write.bind(stderr);
    /** @type {import('./ViewTypes.mjs').LiveView|undefined} */ this.view =
      undefined;
    this.fullscreen = false;
    this.lines = 0;
    /** @type {string[]} */ this.logs = [];
    /** @type {ReturnType<typeof setImmediate>|undefined} */ this.scheduled =
      undefined;
    /** @type {(()=>void)|undefined} */ this.unsubscribe = undefined;
    this.closed = false;
    this.exit = () => {
      try {
        this.close();
      } catch {
        /* Restore controls even during a process-level deadline exit. */
      }
    };
    process.once("exit", this.exit);
    this.resize = () => this.schedule();
    /** @param {'out'|'err'} channel */
    const intercept = (channel) =>
      /** @type {NodeJS.WriteStream['write']} */ (
        (chunk, encoding, callback) => {
          if (this.closed || !this.view || !this.interactive) {
            const write =
              channel === "out" && !this.json && !this.markdown
                ? this.rawOut
                : this.rawErr;
            // Preserve native bytes, callback overloads and backpressure outside
            // the live region, including commands that never return a view.
            return Reflect.apply(write, undefined, [chunk, encoding, callback]);
          }
          const cb = typeof encoding === "function" ? encoding : callback;
          const text =
            typeof chunk === "string"
              ? chunk
              : Buffer.from(chunk).toString(
                  typeof encoding === "string" ? encoding : "utf8",
                );
          this.output(channel, text);
          if (cb) queueMicrotask(cb);
          return true;
        }
      );
    stdout.write = intercept("out");
    stderr.write = intercept("err");
  }
  /** @returns {import('./ViewTypes.mjs').ViewPresentation} */
  presentation() {
    return {
      fullscreen:
        this.override.fullscreen ?? this.view?.presentation.fullscreen ?? false,
      logs: this.override.logs ?? this.view?.presentation.logs ?? "show",
    };
  }
  /** @param {'out'|'err'} channel @param {string} text */
  output(channel, text) {
    if (this.closed || !this.view || !this.interactive) {
      (channel === "out" && !this.json && !this.markdown
        ? this.rawOut
        : this.rawErr)(text);
      return;
    }
    if (this.presentation().logs === "hide") return;
    if (this.fullscreen) {
      this.logs.push(...clean(text).replace(/\n$/, "").split("\n"));
      this.logs = this.logs.slice(-200);
      this.schedule();
    } else {
      this.clear();
      (channel === "out" ? this.rawOut : this.rawErr)(text);
      if (!text.endsWith("\n")) this.rawOut("\n");
      this.schedule();
    }
  }
  /** @param {import('./ViewTypes.mjs').LiveView} view */
  mount(view) {
    this.view = view;
    if (!this.interactive) return;
    this.unsubscribe = view.subscribe(() => this.schedule());
    this.stdout.on("resize", this.resize);
    this.draw();
  }
  schedule() {
    if (this.scheduled || this.closed) return;
    this.scheduled = setImmediate(() => {
      this.scheduled = undefined;
      try {
        this.draw();
      } catch (error) {
        this.view?.fail(error);
      }
    });
  }
  clear() {
    if (this.lines) this.rawOut(`\r\x1b[${this.lines}A\x1b[J`);
    this.lines = 0;
  }
  display() {
    return viewDisplay({
      width: this.stdout.columns || 80,
      height: this.stdout.rows || 24,
    });
  }
  draw() {
    if (!this.view || !this.interactive || this.closed) return;
    const display = this.display();
    const presentation = this.presentation();
    const rendered = terminalMarkdown(this.view.render(display), {
      width: display.width,
      color: this.color,
    });
    if (presentation.fullscreen !== this.fullscreen) {
      this.clear();
      this.rawOut(
        presentation.fullscreen
          ? "\x1b[?1049h\x1b[?25l"
          : "\x1b[?25h\x1b[?1049l",
      );
      this.fullscreen = presentation.fullscreen;
    }
    if (this.fullscreen) {
      this.rawOut("\x1b[H\x1b[2J");
      const logHeight =
        presentation.logs === "show"
          ? Math.max(0, Math.floor(display.height / 3))
          : 0;
      const logs = this.logs
        .flatMap((line) => wrap(line, display.width))
        .slice(-logHeight);
      const visibleLogs = logHeight ? logs : [];
      const frame = [
        ...visibleLogs,
        ...rendered
          .split("\n")
          .slice(0, Math.max(0, display.height - visibleLogs.length - 1)),
      ];
      this.rawOut(frame.join("\n") + (this.color ? "\x1b[0m" : ""));
    } else {
      this.clear();
      const frame = rendered
        .split("\n")
        .slice(0, Math.max(1, display.height - 1));
      this.rawOut(frame.join("\n") + (this.color ? "\x1b[0m" : "") + "\n");
      this.lines = frame.length;
    }
  }
  /** Restore streams and terminal even if final rendering fails. */
  /** @param {import('./Error.mjs').RundownError} [primary] */
  close(primary) {
    try {
      this.finish();
    } catch (error) {
      if (!primary) throw error;
      primary.related.push(diagnostic(error, primary.invocationId));
    }
  }
  finish() {
    if (this.closed) return;
    this.closed = true;
    process.off("exit", this.exit);
    clearImmediate(this.scheduled);
    this.unsubscribe?.();
    this.stdout.off("resize", this.resize);
    this.stdout.write = this.originalOut;
    this.stderr.write = this.originalErr;
    if (!this.interactive || !this.view) return;
    this.clear();
    if (this.fullscreen) this.rawOut("\x1b[?25h\x1b[?1049l");
    try {
      const display = this.display();
      this.rawOut(
        terminalMarkdown(this.view.render(display), {
          width: display.width,
          color: this.color,
        }) +
          (this.color ? "\x1b[0m" : "") +
          "\n",
      );
    } catch (error) {
      if (this.view.state === "closed") throw error;
    }
  }
}
