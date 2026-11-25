jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
  apiBaseUrl: jest.fn(),
}));

import { ResourceType, apiBaseUrl } from 'librechat-data-provider';
import { RESOURCE_CONFIGS } from '../resources';

describe('RESOURCE_CONFIGS', () => {
  describe('REMOTE_AGENT getResourceUrl', () => {
    it('returns the Open Responses endpoint for standard root deployments', () => {
      (apiBaseUrl as jest.Mock).mockReturnValue('');
      const getUrl = RESOURCE_CONFIGS[ResourceType.REMOTE_AGENT]?.getResourceUrl;
      expect(getUrl?.('agent123')).toBe('http://localhost:3080/api/agents/v1/responses');
    });

    it('includes the base path for subdirectory deployments', () => {
      (apiBaseUrl as jest.Mock).mockReturnValue('/librechat');
      const getUrl = RESOURCE_CONFIGS[ResourceType.REMOTE_AGENT]?.getResourceUrl;
      expect(getUrl?.('agent123')).toBe('http://localhost:3080/librechat/api/agents/v1/responses');
    });
  });

  describe('AGENT getResourceUrl', () => {
    it('returns the agent chat URL for standard root deployments', () => {
      (apiBaseUrl as jest.Mock).mockReturnValue('');
      const getUrl = RESOURCE_CONFIGS[ResourceType.AGENT]?.getResourceUrl;
      expect(getUrl?.('agent123')).toBe('http://localhost:3080/c/new?agent_id=agent123');
    });

    it('includes the base path for subdirectory deployments', () => {
      (apiBaseUrl as jest.Mock).mockReturnValue('/librechat');
      const getUrl = RESOURCE_CONFIGS[ResourceType.AGENT]?.getResourceUrl;
      expect(getUrl?.('agent123')).toBe('http://localhost:3080/librechat/c/new?agent_id=agent123');
    });
  });
});
