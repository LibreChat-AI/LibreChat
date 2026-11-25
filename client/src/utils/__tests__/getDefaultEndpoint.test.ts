import { EModelEndpoint } from 'librechat-data-provider';
import getDefaultEndpoint from '../getDefaultEndpoint';

jest.mock('../localStorage', () => ({
  getLocalStorageItems: jest.fn(() => ({})),
}));

describe('getDefaultEndpoint', () => {
  it('opens a fresh composer on a model provider rather than the agent list', () => {
    const endpointsConfig = {
      [EModelEndpoint.agents]: { order: 0 },
      OpenCodex: { order: 1, type: EModelEndpoint.custom },
    };

    expect(getDefaultEndpoint({ convoSetup: {}, endpointsConfig })).toBe('OpenCodex');
  });

  it('still falls back to the agent list when it is the only endpoint offered', () => {
    const endpointsConfig = { [EModelEndpoint.agents]: { order: 0 } };

    expect(getDefaultEndpoint({ convoSetup: {}, endpointsConfig })).toBe(EModelEndpoint.agents);
  });
});
