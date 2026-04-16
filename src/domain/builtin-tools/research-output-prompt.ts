import { DEFAULT_RESEARCH_OUTPUT_CONTRACT_TEMPLATE } from "../defaults.js";
import type { FileSystem } from "../ports/file-system.js";
import type { PathOperationsPort } from "../ports/path-operations-port.js";
import { renderTemplate } from "../template.js";

const RESEARCH_OUTPUT_CONTRACT_TEMPLATE_FILE_NAME = "research-output-contract.md";
const BULLET_PREFIX_PATTERN = /^([-*+]|\d+[.)])\s+/;

interface ResearchOutputPromptContractOptions {
  itemLabel: string;
  metadataPrefix: string;
  emptyConditionLabel: string;
}

interface ResearchOutputPromptContractTemplateContext {
  configDir?: string;
  fileSystem: FileSystem;
  pathOperations: Pick<PathOperationsPort, "join">;
}

export function buildResearchOutputPromptContract(
  options: ResearchOutputPromptContractOptions,
  templateContext?: ResearchOutputPromptContractTemplateContext,
): string[] {
  const template = loadResearchOutputPromptContractTemplate(templateContext);
  const renderedLines = renderResearchOutputContractTemplate(template, options);
  if (renderedLines.length > 0) {
    return renderedLines;
  }

  return renderResearchOutputContractTemplate(DEFAULT_RESEARCH_OUTPUT_CONTRACT_TEMPLATE, options);
}

function loadResearchOutputPromptContractTemplate(
  templateContext: ResearchOutputPromptContractTemplateContext | undefined,
): string {
  if (!templateContext?.configDir) {
    return DEFAULT_RESEARCH_OUTPUT_CONTRACT_TEMPLATE;
  }

  const templatePath = templateContext.pathOperations.join(
    templateContext.configDir,
    RESEARCH_OUTPUT_CONTRACT_TEMPLATE_FILE_NAME,
  );
  if (!templateContext.fileSystem.exists(templatePath)) {
    return DEFAULT_RESEARCH_OUTPUT_CONTRACT_TEMPLATE;
  }

  const loadedTemplate = templateContext.fileSystem.readText(templatePath).trim();
  return loadedTemplate.length > 0
    ? loadedTemplate
    : DEFAULT_RESEARCH_OUTPUT_CONTRACT_TEMPLATE;
}

function renderResearchOutputContractTemplate(
  template: string,
  options: ResearchOutputPromptContractOptions,
): string[] {
  const rendered = renderTemplate(template, {
    task: "",
    file: "",
    context: "",
    taskIndex: 0,
    taskLine: 0,
    source: "",
    itemLabel: options.itemLabel,
    metadataPrefix: options.metadataPrefix,
    emptyConditionLabel: options.emptyConditionLabel,
  });

  return rendered
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(BULLET_PREFIX_PATTERN, ""));
}
