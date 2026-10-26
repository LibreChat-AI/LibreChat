import { logger } from '@librechat/data-schemas';
import type { ReportedConfig } from './report';
import { getEndpointOverrideReport, reportEndpointOverrides } from './report';

const east = {
  group: 'east',
  apiKey: 'east-key',
  instanceName: 'east',
  version: '2024-10-21',
  deploymentName: 'gpt-4o',
  models: { 'gpt-4o': true },
};
const yaml = { endpoints: { azureOpenAI: { groups: [east] } } };

function config(
  principalId: string,
  overrides: Record<string, unknown>,
  extra: Partial<ReportedConfig> = {},
): ReportedConfig {
  return {
    principalType: 'role',
    principalId,
    priority: 10,
    overrides,
    ...extra,
  } as ReportedConfig;
}

describe('getEndpointOverrideReport', () => {
  it('sorts documents by what this release changes for their endpoint overrides', () => {
    const report = getEndpointOverrideReport(
      [
        config('vertex', { endpoints: { anthropic: { vertex: { enabled: false } } } }),
        config(
          'assistants',
          { endpoints: { azureOpenAI: { assistants: true } } },
          { tenantId: 't1' },
        ),
        config('merged', {
          endpoints: {
            azureOpenAI: { groups: [{ group: 'east', models: { o3: { deploymentName: 'o3' } } }] },
          },
        }),
        /** A full copy an older admin panel stored, with the deployment names it left blank. */
        config(
          'noise',
          { endpoints: { azureOpenAI: { groups: [{ ...east, deploymentName: '' }] } } },
          { isActive: false },
        ),
        config(
          'replaced',
          {
            endpoints: {
              azureOpenAI: { groups: [{ ...east, group: 'west', models: { 'gpt-5': true } }] },
            },
          },
          {
            tombstones: ['endpoints.azureOpenAI.groups'],
          },
        ),
        config('plain', { interface: { customWelcome: 'hi' } }),
        config('removed', {}, { tombstones: ['endpoints.azureOpenAI.groups'] }),
        config('unvertexed', {}, { tombstones: ['endpoints.anthropic.vertex'] }),
      ],
      yaml,
    );

    expect(report).toEqual({
      rederived: ['role/assistants in tenant t1'],
      ignoredVertex: ['role/vertex', 'role/unvertexed'],
      azureGroups: ['role/merged', 'role/replaced', 'role/removed'],
      unresolvedAzureGroups: ['role/noise (inactive)'],
    });
  });

  it('lists a document whose only Azure groups override is a keyed tombstone of one', () => {
    const report = getEndpointOverrideReport(
      [
        config('hide', {}, { tombstones: ['endpoints.azureOpenAI.groups["east"]'] }),
        config(
          'inside',
          {},
          { tombstones: ['endpoints.azureOpenAI.groups["east"].models.gpt-4o'] },
        ),
        config('custom', {}, { tombstones: ['endpoints.custom["east"]'] }),
        config('endpoint', {}, { tombstones: ['endpoints.azureOpenAI.titleModel'] }),
      ],
      yaml,
    );

    expect(report.azureGroups).toEqual(['role/hide', 'role/inside']);
    expect(report.rederived).toEqual([]);
    expect(report.unresolvedAzureGroups).toEqual([]);
  });

  it('lists Vertex AI overrides as applied only where librechat.yaml configures Vertex AI', () => {
    const configs = [
      config('vertex', { endpoints: { anthropic: { vertex: { models: ['m'] } } } }),
      config('unvertexed', {}, { tombstones: ['endpoints.anthropic.vertex'] }),
    ];
    const configured = (vertex: Record<string, unknown>) =>
      getEndpointOverrideReport(configs, {
        ...yaml,
        endpoints: { ...yaml.endpoints, anthropic: { vertex } },
      });

    for (const report of [configured({ projectId: 'p' }), configured({ enabled: false })]) {
      expect(report.rederived).toEqual(['role/vertex', 'role/unvertexed']);
      expect(report.ignoredVertex).toEqual([]);
    }
  });

  it("judges a profile's groups over its tenant's active Base profile, which merges first", () => {
    const review = {
      ...east,
      group: 'west-review',
      instanceName: 'west-review',
      models: { 'gpt-west-review': true },
    };
    const partial = {
      endpoints: {
        azureOpenAI: {
          groups: [
            { group: 'west-review', models: { 'gpt-west-review-2': { deploymentName: 'r2' } } },
          ],
        },
      },
    };
    const base = (extra: Partial<ReportedConfig> = {}) =>
      config('__base__', { endpoints: { azureOpenAI: { groups: [review] } } }, extra);

    const report = getEndpointOverrideReport(
      [
        base(),
        config('USER', partial),
        base({ tenantId: 't2', isActive: false }),
        config('ADMIN', partial, { tenantId: 't2' }),
        config('OTHER', partial, { tenantId: 't3' }),
      ],
      yaml,
    );

    expect(report).toEqual({
      rederived: [],
      ignoredVertex: [],
      azureGroups: ['role/__base__', 'role/USER', 'role/__base__ in tenant t2 (inactive)'],
      unresolvedAzureGroups: ['role/ADMIN in tenant t2', 'role/OTHER in tenant t3'],
    });
  });
});

