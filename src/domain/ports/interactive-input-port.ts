/**
 * Option metadata for select-style prompts.
 */
export interface InteractiveChoice {
  value: string;
  label?: string;
  description?: string;
  isDefault?: boolean;
}

/**
 * Request for free-text interactive input.
 */
export interface InteractiveTextPromptRequest {
  kind: "text";
  message: string;
  defaultValue?: string;
  required?: boolean;
}

/**
 * Request for selecting one value from predefined choices.
 */
export interface InteractiveSelectPromptRequest {
  kind: "select";
  message: string;
  choices: readonly InteractiveChoice[];
  defaultValue?: string;
  allowCustomValue?: boolean;
}

/**
 * Request for boolean confirmation.
 */
export interface InteractiveConfirmPromptRequest {
  kind: "confirm";
  message: string;
  defaultValue?: boolean;
}

/**
 * Unified prompt request contract for interactive tools.
 */
export type InteractivePromptRequest =
  | InteractiveTextPromptRequest
  | InteractiveSelectPromptRequest
  | InteractiveConfirmPromptRequest;

/**
 * Result returned by interactive prompt resolution.
 */
export interface InteractivePromptResult {
  value: string;
  usedDefault: boolean;
  interactive: boolean;
}

/**
 * Domain contract for user interaction required by built-in tools.
 */
export interface InteractiveInputPort {
  /**
   * Returns whether the current execution environment supports TTY interaction.
   */
  isTTY(): boolean;

  /**
   * Allows adapters to flush or finalize any pending terminal rendering before prompting.
   */
  prepareForPrompt?(): Promise<void> | void;

  /**
   * Resolves the prompt request and returns the selected or entered value.
   *
   * Implementations must fall back to defaults in non-interactive environments.
   */
  prompt(request: InteractivePromptRequest): Promise<InteractivePromptResult>;
}
