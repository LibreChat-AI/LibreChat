import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  ChannelDeliveryPlan,
  ChannelDeliveryReceipt,
  ChannelRunView,
} from 'librechat-data-provider';
import type { ChannelBundle, Lease, Logger, ResponseGrant } from './types';
import { ChannelWorker, progressText } from './worker';
import { ChannelClient } from './client';
import { makeSlackPlan } from './render';
import { loadConfig } from './config';
import { SlackClient } from './slack';

const json = (body: object, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
const slackOK = (body: object = {}) => json({ ok: true, ...body });

interface MutationBody {
  owner?: string;
  fence?: Lease['fence'];
  responseId?: string;
  revision?: number;
  rendererVersion?: string;
  text?: string;
  plan?: ChannelDeliveryPlan;
  operationId?: string;
  attempts?: number;
  upload?: ChannelDeliveryReceipt['upload'];
  receipt?: ChannelDeliveryReceipt;
}

function fixture() {
  const config = loadConfig({
    CHANNEL_SERVICE_TOKEN: 'service-token',
    CHANNEL_ID: 'channel-1',
    CHANNEL_TENANT_ID: 'tenant-1',
    LIBRECHAT_INTERNAL_URL: 'http://backend.example',
    SLACK_API_BASE_URL: 'http://127.0.0.1:8080/api/',
    API_CALL_TIMEOUT_MS: '2000',
    AGENT_INVOKE_TIMEOUT_MS: '2000',
  });
  const bundle: ChannelBundle = {
    channel: {
      channelId: config.CHANNEL_ID,
      tenantId: config.CHANNEL_TENANT_ID,
      agentId: 'agent-1',
      createdBy: 'user-1',
      credentialMode: 'per_user',
      type: 'slack',
      status: 'active',
      revision: 'revision-1',
      slack: { teamId: 'T1', appId: 'A1', botUserId: 'BOT1' },
    },
    credentials: { botToken: 'bot-token' },
    agent: { id: 'agent-1', name: 'Test' },
  };
  const state: ChannelRunView = {
    runId: 'run-1',
    channelId: config.CHANNEL_ID,
    revision: 'revision-1',
    state: 'executing',
    sequence: 1,
    cancellationRequested: false,
    receipts: [],
    admission: {
      actor: { teamId: 'T1', appId: 'A1', externalUserId: 'U1' },
      eventId: 'event-1',
      externalChannelId: 'C1',
      externalThreadKey: 'C1:123.456',
      externalMessageKey: 'C1:123.457',
      input: 'hello',
    },
  };
  const grant: ResponseGrant = {
    apiKey: 'sk-bound-test',
    requestKey: 'channel:run-1',
    responseId: 'resp_test',
    request: {
      model: bundle.agent.id,
      input: state.admission.input,
      background: true,
      store: true,
    },
  };
  const lease: Lease = {
    run: state,
    fence: { runId: state.runId, owner: 'worker-1', epoch: 1 },
    leaseExpiresAt: Date.now() + 60_000,
  };
  const requests: {
    path: string;
    body: MutationBody;
    authorization: string | null;
    key: string | null;
  }[] = [];
  const slackRequests: { method: string; body: URLSearchParams }[] = [];
  const artifactBytes = Buffer.from('test artifact');
  const controller = new AbortController();
  let claimCount = 0;
  const log: Logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const hooks: {
    advance?: () => void;
    renew?: () => Promise<Response>;
    response?: () => Promise<Response>;
    slack?: (method: string, body: URLSearchParams) => Promise<Response>;
    prepare?: () => ResponseGrant;
    checkpoint?: () => Promise<Response>;
  } = {};
  const snapshot = () => structuredClone(state);
  const backend = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(
    async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body: MutationBody = init?.body ? JSON.parse(String(init.body)) : {};
      const headers = new Headers(init?.headers);
      requests.push({
        path,
        body,
        authorization: headers.get('authorization'),
        key: headers.get('idempotency-key'),
      });
      if (path.includes('/service/slack/')) return json(bundle);
      if (path.includes('/api/agents/v1/responses')) {
        if (hooks.response) return hooks.response();
        return json({
          id: grant.responseId ?? 'resp_test',
          object: 'response',
          model: bundle.agent.id,
          background: true,
          store: true,
          status: 'completed',
        });
      }
      if (path.endsWith('/claim')) {
        if (claimCount++) return new Response(null, { status: 204 });
        lease.fence.owner = body.owner ?? '';
        return json({ ...lease, run: snapshot() });
      }
      if (path.endsWith('/renew')) {
        if (hooks.renew) return hooks.renew();
        return json({ ...lease, run: snapshot(), leaseExpiresAt: Date.now() + 90 });
      }
      if (path.endsWith('/yield')) {
        controller.abort();
        return new Response(null, { status: 204 });
      }
      if (path.endsWith('/response/prepare')) return json(hooks.prepare?.() ?? grant);
      if (path.endsWith('/response/bind')) grant.responseId = body.responseId;
      else if (path.endsWith('/advance')) {
        if (hooks.advance) hooks.advance();
        else {
          state.state = 'delivering';
          state.snapshot = {
            status: 'completed',
            text: 'Final answer',
            responseId: grant.responseId,
            elapsedMs: 200,
          };
        }
      } else if (path.endsWith('/progress/plan')) {
        state.progress = {
          revision: body.revision ?? 0,
          rendererVersion: body.rendererVersion ?? '',
          text: body.text ?? '',
          outcome: 'planned',
          attempts: 0,
          externalMessageKey: state.progress?.externalMessageKey,
        };
      } else if (path.endsWith('/progress/begin')) {
        if (!state.progress) throw new Error('Missing progress fixture');
        state.progress.outcome = 'inflight';
        state.progress.attempts++;
      } else if (path.endsWith('/progress/settle')) {
        if (!state.progress || !body.receipt)
          throw new Error('Missing progress settlement fixture');
        state.progress = { ...state.progress, ...body.receipt };
      } else if (path.endsWith('/plan')) {
        state.plan = body.plan;
        state.receipts =
          body.plan?.parts.map((part) => ({
            operationId: part.operationId,
            outcome: 'planned',
            attempts: 0,
          })) ?? [];
      } else if (path.includes('/artifacts/')) {
        const artifact = state.snapshot?.artifacts?.[0];
        if (!artifact) throw new Error('Missing artifact fixture');
        return new Response(artifactBytes, {
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-Artifact-Filename': encodeURIComponent(artifact.filename),
            'X-Artifact-SHA256': artifact.sha256,
            'X-Artifact-Media-Type': artifact.mediaType,
          },
        });
      } else if (path.endsWith('/delivery/begin')) {
        const receipt = state.receipts.find((item) => item.operationId === body.operationId);
        if (!receipt) throw new Error('Missing begin fixture');
        receipt.outcome = 'inflight';
        receipt.attempts++;
      } else if (path.endsWith('/delivery/checkpoint')) {
        const receipt = state.receipts.find((item) => item.operationId === body.operationId);
        if (!receipt) throw new Error('Missing checkpoint fixture');
        receipt.upload = body.upload;
        if (hooks.checkpoint) return hooks.checkpoint();
      } else if (path.endsWith('/delivery/settle')) {
        const receipt = state.receipts.find(
          (item) => item.operationId === body.receipt?.operationId,
        );
        if (!receipt || !body.receipt) throw new Error('Missing settle fixture');
        Object.assign(receipt, body.receipt);
      } else if (path.endsWith('/commit')) state.state = 'delivered';
      else throw new Error('Unexpected backend fixture path');
      return json(snapshot());
    },
  );
  const slackTransport = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(
    async (input, init) => {
      const method = new URL(String(input)).pathname.split('/').at(-1) ?? '';
      const body = new URLSearchParams(String(init?.body));
      slackRequests.push({ method, body });
      if (hooks.slack) return hooks.slack(method, body);
      if (method === 'files.getUploadURLExternal')
        return slackOK({ file_id: 'F1', upload_url: 'http://127.0.0.1:8080/upload' });
      if (method === 'upload') return new Response('ok');
      if (method === 'files.completeUploadExternal') return slackOK({ files: [{ id: 'F1' }] });
      if (method === 'agents.sessions.setStatus') return slackOK();
      return slackOK({ channel: 'C1', ts: method === 'chat.update' ? body.get('ts') : '123.789' });
    },
  );
  const client = new ChannelClient(config, backend);
  const slack = new SlackClient(config, log, slackTransport);
  const worker = new ChannelWorker(config, client, slack, log);
  const savedPlan = (artifacts = false) => {
    state.state = 'delivering';
    state.snapshot = {
      status: 'completed',
      text: 'Saved final answer',
      responseId: grant.responseId,
      elapsedMs: 200,
    };
    if (artifacts)
      state.snapshot.artifacts = [
        {
          artifactId: 'artifact-1',
          filename: 'report.txt',
          bytes: artifactBytes.length,
          mediaType: 'text/plain',
          sha256: createHash('sha256').update(artifactBytes).digest('hex'),
        },
      ];
    state.plan = makeSlackPlan(state, true);
    state.receipts = state.plan.parts.map((part) => ({
      operationId: part.operationId,
      outcome: 'planned',
      attempts: 0,
    }));
  };
  const execute = () => worker.process({ ...lease, run: snapshot() }, controller.signal);
  const paths = () => requests.map((request) => request.path);
  return {
    config,
    bundle,
    state,
    grant,
    lease,
    requests,
    slackRequests,
    artifactBytes,
    controller,
    log,
    hooks,
    backend,
    slackTransport,
    worker,
    savedPlan,
    execute,
    paths,
  };
}

