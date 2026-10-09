import { omitResolvedCanonicalFileLocators } from '../protection/files';
/// <reference types="jest" />
import express from 'express';
import request from 'supertest';
import { EventEmitter } from 'events';
import { recordAgentEventActorReceiptMetric } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import {
  createMetrics,
  reportLocatorTraversalFailure,
  instrumentMongooseQueryMetrics,
  normalizePath,
  recordAgentStartupMilestone,
  recordAgentStartupResult,
  recordGenerationJob,
  recordGenerationStreamAttachment,
  recordGenerationStreamEarlyBufferOverflow,
  recordGenerationStreamRecovery,
  recordGenerationStreamResumePendingEvents,
  recordGenerationStreamSubscription,
  recordOpenIDUserLookup,
  recordRedisOperation,
  recordRumProxyRequest,
  recordShareLinkRejection,
  setGenerationJobsInFlight,
} from './metrics';

describe('normalizePath', () => {
  it.each([
    // Known high-cardinality routes
    ['/api/messages/507f1f77bcf86cd799439011', '/api/messages/#id'],
    ['/api/messages/507f1f77bcf86cd799439011/507f1f77bcf86cd799439012', '/api/messages/#id/#id'],
    ['/api/messages/artifact/507f1f77bcf86cd799439012', '/api/messages/artifact/#id'],
    ['/api/convos/507f1f77bcf86cd799439011', '/api/convos/#id'],
    ['/api/files/507f1f77bcf86cd799439011', '/api/files/#id'],
    ['/api/files/507f1f77bcf86cd799439011/preview', '/api/files/#id/preview'],
    ['/api/files/download/user-123/file-456', '/api/files/download/#id/#id'],
    ['/api/files/download-url/user-123/file-456', '/api/files/download-url/#id/#id'],
    ['/api/files/code/download/session-123/file-456', '/api/files/code/download/#id/#id'],
    ['/api/agents/507f1f77bcf86cd799439011', '/api/agents/#id'],
    ['/api/agents/chat/stream/stream-123', '/api/agents/chat/stream/#id'],
    ['/api/agents/chat/status/convo-123', '/api/agents/chat/status/#id'],
    ['/api/agents/v1/chat/completions', '/api/agents/v1/chat/completions'],
    ['/api/agents/v1/responses', '/api/agents/v1/responses'],
    ['/api/assistants/507f1f77bcf86cd799439011', '/api/assistants/#id'],
    ['/api/skills/507f1f77bcf86cd799439011/files/reference.md', '/api/skills/#id/files'],
    ['/api/share/some-token-value', '/api/share/#token'],
    ['/share/shareId-with_nanoidChars', '/share/#id'],
    ['/share/shareId-with_nanoidChars/edit', '/share/#id/edit'],
    // Known API routes with dynamic IDs
    ['/api/tags/507f1f77bcf86cd799439011', '/api/tags/#id'],
    ['/api/tags/507F1F77BCF86CD799439011', '/api/tags/#id'],
    ['/api/tools/507f1f77bcf86cd799439011', '/api/tools/#id'],
    ['/api/runs/507f1f77bcf86cd799439011', '/api/runs/#id'],
    // Catch-all: UUID in unknown routes
    ['/api/tools/123e4567-e89b-12d3-a456-426614174000', '/api/tools/#id'],
    ['/api/sessions/123E4567-E89B-12D3-A456-426614174000', '/api/sessions/#id'],
    // Multiple dynamic segments
    [
      '/api/convos/507f1f77bcf86cd799439011/messages/507f1f77bcf86cd799439012',
      '/api/convos/#id/messages/#id',
    ],
    // Static paths are not modified
    ['/api/auth/login', '/api/auth/login'],
    ['/api/config', '/api/config'],
    ['/health', '/health'],
    ['/metrics', '/metrics'],
    ['/', '/'],
    // Unknown/user-generated routes collapse into bounded label buckets
    ['/api/not-a-real-route/user-generated-value', '/api/#path'],
    ['/images/user-123/avatar-1700000000000.png', '/images/#path'],
    ['/avatars/user-123/avatar-1700000000000.png', '/avatars/#path'],
    ['/t/tenant-a/images/user-123/avatar-1700000000000.png', '/t/#path'],
    ['/unknown/shareId-with_nanoidChars', '/#path'],
    ['/api/messages/507f1f77bcf86cd799439011/user-generated-value/extra', '/api/#path'],
    ['/api/messages/artifact/507f1f77bcf86cd799439012/user-generated-value', '/api/#path'],
  ])('normalizes %s -> %s', (input: string, normalized: string) => {
    expect(normalizePath(input)).toBe(normalized);
  });
});

