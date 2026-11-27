import { EModelEndpoint } from 'librechat-data-provider';
import { filterMentionEndpoints } from './mentions';

describe('filterMentionEndpoints', () => {
  const endpoints = [EModelEndpoint.anthropic, EModelEndpoint.bedrock, EModelEndpoint.agents];

  it('limits mention endpoints to model spec addedEndpoints', () => {
    const result = filterMentionEndpoints({
      endpoints,
      includedEndpoints: new Set([EModelEndpoint.agents]),
      includeAssistants: true,
      hasAgentAccess: true,
    });

    expect(result).toEqual([EModelEndpoint.agents]);
  });

  it('keeps provider endpoints when no model spec allow-list is configured', () => {
    const result = filterMentionEndpoints({
      endpoints,
      includedEndpoints: new Set(),
      includeAssistants: true,
      hasAgentAccess: true,
    });

    expect(result).toEqual(endpoints);
  });

  it('excludes agents when the user lacks agent access', () => {
    const result = filterMentionEndpoints({
      endpoints,
      includedEndpoints: new Set([EModelEndpoint.agents]),
      includeAssistants: true,
      hasAgentAccess: false,
    });

    expect(result).toEqual([]);
  });

  it('excludes assistants when they are not included for the mention menu', () => {
    const result = filterMentionEndpoints({
      endpoints: [EModelEndpoint.assistants, EModelEndpoint.azureAssistants, EModelEndpoint.openAI],
      includedEndpoints: new Set(),
      includeAssistants: false,
      hasAgentAccess: true,
    });

    expect(result).toEqual([EModelEndpoint.openAI]);
  });
});
