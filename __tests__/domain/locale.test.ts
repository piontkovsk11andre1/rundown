import { describe, expect, it } from "vitest";
import { msg } from "../../src/domain/locale.js";
import { MESSAGES } from "../../src/domain/messages.js";

describe("msg", () => {
  it("uses a locale message when the id exists in the locale map", () => {
    const localeMessages = {
      "run.no-unchecked-tasks": "No se encontraron tareas sin marcar.",
    };

    expect(msg("run.no-unchecked-tasks", {}, localeMessages)).toBe("No se encontraron tareas sin marcar.");
  });

  it("falls back to the English catalog message when the locale id is missing", () => {
    expect(msg("run.no-unchecked-tasks", {}, {})).toBe(MESSAGES["run.no-unchecked-tasks"]);
  });

  it("substitutes {{var}} placeholders in locale messages", () => {
    const localeMessages = {
      "init.created": "Creado {{filePath}}",
    };

    expect(msg("init.created", { filePath: "docs/readme.md" }, localeMessages)).toBe("Creado docs/readme.md");
  });

  it("substitutes {{var}} placeholders in English fallback messages", () => {
    expect(msg("init.created", { filePath: "docs/readme.md" }, {})).toBe("Created docs/readme.md");
  });

  it("leaves placeholders intact when a variable is missing", () => {
    expect(msg("init.created", {}, {})).toBe("Created {{filePath}}");
  });

  it("works with an empty vars map", () => {
    const localeMessages = {
      "run.no-unchecked-tasks": "Aucune tache non cochee.",
    };

    expect(msg("run.no-unchecked-tasks", {}, localeMessages)).toBe("Aucune tache non cochee.");
  });
});

describe("MESSAGES catalog", () => {
  it("contains at least a sanity-threshold number of message keys", () => {
    expect(Object.keys(MESSAGES).length).toBeGreaterThanOrEqual(150);
  });

  it("does not contain empty message values", () => {
    for (const value of Object.values(MESSAGES)) {
      expect(value.trim().length).toBeGreaterThan(0);
    }
  });
});
