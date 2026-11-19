import { AxiosError, AxiosHeaders } from 'axios';
import * as service from './data-service';
import request from './request';

const root = '/api/channels/discord';
afterEach(() => jest.restoreAllMocks());
test('keeps private DM codes out of mutation inputs and encodes owner list/revoke paths', async () => {
  const get = jest
    .spyOn(request, 'get')
    .mockResolvedValue({ ok: true, value: { selections: [], enabled: false } });
  const post = jest
    .spyOn(request, 'post')
    .mockResolvedValue({ ok: true, value: { code: 'private-code', expiresAtMs: 123 } });
  const remove = jest
    .spyOn(request, 'deleteWithOptions')
    .mockResolvedValue({ ok: true, value: null });
  expect(await service.listDiscordDmSelections('cursor/?')).toEqual({
    selections: [],
    enabled: false,
  });
  expect(get).toHaveBeenCalledWith(`${root}/dm/selections?cursor=cursor%2F%3F`);
  expect(
    await service.issueDiscordDmCode({ linkId: 'link', expectedLinkRevision: 'current' }),
  ).toEqual({ code: 'private-code', expiresAtMs: 123 });
  expect(post).toHaveBeenCalledWith(`${root}/dm/codes`, {
    linkId: 'link',
    expectedLinkRevision: 'current',
  });
  expect(
    await service.revokeDiscordDmSelection({ selectionId: 'id/?', revision: 'current' }),
  ).toBeNull();
  expect(remove).toHaveBeenCalledWith(`${root}/dm/selections/id%2F%3F`, {
    data: { revision: 'current' },
  });
});

test('encodes opaque cursors and resource IDs', async () => {
  const get = jest.spyOn(request, 'get').mockResolvedValue({});
  const remove = jest.spyOn(request, 'delete').mockResolvedValue(true);
  const disconnect = jest.spyOn(request, 'deleteWithOptions').mockResolvedValue({});
  await service.getDiscordApps('cursor/?a=b');
  await service.getDiscordGuilds('cursor/?a=b');
  await service.cancelDiscordInstall('flow/a?b');
  await service.disconnectDiscordGuild('install/a?b', 'revision-1');
  expect(get.mock.calls.map(([url]) => url)).toEqual([
    `${root}/apps?cursor=cursor%2F%3Fa%3Db`,
    `${root}/guilds?cursor=cursor%2F%3Fa%3Db`,
  ]);
  expect(remove).toHaveBeenCalledWith(`${root}/attempts/flow%2Fa%3Fb`);
  expect(disconnect).toHaveBeenCalledWith(`${root}/guilds/install%2Fa%3Fb`, {
    data: { revision: 'revision-1' },
  });
});

test('uses write-only application PUT and exact reconnect POST bodies', async () => {
  const put = jest.spyOn(request, 'put').mockResolvedValue({});
  const post = jest.spyOn(request, 'post').mockResolvedValue({});
  const input = {
    applicationId: '123456789012345678',
    botToken: 'private-token',
    clientSecret: 'private-secret',
  };
  await service.configureDiscordApplication(input);
  await service.connectDiscordGuild(input.applicationId, 'installation');
  expect(put).toHaveBeenCalledWith(`${root}/apps`, input);
  expect(post).toHaveBeenCalledWith(`${root}/connect`, {
    applicationId: input.applicationId,
    installationId: 'installation',
  });
});

test.each(['application_changed', 'unapproved-private-error'])(
  'sanitizes response/config secrets for %s',
  async (code) => {
    const config = {
      headers: new AxiosHeaders({ Authorization: 'private-token' }),
      data: 'private-secret',
    };
    const error = new AxiosError('private-provider-message', undefined, config, undefined, {
      status: 409,
      statusText: 'Conflict',
      headers: {},
      config,
      data: { error: { code, message: 'private-provider-body' } },
    });
    jest.spyOn(request, 'put').mockRejectedValue(error);
    let caught: unknown;
    try {
      await service.configureDiscordApplication({
        applicationId: '123456789012345678',
        botToken: 'private-token',
        clientSecret: 'private-secret',
      });
    } catch (failure) {
      caught = failure;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).toMatchObject({
      code: code === 'application_changed' ? code : 'unavailable',
      status: 409,
    });
    expect(JSON.stringify(caught)).not.toMatch(/private|config|headers|cause/);
    expect((caught as Error).message).toBe('Discord operation was not confirmed');
  },
);

test('encodes binding targets, unwraps responses, and keeps revision bodies exact', async () => {
  const status = { occupied: true, assignedToThisAgent: true, canReplace: true, revision: 'r1' };
  const get = jest.spyOn(request, 'get').mockResolvedValue({ ok: true, value: status });
  const put = jest
    .spyOn(request, 'put')
    .mockResolvedValue({ ok: true, value: { routeRevision: 'r2' } });
  const remove = jest
    .spyOn(request, 'deleteWithOptions')
    .mockResolvedValue({ ok: true, value: null });
  const target = {
    agentId: 'agent/a?b',
    installationId: 'install/a?b',
    externalChannelId: '123456789012345678',
  };
  expect(await service.getDiscordBinding(target)).toEqual(status);
  await service.bindDiscordChannel({ ...target, expectedRevision: 'r1' });
  expect(await service.removeDiscordBinding({ ...target, expectedRevision: 'r1' })).toBeNull();
  expect(get).toHaveBeenCalledWith(
    `${root}/agents/agent%2Fa%3Fb/binding?installationId=install%2Fa%3Fb&externalChannelId=123456789012345678`,
  );
  const body = {
    installationId: target.installationId,
    externalChannelId: target.externalChannelId,
    expectedRevision: 'r1',
  };
  expect(put).toHaveBeenCalledWith(`${root}/agents/agent%2Fa%3Fb/binding`, body);
  expect(remove).toHaveBeenCalledWith(`${root}/agents/agent%2Fa%3Fb/binding`, { data: body });
});

test('preserves the safe uncertain-binding code without provider diagnostics', async () => {
  const config = { headers: new AxiosHeaders(), data: 'private' };
  jest.spyOn(request, 'put').mockRejectedValue(
    new AxiosError('private provider detail', undefined, config, undefined, {
      status: 503,
      statusText: 'Unavailable',
      headers: {},
      config,
      data: { ok: false, error: { code: 'binding_uncertain', message: 'private' } },
    }),
  );
  await expect(
    service.bindDiscordChannel({
      agentId: 'agent',
      installationId: 'install',
      externalChannelId: '123456789012345678',
    }),
  ).rejects.toMatchObject({ code: 'binding_uncertain', status: 503 });
});