describe('durable Channels worker', () => {
  test('executes only through a bound Responses grant and persists progress before writes', async () => {
    const f = fixture();
    delete f.grant.responseId;
    await f.execute();
    const responseRequests = f.requests.filter((request) =>
      request.path.startsWith('/api/agents/v1/responses'),
    );
    expect(responseRequests.map((request) => request.authorization)).toEqual([
      'Bearer sk-bound-test',
      'Bearer sk-bound-test',
    ]);
    expect(responseRequests[0].key).toBe('channel:run-1');
    expect(responseRequests[0].body).toMatchObject({
      model: 'agent-1',
      input: 'hello',
      background: true,
      store: true,
      stream: false,
    });
    expect(f.paths().some((path) => path.endsWith('/response/bind'))).toBe(true);
    const writes = f.slackRequests.filter((request) =>
      ['chat.postMessage', 'chat.update'].includes(request.method),
    );
    expect(writes.map((request) => request.method)).toEqual([
      'chat.postMessage',
      'chat.update',
      'chat.postMessage',
    ]);
    expect(writes[0].body.get('text')).toBe(':hourglass_flowing_sand: Working…');
    expect(writes[1].body.get('text')).toBe(':white_check_mark: Completed.');
    expect(f.paths().filter((path) => path.endsWith('/progress/begin'))).toHaveLength(2);
    expect(f.paths().filter((path) => path.endsWith('/progress/settle'))).toHaveLength(2);
    expect(f.state.state).toBe('delivered');
  });

  test('reuses a saved immutable plan without preparing or reexecuting Responses', async () => {
    const f = fixture();
    f.savedPlan();
    f.state.snapshot!.text = 'Mutated snapshot must not render';
    await f.execute();
    expect(
      f.slackRequests.find((request) => request.method === 'chat.postMessage')?.body.get('text'),
    ).toContain('Saved final answer');
    expect(f.paths().some((path) => /response|advance|\/plan$/.test(path))).toBe(false);
    expect(f.state.state).toBe('delivered');
  });

  test.each(['unknown', 'inflight'] as const)(
    'never replays a required %s delivery',
    async (outcome) => {
      const f = fixture();
      f.savedPlan();
      f.state.receipts[0].outcome = outcome;
      await expect(f.execute()).rejects.toThrow('reconciliation');
      expect(f.slackRequests).toHaveLength(0);
      expect(f.paths().some((path) => /delivery\/begin|commit|yield/.test(path))).toBe(false);
    },
  );

  test('records an uncertain create once and holds it on recovery', async () => {
    const f = fixture();
    f.savedPlan();
    f.hooks.slack = async () => {
      throw new Error('Uncertain connection reset');
    };
    await expect(f.execute()).rejects.toThrow('not confirmed');
    expect(f.state.receipts[0]).toMatchObject({ outcome: 'unknown', attempts: 1 });
    await expect(f.execute()).rejects.toThrow('reconciliation');
    expect(f.slackRequests).toHaveLength(1);
    expect(f.paths().filter((path) => path.endsWith('/delivery/begin'))).toHaveLength(1);
  });

  test.each(['apiKey', 'requestKey', 'model', 'input'] as const)(
    'rejects a changed %s grant before Responses execution',
    async (field) => {
      const f = fixture();
      f.config.SLACK_NATIVE_SESSIONS = true;
      if (field === 'apiKey' || field === 'requestKey') f.grant[field] = 'wrong';
      else f.grant.request[field] = 'wrong';
      await expect(f.execute()).rejects.toThrow('grant');
      expect(f.paths().some((path) => path.startsWith('/api/agents/'))).toBe(false);
    },
  );

  test('renews independently while a Slack create is slow', async () => {
    const f = fixture();
    f.savedPlan();
    f.lease.leaseExpiresAt = Date.now() + 60;
    f.hooks.slack = async () => {
      await delay(120);
      return slackOK({ channel: 'C1', ts: '123.789' });
    };
    await f.execute();
    expect(f.paths().filter((path) => path.endsWith('/renew')).length).toBeGreaterThan(1);
    expect(f.state.state).toBe('delivered');
    expect(f.paths().some((path) => path.endsWith('/yield'))).toBe(false);
  });

  test('uncertain renewal stops settlement and does not blindly yield an inflight create', async () => {
    const f = fixture();
    f.savedPlan();
    f.lease.leaseExpiresAt = Date.now() + 60;
    f.hooks.renew = async () => json({ error: 'unavailable' }, 503);
    f.hooks.slack = async () => {
      await delay(100);
      return slackOK({ channel: 'C1', ts: '123.789' });
    };
    f.log.warn = () => f.controller.abort();
    await f.worker.run(f.controller.signal);
    expect(f.paths().some((path) => path.endsWith('/renew'))).toBe(true);
    expect(f.state.receipts[0].outcome).toBe('inflight');
    expect(f.paths().some((path) => /delivery\/settle|commit|yield/.test(path))).toBe(false);
    expect(f.slackRequests).toHaveLength(1);
  });

  test('unknown progress is not replayed and cannot safely yield a waiting run', async () => {
    const f = fixture();
    f.state.progress = {
      revision: 1,
      rendererVersion: 'slack-progress-v1',
      text: 'Working',
      outcome: 'unknown',
      attempts: 1,
    };
    f.hooks.advance = () => {
      f.state.state = 'requires_action';
      f.state.snapshot = {
        status: 'requires_action',
        text: '',
        responseId: 'resp_test',
        elapsedMs: 10,
      };
    };
    f.log.warn = () => f.controller.abort();
    await f.worker.run(f.controller.signal);
    expect(f.slackRequests).toHaveLength(0);
    expect(f.paths().some((path) => /progress\/(begin|settle)|yield/.test(path))).toBe(false);
  });

  test('cleans terminal progress before persisting a final plan', async () => {
    const f = fixture();
    f.state.progress = {
      revision: 1,
      rendererVersion: 'slack-progress-v1',
      text: progressText(f.state),
      outcome: 'confirmed',
      attempts: 1,
      externalMessageKey: 'C1:123.700',
    };
    await f.execute();
    expect(f.slackRequests[0].method).toBe('chat.update');
    expect(f.slackRequests[0].body.get('text')).toBe(':white_check_mark: Completed.');
    const cleanup = f.paths().findIndex((path) => path.endsWith('/progress/settle'));
    const final = f.paths().findIndex((path) => path.endsWith('/run-1/plan'));
    expect(cleanup).toBeLessThan(final);
    expect(cleanup).toBeGreaterThan(-1);
  });

  test('checkpoint allocation and upload before completion, without a false failure notice', async () => {
    const f = fixture();
    f.savedPlan(true);
    await f.execute();
    expect(f.slackRequests.map((request) => request.method)).toEqual([
      'chat.postMessage',
      'files.getUploadURLExternal',
      'upload',
      'files.completeUploadExternal',
    ]);
    expect(
      f.requests
        .filter((request) => request.path.endsWith('/delivery/checkpoint'))
        .map((request) => request.body.upload),
    ).toEqual([
      { fileId: 'F1', stage: 'allocated' },
      { fileId: 'F1', stage: 'uploaded' },
    ]);
    expect(
      f.state.receipts.find((receipt) => receipt.operationId.includes(':artifact:')),
    ).toMatchObject({
      outcome: 'confirmed',
      externalFileId: 'F1',
      upload: { fileId: 'F1', stage: 'uploaded' },
    });
    expect(f.state.state).toBe('delivered');
  });

  test('unknown artifact completion retains its checkpoint and is never allocated/uploaded again', async () => {
    const f = fixture();
    f.savedPlan(true);
    f.hooks.slack = async (method) => {
      if (method === 'files.getUploadURLExternal')
        return slackOK({ file_id: 'F1', upload_url: 'http://127.0.0.1:8080/upload' });
      if (method === 'upload') return new Response('ok');
      if (method === 'files.completeUploadExternal')
        throw new Error('Connection lost after completion');
      return slackOK({ channel: 'C1', ts: '123.789' });
    };
    await f.execute();
    expect(
      f.state.receipts.find((receipt) => receipt.operationId.includes(':artifact:')),
    ).toMatchObject({ outcome: 'unknown', upload: { fileId: 'F1', stage: 'uploaded' } });
    const before = f.slackRequests.length;
    await f.execute();
    expect(f.slackRequests).toHaveLength(before);
    expect(
      f.slackRequests.filter((request) => request.method === 'files.getUploadURLExternal'),
    ).toHaveLength(1);
    expect(
      f.slackRequests.filter((request) => request.method === 'files.completeUploadExternal'),
    ).toHaveLength(1);
  });

  test('an inflight artifact checkpoint is held, never resumed by allocating a second file', async () => {
    const f = fixture();
    f.savedPlan(true);
    f.state.receipts[0].outcome = 'confirmed';
    const artifact = f.state.receipts.find((receipt) =>
      receipt.operationId.includes(':artifact:'),
    )!;
    artifact.outcome = 'inflight';
    artifact.attempts = 1;
    artifact.upload = { fileId: 'F-existing', stage: 'allocated' };
    await expect(f.execute()).rejects.toThrow('reconciliation');
    expect(f.slackRequests).toHaveLength(0);
    expect(f.paths().some((path) => /delivery\/begin|commit/.test(path))).toBe(false);
  });

  test('an invalid actor binding cannot create Responses or send Slack output', async () => {
    const f = fixture();
    f.state.admission.actor.appId = 'FOREIGN';
    await expect(f.execute()).rejects.toThrow('binding');
    expect(f.slackRequests).toHaveLength(0);
    expect(f.paths().some((path) => /prepare|agents\/v1/.test(path))).toBe(false);
  });

  test('falls back to the persisted text only after an explicit rich-block rejection', async () => {
    const f = fixture();
    f.savedPlan();
    f.hooks.slack = async (_method, body) =>
      body.has('blocks') && body.get('blocks') !== '[]'
        ? slackOK({ ok: false, error: 'invalid_blocks' })
        : slackOK({ channel: 'C1', ts: '123.789' });
    await f.execute();
    expect(f.slackRequests).toHaveLength(2);
    expect(f.slackRequests[0].body.get('text')).toBe(f.slackRequests[1].body.get('text'));
    expect(f.slackRequests[1].body.get('blocks')).toBe('[]');
    expect(f.paths().filter((path) => path.endsWith('/delivery/begin'))).toHaveLength(1);
    expect(f.state.receipts[0]).toMatchObject({ outcome: 'confirmed', attempts: 1 });
  });

  test('exhausted optional artifact retries settle as failed instead of blocking final answer commit', async () => {
    const f = fixture();
    f.savedPlan(true);
    f.state.receipts[0].outcome = 'confirmed';
    const receipt = f.state.receipts.find((item) => item.operationId.includes(':artifact:'))!;
    receipt.outcome = 'retryable';
    receipt.attempts = 5;
    await f.execute();
    expect(receipt.outcome).toBe('permanent_failure');
    expect(f.slackRequests.some((request) => request.method === 'files.getUploadURLExternal')).toBe(
      false,
    );
    expect(f.state.state).toBe('delivered');
  });

  test('does not yield when a renewal becomes uncertain while the independent renewer drains', async () => {
    const f = fixture();
    f.config.SLACK_NATIVE_SESSIONS = true;
    f.lease.leaseExpiresAt = Date.now() + 60;
    f.hooks.renew = async () => {
      await delay(30);
      return json({ error: 'unavailable' }, 503);
    };
    f.hooks.response = async () => {
      await delay(25);
      return json({
        id: 'resp_test',
        object: 'response',
        model: 'agent-1',
        background: true,
        store: true,
        status: 'requires_action',
      });
    };
    f.hooks.advance = () => {
      f.state.state = 'requires_action';
      f.state.snapshot = {
        status: 'requires_action',
        text: '',
        responseId: 'resp_test',
        elapsedMs: 10,
      };
    };
    f.log.warn = () => f.controller.abort();
    await f.worker.run(f.controller.signal);
    expect(f.paths().some((path) => path.endsWith('/renew'))).toBe(true);
    expect(f.paths().some((path) => path.endsWith('/yield'))).toBe(false);
  });

  test('a lost allocation checkpoint acknowledgement cannot trigger binary upload or another allocation', async () => {
    const f = fixture();
    f.savedPlan(true);
    f.hooks.checkpoint = async () => {
      throw new Error('Checkpoint acknowledgement lost');
    };
    await expect(f.execute()).rejects.toThrow('Checkpoint acknowledgement lost');
    const receipt = f.state.receipts.find((item) => item.operationId.includes(':artifact:'))!;
    expect(receipt).toMatchObject({
      outcome: 'inflight',
      upload: { fileId: 'F1', stage: 'allocated' },
    });
    await expect(f.execute()).rejects.toThrow('reconciliation');
    expect(f.slackRequests.map((request) => request.method)).toEqual([
      'chat.postMessage',
      'files.getUploadURLExternal',
    ]);
  });

  test('verified unstarted cancellation never creates or polls a Response', async () => {
    const f = fixture();
    f.config.SLACK_NATIVE_SESSIONS = true;
    f.state.cancellationRequested = true;
    f.hooks.prepare = () => ({
      ...f.grant,
      settled: {
        ...f.state,
        state: 'delivering',
        snapshot: { text: '', status: 'cancelled', elapsedMs: 0 },
      },
    });
    await f.execute();
    expect(f.paths().some((path) => /agents\/v1|advance|response\/bind/.test(path))).toBe(false);
    expect(
      f.slackRequests.find((request) => request.method === 'chat.postMessage')?.body.get('text'),
    ).toContain('This request was cancelled');
  });

  test('unproved cancellation without a Response cursor is held instead of creating new work', async () => {
    const f = fixture();
    f.config.SLACK_NATIVE_SESSIONS = true;
    f.state.cancellationRequested = true;
    delete f.grant.responseId;
    await expect(f.execute()).rejects.toThrow('awaits reconciliation');
    expect(f.paths().some((path) => /agents\/v1|advance|response\/bind/.test(path))).toBe(false);
  });

  test('a canonical cancellation polls only the exact bound Response cancellation route', async () => {
    const f = fixture();
    f.config.SLACK_NATIVE_SESSIONS = true;
    f.state.cancellationRequested = true;
    f.hooks.advance = () => {
      f.state.state = 'delivering';
      f.state.snapshot = { text: '', status: 'cancelled', responseId: 'resp_test', elapsedMs: 0 };
    };
    await f.execute();
    expect(
      f.requests
        .filter((request) => request.path.startsWith('/api/agents/'))
        .map((request) => request.path),
    ).toEqual(['/api/agents/v1/responses/resp_test/cancel']);
    expect(
      f.slackRequests
        .filter((request) => request.method === 'agents.sessions.setStatus')
        .map((request) => request.body.get('status')),
    ).toEqual(['processing', 'active']);
  });

  test('requires-action uses native suspended state and one safe actor-lane yield', async () => {
    const f = fixture();
    f.config.SLACK_NATIVE_SESSIONS = true;
    f.hooks.advance = () => {
      f.state.state = 'requires_action';
      f.state.snapshot = {
        status: 'requires_action',
        text: '',
        responseId: 'resp_test',
        elapsedMs: 10,
      };
    };
    await f.worker.run(f.controller.signal);
    expect(f.slackRequests.map((request) => [request.method, request.body.get('status')])).toEqual([
      ['agents.sessions.setStatus', 'processing'],
      ['agents.sessions.setStatus', 'suspended'],
    ]);
    expect(f.paths().filter((path) => path.endsWith('/yield'))).toHaveLength(1);
    expect(f.paths().some((path) => path.endsWith('/commit'))).toBe(false);
  });
});
