import { EModelEndpoint } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { ServerRequest } from '~/types';
import { createEndpointsConfigService } from './endpoints';

async function agentsEntry() {
  const { getEndpointsConfig } = createEndpointsConfigService({
    getAppConfig: jest.fn().mockResolvedValue({
      endpoints: { [EModelEndpoint.agents]: { capabilities: [] } },
    } as unknown as AppConfig),
    loadDefaultEndpointsConfig: jest.fn().mockResolvedValue({
      [EModelEndpoint.agents]: { userProvide: false, order: 0 },
    }),
    loadCustomEndpointsConfig: jest.fn().mockReturnValue(undefined),
  });
  const result = await getEndpointsConfig({
    user: { id: 'u1', role: 'USER' },
  } as ServerRequest);
  return result?.[EModelEndpoint.agents];
}

describe('agents endpoint codeDefaultProfile', () => {
  afterEach(() => {
    delete process.env.LIBRECHAT_CODE_DEFAULT_PROFILE;
  });

  it('advertises stateful when the deployment runs code stateful', async () => {
    process.env.LIBRECHAT_CODE_DEFAULT_PROFILE = 'stateful';
    expect((await agentsEntry())?.codeDefaultProfile).toBe('stateful');
  });

  it('advertises default when unset', async () => {
    expect((await agentsEntry())?.codeDefaultProfile).toBe('default');
  });
});
