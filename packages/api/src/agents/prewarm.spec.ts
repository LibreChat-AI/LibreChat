import type { StatefulCodeEnvironment } from 'librechat-data-provider';
import type { CodeExecutionContext } from './execution';
import {
  markSandboxReady,
  maybePrewarmCodeSandbox,
  resetSandboxStateForTests,
  shouldSignalSandboxStart,
} from './prewarm';

type PrewarmParams = Parameters<typeof maybePrewarmCodeSandbox>[0];

interface TestAgent {
  id: string;
  statefulCodeSessions?: boolean;
  statefulCodeEnvironment?: StatefulCodeEnvironment;
  codeExecutionContext?: CodeExecutionContext;
  subagentAgentConfigs?: TestAgent[];
  lazySubagentConfigs?: TestAgent[];
}

const req = { user: { id: 'user-1' } } as PrewarmParams['req'];
const statefulAgent: TestAgent = { id: 'agent_stateful', statefulCodeSessions: true };
const plainAgent: TestAgent = { id: 'agent_plain', statefulCodeSessions: false };

function agents(...list: TestAgent[]): PrewarmParams['agents'] {
  return list as PrewarmParams['agents'];
}

function flushAsync(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function mockResponse(init: { ok: boolean; status: number }): Response {
  return { ...init, arrayBuffer: async () => new ArrayBuffer(0) } as Response;
}

describe('maybePrewarmCodeSandbox', () => {
  let fetchMock: jest.SpyInstance;

  beforeEach(async () => {
    await resetSandboxStateForTests();
    process.env.LIBRECHAT_CODE_BASEURL = 'http://code.test/v1';
    process.env.LIBRECHAT_CODE_BASEURL_STATEFUL = 'http://code-stateful.test/v1';
    delete process.env.CODE_SANDBOX_PREWARM;
    delete process.env.CODE_SANDBOX_COLD_AFTER_MS;
    delete process.env.CODEAPI_JWT_ENABLED;
    delete process.env.CODEAPI_AUTH_PROVIDER;
    fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(mockResponse({ ok: true, status: 200 }));
  });

  afterEach(() => {
    fetchMock.mockRestore();
    jest.useRealTimers();
    delete process.env.LIBRECHAT_CODE_BASEURL;
    delete process.env.LIBRECHAT_CODE_BASEURL_STATEFUL;
  });

  it('does nothing when no reachable agent has stateful sessions', async () => {
    maybePrewarmCodeSandbox({ req, conversationId: 'convo-1', agents: agents(plainAgent) });
    await flushAsync();
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(shouldSignalSandboxStart('convo-1')).resolves.toBe(false);
  });

  it('does nothing without a conversationId', async () => {
    maybePrewarmCodeSandbox({ req, conversationId: null, agents: agents(statefulAgent) });
    await flushAsync();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('respects the CODE_SANDBOX_PREWARM=false kill switch', async () => {
    process.env.CODE_SANDBOX_PREWARM = 'false';
    maybePrewarmCodeSandbox({ req, conversationId: 'convo-1', agents: agents(statefulAgent) });
    await flushAsync();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fires one stateful-profile exec with the default user environment and marks ready', async () => {
    maybePrewarmCodeSandbox({ req, conversationId: 'convo-1', agents: agents(statefulAgent) });
    await flushAsync();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://code-stateful.test/v1/exec');
    expect(init.headers).toEqual(
      expect.objectContaining({ 'X-CodeAPI-Expected-Profile': 'stateful' }),
    );
    expect(JSON.parse(init.body as string)).toEqual({
      lang: 'bash',
      code: 'true',
      runtime_session_hint: 'v2:user:b5729fb0e3ca12e7a61ff6857b99d98e',
    });
    await expect(shouldSignalSandboxStart('convo-1')).resolves.toBe(false);
  });

  it('does not prewarm an attached environment that leases a single worker', async () => {
    const attachedAgent: TestAgent = {
      id: 'agent_attached',
      statefulCodeSessions: true,
      codeExecutionContext: {
        baseUrl: 'http://attached-code.test/v1',
        codeSessionKey: 'execute_code:stateful:attached',
        executionProfile: 'stateful',
        runtimeSessionHint: 'v3:attached:conversation:abc',
        statefulSessions: true,
        environmentId: 'e2e-vm',
        environmentType: 'attached',
      },
    };

    maybePrewarmCodeSandbox({ req, conversationId: 'convo-1', agents: agents(attachedAgent) });
    await flushAsync();

    expect(fetchMock).not.toHaveBeenCalled();
    await expect(shouldSignalSandboxStart('convo-1')).resolves.toBe(false);
  });

  it('walks subagent configs for the stateful gate', async () => {
    const parent = { id: 'agent_parent', subagentAgentConfigs: [statefulAgent] };
    maybePrewarmCodeSandbox({ req, conversationId: 'convo-1', agents: agents(parent) });
    await flushAsync();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('walks lazy subagents and deduplicates user-scoped environments', async () => {
    const parent = {
      id: 'agent_parent',
      statefulCodeSessions: true,
      lazySubagentConfigs: [statefulAgent],
    };
    maybePrewarmCodeSandbox({ req, conversationId: 'convo-1', agents: agents(parent) });
    await flushAsync();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('prewarms distinct per-agent environments independently', async () => {
    const first: TestAgent = {
      id: 'agent-1',
      statefulCodeSessions: true,
      statefulCodeEnvironment: 'agent-user',
    };
    const second: TestAgent = {
      id: 'agent-2',
      statefulCodeSessions: true,
      statefulCodeEnvironment: 'agent-user',
    };
    maybePrewarmCodeSandbox({ req, conversationId: 'convo-1', agents: agents(first, second) });
    await flushAsync();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const hints = fetchMock.mock.calls.map(
      ([, init]) => JSON.parse(init.body).runtime_session_hint,
    );
    expect(hints).toEqual(
      expect.arrayContaining([
        'v2:agent-user:9cf1605ead4951d96f711e1b3db86642',
        'v2:agent-user:f2a396a5aa5e99ce8e423f5ba6c323a3',
      ]),
    );
  });

  it('does not share prewarm cache entries between authenticated users', async () => {
    maybePrewarmCodeSandbox({ req, conversationId: 'convo-1', agents: agents(statefulAgent) });
    await flushAsync();
    const otherReq = { user: { id: 'user-2' } } as PrewarmParams['req'];
    maybePrewarmCodeSandbox({
      req: otherReq,
      conversationId: 'convo-2',
      agents: agents(statefulAgent),
    });
    await flushAsync();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const hints = fetchMock.mock.calls.map(
      ([, init]) => JSON.parse(init.body).runtime_session_hint,
    );
    expect(new Set(hints).size).toBe(2);
  });

  it('keeps the conversation start signal active until every selected environment is warm', async () => {
    const resolvers: Array<(response: Response) => void> = [];
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const first = {
      id: 'agent-1',
      statefulCodeSessions: true,
      statefulCodeEnvironment: 'agent-user' as const,
    };
    const second = {
      id: 'agent-2',
      statefulCodeSessions: true,
      statefulCodeEnvironment: 'agent-user' as const,
    };

    maybePrewarmCodeSandbox({ req, conversationId: 'convo-1', agents: agents(first, second) });
    await flushAsync();
    expect(resolvers).toHaveLength(2);
    await expect(shouldSignalSandboxStart('convo-1')).resolves.toBe(true);

    resolvers[0](mockResponse({ ok: true, status: 200 }));
    await flushAsync();
    await expect(shouldSignalSandboxStart('convo-1')).resolves.toBe(true);

    resolvers[1](mockResponse({ ok: true, status: 200 }));
    await flushAsync();
    await expect(shouldSignalSandboxStart('convo-1')).resolves.toBe(false);
  });

  it('does not refire while the warm marker is fresh', async () => {
    maybePrewarmCodeSandbox({ req, conversationId: 'convo-1', agents: agents(statefulAgent) });
    await flushAsync();
    maybePrewarmCodeSandbox({ req, conversationId: 'convo-1', agents: agents(statefulAgent) });
    await flushAsync();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('prewarms a replacement route even when its runtime session hint is unchanged', async () => {
    const context = (executionRouteKey: string, baseUrl: string): TestAgent => ({
      id: `agent-${executionRouteKey}`,
      statefulCodeSessions: true,
      codeExecutionContext: {
        baseUrl,
        codeSessionKey: `execute_code:${executionRouteKey}`,
        executionProfile: 'stateful',
        executionRouteKey,
        runtimeSessionHint: 'v3:stable:user:scope',
        statefulSessions: true,
        environmentType: 'managed',
      },
    });

    maybePrewarmCodeSandbox({
      req,
      conversationId: 'convo-1',
      agents: agents(context(`stateful:${'a'.repeat(32)}`, 'https://old-code.example.com')),
    });
    await flushAsync();
    maybePrewarmCodeSandbox({
      req,
      conversationId: 'convo-2',
      agents: agents(context(`stateful:${'b'.repeat(32)}`, 'https://new-code.example.com')),
    });
    await flushAsync();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://old-code.example.com/exec',
      'https://new-code.example.com/exec',
    ]);
  });

  it('does not refire while a prewarm is in flight', async () => {
    fetchMock.mockImplementation(() => new Promise(() => undefined));
    maybePrewarmCodeSandbox({ req, conversationId: 'convo-1', agents: agents(statefulAgent) });
    await flushAsync();
    maybePrewarmCodeSandbox({ req, conversationId: 'convo-1', agents: agents(statefulAgent) });
    await flushAsync();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps a second conversation cold while it joins an in-flight user prewarm', async () => {
    fetchMock.mockImplementation(() => new Promise(() => undefined));
    maybePrewarmCodeSandbox({ req, conversationId: 'convo-1', agents: agents(statefulAgent) });
    await flushAsync();
    maybePrewarmCodeSandbox({ req, conversationId: 'convo-2', agents: agents(statefulAgent) });
    await flushAsync();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(shouldSignalSandboxStart('convo-1')).resolves.toBe(true);
    await expect(shouldSignalSandboxStart('convo-2')).resolves.toBe(true);
  });

  it('refires once the warm marker has expired', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    jest.setSystemTime(new Date('2026-07-13T00:00:00Z'));
    maybePrewarmCodeSandbox({ req, conversationId: 'convo-1', agents: agents(statefulAgent) });
    await flushAsync();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    jest.setSystemTime(new Date('2026-07-13T01:00:00Z'));
    maybePrewarmCodeSandbox({ req, conversationId: 'convo-1', agents: agents(statefulAgent) });
    await flushAsync();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('prewarms again after a short cold-after window even within the fire cooldown', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    jest.setSystemTime(new Date('2026-07-13T00:00:00Z'));
    process.env.CODE_SANDBOX_COLD_AFTER_MS = '30000';
    maybePrewarmCodeSandbox({ req, conversationId: 'convo-1', agents: agents(statefulAgent) });
    await flushAsync();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    jest.setSystemTime(new Date('2026-07-13T00:00:45Z'));
    maybePrewarmCodeSandbox({ req, conversationId: 'convo-1', agents: agents(statefulAgent) });
    await flushAsync();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('signals while a prewarm is in flight and stops after it completes', async () => {
    let resolveFetch: ((value: Response) => void) | undefined;
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    maybePrewarmCodeSandbox({ req, conversationId: 'convo-1', agents: agents(statefulAgent) });
    await flushAsync();
    await expect(shouldSignalSandboxStart('convo-1')).resolves.toBe(true);

    resolveFetch?.(mockResponse({ ok: true, status: 200 }));
    await flushAsync();
    await expect(shouldSignalSandboxStart('convo-1')).resolves.toBe(false);
  });

  it('keeps signaling when the prewarm request fails, without throwing', async () => {
    fetchMock.mockRejectedValue(new Error('boom'));
    maybePrewarmCodeSandbox({ req, conversationId: 'convo-1', agents: agents(statefulAgent) });
    await flushAsync();
    await expect(shouldSignalSandboxStart('convo-1')).resolves.toBe(true);
  });

  it('treats a non-2xx prewarm response as a failure', async () => {
    fetchMock.mockResolvedValue(mockResponse({ ok: false, status: 503 }));
    maybePrewarmCodeSandbox({ req, conversationId: 'convo-1', agents: agents(statefulAgent) });
    await flushAsync();
    await expect(shouldSignalSandboxStart('convo-1')).resolves.toBe(true);
  });

  it('does not mark the sandbox ready when the 2xx body fails to drain', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => {
        throw new Error('body aborted');
      },
    } as unknown as Response);
    maybePrewarmCodeSandbox({ req, conversationId: 'convo-1', agents: agents(statefulAgent) });
    await flushAsync();
    await expect(shouldSignalSandboxStart('convo-1')).resolves.toBe(true);
  });
});

describe('shouldSignalSandboxStart / markSandboxReady', () => {
  beforeEach(async () => {
    await resetSandboxStateForTests();
    process.env.LIBRECHAT_CODE_BASEURL_STATEFUL = 'http://code-stateful.test/v1';
    delete process.env.CODE_SANDBOX_PREWARM;
    delete process.env.CODE_SANDBOX_COLD_AFTER_MS;
  });

  afterEach(() => {
    jest.useRealTimers();
    delete process.env.LIBRECHAT_CODE_BASEURL_STATEFUL;
  });

  it('never signals for untracked conversations (stateless deployments)', async () => {
    await expect(shouldSignalSandboxStart('never-seen')).resolves.toBe(false);
    await expect(shouldSignalSandboxStart(null)).resolves.toBe(false);
    await expect(shouldSignalSandboxStart(undefined)).resolves.toBe(false);
  });

  it('stops signaling after a real tool call marks the sandbox ready', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => new Promise(() => undefined));
    maybePrewarmCodeSandbox({ req, conversationId: 'convo-1', agents: agents(statefulAgent) });
    await flushAsync();
    await expect(shouldSignalSandboxStart('convo-1')).resolves.toBe(true);

    await markSandboxReady('convo-1');
    await expect(shouldSignalSandboxStart('convo-1')).resolves.toBe(false);
    fetchMock.mockRestore();
  });

  it('never signals when the kill switch is on, even with an in-flight prewarm', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => new Promise(() => undefined));
    maybePrewarmCodeSandbox({ req, conversationId: 'convo-1', agents: agents(statefulAgent) });
    await flushAsync();
    process.env.CODE_SANDBOX_PREWARM = 'false';
    await expect(shouldSignalSandboxStart('convo-1')).resolves.toBe(false);
    fetchMock.mockRestore();
  });
});
