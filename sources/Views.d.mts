import type {
  LiveView,
  ViewOptions,
  ViewPresentation,
  ViewDisplay,
} from "./ViewTypes.mjs";
export type * from "./ViewTypes.mjs";
export class View<
  T extends Record<string, unknown> = Record<string, unknown>,
> implements LiveView<T> {
  constructor(
    source: string,
    data: T,
    options?: Partial<ViewPresentation> & { file?: string },
  );
  readonly data: T;
  readonly revision: number;
  readonly state: LiveView["state"];
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
export function createView<T extends Record<string, unknown>>(
  specifier: string | URL,
  data: T,
  options?: ViewOptions,
): Promise<View<T>>;
export function isView(value: unknown): value is View;
