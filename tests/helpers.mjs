import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
  cp,
  copyFile,
  access,
} from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
export async function workspace(t, files = {}) {
  // Catalog/test fixtures declare their package entry explicitly; empty fixtures
  // remain genuinely uninitialized for onboarding and discovery tests.
  if (!Object.hasOwn(files, "package.json")) {
    const commands = Object.hasOwn(files, "commands.md");
    const tests = Object.keys(files).some((file) => file.startsWith("tests/"));
    if (commands || tests)
      files = {
        "package.json": JSON.stringify({
          private: true,
          type: "module",
          rundown: {
            ...(commands ? { commands: "./commands.md" } : {}),
            ...(tests ? { tests: "./tests" } : {}),
          },
        }),
        ...files,
      };
  }
  const base = fileURLToPath(new URL("../.test-tmp/", import.meta.url));
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [name, source] of Object.entries(files)) {
    await mkdir(dirname(join(directory, name)), { recursive: true });
    await writeFile(join(directory, name), source);
  }
  return directory;
}
export const emptyParams =
  "| Name | Type | Required | Default | Description |\n| --- | --- | --- | --- | --- |";

/** Source fixtures are copied explicitly; initialization only registers them. */
export async function copyGreeting(cwd) {
  await cp(
    new URL("../examples/greeting/example/", import.meta.url),
    join(cwd, "example"),
    { recursive: true, errorOnExist: true, force: false },
  );
  await cp(
    new URL("../examples/greeting/tests/", import.meta.url),
    join(cwd, "tests"),
    { recursive: true, errorOnExist: true, force: false },
  );
  await copyFile(
    new URL("../examples/greeting/commands.md", import.meta.url),
    join(cwd, "commands.md"),
  );
  try {
    await access(join(cwd, "package.json"));
  } catch {
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({ private: true, type: "module" }),
      { flag: "wx" },
    );
  }
}
export function method(
  name,
  body,
  {
    parameters = emptyParams,
    options = "",
    returns = "string",
    description = "A documented method.\n\nAdditional explanation.",
  } = {},
) {
  return `## Method: ${name}\n\n${description}\n\n${options}### Parameters\n\n${parameters}\n\n### Returns\n\n| Type | Description |\n| --- | --- |\n| \`${returns}\` | Result. |\n\n### Implementation\n\n\`\`\`js\n${body}\n\`\`\`\n`;
}
export function moduleFile(body, options = {}) {
  return "# Test module\n\nA module.\n\n" + method("run", body, options);
}
export function commandFile(
  body,
  {
    name = "test",
    options = "",
    parameters = "| Name | Type | Required | Default | CLI | Description |\n| --- | --- | --- | --- | --- | --- |",
    extra = "",
  } = {},
) {
  return `# Commands\n\n## Command: ${name}\n\nA test command.\n\n${options}### Parameters\n\n${parameters}\n\n${extra}### Returns\n\n| Type | Description |\n| --- | --- |\n| object | Result. |\n\n### Handler\n\n\`\`\`js\n${body}\n\`\`\`\n`;
}
export const objectSchema = {
  type: "object",
  properties: { value: { type: "integer" } },
  required: ["value"],
  additionalProperties: false,
};
export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