describe('createMetrics', () => {
  afterEach(() => {
    delete process.env.METRICS_SECRET;
  });

  it('uses a no-op middleware and unauthorized router when metrics are not configured', async () => {
    const app = express();
    const { metricsMiddleware, metricsRouter } = createMetrics();
    const res = new EventEmitter();
    const next = jest.fn();

    metricsMiddleware(
      { headers: {}, method: 'GET', path: '/api/slow-response' } as Request,
      res as unknown as Response,
      next,
    );
    app.use('/metrics', metricsRouter);

    await request(app).get('/metrics').expect(401);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.listenerCount('finish')).toBe(0);
    expect(res.listenerCount('close')).toBe(0);
  });

  it('tracks request counts, in-flight gauges, and request body sizes', async () => {
    const app = express();
    process.env.METRICS_SECRET = 'test-secret';
    const { metricsMiddleware, metricsRouter } = createMetrics();
    app.use(metricsMiddleware);
    app.use(express.text({ type: '*/*' }));
    app.post('/api/files/:id', (_req, res) => {
      res.status(201).send('ok');
    });
    app.use('/metrics', metricsRouter);

    await request(app)
      .post('/api/files/507f1f77bcf86cd799439011')
      .set('Content-Type', 'text/plain')
      .send('x'.repeat(42))
      .expect(201);

    const response = await request(app)
      .get('/metrics')
      .set('Authorization', 'Bearer test-secret')
      .expect(200);

    expect(response.text).toMatch(
      /http_requests_total\{method="POST",path="\/api\/files\/#id",status="201"\} 1/,
    );
    expect(response.text).toMatch(
      /http_requests_in_flight\{method="POST",path="\/api\/files\/#id"\} 0/,
    );
    expect(response.text).toMatch(
      /http_request_body_bytes_count\{method="POST",path="\/api\/files\/#id"\} 1/,
    );
    expect(response.text).toMatch(
      /http_request_body_bytes_sum\{method="POST",path="\/api\/files\/#id"\} 42/,
    );
  });

  it('records locator traversal reasons and count distributions without content labels', async () => {
    process.env.METRICS_SECRET = 'test-secret';
    createMetrics();
    const app = express();
    app.use('/metrics', createMetrics().metricsRouter);
    expect(() =>
      omitResolvedCanonicalFileLocators(
        { file_id: 'PRIVATE-FILE', payload: new Array(4096) },
        new Map([['PRIVATE-FILE', { file_id: 'PRIVATE-FILE' }]]),
        { messageCount: 58, onTraversalFailure: reportLocatorTraversalFailure },
      ),
    ).toThrow();
    const response = await request(app).get('/metrics').set('Authorization', 'Bearer test-secret');
    expect(response.status).toBe(200);
    expect(response.text).toContain(
      'content_filter_locator_traversal_failures_total{operation="omit_resolved_file_locators",reason="array_length"} 1',
    );
    for (const [dimension, count] of [
      ['visitedNodes', 2],
      ['depth', 1],
      ['messageCount', 58],
      ['resolvedFileCount', 1],
    ]) {
      expect(response.text).toContain(
        `content_filter_locator_traversal_size_sum{operation="omit_resolved_file_locators",reason="array_length",dimension="${dimension}"} ${count}`,
      );
    }
    expect(response.text).not.toContain('PRIVATE-FILE');
  });

  it('exposes bounded event actor receipt settlement, replay, conflict, and migration metrics', async () => {
    const app = express();
    process.env.METRICS_SECRET = 'test-secret';
    const { metricsRouter } = createMetrics();
    app.use('/metrics', metricsRouter);

    recordAgentEventActorReceiptMetric({
      operation: 'settle',
      outcome: 'success',
      resolution: 'checkpoint_verified',
    });
    recordAgentEventActorReceiptMetric({
      operation: 'read',
      outcome: 'hit',
      resolution: 'checkpoint_verified',
    });
    recordAgentEventActorReceiptMetric({
      operation: 'settle',
      outcome: 'conflict',
      resolution: 'action_compensated',
    });
    recordAgentEventActorReceiptMetric({
      operation: 'backfill',
      outcome: 'success',
      resolution: 'history_repaired',
    });

    const response = await request(app)
      .get('/metrics')
      .set('Authorization', 'Bearer test-secret')
      .expect(200);

    expect(response.text).toContain(
      'agent_event_actor_receipt_operations_total{operation="settle",outcome="success",resolution="checkpoint_verified"} 1',
    );
    expect(response.text).toContain(
      'agent_event_actor_receipt_operations_total{operation="read",outcome="hit",resolution="checkpoint_verified"} 1',
    );
    expect(response.text).toContain(
      'agent_event_actor_receipt_operations_total{operation="settle",outcome="conflict",resolution="action_compensated"} 1',
    );
    expect(response.text).toContain(
      'agent_event_actor_receipt_operations_total{operation="backfill",outcome="success",resolution="history_repaired"} 1',
    );
  });

  it('collects truthful event actor receipt, reconciliation, retry, and TTL gauges', async () => {
    const app = express();
    process.env.METRICS_SECRET = 'test-secret';
    const collectAgentEventActorStorageMetrics = jest.fn(async () => ({
      retainedByResolution: {
        checkpoint_verified: 7,
        action_compensated: 2,
        history_repaired: 1,
      },
      expiryEligible: 3,
      retryDeliveries: 4,
      deadDeliveries: 5,
      pendingReconciliations: 6,
      oldestPendingAgeSeconds: 91,
    }));
    const { metricsRouter } = createMetrics({
      collectAgentEventActorStorageMetrics,
    });
    app.use('/metrics', metricsRouter);

    const response = await request(app)
      .get('/metrics')
      .set('Authorization', 'Bearer test-secret')
      .expect(200);

    expect(response.text).toContain(
      'agent_event_actor_receipts_retained{resolution="checkpoint_verified"} 7',
    );
    expect(response.text).toContain('agent_event_actor_receipts_expiry_eligible 3');
    expect(response.text).toContain('agent_event_actor_reconciliations_pending 6');
    expect(response.text).toContain('agent_event_actor_oldest_reconciliation_age_seconds 91');
    expect(response.text).toContain('agent_event_actor_deliveries{state="retry"} 4');
    expect(response.text).toContain('agent_event_actor_deliveries{state="dead"} 5');
    await request(app).get('/metrics').set('Authorization', 'Bearer test-secret').expect(200);
    expect(collectAgentEventActorStorageMetrics).toHaveBeenCalledTimes(1);
  });

  it('tracks SSE stream counts, active gauges, and stream duration', async () => {
    const app = express();
    process.env.METRICS_SECRET = 'test-secret';
    const { metricsMiddleware, metricsRouter } = createMetrics();
    app.use(metricsMiddleware);
    app.get('/api/agents/chat/stream/:streamId', (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.write('event: message\ndata: {}\n\n');
      res.end();
    });
    app.use('/metrics', metricsRouter);

    await request(app).get('/api/agents/chat/stream/stream-123').expect(200);

    const response = await request(app)
      .get('/metrics')
      .set('Authorization', 'Bearer test-secret')
      .expect(200);

    expect(response.text).toMatch(
      /sse_streams_total\{method="GET",path="\/api\/agents\/chat\/stream\/#id",status="200"\} 1/,
    );
    expect(response.text).toMatch(
      /sse_streams_in_flight\{method="GET",path="\/api\/agents\/chat\/stream\/#id"\} 0/,
    );
    expect(response.text).toMatch(
      /sse_stream_duration_seconds_count\{method="GET",path="\/api\/agents\/chat\/stream\/#id",status="200"\} 1/,
    );
  });

  it('tracks upload counts, active gauges, duration, and upload bytes', async () => {
    const app = express();
    process.env.METRICS_SECRET = 'test-secret';
    const { metricsMiddleware, metricsRouter } = createMetrics();
    app.use(metricsMiddleware);
    app.post('/api/files', (_req, res) => {
      res.status(201).send('ok');
    });
    app.use('/metrics', metricsRouter);

    await request(app)
      .post('/api/files')
      .attach('file', Buffer.from('uploaded body'), 'test.txt')
      .expect(201);

    const response = await request(app)
      .get('/metrics')
      .set('Authorization', 'Bearer test-secret')
      .expect(200);

    expect(response.text).toMatch(
      /upload_requests_total\{method="POST",path="\/api\/files",status="201"\} 1/,
    );
    expect(response.text).toMatch(
      /upload_requests_in_flight\{method="POST",path="\/api\/files"\} 0/,
    );
    expect(response.text).toMatch(
      /upload_request_duration_seconds_count\{method="POST",path="\/api\/files",status="201"\} 1/,
    );
    expect(response.text).toMatch(/upload_bytes_total\{method="POST",path="\/api\/files"\} \d+/);
  });

  it('does not track non-upload methods on upload paths as uploads', async () => {
    const app = express();
    process.env.METRICS_SECRET = 'test-secret';
    const { metricsMiddleware, metricsRouter } = createMetrics();
    app.use(metricsMiddleware);
    app.delete('/api/files', (_req, res) => {
      res.status(204).end();
    });
    app.use('/metrics', metricsRouter);

    await request(app).delete('/api/files').expect(204);

    const response = await request(app)
      .get('/metrics')
      .set('Authorization', 'Bearer test-secret')
      .expect(200);

    expect(response.text).not.toMatch(/upload_requests_total\{method="DELETE"/);
    expect(response.text).not.toMatch(/upload_bytes_total\{method="DELETE"/);
  });

  it('labels requests closed before finish as client-aborted', async () => {
    const app = express();
    process.env.METRICS_SECRET = 'test-secret';
    const { metricsMiddleware, metricsRouter } = createMetrics();
    const headers = new Map<string, unknown>();
    const res = Object.assign(new EventEmitter(), {
      destroyed: false,
      getHeader: (name: string) => headers.get(name.toLowerCase()),
      setHeader(name: string, value: unknown) {
        headers.set(name.toLowerCase(), value);
        return this;
      },
      statusCode: 200,
      writableEnded: false,
      writeHead() {
        return this;
      },
    });
    const next = jest.fn();

    metricsMiddleware(
      { headers: {}, method: 'GET', path: '/api/slow-response' } as Request,
      res as unknown as Response,
      next,
    );
    res.emit('close');
    app.use('/metrics', metricsRouter);

    const response = await request(app)
      .get('/metrics')
      .set('Authorization', 'Bearer test-secret')
      .expect(200);

    expect(next).toHaveBeenCalledTimes(1);
    expect(response.text).toMatch(
      /http_requests_total\{method="GET",path="\/api\/#path",status="499"\} 1/,
    );
    expect(response.text).not.toMatch(
      /http_requests_total\{method="GET",path="\/api\/#path",status="200"\}/,
    );
  });

  it('tracks OpenID user lookup outcomes and latency', async () => {
    const app = express();
    process.env.METRICS_SECRET = 'test-secret';
    const { metricsRouter } = createMetrics();
    app.use('/metrics', metricsRouter);

    recordOpenIDUserLookup('found', 0.2);

    const response = await request(app)
      .get('/metrics')
      .set('Authorization', 'Bearer test-secret')
      .expect(200);

    expect(response.text).toMatch(/openid_user_lookup_total\{result="found"\} 1/);
    expect(response.text).toMatch(/openid_user_lookup_duration_seconds_count\{result="found"\} 1/);
    expect(response.text).toMatch(/openid_user_lookup_duration_seconds_sum\{result="found"\} 0.2/);
  });

  it('tracks Redis operation outcomes and latency by use case', async () => {
    const app = express();
    process.env.METRICS_SECRET = 'test-secret';
    const { metricsRouter } = createMetrics();
    app.use('/metrics', metricsRouter);

    recordRedisOperation('keyv', 'auth_user_doc', 'get', 'success', 0.02);
    recordRedisOperation('ioredis', 'rate_limit', 'eval', 'error', 0.05);

    const response = await request(app)
      .get('/metrics')
      .set('Authorization', 'Bearer test-secret')
      .expect(200);

    expect(response.text).toMatch(
      /redis_operations_total\{client="keyv",use_case="auth_user_doc",operation="get",status="success"\} 1/,
    );
    expect(response.text).toMatch(
      /redis_operation_duration_seconds_count\{client="ioredis",use_case="rate_limit",operation="eval",status="error"\} 1/,
    );
    expect(response.text).toMatch(
      /redis_operation_duration_seconds_sum\{client="ioredis",use_case="rate_limit",operation="eval",status="error"\} 0.05/,
    );
  });

  it('tracks RUM proxy request outcomes', async () => {
    const app = express();
    process.env.METRICS_SECRET = 'test-secret';
    const { metricsRouter } = createMetrics();
    app.use('/metrics', metricsRouter);

    recordRumProxyRequest('traces', 'success');
    recordRumProxyRequest('traces', 'auth_drop');
    recordRumProxyRequest('logs', 'auth_error');
    recordRumProxyRequest('logs', 'collector_5xx');

    const response = await request(app)
      .get('/metrics')
      .set('Authorization', 'Bearer test-secret')
      .expect(200);

    expect(response.text).toMatch(
      /rum_proxy_requests_total\{endpoint="traces",result="success"\} 1/,
    );
    expect(response.text).toMatch(
      /rum_proxy_requests_total\{endpoint="traces",result="auth_drop"\} 1/,
    );
    expect(response.text).toMatch(
      /rum_proxy_requests_total\{endpoint="logs",result="auth_error"\} 1/,
    );
    expect(response.text).toMatch(
      /rum_proxy_requests_total\{endpoint="logs",result="collector_5xx"\} 1/,
    );
  });

  it('tracks bounded shared-link rejection outcomes', async () => {
    const app = express();
    process.env.METRICS_SECRET = 'test-secret';
    const { metricsRouter } = createMetrics();
    app.use('/metrics', metricsRouter);

    recordShareLinkRejection('create', 'TARGET_MESSAGE_NOT_FOUND');
    recordShareLinkRejection('update', 'NO_MESSAGES');

    const response = await request(app)
      .get('/metrics')
      .set('Authorization', 'Bearer test-secret')
      .expect(200);

    expect(response.text).toMatch(
      /share_link_rejections_total\{operation="create",code="TARGET_MESSAGE_NOT_FOUND"\} 1/,
    );
    expect(response.text).toMatch(
      /share_link_rejections_total\{operation="update",code="NO_MESSAGES"\} 1/,
    );
  });

  it('tracks mongoose query counts and latency by model and operation', async () => {
    class FakeQuery {
      model = { modelName: 'User' };
      op = 'findOne';

      exec() {
        return Promise.resolve({ _id: 'user-1' });
      }
    }

    const app = express();
    process.env.METRICS_SECRET = 'test-secret';
    const { metricsRouter } = createMetrics();
    app.use('/metrics', metricsRouter);

    instrumentMongooseQueryMetrics({ Query: FakeQuery } as never);
    await new FakeQuery().exec();

    const response = await request(app)
      .get('/metrics')
      .set('Authorization', 'Bearer test-secret')
      .expect(200);

    expect(response.text).toMatch(
      /mongoose_queries_total\{model="User",operation="findOne",status="success"\} 1/,
    );
    expect(response.text).toMatch(
      /mongoose_query_duration_seconds_count\{model="User",operation="findOne",status="success"\} 1/,
    );
  });

  it('does not instrument mongoose queries when metrics are not configured', async () => {
    class FakeQuery {
      model = { modelName: 'User' };
      op = 'findOne';

      exec() {
        return Promise.resolve({ _id: 'user-1' });
      }
    }

    const originalExec = FakeQuery.prototype.exec;

    instrumentMongooseQueryMetrics({ Query: FakeQuery } as never);

    expect(FakeQuery.prototype.exec).toBe(originalExec);
  });

  it('tracks mongoose query errors thrown before a promise is returned', async () => {
    class ThrowingQuery {
      model = { modelName: 'User' };
      op = 'findOne';

      exec() {
        throw new Error('sync database error');
      }
    }

    const app = express();
    process.env.METRICS_SECRET = 'test-secret';
    const { metricsRouter } = createMetrics();
    app.use('/metrics', metricsRouter);

    instrumentMongooseQueryMetrics({ Query: ThrowingQuery } as never);
    expect(() => new ThrowingQuery().exec()).toThrow('sync database error');

    const response = await request(app)
      .get('/metrics')
      .set('Authorization', 'Bearer test-secret')
      .expect(200);

    expect(response.text).toMatch(
      /mongoose_queries_total\{model="User",operation="findOne",status="error"\} 1/,
    );
    expect(response.text).toMatch(
      /mongoose_query_duration_seconds_count\{model="User",operation="findOne",status="error"\} 1/,
    );
  });

  it('tracks generation job and stream resume metrics', async () => {
    const app = express();
    process.env.METRICS_SECRET = 'test-secret';
    const { metricsRouter } = createMetrics();
    app.use('/metrics', metricsRouter);

    recordGenerationJob('memory', 'created');
    setGenerationJobsInFlight('memory', 2);
    recordGenerationStreamSubscription('redis', 'resume', 'not_found');
    recordGenerationStreamSubscription('redis', 'resume_state', 'missing');
    recordGenerationStreamResumePendingEvents('memory', 3);
    recordGenerationStreamEarlyBufferOverflow('redis');
    recordGenerationStreamRecovery('redis', 'redis', 'success', 0.25, 5001, 12);
    recordGenerationStreamAttachment('redis', 'attached', 4.5);
    recordGenerationStreamAttachment('redis', 'bootstrap_slow');

    const response = await request(app)
      .get('/metrics')
      .set('Authorization', 'Bearer test-secret')
      .expect(200);

    expect(response.text).toMatch(/generation_jobs_total\{store="memory",result="created"\} 1/);
    expect(response.text).toMatch(/generation_jobs_in_flight\{store="memory"\} 2/);
    expect(response.text).toMatch(
      /generation_stream_subscriptions_total\{store="redis",type="resume",result="not_found"\} 1/,
    );
    expect(response.text).toMatch(
      /generation_stream_subscriptions_total\{store="redis",type="resume_state",result="missing"\} 1/,
    );
    expect(response.text).toMatch(
      /generation_stream_resume_pending_events_total\{store="memory"\} 3/,
    );
    expect(response.text).toMatch(
      /generation_stream_early_buffer_overflows_total\{store="redis"\} 1/,
    );
    expect(response.text).toMatch(
      /generation_stream_recoveries_total\{store="redis",method="redis",outcome="success"\} 1/,
    );
    expect(response.text).toMatch(
      /generation_stream_recovery_duration_seconds_sum\{store="redis",method="redis",outcome="success"\} 0.25/,
    );
    expect(response.text).toMatch(
      /generation_stream_attachment_outcomes_total\{store="redis",outcome="attached"\} 1/,
    );
    expect(response.text).toMatch(
      /generation_stream_attachment_outcomes_total\{store="redis",outcome="bootstrap_slow"\} 1/,
    );
    expect(response.text).toMatch(
      /generation_stream_first_attachment_delay_seconds_sum\{store="redis"\} 4.5/,
    );
  });

  it('tracks cumulative agent startup milestones and terminal results', async () => {
    const app = express();
    process.env.METRICS_SECRET = 'test-secret';
    const { metricsRouter } = createMetrics();
    app.use('/metrics', metricsRouter);

    recordAgentStartupMilestone('job_created', 0.125);
    recordAgentStartupMilestone('first_response_event_queued', 0.75);
    recordAgentStartupResult('content_queued');
    Reflect.apply(recordAgentStartupMilestone, undefined, ['unbounded-user-value', 1]);
    Reflect.apply(recordAgentStartupMilestone, undefined, ['job_created', Number.NaN]);
    Reflect.apply(recordAgentStartupResult, undefined, ['unbounded-user-value']);

    const response = await request(app)
      .get('/metrics')
      .set('Authorization', 'Bearer test-secret')
      .expect(200);

    expect(response.text).toMatch(
      /agent_startup_milestone_duration_seconds_count\{milestone="job_created"\} 1/,
    );
    expect(response.text).toMatch(
      /agent_startup_milestone_duration_seconds_sum\{milestone="job_created"\} 0.125/,
    );
    expect(response.text).toMatch(
      /agent_startup_milestone_duration_seconds_count\{milestone="first_response_event_queued"\} 1/,
    );
    expect(response.text).toMatch(/agent_startups_total\{result="content_queued"\} 1/);
    expect(response.text).not.toContain('unbounded-user-value');
  });
});
