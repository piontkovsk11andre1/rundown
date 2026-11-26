export interface ViewDisplay {
  width: number;
  height: number;
}
export interface ViewPresentation {
  fullscreen: boolean;
  logs: "show" | "hide";
}
export interface ViewOptions extends Partial<ViewPresentation> {
  baseURL?: string | URL;
  cwd?: string;
}
export interface LiveView<
  T extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly data: T;
  readonly revision: number;
  readonly state: "open" | "closed" | "failed" | "cancelled";
  readonly presentation: ViewPresentation;
  readonly done: Promise<void>;
  update(patch: Partial<T>): void;
  replace(data: T): void;
  configure(options: Partial<ViewPresentation>): void;
  subscribe(listener: () => void): () => void;
  track<R>(operation: PromiseLike<R> | (() => R | PromiseLike<R>)): Promise<R>;
  close(): void;
  fail(error: unknown): void;
  render(display?: Partial<ViewDisplay>): string;
}
