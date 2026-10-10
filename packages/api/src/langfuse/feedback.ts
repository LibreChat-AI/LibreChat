import { logger } from '@librechat/data-schemas';
import type { AppConfig } from '@librechat/data-schemas';
import { getScoreDestinations, type LangfuseScoreDestination } from './destinations';
import { isLangfuseMetricsOnlyPrivacy } from './policy';
import { mergeHeaders } from '~/utils/headers';
import { redirectPolicyFor } from './utils';

export type LangfuseFeedback = {
  rating?: 'thumbsUp' | 'thumbsDown';
  tag?: string;
  text?: string;
};

export type LangfuseFeedbackMetadata = Record<string, string | number | boolean | null | undefined>;

export type SendFeedbackScoreParams = {
  traceId: string;
  sampled?: boolean;
  destinationIds?: string[];
  feedback?: LangfuseFeedback | null;
  metadata?: LangfuseFeedbackMetadata;
  observationId?: string;
  appConfig?: AppConfig;
  /**
   * Must mirror the value used when the trace was generated. `destinationIds`
   * only restricts feedback to destinations that carry a stable id, so a caller
   * that opts out of central export has to re-assert it here for destinations
   * whose project identity is unknown.
   */
  centralTraceExportEnabled?: boolean;
};

const ENVIRONMENT = process.env.LANGFUSE_TRACING_ENVIRONMENT;

type LangfuseScorePayload = {
  id: string;
  traceId: string;
  name: 'user-feedback';
  value: number;
  dataType: 'BOOLEAN';
  comment?: string;
  metadata: Record<string, string | number | boolean>;
  observationId?: string;
  environment?: string;
};

function cleanMetadata(
  metadata: LangfuseFeedbackMetadata,
): Record<string, string | number | boolean> {
  return Object.entries(metadata).reduce<Record<string, string | number | boolean>>(
    (result, [key, value]) => {
      if (value == null || (typeof value === 'string' && value.trim() === '')) {
        return result;
      }
      result[key] = value;
      return result;
    },
    {},
  );
}

async function deleteScore(destination: LangfuseScoreDestination, scoreId: string): Promise<void> {
  const res = await fetch(
    `${destination.baseUrl}/api/public/scores/${encodeURIComponent(scoreId)}`,
    {
      method: 'DELETE',
      headers: mergeHeaders(destination.headers, { Authorization: destination.authorization }),
      ...redirectPolicyFor(destination.headers),
    },
  );
  if (!res.ok && res.status !== 404) {
    throw new Error(`score delete ${res.status}: ${await res.text()}`);
  }
}

async function createScore(
  destination: LangfuseScoreDestination,
  payload: LangfuseScorePayload,
): Promise<void> {
  const res = await fetch(`${destination.baseUrl}/api/public/scores`, {
    method: 'POST',
    headers: mergeHeaders(destination.headers, {
      Authorization: destination.authorization,
      'Content-Type': 'application/json',
    }),
    body: JSON.stringify(payload),
    ...redirectPolicyFor(destination.headers),
  });
  if (!res.ok) {
    throw new Error(`score create ${res.status}: ${await res.text()}`);
  }
}

/** Metadata keys carrying user-written or personal values, dropped under
 *  metricsOnly: the sender is a person's display name, tag is user input. */
const FEEDBACK_CONTENT_METADATA_KEYS = new Set(['sender', 'tag']);

function stripFeedbackContent(
  metadata: Record<string, string | number | boolean>,
): Record<string, string | number | boolean> {
  return Object.fromEntries(
    Object.entries(metadata).filter(([key]) => !FEEDBACK_CONTENT_METADATA_KEYS.has(key)),
  );
}

function buildScorePayload({
  scoreId,
  traceId,
  feedback,
  metadata,
  observationId,
  metricsOnly,
}: {
  scoreId: string;
  traceId: string;
  feedback: LangfuseFeedback;
  metadata: LangfuseFeedbackMetadata;
  observationId?: string;
  metricsOnly: boolean;
}): LangfuseScorePayload {
  const fullMetadata = cleanMetadata({
    ...metadata,
    rating: feedback.rating,
    tag: feedback.tag,
  });
  return {
    id: scoreId,
    traceId,
    name: 'user-feedback',
    value: feedback.rating === 'thumbsUp' ? 1 : 0,
    dataType: 'BOOLEAN',
    comment: metricsOnly
      ? undefined
      : [feedback.tag, feedback.text].filter(Boolean).join(': ') || undefined,
    metadata: metricsOnly ? stripFeedbackContent(fullMetadata) : fullMetadata,
    ...(observationId ? { observationId } : {}),
    ...(ENVIRONMENT ? { environment: ENVIRONMENT } : {}),
  };
}

export async function sendFeedbackScore({
  traceId,
  sampled,
  destinationIds,
  feedback,
  metadata = {},
  observationId,
  appConfig,
  centralTraceExportEnabled,
}: SendFeedbackScoreParams): Promise<void> {
  if (!traceId) {
    return;
  }

  const destinationIdSet = destinationIds == null ? undefined : new Set(destinationIds);
  const destinations = (
    await getScoreDestinations(appConfig, traceId, sampled, { centralTraceExportEnabled })
  ).filter(({ id }) => destinationIdSet == null || (id != null && destinationIdSet.has(id)));
  if (destinations.length === 0) {
    return;
  }

  const scoreId = `feedback-${traceId}`;
  const payload = feedback?.rating
    ? buildScorePayload({
        scoreId,
        traceId,
        feedback,
        metadata,
        observationId,
        metricsOnly: isLangfuseMetricsOnlyPrivacy(appConfig),
      })
    : undefined;

  const results = await Promise.allSettled(
    destinations.map((destination) =>
      payload ? createScore(destination, payload) : deleteScore(destination, scoreId),
    ),
  );
  const failures: string[] = [];

  results.forEach((result, index) => {
    const destination = destinations[index];
    if (!destination) {
      return;
    }
    if (result.status === 'fulfilled') {
      logger.debug(
        `[langfuse] ${destination.name} feedback score ${
          payload ? 'sent' : 'deleted'
        } for trace ${traceId} (${feedback?.rating ?? 'none'})`,
      );
      return;
    }

    logger.error(
      `[langfuse] ${destination.name} feedback score ${
        payload ? 'send' : 'delete'
      } failed for trace ${traceId}:`,
      result.reason,
    );
    failures.push(
      `langfuse ${destination.name} score ${payload ? 'create' : 'delete'} failed: ${
        result.reason instanceof Error ? result.reason.message : String(result.reason)
      }`,
    );
  });

  if (failures.length > 0) {
    throw new Error(failures.join('; '));
  }
}
