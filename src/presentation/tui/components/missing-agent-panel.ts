// @ts-nocheck
import pc from "picocolors";

function withSectionGap(lines, sectionGap) {
  const gap = Number.isInteger(sectionGap) && sectionGap > 0 ? sectionGap : 0;
  for (let index = 0; index < gap; index += 1) {
    lines.push("");
  }
}

export function renderMissingAgentPanelLines({ sectionGap = 1 } = {}) {
  const lines = [];
  lines.push("No agent prompt found.");
  withSectionGap(lines, sectionGap);
  lines.push("rundown looks for the agent prompt at .rundown/agent.md.");
  lines.push("This file controls how rundown talks to the AI in agent sessions.");
  withSectionGap(lines, sectionGap);
  lines.push(" [g]  Generate from template (writes .rundown/agent.md)");
  lines.push(" [o]  Open .rundown/ in your editor");
  lines.push(pc.dim(" [Esc] Back to menu"));
  return lines;
}
