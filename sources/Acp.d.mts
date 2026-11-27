import type { InvocationContext } from "./types.mjs";
import type { AcpConnection, AcpInvocation, AcpResult } from "./AcpTypes.mjs";
export type * from "./AcpTypes.mjs";
export function invokeAcp(
  context: InvocationContext,
  connection: AcpConnection,
  input: AcpInvocation,
): Promise<AcpResult>;
