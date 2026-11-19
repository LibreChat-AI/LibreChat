import { AxiosError, AxiosHeaders } from 'axios';
import * as service from './data-service';
import request from './request';

const root = '/api/channels/discord';
afterEach(() => jest.restoreAllMocks());

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
