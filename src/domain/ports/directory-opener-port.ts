/**
 * Defines the domain port responsible for opening a directory in the user's environment.
 */
export interface DirectoryOpenerPort {
  // Domain contract for delegating directory-opening behavior to infrastructure adapters.
  /**
   * Opens the provided directory path using the platform-specific mechanism.
   *
   * @param dirPath Absolute or relative path to the directory to open.
   */
  openDirectory(dirPath: string): void;
}
