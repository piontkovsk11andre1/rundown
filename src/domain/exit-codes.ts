export type RundownExitCode = 0 | 1 | 2 | 3;

export const EXIT_CODE_SUCCESS: RundownExitCode = 0;
export const EXIT_CODE_FAILURE: RundownExitCode = 1;
export const EXIT_CODE_VERIFICATION_FAILURE: RundownExitCode = 2;
export const EXIT_CODE_NO_WORK: RundownExitCode = 3;

export function normalizeExitCode(code: number): RundownExitCode {
  if (code === EXIT_CODE_SUCCESS) {
    return EXIT_CODE_SUCCESS;
  }

  if (code === EXIT_CODE_VERIFICATION_FAILURE) {
    return EXIT_CODE_VERIFICATION_FAILURE;
  }

  if (code === EXIT_CODE_NO_WORK) {
    return EXIT_CODE_NO_WORK;
  }

  return EXIT_CODE_FAILURE;
}
