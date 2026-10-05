import { FileContext } from 'librechat-data-provider';
import type { MediaAsset, MediaJob, MediaOutput, MediaThread } from 'librechat-data-provider';
import type { MediaStoredJob, MediaStoredThread, MediaStoredTurn } from '~/types/media';
import { positiveMediaLimit as positive, toMediaAsset } from '~/utils/media';
import { terminal } from './scope';

export function assetContext(outputKey: string, type: string): FileContext {
  if (outputKey.startsWith('upload:') || outputKey.startsWith('capture:')) {
    return FileContext.message_attachment;
  }
  return type.startsWith('video/') ? FileContext.video_generation : FileContext.image_generation;
}

export const readyAssetOutput: {
  kind: { $in: string[] };
  state: string;
  'asset.file_id': { $exists: boolean };
} = {
  kind: { $in: ['image', 'video'] },
  state: 'ready',
  'asset.file_id': { $exists: true },
};

/** The lowest-ordinal ready image or video output; the cover a thread shows before it is chosen. */
export function firstReadyAsset(outputs: MediaOutput[] = []): MediaAsset | undefined {
  let cover: Extract<MediaOutput, { kind: 'image' | 'video' }> | undefined;
  for (const output of outputs) {
    if (output.kind === 'text' || output.state !== 'ready' || !output.asset?.file_id) {
      continue;
    }
    if (!cover || output.ordinal < cover.ordinal) {
      cover = output;
    }
  }
  return cover?.asset;
}

export function jobView(job: MediaStoredJob): MediaJob {
  const remoteCancellation =
    !!job.execution.cancellation &&
    !!job.provider.operationId &&
    ['running', 'reconciling'].includes(job.phase) &&
    job.provider.certainty === 'submitted';
  const canRetry =
    job.receipt.phase === 'accepted' &&
    job.executionOwner === 'media' &&
    ((job.phase === 'failed' && ['unsubmitted', 'terminal'].includes(job.provider.certainty)) ||
      (job.phase === 'cancelled' && job.provider.certainty === 'unsubmitted'));
  let cancellation: MediaJob['cancellation'];
  if (job.cancelRequestedAt && job.execution.cancellation) {
    if (job.provider.recovery?.terminalStatus === 'cancelled') cancellation = 'confirmed';
    else if (!terminal.includes(job.phase)) cancellation = 'requested';
  }
  return {
    schemaVersion: 1,
    jobId: job.jobId,
    threadId: job.threadId,
    turnId: job.turnId,
    version: job.version,
    phase: job.phase,
    executionOwner: job.executionOwner,
    operation: job.operation,
    selection: job.selection,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    outputs: job.outputs.map((output) =>
      output.kind !== 'text' && output.asset
        ? { ...output, asset: toMediaAsset(output.asset) }
        : output,
    ),
    ...(job.error ? { error: job.error } : {}),
    ...(job.retryOfJobId ? { retryOfJobId: job.retryOfJobId } : {}),
    ...(cancellation ? { cancellation } : {}),
    allowedActions: {
      cancel:
        job.executionOwner === 'media' &&
        ((job.phase === 'queued' && job.provider.certainty === 'unsubmitted') ||
          remoteCancellation) &&
        !job.cancelRequestedAt,
      retry: canRetry,
    },
  };
}

export function threadView(thread: MediaStoredThread): MediaThread {
  return {
    schemaVersion: 1,
    threadId: thread.threadId,
    version: thread.version,
    title: thread.title,
    createdAt: thread.createdAt.toISOString(),
    updatedAt: thread.updatedAt.toISOString(),
    pendingJobCount: thread.pendingJobCount,
    turnCount: thread.turnCount,
    ...(thread.temporary !== undefined ? { temporary: thread.temporary } : {}),
    ...(thread.cover ? { cover: toMediaAsset(thread.cover) } : {}),
    ...(thread.expiresAt ? { expiresAt: thread.expiresAt.toISOString() } : {}),
  };
}

/** A temporary creation expires a fixed interval after the thread's own creation time. */
export function temporaryExpiry(
  turn: MediaStoredTurn,
  temporary: boolean | undefined,
  retentionMs: number | undefined,
): Date | undefined {
  if (!turn.newThread || temporary !== true || retentionMs === undefined) {
    return undefined;
  }
  return new Date(turn.createdAt.getTime() + positive(retentionMs));
}
