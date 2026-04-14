import { CONFIG_DIR_NAME } from "./ports/config-dir-port.js";
import type { FileSystem } from "./ports/file-system.js";
import type { PathOperationsPort } from "./ports/path-operations-port.js";

export const WORKSPACE_LINK_FILE_NAME = "workspace.link";
export const WORKSPACE_LINK_RELATIVE_PATH = `${CONFIG_DIR_NAME}/${WORKSPACE_LINK_FILE_NAME}`;
export const WORKSPACE_LINK_SCHEMA_VERSION = 1 as const;

export type WorkspaceLinkSourceFormat = "legacy-single-path" | "multi-record-v1";

export interface WorkspaceLinkRecord {
  id: string;
  workspacePath: string;
  default?: boolean;
}

export interface WorkspaceLinkDocumentV1 {
  schemaVersion: typeof WORKSPACE_LINK_SCHEMA_VERSION;
  records: WorkspaceLinkRecord[];
  defaultRecordId?: string;
}

export interface CanonicalWorkspaceLinkRecord {
  id: string;
  workspacePath: string;
  isDefault: boolean;
}

export interface CanonicalWorkspaceLinkSchema {
  schemaVersion: typeof WORKSPACE_LINK_SCHEMA_VERSION;
  sourceFormat: WorkspaceLinkSourceFormat;
  records: CanonicalWorkspaceLinkRecord[];
  defaultRecordId?: string;
  requiresWorkspaceSelection: boolean;
}

export type WorkspaceLinkSchemaErrorReason =
  | "empty"
  | "absolute"
  | "malformed"
  | "unsupported-schema"
  | "invalid-record"
  | "duplicate-record-id"
  | "missing-default-record"
  | "multiple-default-records"
  | "conflicting-default-markers";

export type ParseWorkspaceLinkSchemaResult =
  | {
    status: "ok";
    schema: CanonicalWorkspaceLinkSchema;
  }
  | {
    status: "error";
    reason: WorkspaceLinkSchemaErrorReason;
    message: string;
  };

export type WorkspaceLinkInvalidReason =
  | "empty"
  | "absolute"
  | "malformed"
  | "ambiguous"
  | "target-missing"
  | "target-not-directory";

export type WorkspaceLinkResolution =
  | {
    status: "absent";
    linkPath: string;
  }
  | {
    status: "invalid";
    linkPath: string;
    relativeTarget: string;
    reason: WorkspaceLinkInvalidReason;
  }
  | {
    status: "resolved";
    linkPath: string;
    relativeTarget: string;
    workspaceRoot: string;
  };

export interface ResolveWorkspaceLinkInput {
  currentDir: string;
  fileSystem: FileSystem;
  pathOperations: PathOperationsPort;
}

export interface ResolveEffectiveWorkspaceRootInput extends ResolveWorkspaceLinkInput {
  maxHops?: number;
}