describe('reportEndpointOverrides', () => {
  const vertex = config('vertex', { endpoints: { anthropic: { vertex: { models: ['m'] } } } });
  const vertexYaml = {
    endpoints: { ...yaml.endpoints, anthropic: { vertex: { projectId: 'p' } } },
  };

  const groups = config('groups', {
    endpoints: {
      azureOpenAI: { groups: [{ group: 'east', models: { o3: { deploymentName: 'o3' } } }] },
    },
  });
  const noise = config('noise', {
    endpoints: { azureOpenAI: { groups: [{ ...east, deploymentName: '' }] } },
  });

  it('warns about every override the switch would apply, Azure groups included, while it is off', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    const info = jest.spyOn(logger, 'info').mockImplementation(() => logger);
    const listConfigs = jest.fn().mockResolvedValue([vertex, groups, noise]);

    await reportEndpointOverrides({ listConfigs, baseYaml: vertexYaml, rederiveEndpoints: false });

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenNthCalledWith(
      1,
      expect.stringMatching(
        /inert until CONFIG_REDERIVE_ENDPOINTS=true.*: role\/vertex, role\/groups, role\/noise$/,
      ),
    );
    expect(warn).toHaveBeenNthCalledWith(
      2,
      expect.stringMatching(/would leave them out.*: role\/noise$/),
    );
    expect(info).not.toHaveBeenCalled();
    warn.mockRestore();
    info.mockRestore();
  });

  it('lists the overrides it applies, and the groups it leaves out, while it is on', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    const info = jest.spyOn(logger, 'info').mockImplementation(() => logger);
    const listConfigs = jest.fn().mockResolvedValue([vertex, groups, noise]);

    await reportEndpointOverrides({ listConfigs, baseYaml: vertexYaml, rederiveEndpoints: true });

    expect(info).toHaveBeenCalledWith(
      expect.stringMatching(/Applying the Vertex AI.*role\/vertex$/),
    );
    expect(info).toHaveBeenCalledWith(
      expect.stringMatching(/Applying the Azure groups.*role\/groups$/),
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^\[config\] Ignoring.*role\/noise$/));
    warn.mockRestore();
    info.mockRestore();
  });

  it.each([false, true])(
    'warns, switch on or off (%s), of Vertex AI overrides librechat.yaml configures none for',
    async (rederiveEndpoints) => {
      const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
      const info = jest.spyOn(logger, 'info').mockImplementation(() => logger);
      const listConfigs = jest.fn().mockResolvedValue([vertex]);

      const report = await reportEndpointOverrides({
        listConfigs,
        baseYaml: yaml,
        rederiveEndpoints,
      });

      expect(report?.ignoredVertex).toEqual(['role/vertex']);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/librechat\.yaml configures no Vertex AI.*: role\/vertex$/),
      );
      expect(info).not.toHaveBeenCalled();
      warn.mockRestore();
      info.mockRestore();
    },
  );

  it('logs a failure to list the documents and never throws', async () => {
    const error = jest.spyOn(logger, 'error').mockImplementation(() => logger);

    await expect(
      reportEndpointOverrides({
        listConfigs: jest.fn().mockRejectedValue(new Error('db down')),
        baseYaml: {},
        rederiveEndpoints: false,
      }),
    ).resolves.toBeNull();
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});
