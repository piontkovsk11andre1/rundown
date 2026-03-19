export interface Clock {
  now(): Date;
  nowIsoString(): string;
}