export function parseWorkspaceLinkSchema(rawContent: string): ParseWorkspaceLinkSchemaResult {
  const trimmedContent = rawContent.trim();
  if (trimmedContent.length === 0) {
    return {
      status: "error",
      reason: "empty",
      message: "workspace.link cannot be empty.",
    };
  }

  if (!trimmedContent.startsWith("{")) {
    const normalizedPath = normalizeRelativeWorkspacePath(trimmedContent);
    if (normalizedPath.status === "error") {
      return normalizedPath;
    }

    return {
      status: "ok",
      schema: {
        schemaVersion: WORKSPACE_LINK_SCHEMA_VERSION,
        sourceFormat: "legacy-single-path",
        records: [{
          id: "default",
          workspacePath: normalizedPath.workspacePath,
          isDefault: true,
        }],
        defaultRecordId: "default",
        requiresWorkspaceSelection: false,
      },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmedContent);
  } catch {
    return {
      status: "error",
      reason: "malformed",
      message: "workspace.link JSON is not valid.",
    };
  }

  if (!isPlainObject(parsed)) {
    return {
      status: "error",
      reason: "malformed",
      message: "workspace.link JSON must be an object.",
    };
  }

  const schemaVersion = parsed.schemaVersion;
  if (schemaVersion !== WORKSPACE_LINK_SCHEMA_VERSION) {
    return {
      status: "error",
      reason: "unsupported-schema",
      message: `workspace.link schemaVersion ${String(schemaVersion)} is not supported.`,
    };
  }

  const recordsValue = parsed.records;
  if (!Array.isArray(recordsValue) || recordsValue.length === 0) {
    return {
      status: "error",
      reason: "invalid-record",
      message: "workspace.link requires a non-empty records array.",
    };
  }

  const records: CanonicalWorkspaceLinkRecord[] = [];
  const seenIds = new Set<string>();

  for (const rawRecord of recordsValue) {
    if (!isPlainObject(rawRecord)) {
      return {
        status: "error",
        reason: "invalid-record",
        message: "workspace.link records must be objects.",
      };
    }

    const id = typeof rawRecord.id === "string"
      ? rawRecord.id.trim()
      : "";
    if (!isValidWorkspaceRecordId(id)) {
      return {
        status: "error",
        reason: "invalid-record",
        message: "workspace.link record id must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/.",
      };
    }

    if (seenIds.has(id)) {
      return {
        status: "error",
        reason: "duplicate-record-id",
        message: `workspace.link record id \"${id}\" is duplicated.`,
      };
    }
    seenIds.add(id);

    if (typeof rawRecord.workspacePath !== "string") {
      return {
        status: "error",
        reason: "invalid-record",
        message: `workspace.link record \"${id}\" must include workspacePath as a string.`,
      };
    }

    const normalizedPath = normalizeRelativeWorkspacePath(rawRecord.workspacePath);
    if (normalizedPath.status === "error") {
      return normalizedPath;
    }

    records.push({
      id,
      workspacePath: normalizedPath.workspacePath,
      isDefault: rawRecord.default === true,
    });
  }

  const explicitDefaultRecordId = typeof parsed.defaultRecordId === "string"
    ? parsed.defaultRecordId.trim()
    : undefined;
  const markedDefaultRecords = records.filter((record) => record.isDefault);

  if (markedDefaultRecords.length > 1) {
    return {
      status: "error",
      reason: "multiple-default-records",
      message: "workspace.link can mark at most one record as default.",
    };
  }

  let resolvedDefaultRecordId = explicitDefaultRecordId;
  if (resolvedDefaultRecordId !== undefined && resolvedDefaultRecordId.length === 0) {
    resolvedDefaultRecordId = undefined;
  }

  if (resolvedDefaultRecordId !== undefined && !seenIds.has(resolvedDefaultRecordId)) {
    return {
      status: "error",
      reason: "missing-default-record",
      message: `workspace.link defaultRecordId \"${resolvedDefaultRecordId}\" does not match any record id.`,
    };
  }

  const markedDefaultRecord = markedDefaultRecords[0];
  if (resolvedDefaultRecordId === undefined && markedDefaultRecord) {
    resolvedDefaultRecordId = markedDefaultRecord.id;
  }

  if (
    resolvedDefaultRecordId !== undefined
    && markedDefaultRecord
    && markedDefaultRecord.id !== resolvedDefaultRecordId
  ) {
    return {
      status: "error",
      reason: "conflicting-default-markers",
      message: "workspace.link defaultRecordId conflicts with record.default marker.",
    };
  }

  const normalizedRecords = records.map((record) => ({
    ...record,
    isDefault: resolvedDefaultRecordId !== undefined && record.id === resolvedDefaultRecordId,
  }));

  return {
    status: "ok",
    schema: {
      schemaVersion: WORKSPACE_LINK_SCHEMA_VERSION,
      sourceFormat: "multi-record-v1",
      records: normalizedRecords,
      defaultRecordId: resolvedDefaultRecordId,
      requiresWorkspaceSelection: normalizedRecords.length > 1 && resolvedDefaultRecordId === undefined,
    },
  };
}

export function serializeWorkspaceLinkSchema(input: {
  records: Array<{ id: string; workspacePath: string; isDefault?: boolean }>;
  defaultRecordId?: string;
  sourceFormat?: WorkspaceLinkSourceFormat;
}): string {
  const parsed = parseWorkspaceLinkSchema(JSON.stringify({
    schemaVersion: WORKSPACE_LINK_SCHEMA_VERSION,
    records: input.records.map((record) => ({
      id: record.id,
      workspacePath: record.workspacePath,
      default: record.isDefault === true,
    })),
    defaultRecordId: input.defaultRecordId,
  }));

  if (parsed.status === "error") {
    throw new Error(parsed.message);
  }

  if (input.sourceFormat === "legacy-single-path") {
    if (parsed.schema.records.length !== 1) {
      throw new Error("legacy workspace.link format supports exactly one record.");
    }

    const legacyRecord = parsed.schema.records[0];
    if (!legacyRecord) {
      throw new Error("legacy workspace.link format requires a single workspace record.");
    }

    return `${legacyRecord.workspacePath}\n`;
  }

  const document: WorkspaceLinkDocumentV1 = {
    schemaVersion: WORKSPACE_LINK_SCHEMA_VERSION,
    records: parsed.schema.records.map((record) => ({
      id: record.id,
      workspacePath: record.workspacePath,
      ...(record.isDefault ? { default: true } : {}),
    })),
    ...(parsed.schema.defaultRecordId !== undefined
      ? { defaultRecordId: parsed.schema.defaultRecordId }
      : {}),
  };

  return JSON.stringify(document, null, 2) + "\n";
}

