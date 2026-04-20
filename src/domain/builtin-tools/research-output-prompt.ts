import { DEFAULT_RESEARCH_OUTPUT_CONTRACT_TEMPLATE } from "../defaults.js";
import { renderTemplate } from "../template.js";

const BULLET_PREFIX_PATTERN = /^([-*+]|\d+[.)])\s+/;

interface ResearchOutputPromptContractOptions {
  itemLabel: string;
  metadataPrefix: string;
  emptyConditionLabel: string;
}

export function buildResearchOutputPromptContract(
  options: ResearchOutputPromptContractOptions,
  template?: string,
): string[] {
  const renderedLines = renderResearchOutputContractTemplate(
    template ?? DEFAULT_RESEARCH_OUTPUT_CONTRACT_TEMPLATE,
    options,
  );
  if (renderedLines.length > 0) {
    return renderedLines;
  }

  return renderResearchOutputContractTemplate(DEFAULT_RESEARCH_OUTPUT_CONTRACT_TEMPLATE, options);
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
