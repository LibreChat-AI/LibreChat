import type { MCPAuthorityProofV1, MCPAuthorityMethods } from '@librechat/data-schemas';
import { MCPAuthorityProofResolver } from './index';

const proof: MCPAuthorityProofV1 = Object.freeze({
  version: 1,
  shared: {
    user: {
      userId: '64b64c13a1136b7f18a7e111',
      tenantId: null,
      role: 'USER',
      provider: 'local',
      sourceIdentityDigest: 'source',
      revision: 'user',
    },
    groups: [],
    configs: [],
    role: { id: 'role-id', name: 'USER', use: true, revision: 'role' },
    boot: { revision: 'boot-1', digest: 'boot-digest' },
    groupsRevision: 'groups',
    configsRevision: 'configs',
    revision: 'shared',
  },
  servers: [],
  revision: 'proof',
});

function createResolver(beforeExecute?: () => void | Promise<void>) {
  const resolveMCPAuthorityProof: jest.MockedFunction<
    MCPAuthorityMethods['resolveMCPAuthorityProof']
  > = jest.fn();
  const assertMCPAuthorityProofsCurrent: jest.MockedFunction<
    MCPAuthorityMethods['assertMCPAuthorityProofsCurrent']
  > = jest.fn();
  resolveMCPAuthorityProof.mockResolvedValue(proof);
  assertMCPAuthorityProofsCurrent.mockResolvedValue(undefined);
  const resolver = new MCPAuthorityProofResolver({
    methods: { resolveMCPAuthorityProof, assertMCPAuthorityProofsCurrent },
    bootRevision: 'boot-1',
    immutableConfig: {
      mcpServers: {
        operator: { type: 'sse', url: 'https://operator.example/mcp' },
      },
    },
    beforeExecute,
  });
  return { resolver, resolveMCPAuthorityProof, assertMCPAuthorityProofsCurrent };
}

async function resolveFixture(resolver: MCPAuthorityProofResolver) {
  return await resolver.resolve({
    userId: '64b64c13a1136b7f18a7e111',
    targets: [
      {
        serverName: 'operator',
        source: 'config',
        sourceRevision: 'config-source-revision',
        expectedCredentialRevision: 'credential-revision',
        expectedOAuthGrantGeneration: null,
        resolvedConfig: { type: 'sse', url: 'https://operator.example/mcp' },
      },
    ],
    parsedConfig: { operator: { type: 'sse' } },
    schemas: [{ name: 'search' }],
    calculateArtifactRevision: ({ parsedConfig, schemas }) =>
      JSON.stringify({ parsedConfig, schemas }),
  });
}

