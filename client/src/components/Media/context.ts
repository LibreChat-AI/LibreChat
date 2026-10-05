import { resolveMediaParameters, validateMediaCapability } from 'librechat-data-provider';
import type {
  MediaAsset,
  MediaAssetContext,
  MediaCapability,
  MediaLimits,
  MediaOperation,
  MediaTurn,
} from 'librechat-data-provider';
import type { MediaDraft, MediaParameterContext } from './state';

export type MediaEditTarget = MediaAssetContext;

export const compareTurns = (left: MediaTurn, right: MediaTurn) =>
  (left.sequence ?? 0) - (right.sequence ?? 0) || left.createdAt.localeCompare(right.createdAt);

function latestAssetContext(turns: MediaTurn[], kind: 'image' | 'video') {
  let contextTurn: MediaTurn | undefined;
  let context: MediaEditTarget | undefined;
  for (const turn of turns) {
    if (contextTurn && compareTurns(turn, contextTurn) <= 0) continue;
    let asset =
      turn.kind === 'import'
        ? turn.assets.find((item) => item.type.startsWith(`${kind}/`))
        : undefined;
    let attemptAt = '';
    for (const job of turn.jobs) {
      if (job.phase !== 'succeeded' || job.createdAt < attemptAt) continue;
      let ordinal = Infinity;
      let result: MediaAsset | undefined;
      for (const output of job.outputs) {
        if (output.kind === kind && output.state === 'ready' && output.ordinal < ordinal) {
          ordinal = output.ordinal;
          result = output.asset;
        }
      }
      if (result) {
        asset = result;
        attemptAt = job.createdAt;
      }
    }
    if (asset) {
      contextTurn = turn;
      context = { turnId: turn.turnId, asset };
    }
  }
  return context;
}

export function mediaThreadContext(turns: MediaTurn[]) {
  let latestTurn: MediaTurn | undefined;
  for (const turn of turns) {
    if (!latestTurn || compareTurns(turn, latestTurn) > 0) latestTurn = turn;
  }
  return {
    latestTurn,
    image: latestAssetContext(turns, 'image'),
    video: latestAssetContext(turns, 'video'),
  };
}

export function withMediaContext(
  draft: MediaDraft,
  context: { image?: MediaEditTarget; video?: MediaEditTarget },
  operation: MediaOperation = draft.operation,
): MediaDraft {
  const target = operation === 'video.generate' ? context.video : context.image;
  if (!target || draft.autoEdit === false || draft.inputs.length > 0 || draft.parentTurnId)
    return draft;
  return {
    ...draft,
    operation: operation === 'video.generate' ? operation : 'image.edit',
    parentTurnId: target.turnId,
    inputs: [
      {
        role: operation === 'video.generate' ? 'video' : 'reference',
        file_id: target.asset.file_id,
      },
    ],
    assets: [target.asset],
  };
}

export function mediaParameterContext(
  draft: Pick<MediaDraft, 'operation' | 'inputs'>,
): MediaParameterContext {
  return { operation: draft.operation, roles: draft.inputs.map((input) => input.role).sort() };
}

/** Automatic references can change valid settings without changing the user's fresh-work defaults. */
export function mediaContextParameters(
  saved: MediaDraft,
  draft: MediaDraft,
  capability: MediaCapability,
  capabilities: MediaCapability[],
  limits: MediaLimits,
  automaticReference: boolean,
): MediaDraft['parameters'] {
  if (!automaticReference && (saved.inputs.length > 0 || saved.parentTurnId))
    return resolveMediaParameters(draft, capability, { optionalChoices: true });
  const currentContext = JSON.stringify(mediaParameterContext(draft));
  const originalContext = mediaParameterContext(saved);
  const parameters = { ...draft.parameters };
  const invalid = validateMediaCapability(
    { operation: capability.operation, inputs: draft.inputs, parameters },
    capability,
    limits,
  );
  for (const { field } of invalid) {
    if (field === 'inputs' || field === 'prompt' || field === 'providerOptions') continue;
    const source = saved.parameterContexts?.[field] ?? originalContext;
    if (JSON.stringify(source) === currentContext) continue;
    const sourceCapability = capabilities.find((item) => item.operation === source.operation);
    if (!sourceCapability) continue;
    const sourceIssues = validateMediaCapability(
      {
        operation: source.operation,
        inputs: source.roles.map((role, index) => ({ role, file_id: `context-${index}` })),
        parameters: draft.parameters,
      },
      sourceCapability,
      limits,
    );
    if (sourceIssues.some((issue) => issue.field === field)) continue;
    Object.assign(parameters, { [field]: undefined });
  }
  return resolveMediaParameters(
    { operation: capability.operation, inputs: draft.inputs, parameters },
    capability,
    { optionalChoices: true },
  );
}
