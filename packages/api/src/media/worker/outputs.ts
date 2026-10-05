import { Readable } from 'node:stream';
import type {
  MediaJobObservation,
  MediaStoredJob,
  MediaProviderState,
} from '@librechat/data-schemas';
import type { MediaOutput } from 'librechat-data-provider';
import type { MediaProviderPart, MediaProviderResult } from '../provider';
import type { MediaServiceDependencies, MediaContext } from '../service';
import { mediaContentExtension } from '../content';
import { MediaServiceError } from '../errors';

type CompletedResult = Extract<MediaProviderResult, { status: 'completed' }>;
type OutputDependencies = Pick<MediaServiceDependencies, 'repository' | 'storage' | 'now'>;

/** Recover only recorded originals; provider resolution remains lazy in the execution owner. */
export async function restoreMediaOutputResult({
  job,
  context,
  deps,
}: {
  job: MediaStoredJob;
  context: MediaContext;
  deps: Pick<MediaServiceDependencies, 'repository'>;
}): Promise<CompletedResult> {
  const parts: MediaProviderPart[] = [];
  for (const part of job.provider.recovery?.parts ?? []) {
    if (part.kind === 'text') {
      parts.push(part);
      continue;
    }
    const outputId = `${job.jobId}:${part.ordinal}`;
    const asset = part.fileId
      ? await deps.repository.getMediaAsset(context.scope, part.fileId)
      : await deps.repository.getPublishedMediaAsset({
          scope: context.scope,
          outputKey: outputId,
          rendition: 'original',
        });
    if (asset || part.fileId) {
      if (asset) {
        part.fileId = asset.file_id;
      }
      if (!job.outputs.some((output) => output.outputId === outputId)) {
        const retained =
          asset &&
          (await deps.repository.retainMediaThreadAsset({
            scope: context.scope,
            threadId: job.threadId,
            fileId: asset.file_id,
            maxRetainers: context.config.limits.maxAssetRetainers,
          }));
        job.outputs.push(
          retained
            ? { kind: part.kind, outputId, ordinal: part.ordinal, state: 'ready', asset }
            : {
                kind: part.kind,
                outputId,
                ordinal: part.ordinal,
                state: 'expired',
                error: { code: 'output_expired' },
              },
        );
      }
      continue;
    }
    if (!part.url) {
      throw new MediaServiceError(
        'output_expired',
        409,
        'This direct output could not be recovered.',
      );
    }
    parts.push(part);
  }
  return { status: 'completed', parts, usage: job.provider.recovery?.usage };
}

/** Every progress write returns through the execution owner's serialized lease/version fence. */
export async function publishMediaOutputs({
  getJob,
  context,
  deps,
  result,
  observe,
  download,
}: {
  getJob(): MediaStoredJob;
  context: MediaContext;
  deps: OutputDependencies;
  result: CompletedResult;
  observe(observation: MediaJobObservation): Promise<void>;
  download(part: Extract<MediaProviderPart, { kind: 'image' | 'video' }>): Promise<Readable>;
}): Promise<MediaOutput[]> {
  const recovered = getJob().provider.recovery;
  const recovery: NonNullable<MediaProviderState['recovery']> = recovered?.parts
    ? recovered
    : {
        terminalStatus: 'completed' as const,
        usage: result.usage,
        parts: result.parts.map((part) =>
          part.kind === 'text'
            ? part
            : {
                kind: part.kind,
                ordinal: part.ordinal,
                type: part.type,
                url: part.url,
                thoughtSignature: part.thoughtSignature,
              },
        ),
      };
  await observe({
    phase: 'ingesting',
    outputs: getJob().outputs,
    provider: { ...getJob().provider, certainty: 'terminal', recovery },
  });
  const outputs: MediaOutput[] = [...getJob().outputs];
  for (const part of result.parts) {
    const outputId = `${getJob().jobId}:${part.ordinal}`;
    if (
      outputs.some(
        (output) =>
          output.outputId === outputId && (output.kind === 'text' || output.state === 'ready'),
      )
    ) {
      continue;
    }
    if (part.kind === 'text') {
      outputs.push({ kind: 'text', outputId, ordinal: part.ordinal, text: part.text });
    } else {
      const original = await deps.storage.publish({
        scope: context.scope,
        outputKey: outputId,
        stream: part.data ? Readable.from([part.data]) : await download(part),
        type: part.type,
        filename: `${getJob().jobId}-${part.ordinal}.${mediaContentExtension(part.type)}`,
        config: context.config,
        expiredAt: new Date(deps.now() + context.config.assets.orphanRetentionMs).toISOString(),
        hardExpiresAt: getJob().publicationExpiresAt?.toISOString(),
      });
      const retained = await deps.repository.retainMediaThreadAsset({
        scope: context.scope,
        fileId: original.file_id,
        threadId: getJob().threadId,
        maxRetainers: context.config.limits.maxAssetRetainers,
      });
      outputs.push(
        retained
          ? {
              kind: part.kind,
              outputId,
              ordinal: part.ordinal,
              state: 'ready',
              asset: original,
            }
          : {
              kind: part.kind,
              outputId,
              ordinal: part.ordinal,
              state: 'expired',
              error: { code: 'output_expired' },
            },
      );
      const descriptor = recovery.parts?.find((entry) => entry.ordinal === part.ordinal);
      if (descriptor && descriptor.kind !== 'text') {
        descriptor.fileId = original.file_id;
      }
    }
    outputs.sort((a, b) => a.ordinal - b.ordinal);
    await observe({
      phase: 'ingesting',
      outputs,
      provider: {
        ...getJob().provider,
        certainty: 'terminal',
        recovery: {
          terminalStatus: 'completed',
          usage: result.usage,
          parts: (recovery.parts ?? []).map((item) => {
            if (item.kind === 'text') {
              return item;
            }
            const output = outputs.find((entry) => entry.ordinal === item.ordinal);
            return {
              ...item,
              fileId:
                output && output.kind !== 'text'
                  ? (output.asset?.file_id ?? item.fileId)
                  : item.fileId,
            };
          }),
        },
      },
    });
  }
  if (result.parts.length === 0 && recovered?.parts && outputs.length === 0) {
    throw new MediaServiceError('storage_failed', 409, 'Output recovery is incomplete.');
  }
  return outputs;
}