describe('MCPAuthorityProofResolver', () => {
  test('returns parsed config and schemas with the resolved authority proof', async () => {
    const { resolver, resolveMCPAuthorityProof } = createResolver();
    const result = await resolveFixture(resolver);

    expect(Object.isFrozen(result)).toBe(true);
    expect(result).toMatchObject({
      parsedConfig: { operator: { type: 'sse' } },
      schemas: [{ name: 'search' }],
      authorityProof: proof,
    });
    expect(resolveMCPAuthorityProof).toHaveBeenCalledWith(
      expect.objectContaining({ boot: resolver.bootRevision }),
    );
  });

  test('asserts immediately before publishing or binding results', async () => {
    const events: string[] = [];
    const { resolver, assertMCPAuthorityProofsCurrent } = createResolver();
    const resolution = await resolveFixture(resolver);
    assertMCPAuthorityProofsCurrent.mockImplementation(async () => {
      events.push('assert');
    });

    await resolver.publishWithCurrentAuthority(resolution, (current) => {
      expect(current).toBe(resolution);
      events.push('publish');
    });
    await resolver.bindWithCurrentAuthority(resolution, (current) => {
      expect(current).toBe(resolution);
      events.push('bind');
    });

    expect(events).toEqual(['assert', 'publish', 'assert', 'bind']);
  });

  test('runs the injected mutation seam before the final remote-call assertion', async () => {
    const events: string[] = [];
    const { resolver, assertMCPAuthorityProofsCurrent } = createResolver(() => {
      events.push('mutate');
    });
    const resolution = await resolveFixture(resolver);
    assertMCPAuthorityProofsCurrent.mockImplementation(async () => {
      events.push('assert');
    });

    await resolver.executeWithCurrentAuthority(resolution, () => events.push('execute'));

    expect(events).toEqual(['mutate', 'assert', 'execute']);
  });

  test('does not publish, bind, or execute when the final assertion rejects', async () => {
    const action = jest.fn();
    const { resolver, assertMCPAuthorityProofsCurrent } = createResolver();
    const resolution = await resolveFixture(resolver);
    assertMCPAuthorityProofsCurrent.mockRejectedValue(new Error('revoked'));

    await expect(resolver.publishWithCurrentAuthority(resolution, action)).rejects.toThrow(
      'revoked',
    );
    await expect(resolver.bindWithCurrentAuthority(resolution, action)).rejects.toThrow('revoked');
    await expect(resolver.executeWithCurrentAuthority(resolution, action)).rejects.toThrow(
      'revoked',
    );
    expect(action).not.toHaveBeenCalled();
  });

  test('rejects structurally copied artifacts that were not issued by this resolver', async () => {
    const action = jest.fn();
    const { resolver, assertMCPAuthorityProofsCurrent } = createResolver();
    const resolution = await resolveFixture(resolver);
    const copiedResolution = { ...resolution };

    await expect(resolver.publishWithCurrentAuthority(copiedResolution, action)).rejects.toEqual(
      expect.objectContaining({ reason: 'malformed_input' }),
    );
    expect(assertMCPAuthorityProofsCurrent).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
  });

  test('does not mutate inputs and rejects artifact changes at the final fence', async () => {
    const { resolver, assertMCPAuthorityProofsCurrent } = createResolver();
    const resolution = await resolveFixture(resolver);
    resolution.schemas[0].name = 'changed';
    const action = jest.fn();

    await expect(resolver.publishWithCurrentAuthority(resolution, action)).rejects.toEqual(
      expect.objectContaining({ reason: 'malformed_input' }),
    );
    expect(Object.isFrozen(resolution.schemas)).toBe(false);
    expect(assertMCPAuthorityProofsCurrent).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
  });

  test('rejects artifact mutation injected while the authority assertion is in flight', async () => {
    let releaseAssertion: (() => void) | undefined;
    const assertionGate = new Promise<void>((resolve) => {
      releaseAssertion = resolve;
    });
    const { resolver, assertMCPAuthorityProofsCurrent } = createResolver();
    const resolution = await resolveFixture(resolver);
    const action = jest.fn();
    assertMCPAuthorityProofsCurrent.mockReturnValue(assertionGate);

    const publication = resolver.publishWithCurrentAuthority(resolution, action);
    await Promise.resolve();
    resolution.schemas[0].name = 'injected-change';
    releaseAssertion?.();

    await expect(publication).rejects.toEqual(
      expect.objectContaining({ reason: 'malformed_input' }),
    );
    expect(action).not.toHaveBeenCalled();
  });

  test('invokes the fenced action before a post-check queued mutation can run', async () => {
    const { resolver } = createResolver();
    const schemas = [{ name: 'search' }];
    let revisionCalls = 0;
    const resolution = await resolver.resolve({
      userId: '64b64c13a1136b7f18a7e111',
      targets: [
        {
          serverName: 'operator',
          source: 'config',
          sourceRevision: 'config-source-revision',
          expectedCredentialRevision: 'credential-revision',
          expectedOAuthGrantGeneration: null,
          resolvedConfig: { type: 'sse', url: 'https://operator.example/mcp' },
        },
      ],
      parsedConfig: { operator: { type: 'sse' } },
      schemas,
      calculateArtifactRevision: ({ parsedConfig, schemas: currentSchemas }) => {
        revisionCalls++;
        if (revisionCalls === 4) {
          queueMicrotask(() => {
            schemas[0].name = 'queued-mutation';
          });
        }
        return JSON.stringify({ parsedConfig, schemas: currentSchemas });
      },
    });
    const observedNames: string[] = [];

    await resolver.publishWithCurrentAuthority(resolution, (current) => {
      observedNames.push(current.schemas[0].name);
    });

    expect(observedNames).toEqual(['search']);
    expect(schemas[0].name).toBe('queued-mutation');
  });
});
