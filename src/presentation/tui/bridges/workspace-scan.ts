// @ts-nocheck
import fs from "node:fs/promises";
import { resolveSources } from "../../../infrastructure/sources.js";

const FRONTMATTER_BOUNDARY = "---";
const FRONTMATTER_PROFILE_PATTERN = /^profile:\s*(.+?)\s*$/;
const DIRECTIVE_PROFILE_PATTERN = /^\s*-\s+profile=(.+?)\s*$/;
const CHECKBOX_TASK_PATTERN = /^\s*-\s+\[(?: |x|X)\]\s+(.+)$/;
const PROFILE_PREFIX_SEGMENT_PATTERN = /(?:^|[;,]\s)profile=([^,;]+?)(?=$|[;,]\s)/g;

function toNonEmptyString(value) {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : "";
}

function splitLines(markdownSource) {
  if (typeof markdownSource !== "string" || markdownSource.length === 0) {
    return [];
  }
  return markdownSource.split(/\r?\n/);
}

function collectFrontmatterReferences(lines, filePath) {
  const references = [];
  if (!Array.isArray(lines) || lines.length === 0) {
    return references;
  }

  if ((lines[0] ?? "").trim() !== FRONTMATTER_BOUNDARY) {
    return references;
  }

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() === FRONTMATTER_BOUNDARY) {
      break;
    }

    const profileMatch = line.match(FRONTMATTER_PROFILE_PATTERN);
    if (!profileMatch) {
      continue;
    }

    const profileName = toNonEmptyString(profileMatch[1]);
    if (!profileName) {
      continue;
    }

    references.push({
      profile: profileName,
      file: filePath,
      line: index + 1,
      kind: "frontmatter",
    });
  }

  return references;
}

function collectDirectiveReference(line, filePath, lineNumber) {
  const directiveMatch = line.match(DIRECTIVE_PROFILE_PATTERN);
  if (!directiveMatch) {
    return [];
  }

  const profileName = toNonEmptyString(directiveMatch[1]);
  if (!profileName) {
    return [];
  }

  return [{
    profile: profileName,
    file: filePath,
    line: lineNumber,
    kind: "directive",
  }];
}

function collectPrefixReferences(line, filePath, lineNumber) {
  const checkboxMatch = line.match(CHECKBOX_TASK_PATTERN);
  if (!checkboxMatch) {
    return [];
  }

  const taskText = checkboxMatch[1] ?? "";
  const references = [];
  PROFILE_PREFIX_SEGMENT_PATTERN.lastIndex = 0;
  let segmentMatch = PROFILE_PREFIX_SEGMENT_PATTERN.exec(taskText);
  while (segmentMatch) {
    const profileName = toNonEmptyString(segmentMatch[1]);
    if (profileName) {
      references.push({
        profile: profileName,
        file: filePath,
        line: lineNumber,
        kind: "prefix",
      });
    }
    segmentMatch = PROFILE_PREFIX_SEGMENT_PATTERN.exec(taskText);
  }

  return references;
}

function collectReferencesFromMarkdown(markdownSource, filePath) {
  const lines = splitLines(markdownSource);
  if (lines.length === 0) {
    return [];
  }

  const references = [
    ...collectFrontmatterReferences(lines, filePath),
  ];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const lineNumber = index + 1;
    references.push(...collectDirectiveReference(line, filePath, lineNumber));
    references.push(...collectPrefixReferences(line, filePath, lineNumber));
  }

  return references;
}

export function createWorkspaceScanBridge({
  cwd = process.cwd(),
  source,
  sourceResolver = resolveSources,
  readFile = (filePath) => fs.readFile(filePath, "utf8"),
} = {}) {
  async function scanProfileReferences({ sourcePath } = {}) {
    const scanSource = typeof sourcePath === "string" && sourcePath.length > 0
      ? sourcePath
      : (typeof source === "string" && source.length > 0 ? source : cwd);
    const markdownFiles = await sourceResolver(scanSource);
    const references = [];

    for (const filePath of markdownFiles) {
      if (typeof filePath !== "string" || filePath.length === 0) {
        continue;
      }

      const markdownSource = await readFile(filePath);
      references.push(...collectReferencesFromMarkdown(markdownSource, filePath));
    }

    return references;
  }

  return {
    scanProfileReferences,
  };
}
