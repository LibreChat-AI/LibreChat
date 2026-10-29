import { agentsEndpointSchema, channelConfigSchema } from '../src/config';
import {
  responseCancelReceiptSchema,
  responseReviewDecisionReceiptSchema,
  responseReviewDecisionSchema,
} from '../src/types/responseReview';

it('does not enable Channels or background Responses for existing configurations', () => {
  const defaults = agentsEndpointSchema.parse({});
  expect(defaults.channels).toBeUndefined();
  expect(defaults.remoteApi?.background).toBeUndefined();
  const configured = agentsEndpointSchema.parse({ channels: {}, remoteApi: { background: {} } });
  expect(configured.channels?.enabled).toBe(false);
  expect(configured.remoteApi?.background?.enabled).toBe(false);
  expect(channelConfigSchema.parse({}).enabled).toBe(false);
  expect(configured.channels?.cleanup).toEqual({
    batchSize: 25,
    intervalMs: 1000,
    maxIdleIntervalMs: 30_000,
  });
  expect(configured.channels?.feedback).toEqual({
    maxConflictRetries: 5,
    exportTimeoutMs: 10_000,
    exportLeaseMs: 60_000,
    exportRetryMs: 5000,
    batchSize: 25,
    intervalMs: 1000,
    maxIdleIntervalMs: 30_000,
  });
});

it('requires explicit configuration to enable either execution surface', () => {
  const configured = agentsEndpointSchema.parse({
    channels: { enabled: true },
    remoteApi: { background: { enabled: true } },
  });
  expect(configured.channels?.enabled).toBe(true);
  expect(configured.remoteApi?.background?.enabled).toBe(true);
});

it('validates bounded persistence and acknowledgement settings', () => {
  expect(channelConfigSchema.safeParse({ leaseMs: 0 }).success).toBe(false);
  expect(channelConfigSchema.safeParse({ artifactMaxFiles: 21 }).success).toBe(false);
  expect(
    agentsEndpointSchema.safeParse({ remoteApi: { background: { acknowledgementTimeoutMs: 0 } } })
      .success,
  ).toBe(false);
});

it('accepts the existing single, batch and tool decision wire shapes without extra authority fields', () => {
  for (const decision of [
    { actionId: 'action', answer: 'yes' },
    { actionId: 'action', answers: { question: 'yes' } },
    { actionId: 'action', decisions: [{ tool_call_id: 'call', decision: 'approve' }] },
  ]) {
    expect(responseReviewDecisionSchema.safeParse(decision).success).toBe(true);
  }
  expect(
    responseReviewDecisionSchema.safeParse({ actionId: 'action', answer: 'yes', userId: 'other' })
      .success,
  ).toBe(false);
});

it('recognizes only supported decision and cancellation acknowledgement states', () => {
  expect(
    responseReviewDecisionReceiptSchema.safeParse({
      responseId: 'response',
      actionId: 'action',
      intentId: 'intent',
      status: 'queued',
    }).success,
  ).toBe(true);
  expect(
    responseCancelReceiptSchema.safeParse({ id: 'response', status: 'in_progress' }).success,
  ).toBe(true);
  expect(
    responseCancelReceiptSchema.safeParse({ id: 'response', status: 'stopping' }).success,
  ).toBe(false);
});
