import {
  WORKER_FAILURE_CLASS_EXECUTION_FAILURE_OTHER,
  WORKER_FAILURE_CLASS_TRANSPORT_UNAVAILABLE,
  WORKER_FAILURE_CLASS_USAGE_LIMIT,
  type WorkerFailureClass,
} from "../domain/worker-health.js";
import { RUN_REASON_USAGE_LIMIT_DETECTED } from "../domain/run-reasons.js";
import { containsKnownUsageLimitPattern } from "../domain/services/output-similarity.js";

const TRANSPORT_UNAVAILABLE_PATTERNS: RegExp[] = [
  /\btimeout\b/i,
  /\btimed\s*out\b/i,
  /\bdeadline\s*exceeded\b/i,
  /\bno\s*response\b/i,
  /\bconnection\s*(?:was\s*)?(?:killed|closed|reset|refused|aborted|lost|dropped)\b/i,
  /\bchannel\s*(?:closed|unavailable|terminated)\b/i,
  /\bsocket\s*hang\s*up\b/i,
  /\bnetwork\s*(?:unreachable|error|failure)\b/i,
  /\btransport\s*(?:error|unavailable|closed)\b/i,
  /\b(?:econnreset|econnrefused|econnaborted|etimedout|enetunreach|ehostunreach|eai_again)\b/i,
  /\b(?:sigterm|sigkill|terminated\s+by\s+signal)\b/i,
];

export function classifyWorkerFailure(input: {
  runReason?: string;
  exitCode?: number | null;
  usageLimitDetected?: boolean;
  message?: string;
  stdout?: string;
  stderr?: string;
}): WorkerFailureClass {
  const combinedOutput = [input.message, input.stdout, input.stderr]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n");

  if (
    input.usageLimitDetected === true
    || input.runReason === RUN_REASON_USAGE_LIMIT_DETECTED
    || containsKnownUsageLimitPattern(combinedOutput)
  ) {
    return WORKER_FAILURE_CLASS_USAGE_LIMIT;
  }

  if (input.exitCode === null) {
    return WORKER_FAILURE_CLASS_TRANSPORT_UNAVAILABLE;
  }

  if (TRANSPORT_UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(combinedOutput))) {
    return WORKER_FAILURE_CLASS_TRANSPORT_UNAVAILABLE;
  }

  return WORKER_FAILURE_CLASS_EXECUTION_FAILURE_OTHER;
}
