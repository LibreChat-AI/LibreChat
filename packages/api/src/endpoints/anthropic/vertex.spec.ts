import { AuthKeys } from 'librechat-data-provider';
import { createAnthropicVertexClient } from './vertex';

describe('createAnthropicVertexClient', () => {
  const credentials = {
    [AuthKeys.GOOGLE_SERVICE_KEY]: {
      project_id: 'test-project',
      client_email: 'test@test-project.iam.gserviceaccount.com',
      private_key: 'test-private-key',
    },
  };

  it('should use Vertex AI multi-region base URLs for Anthropic', () => {
    const testCases = [
      { region: 'eu', baseURL: 'https://aiplatform.eu.rep.googleapis.com/v1' },
      { region: 'us', baseURL: 'https://aiplatform.us.rep.googleapis.com/v1' },
      { region: 'global', baseURL: 'https://aiplatform.googleapis.com/v1' },
    ];

    testCases.forEach(({ region, baseURL }) => {
      const client = createAnthropicVertexClient(credentials, undefined, {
        region,
        projectId: 'test-project',
      });

      expect(client.region).toBe(region);
      expect(client.baseURL).toBe(baseURL);
    });
  });
});