/**
 * Resolves a linked workspace root from `.rundown/workspace.link`.
 *
 * The link file stores a relative path from the invocation directory
 * (`currentDir`) to the intended workspace root.
 */
export function resolveWorkspaceLink(input: ResolveWorkspaceLinkInput): WorkspaceLinkResolution {
  const currentDir = input.pathOperations.resolve(input.currentDir);
  const linkPath = input.pathOperations.join(currentDir, CONFIG_DIR_NAME, WORKSPACE_LINK_FILE_NAME);
  const linkStats = input.fileSystem.stat(linkPath);

  if (linkStats === null || !linkStats.isFile) {
    return {
      status: "absent",
      linkPath,
    };
  }

  const parsedSchema = parseWorkspaceLinkSchema(input.fileSystem.readText(linkPath));
  if (parsedSchema.status === "error") {
    const reason = parsedSchema.reason === "empty"
      ? "empty"
      : parsedSchema.reason === "absolute"
        ? "absolute"
        : "malformed";
    return {
      status: "invalid",
      linkPath,
      relativeTarget: "",
      reason,
    };
  }

  const selectedRecord = parsedSchema.schema.defaultRecordId !== undefined
    ? parsedSchema.schema.records.find((record) => record.id === parsedSchema.schema.defaultRecordId)
    : parsedSchema.schema.records.length === 1
      ? parsedSchema.schema.records[0]
      : undefined;

  if (!selectedRecord) {
    return {
      status: "invalid",
      linkPath,
      relativeTarget: "",
      reason: "ambiguous",
    };
  }

  const relativeTarget = selectedRecord.workspacePath;

  const workspaceRoot = input.pathOperations.resolve(currentDir, relativeTarget);
  const workspaceStats = input.fileSystem.stat(workspaceRoot);
  if (workspaceStats === null) {
    return {
      status: "invalid",
      linkPath,
      relativeTarget,
      reason: "target-missing",
    };
  }

  if (!workspaceStats.isDirectory) {
    return {
      status: "invalid",
      linkPath,
      relativeTarget,
      reason: "target-not-directory",
    };
  }

  return {
    status: "resolved",
    linkPath,
    relativeTarget,
    workspaceRoot,
  };
}

function normalizeRelativeWorkspacePath(value: string):
  | { status: "ok"; workspacePath: string }
  | { status: "error"; reason: WorkspaceLinkSchemaErrorReason; message: string } {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return {
      status: "error",
      reason: "empty",
      message: "workspace path cannot be empty.",
    };
  }

  const unifiedSeparators = trimmed.replace(/\\/g, "/");
  if (isAbsoluteWorkspacePath(unifiedSeparators)) {
    return {
      status: "error",
      reason: "absolute",
      message: "workspace path must be relative.",
    };
  }

  const segments = unifiedSeparators.split("/");
  const normalizedSegments: string[] = [];
  for (const segment of segments) {
    if (segment.length === 0 || segment === ".") {
      continue;
    }

    if (segment === "..") {
      const lastSegment = normalizedSegments[normalizedSegments.length - 1];
      if (lastSegment && lastSegment !== "..") {
        normalizedSegments.pop();
      } else {
        normalizedSegments.push("..");
      }
      continue;
    }

    normalizedSegments.push(segment);
  }

  return {
    status: "ok",
    workspacePath: normalizedSegments.length > 0 ? normalizedSegments.join("/") : ".",
  };
}

function isAbsoluteWorkspacePath(value: string): boolean {
  return value.startsWith("/") || value.startsWith("//") || /^[A-Za-z]:\//.test(value);
}

function isValidWorkspaceRecordId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resolves the effective workspace root by following workspace.link chains.
 *
 * If the initial directory is not linked (or the link is invalid), this returns
 * the normalized current directory. When links chain through multiple
 * workspaces, traversal stops at the first directory without a valid link.
 */
export function resolveEffectiveWorkspaceRoot(input: ResolveEffectiveWorkspaceRootInput): string {
  const maxHops = Math.max(1, input.maxHops ?? 32);
  let workspaceRoot = input.pathOperations.resolve(input.currentDir);
  const visited = new Set<string>([workspaceRoot]);

  for (let hop = 0; hop < maxHops; hop += 1) {
    const resolution = resolveWorkspaceLink({
      currentDir: workspaceRoot,
      fileSystem: input.fileSystem,
      pathOperations: input.pathOperations,
    });

    if (resolution.status !== "resolved") {
      return workspaceRoot;
    }

    const nextWorkspaceRoot = input.pathOperations.resolve(resolution.workspaceRoot);
    if (visited.has(nextWorkspaceRoot)) {
      return workspaceRoot;
    }

    visited.add(nextWorkspaceRoot);
    workspaceRoot = nextWorkspaceRoot;
  }

  return workspaceRoot;
}
