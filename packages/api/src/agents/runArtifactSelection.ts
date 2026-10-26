import type { Agents } from 'librechat-data-provider';
import { normalizeCodeOutputPaths } from '~/files/code/preflight';

export type OutputSelectionIdentity = Pick<
  Agents.OutputSelection,
  'runId' | 'agentId' | 'stepId' | 'toolCallId'
>;

export type OutputSelectionCall = {
  id?: string;
  stepId?: string;
  args?: unknown;
  function?: { arguments?: unknown };
  outputSelection?: Agents.OutputSelection;
};

type OutputSelectionPart = {
  type?: string;
  agentId?: string;
  tool_call?: OutputSelectionCall;
};

export type OutputSelectionRunStep = {
  id?: string;
  index?: number;
  stepDetails?: { tool_calls?: OutputSelectionCall[] };
};

export type RunArtifactSelectionRegistry = {
  assign(input: {
    runId: string;
    agentId: string;
    stepId: string;
    call: OutputSelectionCall;
  }): Agents.OutputSelection | undefined;
  get(identity: OutputSelectionIdentity): Agents.OutputSelection | undefined;
  markPublished(
    identity: OutputSelectionIdentity,
    pathIndex: number,
    selectionId: string,
    fileId?: string,
  ): void;
  markFailed(
    identity: OutputSelectionIdentity,
    failureKind: Agents.OutputSelectionFailureKind,
    failureCode?: string,
  ): Agents.OutputSelection | undefined;
  restoreRunStep(runStep: OutputSelectionRunStep, runId?: string, agentId?: string): void;
  restoreCompleted(
    result: { id?: string; tool_call?: OutputSelectionCall } | undefined,
    runId?: string,
    agentId?: string,
  ): void;
};

function identityKey(identity: OutputSelectionIdentity): string {
  return JSON.stringify([identity.runId, identity.agentId, identity.stepId, identity.toolCallId]);
}

function outputPathsArgument(
  call: OutputSelectionCall,
): { requested: false } | { requested: true; value: unknown } {
  let args = call.args ?? call.function?.arguments;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args) as unknown;
    } catch {
      return { requested: false };
    }
  }
  if (args == null || typeof args !== 'object' || Array.isArray(args)) {
    return { requested: false };
  }
  if (!Object.prototype.hasOwnProperty.call(args, 'output_paths')) {
    return { requested: false };
  }
  return { requested: true, value: (args as { output_paths?: unknown }).output_paths };
}

export function hasCodeOutputSelectionRequest(call: OutputSelectionCall): boolean {
  return outputPathsArgument(call).requested;
}

function isSelection(value: unknown): value is Agents.OutputSelection {
  if (value == null || typeof value !== 'object') {
    return false;
  }
  const selection = value as Partial<Agents.OutputSelection>;
  return (
    selection.version === 1 &&
    typeof selection.runId === 'string' &&
    typeof selection.agentId === 'string' &&
    typeof selection.stepId === 'string' &&
    typeof selection.toolCallId === 'string' &&
    Number.isSafeInteger(selection.ordinal) &&
    (selection.ordinal ?? 0) > 0 &&
    Array.isArray(selection.paths)
  );
}

