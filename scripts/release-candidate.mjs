import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { relative, join, isAbsolute } from "node:path";
import { runProcess } from "../sources/Process.mjs";
import { npmInvocation } from "./Tooling.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const git = async (args) =>
  (await runProcess("git", args, { cwd: root })).stdout.trim();
const npm = async (args) => {
  const tool = npmInvocation(args);
  return runProcess(tool.command, tool.args, {
    cwd: root,
    timeoutMs: 300000,
    maxBytes: 32 * 1024 * 1024,
  });
};

/** Freeze only committed package inputs. Coordination work elsewhere is not packaged. */
async function freeze() {
  const repository = await git(["rev-parse", "--show-toplevel"]);
  const packagePath = relative(repository, root)
    .split("\\")
    .join("/")
    .replace(/\/$/, "");
  if (packagePath.startsWith("../") || isAbsolute(packagePath))
    throw new Error("Package must belong to its owning Git root");
  // Git interprets ordinary pathspecs relative to cwd; anchor release scopes at
  // the repository root even though this script runs from the package directory.
  const scopes = packagePath
    ? [packagePath, ".github/workflows/rundown.yml"].map(
        (path) => `:(top)${path}`,
      )
    : ["."];
  const clean = async () =>
    !(await git([
      "status",
      "--porcelain=v1",
      "--untracked-files=normal",
      "--",
      ...scopes,
    ]));
  if (!(await clean()))
    throw new Error(
      "Commit the reviewed package and workflow changes before freezing a release candidate",
    );
  const manifest = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  if (!/^\d+\.\d+\.\d+-rc\.\d+$/.test(manifest.version))
    throw new Error("Candidate version must use X.Y.Z-rc.N");
  const commit = await git(["rev-parse", "HEAD"]);
  if (process.argv.includes("--verify-inputs")) {
    process.stdout.write(
      JSON.stringify({
        clean: true,
        commit,
        version: manifest.version,
        sourceDirectory: packagePath || ".",
      }) + "\n",
    );
    return;
  }
  process.stdout.write("Verifying candidate package...\n");
  const checked = await npm(["run", "check"]);
  process.stdout.write(checked.stdout);
  process.stderr.write(checked.stderr);
  const audit = await npm(["audit"]);
  process.stdout.write(audit.stdout);
  if ((await git(["rev-parse", "HEAD"])) !== commit || !(await clean()))
    throw new Error("Release inputs changed during verification");
  const parent = join(root, ".release");
  await mkdir(parent, { recursive: true });
  const temporary = await mkdtemp(join(parent, ".pack-"));
  try {
    const packed = JSON.parse(
      (
        await npm([
          "pack",
          "--ignore-scripts",
          "--json",
          "--pack-destination",
          temporary,
        ])
      ).stdout,
    )[0];
    const data = await readFile(join(temporary, packed.filename));
    const integrity =
      "sha512-" + createHash("sha512").update(data).digest("base64");
    if (integrity !== packed.integrity)
      throw new Error("npm integrity does not match packed bytes");
    if ((await git(["rev-parse", "HEAD"])) !== commit || !(await clean()))
      throw new Error("Release inputs changed during packing");
    const directory = join(
      parent,
      `${manifest.version}-${commit.slice(0, 12)}`,
    );
    // Exclusive directory creation prevents overwriting any prior/partial candidate.
    // manifest.json is published last; a directory without it is not a frozen RC.
    await mkdir(directory);
    await writeFile(join(directory, packed.filename), data, { flag: "wx" });
    const record = {
      name: manifest.name,
      version: manifest.version,
      commit,
      sourceDirectory: packagePath || ".",
      createdAt: new Date().toISOString(),
      tarball: {
        file: packed.filename,
        sha256: createHash("sha256").update(data).digest("hex"),
        integrity,
      },
      runtime: {
        node: process.version,
        npm: (await npm(["--version"])).stdout.trim(),
        platform: process.platform,
        arch: process.arch,
      },
      verification: {
        checks: "npm run check",
        audit: "npm audit",
        platforms: "This runtime only; consult the separate CI matrix",
        liveHarnesses: false,
      },
      files: packed.files.map((file) => ({ path: file.path, size: file.size })),
    };
    await writeFile(
      join(directory, "manifest.json"),
      JSON.stringify(record, null, 2) + "\n",
      { flag: "wx" },
    );
    process.stdout.write(`Frozen candidate: ${directory}\n`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
if (process.argv.slice(2).some((arg) => arg !== "--verify-inputs"))
  throw new Error("Unknown release-candidate option");
freeze().catch((error) => {
  process.stderr.write(String(error.message ?? error) + "\n");
  process.exitCode = 1;
});
