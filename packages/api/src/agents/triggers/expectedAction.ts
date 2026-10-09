import type { AgentTriggerExpectedAction } from './envelope';

export interface CompletedToolEvidence {
  toolName: string;
  toolCallId?: string;
  arguments?: unknown;
}

export function parseAgentExpectedActionArguments(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function containsSubset(value: unknown, subset: unknown): boolean {
  if (Array.isArray(subset)) {
    return (
      Array.isArray(value) &&
      value.length === subset.length &&
      subset.every((expected, index) => containsSubset(value[index], expected))
    );
  }
  if (subset == null || typeof subset !== 'object') {
    return Object.is(value, subset);
  }
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  return Object.entries(subset).every(([key, expected]) =>
    containsSubset((value as Record<string, unknown>)[key], expected),
  );
}

export function matchesExpectedAction(
  evidence: CompletedToolEvidence,
  expected: AgentTriggerExpectedAction,
): boolean {
  const nameMatches =
    evidence.toolName === expected.toolName ||
    evidence.toolName.startsWith(`${expected.toolName}_mcp_`);
  return (
    nameMatches &&
    (expected.argumentSubset == null ||
      containsSubset(
        parseAgentExpectedActionArguments(evidence.arguments),
        expected.argumentSubset,
      ))
  );
}
