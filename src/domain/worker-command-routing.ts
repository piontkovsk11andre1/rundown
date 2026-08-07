export const WORKER_ROUTING_DEFAULT = "default" as const;
export const WORKER_ROUTING_INTERACTIVE = "interactive" as const;

export type WorkerRoutingTarget = typeof WORKER_ROUTING_DEFAULT | typeof WORKER_ROUTING_INTERACTIVE;

export const WORKER_COMMAND_ROUTING = {
  run: WORKER_ROUTING_DEFAULT,
  all: WORKER_ROUTING_DEFAULT,
  materialize: WORKER_ROUTING_DEFAULT,
  plan: WORKER_ROUTING_DEFAULT,
  make: WORKER_ROUTING_DEFAULT,
  do: WORKER_ROUTING_DEFAULT,
  add: WORKER_ROUTING_DEFAULT,
  reverify: WORKER_ROUTING_DEFAULT,
  undo: WORKER_ROUTING_DEFAULT,
  repair: WORKER_ROUTING_INTERACTIVE,
  discuss: WORKER_ROUTING_INTERACTIVE,
} as const satisfies Record<string, WorkerRoutingTarget>;

export type RoutedWorkerCommandName = keyof typeof WORKER_COMMAND_ROUTING;

export const ROUTED_WORKER_COMMAND_NAMES = Object.keys(WORKER_COMMAND_ROUTING) as RoutedWorkerCommandName[];

export function getWorkerRoutingTarget(commandName: string): WorkerRoutingTarget | undefined {
  return WORKER_COMMAND_ROUTING[commandName as RoutedWorkerCommandName];
}

export function commandUsesDefaultWorker(commandName: string): boolean {
  return getWorkerRoutingTarget(commandName) === WORKER_ROUTING_DEFAULT;
}

export function commandUsesInteractiveWorker(commandName: string): boolean {
  return getWorkerRoutingTarget(commandName) === WORKER_ROUTING_INTERACTIVE;
}