export function createRunArtifactSelectionRegistry({
  contentParts,
  stepMap,
}: {
  contentParts: Array<OutputSelectionPart | null | undefined>;
  stepMap: Map<string, { index?: number } | undefined>;
}): RunArtifactSelectionRegistry {
  const assignments = new Map<string, Agents.OutputSelection>();
  const contentIndexByIdentity = new Map<string, number>();
  const highWaterByRun = new Map<string, number>();

  const attach = (identity: OutputSelectionIdentity, selection: Agents.OutputSelection): void => {
    const index = contentIndexByIdentity.get(identityKey(identity));
    const part = index == null ? undefined : contentParts[index];
    if (
      part?.type === 'tool_call' &&
      part.tool_call?.id === identity.toolCallId &&
      (part.agentId == null || part.agentId === identity.agentId)
    ) {
      part.tool_call.stepId = identity.stepId;
      part.tool_call.outputSelection = selection;
    }
  };

  const get = (identity: OutputSelectionIdentity): Agents.OutputSelection | undefined =>
    assignments.get(identityKey(identity));

  const assign: RunArtifactSelectionRegistry['assign'] = ({ runId, agentId, stepId, call }) => {
    const request = outputPathsArgument(call);
    if (
      !request.requested ||
      typeof call.id !== 'string' ||
      call.id.length === 0 ||
      runId.length === 0 ||
      agentId.length === 0 ||
      stepId.length === 0
    ) {
      return undefined;
    }

    const identity = { runId, agentId, stepId, toolCallId: call.id };
    const key = identityKey(identity);
    const previous = assignments.get(key);
    let outputPaths: string[] | undefined;
    let failureCode: string | undefined;
    try {
      outputPaths = normalizeCodeOutputPaths(request.value);
    } catch (error) {
      failureCode =
        error != null && typeof error === 'object' && 'code' in error
          ? String(error.code)
          : 'invalid_code_output_selection';
    }

    const ordinal = previous?.ordinal ?? (highWaterByRun.get(runId) ?? 0) + 1;
    highWaterByRun.set(runId, Math.max(highWaterByRun.get(runId) ?? 0, ordinal));
    const samePaths =
      outputPaths != null &&
      previous != null &&
      previous.failureKind !== 'selection' &&
      previous.paths.length === outputPaths.length &&
      previous.paths.every((path, index) => path.outputPath === outputPaths?.[index]);
    if (samePaths && previous) {
      call.stepId = stepId;
      call.outputSelection = previous;
      attach(identity, previous);
      return previous;
    }

    const selection: Agents.OutputSelection =
      outputPaths == null
        ? {
            version: 1,
            ...identity,
            ordinal,
            status: 'failed',
            failureKind: 'selection',
            failureCode,
            paths: [],
          }
        : {
            version: 1,
            ...identity,
            ordinal,
            status: outputPaths.length === 0 ? 'published' : 'pending',
            paths: outputPaths.map((outputPath, pathIndex) => ({
              pathIndex,
              outputPath,
              status: 'pending',
            })),
          };
    assignments.set(key, selection);
    call.stepId = stepId;
    call.outputSelection = selection;
    attach(identity, selection);
    return selection;
  };

  const markPublished: RunArtifactSelectionRegistry['markPublished'] = (
    identity,
    pathIndex,
    selectionId,
    fileId,
  ) => {
    const selection = get(identity);
    const path = selection?.paths.find((item) => item.pathIndex === pathIndex);
    if (!selection || !path || !selectionId) {
      return;
    }
    path.status = 'published';
    path.selectionId = selectionId;
    if (fileId) {
      path.fileId = fileId;
    }
    delete path.failureKind;
    if (selection.paths.every((item) => item.status === 'published')) {
      selection.status = 'published';
      delete selection.failureKind;
      delete selection.failureCode;
    }
    attach(identity, selection);
  };

  const markFailed: RunArtifactSelectionRegistry['markFailed'] = (
    identity,
    failureKind,
    failureCode,
  ) => {
    const selection = get(identity);
    if (!selection) {
      return undefined;
    }
    selection.status = 'failed';
    selection.failureKind = failureKind;
    if (failureCode) {
      selection.failureCode = failureCode;
    }
    for (const path of selection.paths) {
      if (path.status === 'pending') {
        path.status = 'failed';
        path.failureKind = failureKind;
      }
    }
    attach(identity, selection);
    return selection;
  };

  const restoreRunStep: RunArtifactSelectionRegistry['restoreRunStep'] = (
    runStep,
    runId,
    agentId,
  ) => {
    if (typeof runStep.id !== 'string') {
      return;
    }
    const stepIndex = stepMap.get(runStep.id)?.index ?? runStep.index;
    if (typeof stepIndex !== 'number' || !Number.isInteger(stepIndex)) {
      return;
    }
    for (const [callIndex, source] of (runStep.stepDetails?.tool_calls ?? []).entries()) {
      if (typeof source.id !== 'string') {
        continue;
      }
      const identity = {
        runId: runId ?? source.outputSelection?.runId ?? '',
        agentId: agentId ?? source.outputSelection?.agentId ?? '',
        stepId: runStep.id,
        toolCallId: source.id,
      };
      const partIndex = stepIndex + callIndex;
      const part = contentParts[partIndex];
      const selection = get(identity) ?? source.outputSelection;
      if (
        part?.type !== 'tool_call' ||
        part.tool_call?.id !== source.id ||
        (part.agentId != null && part.agentId !== identity.agentId)
      ) {
        continue;
      }
      contentIndexByIdentity.set(identityKey(identity), partIndex);
      if (
        !isSelection(selection) ||
        selection.runId !== identity.runId ||
        selection.agentId !== identity.agentId ||
        selection.stepId !== identity.stepId ||
        selection.toolCallId !== identity.toolCallId
      ) {
        continue;
      }
      assignments.set(identityKey(identity), selection);
      highWaterByRun.set(
        identity.runId,
        Math.max(highWaterByRun.get(identity.runId) ?? 0, selection.ordinal),
      );
      part.tool_call.stepId = runStep.id;
      part.tool_call.outputSelection = selection;
    }
  };

  const restoreCompleted: RunArtifactSelectionRegistry['restoreCompleted'] = (
    result,
    runId,
    agentId,
  ) => {
    const toolCall = result?.tool_call;
    if (
      typeof result?.id !== 'string' ||
      typeof toolCall?.id !== 'string' ||
      typeof runId !== 'string' ||
      typeof agentId !== 'string'
    ) {
      return;
    }
    const identity = {
      runId,
      agentId,
      stepId: result.id,
      toolCallId: toolCall.id,
    };
    const source = toolCall.outputSelection;
    const selection =
      get(identity) ??
      (isSelection(source) && identityKey(source) === identityKey(identity) ? source : undefined);
    if (!selection) {
      return;
    }
    assignments.set(identityKey(identity), selection);
    highWaterByRun.set(runId, Math.max(highWaterByRun.get(runId) ?? 0, selection.ordinal));
    toolCall.stepId = result.id;
    toolCall.outputSelection = selection;
    attach(identity, selection);
  };

  return { assign, get, markPublished, markFailed, restoreRunStep, restoreCompleted };
}
